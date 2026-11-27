'use strict';
/**
 * 블로그 '의미 있는 한 편' — 종목 딥다이브(A) 또는 시장 리뷰(B) (글 개선 Phase 3, 2026-11-27)
 *
 * 양산형 틀(인사 → 🏆 → 🔍 → 📊) 대신 그날 이야기 하나를 칼럼처럼 쓴다.
 *   1) 재료: 그날 랭킹·흐름(market_story) · 지수 일봉 · 확정 재무(연·분기) · orgo 급등 기록과 그 뒤 20거래일 · 근거 기사 제목
 *   2) 형식: 지수가 ±3% 이상 움직인 날 = B(시장), 아니면 계약·실적 재료가 있는 종목 = A, 그것도 없으면 B
 *   3) 초안: Claude API(claude-opus-5-5) — 재료 JSON 안의 숫자만 쓰게 하고, 표·차트는 자리표시자만 넣게 한다(코드가 그림)
 *   4) 검증: 본문 숫자가 재료에 없으면 반려 → 한 번 다시 쓰게 함 / 투자조언·과장어 검사 / 길이
 *   5) 출력: public/marketing/{date}/blog-deep.json · blog-deep.html — 검증 통과분만 verified:true
 *
 *   node scripts/blog_deep.js [YYYYMMDD] [--kind=A|B] [--dry]   (--dry: API 호출 없이 재료만 출력)
 * 환경변수: ANTHROPIC_API_KEY
 */
const fs = require('fs');
const path = require('path');
const market = require('./tg_market');
const Story = require('./market_story');
const insight = require('./insight');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const MODEL = process.env.BLOG_DEEP_MODEL || 'claude-opus-5-5';
const MAX_TOKENS = 32000;
const EFFORT = 'high';
const MARKET_DAY_PCT = 3;        // 지수가 이만큼 움직인 날은 시장 리뷰(B)
const FOLLOW_DAYS = 20;          // 과거 급등 뒤 성적을 볼 거래일
const HISTORY_MAX = 20;          // 재료에 넣을 과거 급등 기록 수
const NEWS_MAX = 10;
const PEERS_MAX = 8;
const BODY_MIN = 1200, BODY_MAX = 4200;   // 본문(태그 뺀) 글자 수
const ATTEMPTS = 2;
const OHLC_URL = (t, s, e) => 'https://api.stock.naver.com/chart/domestic/item/' + t + '/day?startDateTime=' + s + '&endDateTime=' + e;
const FIN_URL = (t, kind) => 'https://m.stock.naver.com/api/stock/' + t + '/finance/' + kind;
// 투자조언(유사투자자문 미신고)·과장어 — 하나라도 있으면 반려
const ADVICE_RE = /매수\s*(?:추천|하세요|타이밍|기회|구간)|매도\s*(?:하세요|타이밍|추천)|추천\s*종목|목표\s*(?:가|주가)|손절|익절|사세요|파세요|담아|비중\s*(?:확대|축소)|수익\s*보장|오를\s*종목|급등\s*예상|지금이\s*기회/;
const HYPE_RE = /벌써|무려|폭등|폭락|대박|떡상|미쳤|역대급|불기둥|🔥|🚀|충격|경악|난리/;
const GREETING_RE = /안녕하세요|같이 정리해 볼게요|오늘도 찾아/;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function num(v) { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : NaN; }
function ymdDash(d) { return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8); }
function addDays(ymd, n) { const t = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + n * 864e5); return t.toISOString().slice(0, 10).replace(/-/g, ''); }
function r1(x) { return Math.round(x * 10) / 10; }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── 재료 ───────────────────────────────────────────
async function fetchFinance(ticker, kind) {
    const d = await market.fetchJsonRetry(FIN_URL(ticker, kind));
    const fi = d && d.financeInfo;
    if (!fi) return [];
    const cols = (fi.trTitleList || []).filter(c => c.isConsensus === 'N');
    const rows = ['매출액', '영업이익', '당기순이익'].map(t => (fi.rowList || []).find(r => r.title === t)).filter(Boolean);
    return cols.map(c => {
        const o = { period: c.title.replace(/\.$/, '') };
        rows.forEach(r => { const v = num(r.columns && r.columns[c.key] && r.columns[c.key].value); if (Number.isFinite(v)) o[r.title + '_억'] = v; });
        return o;
    }).filter(o => Object.keys(o).length > 1);
}
async function fetchOhlc(ticker, start, end) {
    const rows = await market.fetchJsonRetry(OHLC_URL(ticker, start + '0000', end + '2359'));
    return (Array.isArray(rows) ? rows : []).map(r => ({ date: String(r.localDate || ''), close: num(r.closePrice) }))
        .filter(r => /^\d{8}$/.test(r.date) && r.close > 0).sort((a, b) => a.date < b.date ? -1 : 1);
}
/** orgo 급등 기록(+10%↑) 과 그 뒤 20거래일 종가 수익률 */
async function riseHistory(ticker, date) {
    const h = readJson(path.join(PUBLIC, 'data', 'stock-history', ticker + '.json'));
    const ev = ((h && h.events) || []).filter(e => e.date && e.date < date).sort((a, b) => a.date < b.date ? -1 : 1).slice(-HISTORY_MAX);
    if (!ev.length) return [];
    let ohlc = [];
    try { ohlc = await fetchOhlc(ticker, addDays(ev[0].date, -3), date); } catch (e) { console.error('OHLC 실패:', e.message); }
    const idx = new Map(ohlc.map((r, i) => [r.date, i]));
    return ev.map(e => {
        const i = idx.get(e.date);
        const after = i != null && i + FOLLOW_DAYS < ohlc.length ? r1((ohlc[i + FOLLOW_DAYS].close / ohlc[i].close - 1) * 100) : null;
        const reason = String(e.rise_reason || '').trim();
        return { date: e.date, change_pct: r1(Number(e.change_rate) || 0), close: Number(e.close_price) || null,
            reason: /^관련 보도:/.test(reason) ? '' : reason, after_20d_pct: after };
    });
}
function newsOf(row) {
    return (row.news || []).filter(n => n && n.title).slice(0, NEWS_MAX)
        .map(n => ({ date: String(n.date || '').replace(/\D/g, '').slice(0, 8), title: String(n.title).trim(), source: n.source || '' }));
}
function storyOf(date) {
    const day = readJson(path.join(PUBLIC, 'data', 'rise-history', date + '.json'));
    if (!day || !Array.isArray(day.rankings)) throw new Error(date + ' rise-history 없음');
    const lc = (readJson(path.join(PUBLIC, 'data', 'leaders-calendar.json')) || {}).days || {};
    const L = lc[date] && lc[date].stock;
    const s = Story.build(Story.withSnapshot(PUBLIC, day), {
        leader: L ? { ticker: L.ticker, name: L.name, rate: L.rate, vol: L.vol, listing_day: L.listing_day } : null,
        history: Story.loadHistory(PUBLIC, date, 10),
    });
    return { day, s, calendar: lc[date] || null };
}
function flowFacts(f) {
    return { name: f.label, count: f.members.length, background: f.catalyst || '', streak_days: f.streak || 1,
        top: f.members.slice(0, 5).map(r => ({ name: r.name, change_pct: r1(r.rate), reason: r.reason || '' })) };
}
/** A 후보 — 계약·실적 이유가 있고 기사가 2건 이상인 종목, 상승 에너지 순 */
function pickStock(s) {
    const deal = /공급|수주|계약|실적|매출|영업이익|흑자|승인|허가|임상|인수|합병|기술\s*이전/;
    return (s.rows || []).filter(r => !r.ipo && r.reason && deal.test(r.reason) && (r.row.news || []).length >= 2)
        .sort((a, b) => b.energy - a.energy)[0] || null;
}

async function materials(date, forceKind) {
    const { s, calendar } = storyOf(date);
    let kq = [], kp = [];
    try { [kq, kp] = await Promise.all([insight.fetchIndexSeries('KOSDAQ'), insight.fetchIndexSeries('KOSPI')]); }
    catch (e) { console.error('지수 실패:', e.message); }
    const today = ser => ser.find(x => x.date === date) || null;
    const idx = { kospi: today(kp), kosdaq: today(kq) };
    const bigMove = Math.max(Math.abs((idx.kospi || {}).rate || 0), Math.abs((idx.kosdaq || {}).rate || 0));
    const pick = pickStock(s);
    const kind = forceKind || (bigMove >= MARKET_DAY_PCT || !pick ? 'B' : 'A');
    const ins = await insight.build(date, s).catch(() => ({ lines: [], pick: '' }));
    const base = {
        date, date_text: (+date.slice(4, 6)) + '월 ' + (+date.slice(6, 8)) + '일', kind,
        scope_note: '종목 수 집계는 ORGO가 수집한 +10% 이상 상승 종목 기준(시장 전체 전수 아님)',
        market: { kospi: idx.kospi && { close: idx.kospi.close, change_pct: r1(idx.kospi.rate) }, kosdaq: idx.kosdaq && { close: idx.kosdaq.close, change_pct: r1(idx.kosdaq.rate) } },
        counts: { rise10: s.rows.length, rise15: s.hot.length, limit_up: s.limitUps.length },
        leader: calendar && calendar.stock ? { name: calendar.stock.name, change_pct: calendar.stock.rate, trading_value_eok: Math.round(calendar.stock.vol / 1e8) } : null,
        flows: s.lead.slice(0, 4).map(flowFacts),
        computed_context: ins.lines.concat(ins.pick ? [ins.pick] : []),
    };
    if (kind === 'B') {
        const series = (bigMove && Math.abs((idx.kosdaq || {}).rate || 0) >= Math.abs((idx.kospi || {}).rate || 0)) ? { label: '코스닥', s: kq } : { label: '코스피', s: kp };
        const ser = series.s.filter(x => x.date <= date);
        const peak = ser.reduce((a, b) => (b.close > a.close ? b : a), ser[0] || { close: 0 });
        const big = ser.map((x, i) => ({ x, i })).filter(({ x }) => Math.abs(x.rate) >= 4).map(({ x, i }) => ({
            date: x.date, change_pct: r1(x.rate), close: x.close,
            next_day_pct: i + 1 < ser.length ? r1(ser[i + 1].rate) : null,
            after_5d_pct: i + 5 < ser.length ? r1((ser[i + 5].close / x.close - 1) * 100) : null,
        }));
        base.index_focus = { name: series.label, from: ser[0] && ser[0].date, peak: peak && { date: peak.date, close: peak.close },
            from_peak_pct: peak && ser.length ? r1((ser[ser.length - 1].close / peak.close - 1) * 100) : null, big_moves: big,
            series: ser.map(x => ({ date: x.date, close: x.close, change_pct: r1(x.rate) })) };
        base.money_top = s.money.slice(0, 6).map(r => ({ name: r.name, change_pct: r1(r.rate), trading_value_eok: Math.round(r.vol / 1e8) }));
        const seen = new Set();
        base.market_news = s.rows.flatMap(r => newsOf(r.row)).filter(n => n.date === date && /코스피|코스닥|증시|외국인|지수|사이드카|증안/.test(n.title) && !seen.has(n.title) && seen.add(n.title)).slice(0, 12);
    } else {
        const r = pick;
        const [annual, quarter] = await Promise.all([fetchFinance(r.ticker, 'annual').catch(() => []), fetchFinance(r.ticker, 'quarter').catch(() => [])]);
        const hist = await riseHistory(r.ticker, date).catch(() => []);
        const peers = s.rows.filter(x => x !== r && x.theme && x.theme === r.theme).sort((a, b) => b.rate - a.rate).slice(0, PEERS_MAX)
            .map(x => ({ name: x.name, change_pct: r1(x.rate), reason: x.reason || '' }));
        const withAfter = hist.filter(h => h.after_20d_pct != null);
        base.stock = {
            name: r.name, ticker: r.ticker, change_pct: r1(r.rate), close: Number(r.row.close_price) || null,
            market_cap_eok: Math.round((Number(r.row.market_cap) || 0) / 1e8) || null, trading_value_eok: Math.round(r.vol / 1e8),
            sector: r.sector, theme: r.theme, reason_today: r.reason, news: newsOf(r.row),
            annual_confirmed: annual, quarter_confirmed: quarter,
            rise_history: hist, rise_history_summary: { count: hist.length, with_20d: withAfter.length, higher_after_20d: withAfter.filter(h => h.after_20d_pct > 0).length },
            same_theme_today: peers,
        };
    }
    return base;
}

// ── 초안 ───────────────────────────────────────────
const SYSTEM = [
    '당신은 한국 주식시장 데이터 저널리스트다. ORGO(orgo.kr, 날마다 오른 종목과 이유를 기록하는 사이트)의 블로그에 칼럼 한 편을 쓴다.',
    '읽는 사람이 "그래서 이게 왜 중요한가"를 얻어 가는 글이어야 한다. 사실을 나열하지 말고, 질문 하나를 세우고 데이터로 풀어 간다.',
    '규칙:',
    '- 숫자는 주어진 재료 JSON에 있는 값만 쓴다. 새 숫자를 계산하거나 추정하지 않는다(비율·차이도 재료의 computed_context·summary에 있는 것만). 재료에 없는 사실(회사 연혁, 제품명, 고객사 등)은 쓰지 않는다. 기사 제목에 있는 내용은 "기사에 따르면"처럼 출처를 드러내 쓴다.',
    '- 지수·주가는 재료 값 그대로 쓴다. "640대", "700선" 같은 어림 표현은 그 말이 재료(기사 제목 등)에 있을 때만 쓴다.',
    '- 1만억 이상 금액은 조 단위로 쓴다(31596억 → 3조 1,596억, 21316억 → 2조 1,316억). 천 단위 쉼표를 넣는다.',
    '- 투자 권유 금지: 매수·매도·추천·목표가·비중·손절, "오를 것" 같은 전망 단정 금지. 앞으로 볼 지점은 질문으로만 쓴다.',
    '- 과장 금지: 벌써·무려·폭등·폭락·역대급·대박·불기둥·충격, 이모지 금지. 담담한 칼럼 문체(~다).',
    '- 인사말("안녕하세요")과 이모지 섹션 제목 금지. 소제목은 2~5개, 평서문 또는 질문형.',
    '- 제목은 글의 질문 하나(날짜·종목명 나열 금지). 40자 이내.',
    '- 표·차트는 직접 그리지 말고 문단 사이에 자리표시자만 넣는다: A형은 {{TABLE_FIN}}(재무 표)와 {{CHART_HISTORY}}(과거 급등 뒤 20거래일 성적), B형은 {{CHART_INDEX}}(지수 흐름)와 {{TABLE_BIGMOVES}}(큰 움직임 뒤 성적). 각각 한 번씩, 관련 문단 바로 뒤에.',
    '- 분량: 본문 1,500~3,500자. 마지막 문단은 "앞으로 확인할 것" 질문 2~4개.',
].join('\n');
const SCHEMA = {
    type: 'object', additionalProperties: false, required: ['title', 'summary', 'sections'],
    properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        sections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['heading', 'paragraphs'],
            properties: { heading: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } } } },
    },
};
function userPrompt(m, feedback) {
    const kindText = m.kind === 'A'
        ? 'A형(종목 딥다이브): stock 하나를 깊게. 무엇으로 돈을 버는지는 재료(업종·테마·과거 급등 이유)로 알 수 있는 만큼만, 이번 재료의 크기(computed_context의 매출 대비 비율 등), 실적 흐름(확정 연·분기), 과거 급등 뒤 20거래일 성적, 같은 테마 다른 종목과의 차이, 남은 질문.'
        : 'B형(시장 리뷰): index_focus를 중심으로 그날을 설명하는 질문 하나. 어디서 출발한 움직임인지(고점 대비), 과거 큰 움직임 뒤 성적, 무엇이 올랐나(flows·money_top), 기사들이 꼽은 계기(market_news), 다음에 확인할 것.';
    return '글 형식: ' + kindText + '\n\n재료(JSON):\n' + JSON.stringify(m) + (feedback ? '\n\n이전 초안이 검증에서 반려됐다. 고칠 점:\n' + feedback : '');
}
async function draft(m, feedback) {
    const sdk = require('@anthropic-ai/sdk');
    const Anthropic = sdk.default || sdk;
    const client = new Anthropic();
    const stream = client.beta.messages.stream({
        model: MODEL, max_tokens: MAX_TOKENS,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt(m, feedback) }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('refusal: ' + JSON.stringify(msg.stop_details || {}));
    if (msg.stop_reason === 'max_tokens') throw new Error('max_tokens 도달');
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    console.log('usage', JSON.stringify(msg.usage));
    return JSON.parse(text);
}

// ── 검증 ───────────────────────────────────────────
// 숫자 토큰 정규화: "1,656억" → 1656, "15.5%" → 15.5, "−6.0%" → -6 (부호는 떼고 비교)
function numbersIn(text) {
    return (String(text).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(t => Number(t.replace(/,/g, ''))).filter(Number.isFinite);
}
function allowedSet(m) {
    const set = new Set();
    const add = v => { if (!Number.isFinite(v)) return; const a = Math.abs(v); set.add(a); set.add(r1(a)); set.add(Math.round(a)); set.add(Math.floor(a)); };
    JSON.stringify(m).replace(/-?\d[\d,]*(?:\.\d+)?/g, t => { add(Number(t.replace(/,/g, ''))); return t; });
    // 날짜 조각(YYYYMMDD → 년·월·일), 억 → 조 환산 표기("1조 663억")
    (JSON.stringify(m).match(/20\d{6}/g) || []).forEach(d => { add(+d.slice(0, 4)); add(+d.slice(4, 6)); add(+d.slice(6, 8)); });
    [...set].forEach(v => { if (v >= 10000) { add(Math.floor(v / 10000)); add(v % 10000); } });
    return set;
}
const SMALL_OK = 10;   // 1~10 같은 작은 정수는 서수·개수 표현("두 번째", "3가지")으로 허용
function verify(a, m) {
    const problems = [];
    const plain = [a.title, a.summary].concat(...a.sections.map(s => [s.heading].concat(s.paragraphs))).join('\n');
    const allowed = allowedSet(m);
    const bad = [...new Set(numbersIn(plain).filter(n => !(n <= SMALL_OK && Number.isInteger(n)) && !allowed.has(n) && !allowed.has(r1(n))))];
    if (bad.length) problems.push('재료에 없는 숫자: ' + bad.slice(0, 12).join(', '));
    const adv = plain.match(ADVICE_RE); if (adv) problems.push('투자 권유 표현: ' + adv[0]);
    const hype = plain.match(HYPE_RE); if (hype) problems.push('과장 표현: ' + hype[0]);
    if (GREETING_RE.test(plain)) problems.push('인사말 틀');
    const len = plain.replace(/\s/g, '').length;
    if (len < BODY_MIN || len > BODY_MAX) problems.push('본문 길이 ' + len + '자(허용 ' + BODY_MIN + '~' + BODY_MAX + ')');
    if (Array.from(a.title).length > 40) problems.push('제목 40자 초과');
    const need = m.kind === 'A' ? ['{{TABLE_FIN}}', '{{CHART_HISTORY}}'] : ['{{CHART_INDEX}}', '{{TABLE_BIGMOVES}}'];
    need.forEach(t => { if (!plain.includes(t)) problems.push('자리표시자 없음: ' + t); });
    return problems;
}

// ── 그림·표 (숫자는 재료에서 바로) ─────────────────────
function md(d) { return (+d.slice(4, 6)) + '/' + (+d.slice(6, 8)); }
function svgBars(rows, label) {
    const w = 640, h = 230, pad = 30, n = rows.length || 1, bw = (w - 2 * pad) / n;
    const mx = Math.max(1, ...rows.map(r => Math.abs(r.v)));
    let out = '<line x1="' + pad + '" x2="' + (w - pad) + '" y1="' + h / 2 + '" y2="' + h / 2 + '" stroke="#999" stroke-width="0.6"/>';
    rows.forEach((r, i) => {
        const bh = Math.abs(r.v) / mx * (h / 2 - pad), y = r.v >= 0 ? h / 2 - bh : h / 2, col = r.v >= 0 ? '#d6453d' : '#2f6fd6';
        out += '<rect x="' + (pad + i * bw + 3).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw - 6).toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="' + col + '"/>';
        out += '<text x="' + (pad + i * bw + bw / 2).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle" font-size="9" fill="#666">' + esc(r.label) + '</text>';
        out += '<text x="' + (pad + i * bw + bw / 2).toFixed(1) + '" y="' + (r.v >= 0 ? y - 4 : y + bh + 11).toFixed(1) + '" text-anchor="middle" font-size="9" fill="' + col + '">' + (r.v > 0 ? '+' : '') + r.v + '</text>';
    });
    return '<figure><svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '" style="width:100%;height:auto">' + out + '</svg><figcaption>' + esc(label) + '</figcaption></figure>';
}
function svgLine(series, label) {
    const w = 640, h = 220, pad = 34, vals = series.map(x => x.close), lo = Math.min(...vals) * 0.98, hi = Math.max(...vals) * 1.01, n = series.length;
    const x = i => pad + i * (w - 2 * pad) / Math.max(1, n - 1), y = v => h - pad - (v - lo) / (hi - lo) * (h - 2 * pad);
    let out = '<polyline fill="none" stroke="#1d1d1f" stroke-width="1.6" points="' + series.map((p, i) => x(i).toFixed(1) + ',' + y(p.close).toFixed(1)).join(' ') + '"/>';
    series.forEach((p, i) => { if (Math.abs(p.change_pct) >= 4) out += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.close).toFixed(1) + '" r="3.5" fill="' + (p.change_pct > 0 ? '#d6453d' : '#2f6fd6') + '"/>'; });
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 6))) out += '<text x="' + x(i).toFixed(1) + '" y="' + (h - 10) + '" text-anchor="middle" font-size="10" fill="#666">' + md(series[i].date) + '</text>';
    return '<figure><svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '" style="width:100%;height:auto">' + out + '</svg><figcaption>' + esc(label) + '</figcaption></figure>';
}
function table(head, rows) {
    return '<table><thead><tr>' + head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => '<td>' + esc(c == null ? '—' : c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}
const pct = v => v == null ? '—' : (v > 0 ? '+' : '') + v + '%';
function blocks(m) {
    const b = {};
    if (m.kind === 'A' && m.stock) {
        const fin = m.stock.annual_confirmed.concat(m.stock.quarter_confirmed.slice(-4));
        b['{{TABLE_FIN}}'] = table(['기간', '매출액(억)', '영업이익(억)', '순이익(억)'], fin.map(f => [f.period, f['매출액_억'], f['영업이익_억'], f['당기순이익_억']]).map(r => r.map(v => typeof v === 'number' ? v.toLocaleString('ko-KR') : v)))
            + '<p class="src">출처: 네이버 증권 재무(확정치, 컨센서스 제외)</p>';
        const hist = m.stock.rise_history.filter(h => h.after_20d_pct != null);
        b['{{CHART_HISTORY}}'] = svgBars(hist.map(h => ({ label: md(h.date), v: h.after_20d_pct })), m.stock.name + ' — +10% 이상 오른 날 종가 대비 20거래일 뒤 수익률(%) · 출처: ORGO 급등 기록·네이버 일봉');
    } else if (m.index_focus) {
        b['{{CHART_INDEX}}'] = svgLine(m.index_focus.series, m.index_focus.name + ' 종가 — 점은 하루 ±4% 이상 움직인 날 · 출처: 네이버 지수');
        b['{{TABLE_BIGMOVES}}'] = table(['날짜', '등락률', '다음 날', '5거래일 뒤'], m.index_focus.big_moves.map(x => [md(x.date), pct(x.change_pct), pct(x.next_day_pct), pct(x.after_5d_pct)]));
    }
    return b;
}
function render(a, m) {
    const b = blocks(m);
    const para = p => { const t = p.trim(); return b[t] ? b[t] : '<p>' + esc(t).replace(/\{\{[A-Z_]+\}\}/g, k => b[k] ? '</p>' + b[k] + '<p>' : '') + '</p>'; };
    const body = a.sections.map(s => '<h3>' + esc(s.heading) + '</h3>\n' + s.paragraphs.map(para).join('\n')).join('\n');
    return '<h2>' + esc(a.title) + '</h2>\n<p class="meta">' + esc(m.date_text) + ' · ORGO</p>\n<p class="lede">' + esc(a.summary) + '</p>\n' + body +
        '\n<p class="note">이 글은 공개 자료와 ORGO 기록을 정리한 것이며 투자 권유가 아닙니다. ' + esc(m.scope_note) + '.</p>';
}
function page(html, verified, problems) {
    return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ORGO 블로그 원고</title>' +
        '<style>body{font:16px/1.8 -apple-system,"Pretendard","Malgun Gothic",sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;color:#1d1d1f;background:#fbfaf7}h2{font-size:22px}h3{font-size:17px;margin-top:28px}' +
        'table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid #e4e2dc;padding:6px 8px;text-align:right}th:first-child,td:first-child{text-align:left}.meta,.note,.src,figcaption{color:#6b6b70;font-size:13px}.lede{font-weight:600}' +
        '.warn{background:#fff3cd;padding:10px;border-radius:8px}</style></head><body>' +
        (verified ? '' : '<p class="warn">검증 미통과 — 게시하지 마세요: ' + esc(problems.join(' / ')) + '</p>') + html + '</body></html>';
}

async function main(argv = process.argv.slice(2)) {
    const date = argv.find(a => /^\d{8}$/.test(a)) || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    const kindArg = (argv.find(a => a.startsWith('--kind=')) || '').split('=')[1] || '';
    const m = await materials(date, /^[AB]$/.test(kindArg) ? kindArg : '');
    const dir = path.join(PUBLIC, 'marketing', date);
    fs.mkdirSync(dir, { recursive: true });
    const tag = kindArg ? '-' + kindArg : '';
    if (argv.includes('--dry')) { fs.writeFileSync(path.join(dir, 'blog-deep-materials' + tag + '.json'), JSON.stringify(m, null, 2)); console.log('재료만 저장 (kind ' + m.kind + ')'); return; }
    if (!process.env.ANTHROPIC_API_KEY) { console.log('ANTHROPIC_API_KEY 없음 — 건너뜀'); return; }
    let a = null, problems = ['초안 없음'];
    for (let i = 0; i < ATTEMPTS; i++) {
        try { a = await draft(m, i ? problems.join('\n') : ''); problems = verify(a, m); }
        catch (e) { problems = ['초안 실패: ' + e.message]; console.error(problems[0]); }
        console.log('시도 ' + (i + 1) + ': ' + (problems.length ? problems.join(' / ') : '통과'));
        if (!problems.length) break;
    }
    const verified = !!a && !problems.length;
    const html = a ? render(a, m) : '';
    fs.writeFileSync(path.join(dir, 'blog-deep' + tag + '.json'), JSON.stringify({ date, kind: m.kind, model: MODEL, verified, problems, title: a && a.title, summary: a && a.summary, html, materials: m }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'blog-deep' + tag + '.html'), page(html, verified, problems));
    console.log('저장: ' + path.join(dir, 'blog-deep' + tag + '.html') + ' (kind ' + m.kind + ', verified ' + verified + ')');
}

module.exports = { materials, verify, allowedSet, numbersIn, render, pickStock };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
