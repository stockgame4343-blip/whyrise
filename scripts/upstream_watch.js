'use strict';
/**
 * 상류(stock-rise) 날짜 데이터 끊김 감시 — 확정(is_final) 데이터가 1거래일 이상 밀리면 운영자 개인 DM
 * (stock-rise 의존 단계적 독립 1단계, 2026-11-27)
 *
 * 10/22~11/26 상류 수집이 40회 연속 실패했는데 orgo 쪽에서는 '확정 전이라 기다리는 중'으로만 보였다.
 * 그래서 '며칠째 멈췄는지 + 상류 수집 워크플로가 몇 번 연속 실패했는지'를 따로 알린다.
 *
 *   node scripts/upstream_watch.js [YYYYMMDD] [--dry-run]
 *
 * 시계: telegram-evening.yml(19:00 외부 디스패치)·telegram-morning.yml 의 한 스텝. 정상이면 조용히 끝난다.
 * 같은 상태는 하루 한 번만(.marketing-state/{date}-upstream-watch.json), 상태가 바뀌면 다시, 하루 최대 2통.
 * 환경변수: GH_TOKEN·GITHUB_REPOSITORY(하루 1번 기록), TELEGRAM_BOT_TOKEN + TELEGRAM_ADMIN_CHAT_ID 또는 THREADS_ALERT_CHAT_ID
 */
const tg = require('./tg_common');
const { Ledger } = require('./delivery_ledger');

const UPSTREAM_RAW = 'https://raw.githubusercontent.com/stockgame4343-blip/stock-rise/master/public/data/';
const UPSTREAM_RUNS = 'https://api.github.com/repos/stockgame4343-blip/stock-rise/actions/workflows/collect.yml/runs?per_page=50';
const UPSTREAM_ACTIONS = 'https://github.com/stockgame4343-blip/stock-rise/actions/workflows/collect.yml';
const CLOSE_READY_HM = '17:00';   // 이 시각 뒤에는 오늘 마감 확정 데이터가 있어야 정상(상류 마감 수집 ~15:36, 여유 포함)
const LAG_ALERT_DAYS = 1;         // 확정 데이터가 이만큼(거래일) 밀리면 알림
const FINAL_LOOKBACK = 3;         // 최신 몇 날짜까지 is_final 을 확인할지
const FETCH_TIMEOUT_MS = 20000;
const RETRIES = 2;
const MAX_ALERTS = 2;
const LEDGER_CHANNEL = 'upstream-watch';

function dmKey(date, n) { return 'upstream-watch:' + date + ':' + n; }
function addDays(ymd, n) { const t = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + n * 864e5); return t.toISOString().slice(0, 10).replace(/-/g, ''); }
function prevTradingDay(ymd) { let d = addDays(ymd, -1); for (let i = 0; i < 15 && !tg.isKrTradingDay(d); i++) d = addDays(d, -1); return d; }

/** 지금 있어야 할 최신 확정일 — 오늘이 거래일이고 17시가 지났으면 오늘, 아니면 직전 거래일 */
function expectedDate(today, hm) {
    return tg.isKrTradingDay(today) && hm >= CLOSE_READY_HM ? today : prevTradingDay(today);
}
/** from(제외) ~ to(포함) 사이 거래일 수 */
function tradingDaysBetween(from, to) {
    if (!from) return Infinity;
    let n = 0;
    for (let d = addDays(from, 1); d <= to && n < 400; d = addDays(d, 1)) if (tg.isKrTradingDay(d)) n++;
    return n;
}

async function fetchJson(url, headers) {
    let last;
    for (let i = 0; i < RETRIES; i++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': 'orgo-upstream-watch', ...(headers || {}) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (r.status === 404) return null;
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.json();
        } catch (e) { last = e; }
    }
    throw last;
}
/** 상류 최신 확정일 */
async function latestFinal() {
    const dates = (await fetchJson(UPSTREAM_RAW + 'dates.json')) || [];
    const sorted = dates.filter(d => /^\d{8}$/.test(d)).sort().reverse();
    for (const d of sorted.slice(0, FINAL_LOOKBACK)) {
        const day = await fetchJson(UPSTREAM_RAW + d + '.json').catch(() => null);
        if (day && day.is_final === true) return { latest: sorted[0] || '', final: d };
    }
    return { latest: sorted[0] || '', final: '' };
}
/** 상류 수집 워크플로 — 최근부터 연속 실패 수, 마지막 성공 시각 (공개 저장소라 토큰 없이도 읽힘) */
async function collectRuns() {
    const j = await fetchJson(UPSTREAM_RUNS, { Accept: 'application/vnd.github+json' });
    const runs = ((j && j.workflow_runs) || []).filter(r => r.status === 'completed' && r.conclusion !== 'skipped' && r.conclusion !== 'cancelled');
    let failures = 0;
    for (const r of runs) { if (r.conclusion === 'failure') failures++; else break; }
    const ok = runs.find(r => r.conclusion === 'success');
    return { failures, lastSuccess: ok ? ok.updated_at : '', lastUrl: runs[0] ? runs[0].html_url : '' };
}

/** 알릴 줄 — 정상이면 [] */
function report(today, s) {
    if (!(s.lag >= LAG_ALERT_DAYS)) return [];
    const md = d => d ? (+d.slice(4, 6)) + '/' + (+d.slice(6, 8)) : '없음';
    const lines = ['🚨 ' + md(today) + ' 상류(stock-rise) 데이터가 ' + s.lag + '거래일째 안 들어와요',
        '· 최신 확정 ' + md(s.final) + (s.latest && s.latest !== s.final ? ' (미확정 ' + md(s.latest) + ')' : '') + ' · 있어야 할 날 ' + md(s.expected)];
    if (s.runs) {
        if (s.runs.failures) lines.push('· 상류 수집(collect.yml) ' + s.runs.failures + '회 연속 실패' + (s.runs.lastSuccess ? ' — 마지막 성공 ' + s.runs.lastSuccess.slice(0, 10) : ''));
        else lines.push('· 상류 수집 실패는 없음 — 크론이 안 돌았거나 휴장 처리일 수 있어요');
        lines.push('· ' + (s.runs.lastUrl || UPSTREAM_ACTIONS));
    } else lines.push('· 상류 수집 기록 확인 실패 — ' + UPSTREAM_ACTIONS);
    lines.push('영향: 오른 이유·업종·테마가 비고, 마감 텔레그램·블로그 원고가 건너뛰어져요.');
    return lines;
}

async function main(argv = process.argv.slice(2), env = process.env) {
    const dryRun = argv.includes('--dry-run');
    const today = argv.find(a => /^\d{8}$/.test(a)) || tg.ymdKst();
    const hm = argv.includes('--evening') ? '23:59' : tg.hmKst();
    const s = { expected: expectedDate(today, hm), latest: '', final: '', lag: 0, runs: null };
    try { Object.assign(s, await latestFinal()); }
    catch (e) { console.log('::warning::상류 dates.json 확인 실패: ' + e.message); return; }   // 네트워크 문제로 오탐하지 않는다
    s.lag = s.final >= s.expected ? 0 : tradingDaysBetween(s.final, s.expected);
    if (s.lag >= LAG_ALERT_DAYS) { try { s.runs = await collectRuns(); } catch (e) { console.log('상류 런 확인 실패: ' + e.message); } }
    console.log(JSON.stringify({ today, hm, ...s }));
    const lines = report(today, s);
    if (!lines.length) { console.log('상류 정상 — 알림 없음'); return; }
    console.log(lines.join('\n'));
    if (dryRun) { console.log('[dry-run] 전송 생략'); return; }

    const canApi = !!(env.GH_TOKEN && env.GITHUB_REPOSITORY);
    const ledger = canApi ? new Ledger(env.GITHUB_REPOSITORY, env.GH_TOKEN) : null;
    const rec = ledger ? await ledger.load(today, LEDGER_CHANNEL) : null;
    const sent = (rec && rec.state.alerts) || [];
    const key = 'lag' + s.lag + ':' + s.final + ':' + (s.runs ? s.runs.failures : '?');
    if (sent.length >= MAX_ALERTS) { console.log('오늘 상류 알림 ' + sent.length + '통 보냄 — 스킵'); return; }
    if (sent.length && sent[sent.length - 1].key === key) { console.log('같은 상태 이미 알림 — 스킵'); return; }
    const chat = tg.operatorChat(env, 'admin');
    if (!env.TELEGRAM_BOT_TOKEN || !chat) { console.log('::warning::운영자 DM 미설정 — 상류 끊김을 보낼 곳이 없음'); return; }
    await tg.sendMessage(env.TELEGRAM_BOT_TOKEN, chat, lines.join('\n'), { delivery_key: dmKey(today, sent.length) });
    if (rec) await ledger.save(rec, { alerts: [...sent, { at: new Date().toISOString(), key }] });
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { expectedDate, tradingDaysBetween, report, prevTradingDay };
