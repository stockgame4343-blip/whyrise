'use strict';
/**
 * 텔레그램 '왜 중요한가' — 그날 숫자에 맥락 한두 줄을 붙인다 (글 개선 Phase 2, 2026-11-27)
 *
 * 문장은 정해진 틀만 쓰고, 들어가는 숫자는 전부 여기서 계산한다(LLM 없음 → 지어낸 숫자 0).
 *   ① 지수: 하루 ±3% 이상 움직인 날 — '○월 ○일 이후 가장 큰 상승/하락' + 최근 같은 방향 큰 날의 5거래일 뒤 성적
 *   ② 계약: 이유에 'N억 … 공급/수주/계약'이 있는 종목 — 계약액 ÷ 최근 확정 연매출
 *   ③ 테마: 앞장선 테마가 최근 20거래일 동안 3종목 이상 함께 오른 날 수
 * 하나도 못 만들면 [] — 호출부는 블록을 생략한다(게시는 그대로).
 *
 *   node scripts/insight.js [YYYYMMDD]   # 미리보기
 */
const fs = require('fs');
const path = require('path');
const market = require('./tg_market');
const Story = require('./market_story');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const INDEX_URL = code => 'https://m.stock.naver.com/api/index/' + code + '/price?pageSize=' + INDEX_LOOKBACK + '&page=1';
const FINANCE_URL = ticker => 'https://m.stock.naver.com/api/stock/' + ticker + '/finance/annual';
const INDEX_LOOKBACK = 60;          // 지수 일봉 개수(약 3개월, 네이버 API 한도 60) — '○월 이후 최대'·과거 비슷한 날 비교 범위
const BIG_MOVE_PCT = 3;             // 이 이상 움직인 날만 지수 맥락을 붙인다
const SIMILAR_MOVE_PCT = 4;         // '비슷한 날' 기준 — 같은 방향 ±4% 이상
const FOLLOW_DAYS = 5;              // 그 뒤 며칠 성적을 볼지
const RECORD_MIN_DAYS = 20;         // 이보다 짧은 기간의 '최대'는 말하지 않는다
const CONTRACT_MIN_RATIO = 5;       // 계약액이 연매출의 이 % 이상일 때만
const THEME_LOOKBACK = 20;          // 테마 빈도를 셀 거래일 수
const THEME_GROUP_MIN = 3;          // 그날 이 수 이상 함께 올라야 '테마로 오른 날'
const EOK = 1e8;
// '1,656억 규모 SOFC 공급계약', '2300억원 규모 공급계약 체결', '1.2조 수주'
const CONTRACT_RE = /(\d[\d,]*(?:\.\d+)?)\s*(조|억)\s*원?[^0-9]{0,24}?(?:공급|수주|납품|계약)/;

function num(v) { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : NaN; }
function md(ymd) { return (+ymd.slice(4, 6)) + '월 ' + (+ymd.slice(6, 8)) + '일'; }
function sign(x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1) + '%'; }
function eokText(eok) {
    if (eok >= 10000) { const jo = Math.floor(eok / 10000), rest = Math.round(eok % 10000); return jo + '조' + (rest ? ' ' + rest.toLocaleString('ko-KR') + '억' : ''); }
    return Math.round(eok).toLocaleString('ko-KR') + '억';
}

// ── ① 지수 ─────────────────────────────────────────
/** series: [{date:'YYYYMMDD', close, rate}] 오름차순 → 한 줄 또는 '' */
function indexLine(label, series, date, short = false) {
    const i = series.findIndex(x => x.date === date);
    if (i < 0) return '';
    const r = series[i].rate;
    if (!(Math.abs(r) >= BIG_MOVE_PCT)) return '';
    const up = r > 0;
    // 오늘보다 큰 같은 방향 움직임이 마지막으로 있던 날 다음부터가 '○월 ○일 이후 최대' 구간
    let j = i - 1;
    while (j >= 0 && (up ? series[j].rate < r : series[j].rate > r)) j--;
    const sinceIdx = j + 1, span = i - sinceIdx;
    let head = label + ' ' + sign(r);
    // 비교 구간 안에 더 큰 날이 없으면 '구간 시작일 이후'가 아니라 '최근 N거래일 중'이라고만 한다(그 전은 모름)
    const what = '가장 큰 하루 ' + (up ? '상승' : '하락') + '이에요.';
    if (j < 0 && i >= RECORD_MIN_DAYS) head += '는 최근 ' + (i + 1) + '거래일 중 ' + what;
    else if (j >= 0 && span >= RECORD_MIN_DAYS) head += '는 ' + md(series[sinceIdx].date) + ' 이후 ' + what;
    else head += '.';
    // 같은 방향 큰 날(±4%)의 5거래일 뒤 — 5거래일이 다 지난 날만
    const past = [];
    for (let k = 0; k < i; k++) {
        const x = series[k];
        if ((up ? x.rate >= SIMILAR_MOVE_PCT : x.rate <= -SIMILAR_MOVE_PCT) && k + FOLLOW_DAYS <= i - 1) {
            past.push((series[k + FOLLOW_DAYS].close / x.close - 1) * 100);
        }
    }
    const reversed = past.filter(p => (up ? p < 0 : p > 0)).length;
    if (short) {
        // 짧은 캡션용 한 줄 — '최근 N거래일 중 최대 상승. 앞서 +4% 넘게 오른 4번은 5거래일 뒤 모두 더 낮았어요.'
        let t = label + ' ' + sign(r);
        if (j < 0 && i >= RECORD_MIN_DAYS) t += ', 최근 ' + (i + 1) + '거래일 중 최대 ' + (up ? '상승' : '하락');
        else if (j >= 0 && span >= RECORD_MIN_DAYS) t += ', ' + md(series[sinceIdx].date) + ' 이후 최대 ' + (up ? '상승' : '하락');
        if (past.length < 2) return t + '.';
        const word = up ? '+' + SIMILAR_MOVE_PCT + '% 넘게 오른' : SIMILAR_MOVE_PCT + '% 넘게 내린';
        const more = ' 더 ' + (up ? '낮았어요.' : '높았어요.');
        return t + '. 앞서 ' + word + ' ' + (reversed === past.length
            ? past.length + '번은 ' + FOLLOW_DAYS + '거래일 뒤 모두' + more
            : past.length + '번 중 ' + reversed + '번은 ' + FOLLOW_DAYS + '거래일 뒤' + more);
    }
    if (past.length < 2) return head;
    const lo = Math.min(...past), hi = Math.max(...past);
    const kind = up ? '+' + SIMILAR_MOVE_PCT + '% 이상 오른' : SIMILAR_MOVE_PCT + '% 이상 내린';
    const tail = reversed === past.length
        ? ' 최근 ' + kind + ' ' + past.length + '번은 모두 ' + FOLLOW_DAYS + '거래일 뒤 그날보다 ' + (up ? '낮았어요' : '높았어요')
        : ' 최근 ' + kind + ' ' + past.length + '번 중 ' + reversed + '번은 ' + FOLLOW_DAYS + '거래일 뒤 그날보다 ' + (up ? '낮았어요' : '높았어요');
    return head + tail + '(' + sign(lo) + '~' + sign(hi) + ').';
}

async function fetchIndexSeries(code) {
    const rows = await market.fetchJsonRetry(INDEX_URL(code));
    return (Array.isArray(rows) ? rows : []).map(x => ({
        date: String(x.localTradedAt || '').replace(/-/g, '').slice(0, 8), close: num(x.closePrice), rate: num(x.fluctuationsRatio),
    })).filter(x => /^\d{8}$/.test(x.date) && x.close > 0 && Number.isFinite(x.rate)).sort((a, b) => a.date < b.date ? -1 : 1);
}

// ── ② 계약 ─────────────────────────────────────────
function contractEok(reason) {
    if (/누적|합계|총\s/.test(String(reason || ''))) return NaN;   // 누적 수주액은 한 번의 계약이 아니다
    const m = CONTRACT_RE.exec(String(reason || ''));
    if (!m) return NaN;
    const v = num(m[1]);
    return m[2] === '조' ? v * 10000 : v;
}
/** 최근 '확정' 연매출(억) — 컨센서스 열은 쓰지 않는다 → { year, eok } | null */
async function fetchAnnualRevenue(ticker) {
    const d = await market.fetchJsonRetry(FINANCE_URL(ticker));
    const fi = d && d.financeInfo;
    if (!fi) return null;
    const cols = (fi.trTitleList || []).filter(c => c.isConsensus === 'N').map(c => c.key).sort();
    const row = (fi.rowList || []).find(r => r.title === '매출액');
    for (let k = cols.length - 1; k >= 0 && row; k--) {
        const v = num(row.columns && row.columns[cols[k]] && row.columns[cols[k]].value);
        if (v > 0) return { year: cols[k].slice(0, 4), eok: v };
    }
    return null;
}
function contractLine(name, eok, rev) {
    if (!(eok > 0) || !rev || !(rev.eok > 0)) return '';
    const ratio = eok / rev.eok * 100;
    if (ratio < CONTRACT_MIN_RATIO) return '';
    return name + ' ' + eokText(eok) + ' 계약은 ' + rev.year + '년 매출(' + eokText(rev.eok) + ')의 ' + ratio.toFixed(1) + '%예요.';
}

// ── ③ 테마 ─────────────────────────────────────────
/** 앞장선 흐름이 최근 20거래일 중 며칠 '3종목 이상 함께' 올랐나 → 한 줄 또는 '' */
function themeLine(flow, date, pub = PUBLIC) {
    if (!flow || flow.kind === 'sector' || flow.group) return '';
    // 같은 흐름 열쇠(계열)로 센다 — '로봇(산업용…)'·'피지컬 AI/휴머노이드 로봇'처럼 태그가 달라도 같은 로봇 흐름
    const keyOf = r => Story.familyOf(Story.rowTheme(r));
    if (!flow.key) return '';
    let dates = [];
    try { dates = JSON.parse(fs.readFileSync(path.join(pub, 'data', 'rise-history', 'dates.json'), 'utf8')); } catch (_) { return ''; }
    dates = dates.filter(d => d < date).sort().slice(-THEME_LOOKBACK);
    if (dates.length < THEME_LOOKBACK) return '';
    let hit = 0, last = '';
    for (const d of dates) {
        let rows = [];
        try { rows = JSON.parse(fs.readFileSync(path.join(pub, 'data', 'rise-history', d + '.json'), 'utf8')).rankings || []; } catch (_) { continue; }
        const n = rows.filter(r => (Number(r.change_rate) || 0) >= Story.RISE && keyOf(r) === flow.key).length;
        if (n >= THEME_GROUP_MIN) { hit++; last = d; }
    }
    if (!hit) return flow.label + ' 테마가 ' + THEME_GROUP_MIN + '종목 이상 함께 오른 건 최근 ' + THEME_LOOKBACK + '거래일 중 처음이에요.';
    return flow.label + ' 테마는 최근 ' + THEME_LOOKBACK + '거래일 중 ' + hit + '일 함께 올랐어요(직전 ' + md(last) + ').';
}

/**
 * 그날 '왜 중요한가' 줄들 — { lines: [...], pick: '한 종목' 줄 }
 * story: market_story.build 결과, mkt: fetchKrMarketSummary 결과(없어도 됨)
 */
async function build(date, story, opts = {}) {
    const out = { lines: [], pick: '', short: '' };
    // ① 지수 — 코스닥·코스피 중 더 크게 움직인 쪽 하나
    try {
        const [kq, kp] = await Promise.all([fetchIndexSeries('KOSDAQ'), fetchIndexSeries('KOSPI')]);
        const cand = [['코스닥', kq], ['코스피', kp]].map(([label, s]) => ({ label, s, r: (s.find(x => x.date === date) || {}).rate }))
            .filter(c => Number.isFinite(c.r)).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
        const line = cand.length ? indexLine(cand[0].label, cand[0].s, date) : '';
        if (line) { out.lines.push(line); out.short = indexLine(cand[0].label, cand[0].s, date, true); }
    } catch (e) { console.error('insight 지수 실패(생략):', e.message); }
    // ② 계약 — 이유에 계약액이 있는 종목 중 상승 에너지 큰 순
    const deals = (story.rows || []).filter(r => r.reason && contractEok(r.reason) > 0).sort((a, b) => b.energy - a.energy).slice(0, 3);
    for (const r of deals) {
        try {
            const rev = await (opts.fetchRevenue || fetchAnnualRevenue)(r.ticker);
            const line = contractLine(r.name, contractEok(r.reason), rev);
            if (line) { out.pick = line; break; }
        } catch (e) { console.error('insight 매출 실패(' + r.name + '):', e.message); }
    }
    // ③ 테마 — 지수 줄이 없을 때만 (두 줄 넘기지 않는다)
    if (!out.lines.length) {
        const line = themeLine((story.lead || [])[0], date, opts.public || PUBLIC);
        if (line) out.lines.push(line);
    }
    return out;
}

module.exports = { build, indexLine, contractEok, contractLine, themeLine, eokText, fetchAnnualRevenue, fetchIndexSeries };

if (require.main === module) {
    (async () => {
        const date = process.argv[2] || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
        const day = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'rise-history', date + '.json'), 'utf8'));
        const s = Story.build(Story.withSnapshot(PUBLIC, day), { history: Story.loadHistory(PUBLIC, date, 10) });
        console.log(JSON.stringify(await build(date, s), null, 2));
    })().catch(e => { console.error(e); process.exit(1); });
}
