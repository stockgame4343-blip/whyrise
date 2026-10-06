'use strict';
/**
 * 평일 저녁 운영 점검 — 오늘 텔레그램 마감 정리·쓰레드·블로그 원고가 다 나갔는지 보고,
 * 빠진 게 있으면 운영자 개인 DM 으로 한 통 알린다. 다 나갔으면 조용히 끝(완료 DM 은 각 단계가 이미 보냄).
 * 마감 빌드가 안 돌았는데 업스트림은 확정돼 있으면 빌드를 직접 다시 걸어, 이후 발행이 자동으로 이어지게 한다.
 *
 * 시계: telegram-evening.yml 의 19:00 외부 디스패치(cron-job.org tg-evening) — GitHub 크론보다 정확하다.
 * 같은 내용은 하루 1번: .marketing-state/{date}-ops-check.json — 상황이 바뀌었을 때만 다시 보낸다(하루 최대 3통)
 *
 *   node scripts/ops_check.js [YYYYMMDD] [--dry-run]
 *
 * 환경변수: GH_TOKEN·GITHUB_REPOSITORY(진행 중 런 확인·빌드 재실행·하루 1번 기록),
 *           TELEGRAM_BOT_TOKEN + THREADS_ALERT_CHAT_ID 또는 TELEGRAM_ADMIN_CHAT_ID(운영자 개인 채팅 — 공개 채널은 쓰지 않음),
 *           THREADS_AUTOPUBLISH(vars — 'on' 이면 쓰레드 발행까지 점검)
 */
const fs = require('fs');
const path = require('path');
const tg = require('./tg_common');
const { Ledger } = require('./delivery_ledger');

const ROOT = path.resolve(__dirname, '..');
const UPSTREAM_RAW = 'https://raw.githubusercontent.com/stockgame4343-blip/stock-rise/master/public/data/';
const BUILD_WORKFLOW = 'build-history.yml';
const MARKETING_WORKFLOW = 'marketing-daily.yml';
const REBUILD_UNTIL = '20:50';   // 빌드 ~70분 → 마감 정리·원고 발행 창(~22:00) 안에 끝나는 마지막 시각
const LEDGER_CHANNEL = 'ops-check';
const MAX_ALERTS = 3;
const STUDIO = 'https://orgo.kr/marketing.html#blog';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

/** 저장소에 남은 기록만으로 오늘 어디까지 나갔나 */
function inspect(date, root = ROOT) {
    const day = readJson(path.join(root, 'public', 'data', 'rise-history', date + '.json'));
    const close = readJson(path.join(root, 'public', 'data', '_telegram-posted.json'));
    const digest = readJson(path.join(root, 'public', 'marketing', date, 'digest.json'));
    const threads = readJson(path.join(root, '.marketing-state', date + '-threads.json'));
    const note = readJson(path.join(root, '.marketing-state', date + '-blog-note.json'));
    return {
        built: !!(day && day.date === date && day.is_final === true),
        closePosted: !!(close && close.last === date),
        manuscript: !!(digest && digest.date === date),
        threads: (threads && threads.status) || '',
        threadsError: (threads && threads.error) || '',
        blogNoted: !!(note && note.status === 'sent'),
    };
}

/**
 * 운영자에게 보낼 줄들 — 빠진 게 없으면 [] (보내지 않음)
 * o: { autopublish, upstreamFinal(true/false/null), buildRunning, marketingRunning, rebuilt }
 */
function report(date, s, o = {}) {
    const md = `${+date.slice(4, 6)}/${+date.slice(6)}`;
    const head = `🩺 ${md} 저녁 발행 점검`;
    if (!s.built) {
        let why;
        if (o.buildRunning) why = '⏳ 마감 빌드가 아직 도는 중이에요. 끝나면 텔레그램 마감 정리·쓰레드·블로그 원고가 자동으로 이어서 나가요.';
        else if (o.rebuilt) why = '🔁 오늘 마감 빌드가 안 돌아 있어서 방금 다시 걸었어요(약 70분). 끝나면 텔레그램 마감 정리·쓰레드·블로그 원고가 자동으로 나가고, 완료 DM 도 따로 갈 거예요.';
        else if (o.upstreamFinal === false) why = '⏳ 업스트림(stock-rise) 마감 데이터가 아직 확정 전이에요. 확정되면 빌드부터 자동으로 이어져요.';
        else why = '❌ 오늘 마감 빌드가 안 돌았고 자동으로 다시 걸지도 못했어요. Actions 에서 「종목 인덱스 빌드 (1년치)」를 incremental 로 실행해 주세요.';
        return [head + ' — 아직 아무것도 안 나갔어요', why];
    }
    const lines = [], miss = [];
    const mark = (ok, okText, badText) => { lines.push(ok ? '✅ ' + okText : badText); if (!ok) miss.push(badText); };
    mark(s.closePosted, '텔레그램 마감 정리', '❌ 텔레그램 마감 정리(오늘의 대장)가 안 나갔어요.');
    if (o.marketingRunning && (!s.manuscript || (o.autopublish && s.threads !== 'published'))) {
        lines.push('⏳ 쓰레드·블로그 원고 단계가 지금 도는 중이에요. 끝나면 완료 DM 이 따로 가요.');
    } else {
        if (o.autopublish) {
            const t = s.threads;
            mark(t === 'published', '쓰레드 발행',
                !t ? '❌ 쓰레드가 아직 발행 안 됐어요.'
                    : `❌ 쓰레드 ${t === 'uncertain' ? '게시 여부 확인 필요' : '발행 실패'}${s.threadsError ? ' — ' + String(s.threadsError).slice(0, 120) : ''}`);
        } else {
            const off = 'ℹ️ 쓰레드 자동 발행이 꺼져 있어요(저장소 변수 THREADS_AUTOPUBLISH=on 이 아님). 발행실 원고를 직접 올려 주세요.';
            lines.push(off); miss.push(off);
        }
        mark(s.manuscript, '블로그 원고 준비', '❌ 블로그·쓰레드 원고가 아직 안 만들어졌어요.');
        if (s.manuscript && !s.blogNoted) { const t = '📝 블로그 원고 준비 알림이 안 나갔어요 — 원고는 발행실에 있어요: ' + STUDIO; lines.push(t); miss.push(t); }
    }
    if (!miss.length) return [];
    return [head + ' — 빠진 게 있어요', ...lines];
}

async function gh(env, url, init = {}) {
    const r = await fetch('https://api.github.com/repos/' + env.GITHUB_REPOSITORY + url, {
        ...init,
        headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    if (!r.ok && r.status !== 204) throw new Error(url + ' → HTTP ' + r.status);
    return r.status === 204 ? null : r.json();
}
async function running(env, workflow) {
    for (const status of ['in_progress', 'queued']) {
        const j = await gh(env, `/actions/workflows/${workflow}/runs?status=${status}&per_page=5`);
        if (j && j.total_count > 0) return true;
    }
    return false;
}
async function upstreamFinal(date) {
    try {
        const r = await fetch(UPSTREAM_RAW + date + '.json', { signal: AbortSignal.timeout(20000) });
        if (r.status === 404) return false;
        if (!r.ok) return null;
        return (await r.json()).is_final === true;
    } catch (e) { return null; }
}

async function main(argv = process.argv.slice(2), env = process.env) {
    const dryRun = argv.includes('--dry-run');
    const date = argv.find(a => /^\d{8}$/.test(a)) || tg.ymdKst();
    const block = tg.krPublishBlock(date, false);
    if (block) { console.log(block + ' — 점검 스킵'); return; }

    const canApi = !!(env.GH_TOKEN && env.GITHUB_REPOSITORY);
    const ledger = canApi ? new Ledger(env.GITHUB_REPOSITORY, env.GH_TOKEN) : null;
    const rec = ledger ? await ledger.load(date, LEDGER_CHANNEL) : null;
    const sent = (rec && rec.state.alerts) || [];
    if (sent.length >= MAX_ALERTS && !dryRun) { console.log('오늘 점검 알림 ' + sent.length + '통 보냄 — 스킵'); return; }

    const s = inspect(date);
    const o = { autopublish: String(env.THREADS_AUTOPUBLISH || '').trim() === 'on', upstreamFinal: null, buildRunning: false, marketingRunning: false, rebuilt: false };
    if (canApi) {
        try { o.buildRunning = await running(env, BUILD_WORKFLOW); } catch (e) { console.log('빌드 런 확인 실패: ' + e.message); }
        try { o.marketingRunning = await running(env, MARKETING_WORKFLOW); } catch (e) { console.log('원고 런 확인 실패: ' + e.message); }
    }
    if (!s.built && !o.buildRunning) {
        o.upstreamFinal = await upstreamFinal(date);
        if (o.upstreamFinal && canApi && tg.hmKst() <= REBUILD_UNTIL && !dryRun) {
            try {
                await gh(env, `/actions/workflows/${BUILD_WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'master', inputs: { mode: 'incremental' } }) });
                o.rebuilt = true;
                console.log('마감 빌드 재실행(incremental) 디스패치');
            } catch (e) { console.log('::warning::빌드 재실행 실패: ' + e.message); }
        }
    }
    console.log(JSON.stringify({ date, ...s, ...o }));

    const lines = report(date, s, o);
    if (!lines.length) { console.log('오늘 발행 다 나감 — 알림 없음'); return; }
    console.log(lines.join('\n'));
    if (dryRun) { console.log('[dry-run] 전송 생략'); return; }
    const key = lines.slice(1).join('\n');
    if (sent.length && sent[sent.length - 1].key === key) { console.log('같은 내용 이미 보냄 — 스킵'); return; }
    const chat = tg.operatorChat(env);
    if (!env.TELEGRAM_BOT_TOKEN || !chat) { console.log('::warning::운영자 DM 미설정(THREADS_ALERT_CHAT_ID / TELEGRAM_ADMIN_CHAT_ID) — 점검 결과를 보낼 곳이 없음'); return; }
    await tg.sendMessage(env.TELEGRAM_BOT_TOKEN, chat, lines.join('\n'));
    if (rec) await ledger.save(rec, { alerts: [...sent, { at: new Date().toISOString(), key }] });
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { inspect, report };
