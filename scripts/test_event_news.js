/**
 * 검증용 하네스 — public/js/stock.js 의 //#region news-pure 블록을 그대로 추출해
 * 실제 stock-history JSON 으로 pickEventNews 결과(급등일별 임베드 기사)를 덤프한다.
 * 코드 중복 없이 운영 로직 그 자체를 Node 에서 실행한다(DOM 만 스텁).
 *
 *   node scripts/test_event_news.js [sampleN]            # 전체에서 N개 균등 샘플(기본 40)
 *   node scripts/test_event_news.js --tickers 000150 005930
 *   node scripts/test_event_news.js --json out.json --tickers ...   # 워크플로우 입력용 JSON
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STOCK_JS = path.join(ROOT, 'public', 'js', 'stock.js');
const HIST_DIR = path.join(ROOT, 'public', 'data', 'stock-history');

// ── 1) 운영 순수 로직 추출 ──
const src = fs.readFileSync(STOCK_JS, 'utf8');
const start = src.indexOf('//#region news-pure');
const end = src.indexOf('//#endregion news-pure');
if (start < 0 || end < 0) { console.error('news-pure 영역을 찾지 못함'); process.exit(2); }
const region = src.slice(start, end);

// ── 2) DOM 스텁 (cleanNewsText 의 textarea 엔티티 디코드, normalizeNewsLink 의 navigator) ──
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const documentStub = {
    createElement() {
        let v = '';
        return {
            set innerHTML(s) {
                v = String(s)
                    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
                    .replace(/&[a-z]+;/gi, (m) => (ENT[m] != null ? ENT[m] : m));
            },
            get value() { return v; },
        };
    },
};
const navigatorStub = { userAgent: 'node-test' }; // 모바일 아님 → 링크 변환 없음

// esc 는 region 밖(stock.js 상단)에 있어 safeLink 가 참조 → 동일 구현을 주입
const ESC_DEF = "function esc(s){if(s==null)return '';return String(s)" +
    ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')" +
    ".replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}\n";
const factory = new Function('document', 'navigator',
    ESC_DEF + region + '\n; return { pickEventNews: pickEventNews, scoreNews: scoreNews, ' +
    'cleanNewsText: cleanNewsText, importantTokens: importantTokens, dateGapDays: dateGapDays };');
const helpers = factory(documentStub, navigatorStub);
const { pickEventNews } = helpers;

// --diag: 빈 이벤트의 "최선 named 동일날짜(±4d) 후보"를 보여 false-negative 점검
function diagBestNamed(ev, nameLower) {
    const tokens = helpers.importantTokens(ev.theme_tag, ev.sector, ev.rise_reason);
    const evDate = String(ev.date || '').replace(/[^0-9]/g, '').slice(0, 8);
    const evRate = Number(ev.change_rate || 0);
    let best = null;
    (ev.news || []).forEach(n => {
        const title = helpers.cleanNewsText(n.title);
        if (!title) return;
        const lower = title.toLowerCase();
        if (!nameLower || lower.indexOf(nameLower) < 0) return; // named only
        const nd = String(n.date || '').replace(/[^0-9]/g, '').slice(0, 8);
        const gap = helpers.dateGapDays(nd, evDate);
        if (gap === null || gap > 4) return; // within window
        const r = helpers.scoreNews(title, lower, nameLower, tokens, gap, evRate);
        if (!best || r.score > best.score) best = { title, score: Math.round(r.score * 10) / 10, gap, ok: r.ok, fill: r.fill, nd };
    });
    return best;
}

// ── 3) 대상 종목 결정 ──
const args = process.argv.slice(2);
let tickers = [];
let jsonOut = null;
let sampleN = 40;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tickers') { tickers = args.slice(i + 1).filter(a => !a.startsWith('--')); break; }
    if (args[i] === '--json') { jsonOut = args[i + 1]; i++; continue; }
    if (!args[i].startsWith('--')) sampleN = parseInt(args[i], 10) || sampleN;
}
const all = fs.readdirSync(HIST_DIR).filter(f => /^[0-9A-Z]{6}\.json$/i.test(f)).sort();
if (!tickers.length) {
    const step = Math.max(1, Math.floor(all.length / sampleN));
    for (let i = 0; i < all.length && tickers.length < sampleN; i += step) {
        tickers.push(all[i].replace('.json', ''));
    }
}

// ── 4) 덤프 ──
const report = [];
let evTotal = 0, evWithPick = 0, evFlowNoPick = 0;
const FLOW_RE = /순매수|수급|기관|외국인|프로그램|매수세|되돌림|반등|낙폭/;

for (const tk of tickers) {
    const fp = path.join(HIST_DIR, tk + '.json');
    if (!fs.existsSync(fp)) continue;
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const nameLower = String(d.name || '').toLowerCase();
    const events = (d.events || []).map(ev => {
        const picks = pickEventNews(ev, nameLower);
        evTotal++;
        if (picks.length) evWithPick++;
        else if (FLOW_RE.test(ev.rise_reason || '')) evFlowNoPick++;
        return {
            date: ev.date, rate: ev.change_rate, reason: ev.rise_reason || '',
            theme: ev.theme_tag || '', source: ev.reason_source || '',
            news_count: (ev.news || []).length,
            picks: picks.map(p => ({ title: p.title, source: p.source, newsDate: p.newsDate, score: Math.round(p.score * 10) / 10 })),
        };
    });
    report.push({ ticker: tk, name: d.name, market: d.market, events });
}

if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8');
    console.log('wrote', jsonOut, '(' + report.length + ' tickers)');
} else {
    for (const r of report) {
        console.log('\n===== ' + r.ticker + ' ' + r.name + ' (' + r.market + ') =====');
        for (const e of r.events) {
            console.log(`  [${e.date}] +${Number(e.rate).toFixed(1)}%  이유: ${e.reason || '-'}  (테마:${e.theme || '-'}, news:${e.news_count})`);
            if (!e.picks.length) {
                console.log('       └ (기사 없음)');
                if (args.includes('--diag')) {
                    const raw = JSON.parse(fs.readFileSync(path.join(HIST_DIR, r.ticker + '.json'), 'utf8'));
                    const ev = (raw.events || []).find(x => x.date === e.date);
                    const b = ev ? diagBestNamed(ev, String(raw.name || '').toLowerCase()) : null;
                    if (b) console.log(`           ⤷ 최선 named±4d: {s ${b.score} ok=${b.ok} fill=${b.fill} gap${b.gap}} ${b.nd} ${b.title}`);
                }
            }
            e.picks.forEach(p => console.log(`       └ ▶ ${p.newsDate} [${p.source}] ${p.title}  {score ${p.score}}`));
        }
    }
}
console.log(`\n── 요약: 이벤트 ${evTotal}건 / 기사 임베드 ${evWithPick}건(${(100 * evWithPick / Math.max(evTotal, 1)).toFixed(0)}%) / 수급성·기사없음 ${evFlowNoPick}건 ──`);
