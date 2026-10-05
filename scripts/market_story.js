'use strict';
/**
 * 하루 급등주 → '오늘의 흐름' (쓰레드·블로그·텔레그램·날짜별 페이지 공용 재료)
 *
 * 원칙
 * - 숫자는 데이터 그대로, 대신 데이터끼리 어긋나면 싣지 않는다.
 *   · 등락률은 전 거래일 종가로 다시 계산해 맞는 것만 쓴다(시장 스냅샷 보충 종목, 30% 초과 표기).
 *   · 상한가는 '종가 = 호가단위로 절사한 상한가'일 때만 상한가라고 쓴다(+29.7%인데 4호가 모자란 종목 제외).
 *   · 가격제한폭(30%)을 넘는 비상장일 종목, 거래가 없던 종목, 스팩은 순위·집계에서 뺀다.
 *   · 신규상장주의 등락률은 공모가 기준이 아니어서 숫자 없이 '신규상장'으로만 표시한다.
 * - 그룹 종목 수는 상류 사유 문장의 'N종목'이 아니라 실제로 묶인 종목(우선주는 같은 회사)만 센다.
 * - 이유는 같은 날 기사·토스 AI·관리자 수정으로 확인된 것만. 키워드 규칙 사유·'관련 보도'·리포트 의견·
 *   잘린 제목·의문형·지난 기사는 이유로 쓰지 않는다.
 * - 테마는 같은 계열(우주항공산업·스페이스X·우주태양광 → 우주항공)끼리 묶고, 거래대금×상승률(대장주와 같은
 *   '상승 에너지')로 순위를 매긴다. 제목·머리말에는 기사 배경이 있거나 4개사 이상 오른 흐름만 쓴다.
 */
const fs = require('fs');
const path = require('path');
const Reason = require(path.resolve(__dirname, '..', 'public', 'js', 'reason.js'));

const RISE = 10;          // 급등주 목록 기준 (사이트 리스트와 동일)
const HOT = 15;           // '+15% 이상' 집계 (대장 캘린더·텔레그램과 동일)
const LIMIT_UP = 29.5;    // 종가가 없을 때의 상한가 간주 기준
const PRICE_LIMIT = 30.5; // 가격제한폭(30%) + 반올림 여유 — 이보다 크면 상장 초기 종목 또는 데이터 어긋남
const RATE_CAP = 30;      // 상승 에너지 비교용 상한
const RATE_TOLERANCE = 0.6;   // 전일 종가로 다시 계산한 등락률과 허용 차이(%p)
const BLOCKED = { '003060': 1, '018700': 1, '007460': 1 };
// 투자 권유로 읽히는 말 — '공매도', '공개매수', '장내 매수', '순매수' 같은 사실 용어는 제외
const FORBIDDEN = /(?<!공개\s?|장내\s?|순)매수(?!세)|(?<!공)매도|추천|목표가|사세요|팔아|급등\s*예상|오를\s*종목|수익\s*보장|관심\s*가져/;

// ── 테마 계열 ── [표시 이름, 테마 태그 패턴, 사유 키워드]
const FAMILIES = [
    ['반도체', /^(?:반도체|시스템반도체|HBM|CXL|소캠|SOCAMM|유리\s*기판|뉴로모픽|전력반도체|AI\s*반도체|파운드리|D램|낸드)/i, /반도체|HBM|CXL|소캠|D램|낸드|파운드리|웨이퍼|기판|칩|메모리|Pd\s*Alloy/i],
    ['2차전지', /^(?:2차전지|이차전지|리튬|전고체|양극재|음극재|폐배터리|전력저장장치|LFP)/, /배터리|전지|리튬|양극|음극|전해|ESS/],
    ['로봇', /^(?:로봇|지능형로봇|휴머노이드|피지컬\s*AI|협동로봇)/, /로봇|휴머노이드|피지컬|액추에이터|엑추에이터/],
    ['우주항공', /^(?:우주|스페이스X|위성|누리호|항공우주)/, /우주|위성|발사체|누리호|스페이스X|메탄엔진/],
    ['원전', /^(?:원자력|원전|SMR)/, /원전|원자력|SMR|APR1400/],
    ['전력설비', /^(?:전력설비|전력$|전선|변압기|초고압)/, /전력|변압기|전선|송전|배전|버스덕트/],
    ['광통신', /^(?:광통신|통신·광부품)/, /광통신|광섬유|광케이블|광모듈|CPO|트랜시버/],
    ['바이오', /^(?:바이오(?!인식|매스|연료|플라스틱)|면역항암제|치매|알츠하이머|유전자\s*치료제|비만\s*치료제|mRNA|줄기세포|바이오시밀러|탈모\s*치료|항암|신약|제약|코로나|백신|고령화|당뇨|CMO|ADC|RNA|진단키트|의약품)/i,
        /임상|신약|FDA|항체|플랫폼|기술\s*이전|치료제|백신|RNA|ADC|바이오|허가|제약|의약|항암|특허/],
    ['조선', /^(?:조선)/, /조선|선박|LNG선|컨선|해운/],
    ['방산', /^(?:방위산업|방산)/, /방산|방위|국방|미사일/],
    ['양자', /^(?:양자)/, /양자/],
    ['자동차·부품', /^(?:자동차)/, /자동차|전장|완성차/],
    ['스마트폰 부품', /^(?:카메라모듈|스마트폰|폴더블)/, /폴더블|스마트폰|카메라모듈|UTG/],
    ['철강', /^(?:철강)/, /철강|강관|특수강/],
    ['건설', /^(?:건설)/, /건설|분양/],
];
// 테마로 쓰지 않는 태그 / 독자에게 보여줘도 정보가 없는 태그
const JUNK_THEME = /^(?:|-|뉴스|거래량|거래대금|공시|테마|기타|관련|이슈|구성|주요종목|현장|보도|동반|투자|우선|대표|저유동성|보통|발표|리포트|우선주|관리종목|투자주의|단기과열)$|신규\s*상장|기업인수목적|SPAC|스팩/i;
const DISPLAY_JUNK = /^(?:애국|재택근무|공매도|소매유통|코리아 밸류업 지수|밸류업)$/;
// 기사 배경끼리 같은 이야기인지 볼 때 무시하는 흔한 말
const COMMON_WORDS = /^(?:美|미국|中|중국|韓|한국|투자|기대|기대감|확대|소식|수혜|관련|발표|가능성|전망|강세|상승|증가|부각|계약|공급|체결|국내|글로벌|시장|사업|추진|규모|억|조)$/;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function themeShort(t) { return String(t || '').replace(/\s*[\(（][^)）]*[\)）]/g, '').split('/')[0].trim(); }
function familyOf(name) {
    const s = String(name || '').trim();
    for (const [label, re] of FAMILIES) if (re.test(s)) return label;
    // "통신장비·광통신", "AI·로봇·광통신" 같은 묶음 이름은 계열이 있는 쪽으로
    const parts = s.split(/\s*[·,]\s*/).filter(Boolean);
    if (parts.length > 1) for (const part of parts) for (const [label, re] of FAMILIES) if (re.test(part)) return label;
    return s;
}
function keywordsOf(label) {
    const f = FAMILIES.find(x => x[0] === label);
    if (f) return f[2];
    return new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
function rowTheme(row) {
    // "보안주(정보보안 등)" → "보안" — 상류 그룹 이름("보안주 테마 N종목")과 같은 열쇠가 되게
    const tags = [].concat(row.theme_tags || [], row.theme_tag || []).map(themeShort)
        .map(t => /[^지우]주$/.test(t) && Array.from(t).length > 2 ? t.slice(0, -1) : t).filter(t => t && !JUNK_THEME.test(t));
    return tags[0] || '';
}
// 상류 그룹 이름 정리: "반도체주" → "반도체", "2차전지주" → "2차전지", "반도체 대표주" → "반도체"
function cleanGroupName(s) {
    let n = String(s || '').trim().replace(/\s*(?:관련주|대표주|그룹주)$/, '').replace(/(?:주|株)$/, '').trim();
    if (/지$/.test(n) && /지주$/.test(String(s))) n = String(s).trim();   // '지주'는 그대로
    n = n.replace(/\s*(?:중소형|대표)$/, '').trim();
    if (Array.from(n).length < 2 || JUNK_THEME.test(n) || /급등에/.test(n)) return '';
    return n;
}
// 우선주는 보통주와 같은 회사로 센다: "두산퓨얼셀2우B" → "두산퓨얼셀"
function companyOf(name, names) {
    const n = String(name || '');
    const m = n.match(/^(.+?)(\d?우[A-C]?|우\(전환\))$/);
    if (!m) return n;
    return /\d|[A-C]|\(/.test(m[2]) || (names && names.has(m[1])) ? m[1] : n;
}

// ── 가격 ──
// KRX 호가단위(2023~ 코스피·코스닥 공통)
function tick(p) { return p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000; }
function limitPrice(prev) { const raw = prev * 1.3, t = tick(raw); return Math.floor(raw / t + 1e-9) * t; }
function snapPrice(p) { const t = tick(p); return Math.round(p / t) * t; }
/** 상한가 여부 — 종가와 (전일 종가 또는 등락률로 역산한 전일 종가)로 상한가를 계산해 비교 */
function isLimitUp(close, rate, prevClose) {
    close = num(close); rate = num(rate);
    if (rate < 29) return false;                                   // 표시 등락률과 어긋나는 상한가는 없다
    if (!(close > 0)) return rate >= LIMIT_UP;                     // 종가가 없으면 등락률로만
    // 전일 종가는 표시 등락률과 맞을 때만 쓴다(액면병합 등으로 단위가 다른 종가 제외), 아니면 등락률로 역산
    const ok = prevClose > 0 && Math.abs((close / prevClose - 1) * 100 - rate) <= RATE_TOLERANCE;
    const prev = ok ? prevClose : snapPrice(close / (1 + rate / 100));
    return close >= limitPrice(prev);
}

// ── 사유 ──
function trustedSource(row) {
    if (row.reason_status === 'edited' || row.reason_source === 'admin') return true;
    if (row.reason_source === 'news_extract' || row.reason_source === 'news_headline') return true;
    if (row.reason_origin === 'news' || row.reason_origin === 'toss') return true;
    return row.reason_source === 'llm' && Array.isArray(row.reason_evidence) && row.reason_evidence.length > 0;
}
const REPAIRS = [
    [/(액면병합|주식병합|감자|분할)\s*마친,\s*거래\s*재개일?$/, '$1 후 거래 재개'],
    [/\s*[-–]\s*(?:iM|SK|하나|신영|흥국|IBK|KB|NH|미래|삼성|한투|키움|대신|유안타|DB)?證$/, ''],
    [/\s*\((?:[가-힣A-Za-z]+(?:증권|證)|iM|SK|하나|신영|흥국|IBK|KB|NH|키움|대신)\)$/, ''],
    [/\s+/g, ' '],
];
const BAD_REASON = [
    /[?？]|\[[^\]]*$|\s·|·\s*$/,                                          // 의문형·잘린 제목·깨진 이어붙임
    /(?:끝나나|되나|하나요|있나|없나|일까|할까|될까|는가|이유는|이유|왜)$/,    // 물음으로 끝나는 제목
    /(?:는데|지만|으며|이며|하며|에서|으로|에게|부터|비결은|받는|하는|되는|있는|없는|앞두고)$/,   // 이어지다 잘린 제목
    /거래(?:량|대금)\s*1위|\d+\s*만\s*원\s*(?:선\s*)?돌파/,                     // 결과·가격 서술
    /[가-힣](?<!결|효|성|통|초|부|사|학|교)(?:과|와)$/,                       // "…다락손라십과" (결과·효과 등은 제외)
    /에\s*\S+주$/,                                                         // "…호황 전망에 반도체주"
    /연체|반대매매|상폐\s*위기|불확실|하단도|못\s*(?:모아|지켰)|공개\s*매수\s*0주|혼조|희비|변수까지|먹힐까|코넥스행|빨간불|적자\s*난/,
    /저평가|고평가|밸류에이션|재평가|증권가|투자의견|리포트\s*한\s*장|증권.{0,8}(?:전망|평가|분석)|(?:IBK|KB|NH|iM|키움|하나|신한|미래에셋|삼성|대신|유안타|한국투자)\s*(?:투자)?증권/,
    /^(?:국내\s*)?(?:증시|코스피|코스닥)\s*(?:반등|혼조|상승|하락|강세)/,   // 시장 전체 서술
    /^\d[\d,.]*\s*(?:만|천)?\s*원\s*(?:선|대)?\s*(?:돌파|회복|안착|진입|터치)$/,   // 가격대 서술
    /신고가|상한가|급등세?$|강세$/,                                        // 결과 서술
    /^(?:美|미국|中|중국)?\s*훈풍$/,
    /[가-힣](?:은|는|던|온|단|친|킨|낸|른),\s/,                            // 잘린 수식어 ("급한불 끄는, …")
    /상여금|주가\s*따로/,
];
function cleanReason(text) {
    let t = String(text || '').trim();
    for (const [re, to] of REPAIRS) t = t.replace(re, to);
    return t.trim();
}
function goodReason(text) {
    const t = String(text || '');
    if (Array.from(t.replace(/\s/g, '')).length < 4) return false;
    return !BAD_REASON.some(re => re.test(t));
}
// 상류 그룹 사유 → { name, catalyst, kind }
function parseGroup(text) {
    const t = String(text || '').trim();
    let m = t.match(/^(.+?)\s*(테마|업종)\s*\d+\s*종목\s*동반\s*(?:상승|강세|급등)$/);
    if (m) return { name: cleanGroupName(m[1]), catalyst: '', kind: m[2] === '업종' ? 'sector' : 'theme' };
    m = t.match(/^(.+?)\s*\d+\s*종목\s*동반\s*(?:상승|강세|급등)$/);
    if (m) return { name: cleanGroupName(m[1]), catalyst: '', kind: 'theme' };
    m = t.match(/^(.+?)\s*동반\s*(?:강세|상승|급등)(?:\s*[—–]\s*(.+))?$/);
    if (m) {
        const cat = cleanReason(String(m[2] || '').replace(/\s*소식$/, ''));
        return { name: cleanGroupName(m[1]), catalyst: cat && goodReason(cat) && !FORBIDDEN.test(cat) ? cat : '', kind: 'theme' };
    }
    return null;
}
function isSpac(row) { return /스팩|SPAC/i.test(String(row.name || '')) || /기업인수목적/.test(String(row.theme_tag || '')); }
function listingSign(row) {
    // 신규상장 태그(반기 단위) 또는 영문이 섞인 새 형식 종목코드(0161M0 등) — 최근 상장 종목
    return [row.theme_tag, row.theme].concat(row.theme_tags || []).some(t => /신규\s*상장/.test(String(t || ''))) ||
        row.reason_kind === 'ipo' || /[A-Z]/.test(String(row.ticker || ''));
}
// 상장 첫날 — 전 거래일 종가가 없는 종목만(상장 이튿날부터는 가격제한폭 ±30%가 적용된다)
function listingDay(row, leader, prevCloses) {
    if (prevCloses && prevCloses.get(row.ticker) > 0) return false;
    if (leader && leader.ticker === row.ticker && leader.listing_day) return true;
    if (num(row.change_rate) <= PRICE_LIMIT || /^정리매매/.test(String(row.rise_reason || ''))) return false;
    return listingSign(row);
}

/** 하루 → 행 정리   ctx: { leader, prevCloses: Map(ticker → 전 거래일 종가) } */
function rowsOf(day, ctx = {}, extraRows) {
    if (ctx && (ctx.ticker || ctx.name)) ctx = { leader: ctx };     // 이전 호출 형태(rowsOf(day, leader)) 호환
    const leader = ctx.leader || null, prevCloses = ctx.prevCloses || null, altRates = (day && day._altRates) || null;
    const seen = new Map();
    for (const r of ((day && day.rankings) || []).concat(extraRows || [])) {
        if (!r || !/^[0-9A-Z]{6}$/.test(r.ticker || '') || !r.name || BLOCKED[r.ticker]) continue;
        if (!Number.isFinite(Number(r.change_rate)) || /^정리매매/.test(String(r.rise_reason || ''))) continue;
        if (!seen.has(r.ticker)) seen.set(r.ticker, r);   // 랭킹 행(사유·테마 포함)을 우선, 보충 행은 빠진 종목만
    }
    const names = new Set([...seen.values()].map(r => r.name));
    const out = [], abnormal = [];
    for (const row of seen.values()) {
        let rate = num(row.change_rate);
        if (rate < RISE || isSpac(row)) continue;
        // 거래가 전혀 없던 종목(거래정지 등)은 등락률이 의미 없다
        if (row.trading_value === 0 && row.trading_volume === 0) continue;
        const ipo = listingDay(row, leader, prevCloses);
        const close = num(row.close_price), prev = prevCloses && prevCloses.get(row.ticker);
        if (!ipo && rate > 30.05) {
            // 표기 등락률이 가격제한폭(30%)을 넘으면 바로잡는다 — 전일 종가로 다시 계산, 없으면 같은 종가의 시장 스냅샷 값
            const calc = close > 0 && prev > 0 ? (close / prev - 1) * 100 : NaN;
            const alt = altRates && altRates.get(row.ticker);
            if (calc >= RISE && calc <= 30.05) rate = Math.round(calc * 100) / 100;
            else if (alt && alt.close === close && alt.rate >= RISE && alt.rate <= 30.05) rate = alt.rate;
        }
        if (rate > PRICE_LIMIT && !ipo) { abnormal.push({ ticker: row.ticker, name: row.name, rate }); continue; }
        let reason = '', group = null;
        const d = Reason.display(row);
        if (!ipo && !d.unknown && trustedSource(row) && row.reason_kind !== 'analyst' && row.reason_kind !== 'related' &&
            !/^관련 보도:|^상장 첫날|공모가 대비/.test(d.text) && !FORBIDDEN.test(d.text)) {
            const text = cleanReason(d.text);
            group = parseGroup(text);
            if (group) { if (!group.name) group = null; }
            else if (goodReason(text)) reason = text;
        }
        const theme = rowTheme(row);
        out.push({
            row, ticker: row.ticker, name: row.name, company: companyOf(row.name, names), market: String(row.market || ''), rate,
            vol: num(row.trading_value), energy: num(row.trading_value) * Math.min(rate, RATE_CAP),
            theme, family: theme ? familyOf(theme) : '', sector: String(row.sector || '').trim(),
            reason, group, ipo, limit: !ipo && isLimitUp(close, rate, prev), high52: !!row.is_52w_high,
            flow: null, streak: 1,
        });
    }
    out.sort((a, b) => b.rate - a.rate || b.vol - a.vol || a.ticker.localeCompare(b.ticker));
    abnormal.sort((a, b) => b.rate - a.rate);
    return { rows: out, abnormal };
}

// 신규상장 대장은 상류 랭킹에 없을 수 있다(전일 종가 없음) — 캘린더 값으로 채운다
function rowsWithLeader(day, ctx, extraRows) {
    const leader = ctx && ctx.leader;
    const extra = (extraRows || []).slice();
    const prevCloses = ctx && ctx.prevCloses;
    if (leader && leader.ticker && leader.name && (leader.listing_day || listingSign(leader)) && !(prevCloses && prevCloses.get(leader.ticker) > 0) &&
        !((day && day.rankings) || []).concat(extra).some(r => r && r.ticker === leader.ticker))
        extra.push({ ticker: leader.ticker, name: leader.name, change_rate: Math.max(num(leader.rate ?? leader.change_rate), PRICE_LIMIT + 0.01),
            trading_value: num(leader.vol ?? leader.trading_value), theme_tag: leader.theme || '', sector: leader.sector || '', rise_reason: '',
            reason_kind: 'ipo' });
    return rowsOf(day, ctx, extra);
}

// 기사 배경의 핵심어 — "알래스카 LNG 韓 투자 발표 가능성" → [알래스카, LNG]
function distinctiveWords(text) {
    return String(text || '').split(/[\s·,.'"“”‘’()]+/).map(w => w.replace(/[發株]$/, '')).filter(w => w && !COMMON_WORDS.test(w) &&
        (/[A-Z]{3,}/.test(w) || Array.from(w).length >= 3) && !/^\d/.test(w));
}

// 테마 태그가 업종과 동떨어진 경우 — 산업재·기술 계열 테마에 소비재·미디어 업종, 바이오 계열에 IT 업종
const TECH_FAMILIES = new Set(['반도체', '2차전지', '로봇', '우주항공', '원전', '전력설비', '광통신', '조선', '방산', '양자', '자동차·부품', '스마트폰 부품', '철강', '건설']);
function offSector(r) {
    const sec = r.sector || '';
    if (TECH_FAMILIES.has(r.family)) return /방송|엔터테인먼트|미디어|게임|화장품|식품|음료|섬유|의류|호텔|레저|교육|광고|출판|생물공학|제약/.test(sec);
    if (r.family === '바이오') return /반도체|소프트웨어|IT서비스|전자장비|디스플레이|통신장비|핸드셋|자동차|철강|건설|기계/.test(sec);
    return false;
}

/** 행 → 흐름(그룹) */
function flowsOf(rows) {
    const G = new Map();
    const get = (key, label, kind) => {
        if (!G.has(key)) G.set(key, { key, label, kind, core: [], extra: [], cats: [] });
        const g = G.get(key);
        if (kind === 'news' || (kind === 'theme' && g.kind === 'sector')) g.kind = kind;
        return g;
    };
    const companies = list => new Set(list.map(r => r.company)).size;
    const assigned = new Set();
    // ① 상류 그룹 사유(테마·기사 배경) — 같은 계열 이름으로
    for (const r of rows) {
        if (r.ipo || !r.group || r.group.kind === 'sector') continue;
        const key = familyOf(r.group.name);
        const g = get(key, key, r.group.catalyst ? 'news' : 'theme');
        g.core.push(r); assigned.add(r);
        if (r.group.catalyst) g.cats.push({ text: r.group.catalyst, energy: r.energy });
    }
    // ② 이유 없는 종목(업종 묶음 포함)은 테마 계열로 — 업종이 전혀 다른 종목(엔터사가 '로봇' 태그 등)은 빼고
    for (const r of rows) {
        if (assigned.has(r) || r.ipo || r.reason || !r.family || offSector(r)) continue;
        get(r.family, r.family, 'theme').core.push(r); assigned.add(r);
    }
    // 같은 회사(우선주)만으로는 흐름이 아니다 — 서로 다른 회사 수로 센다
    const qualifies = g => companies(g.core) >= 3 || (companies(g.core) >= 2 && g.cats.length > 0);
    // ③ 개별 이유가 있는 종목은 같은 계열이고 이유가 그 흐름을 가리키거나, 기사 배경의 핵심어를 공유할 때만 합류
    const open = [...G.values()].filter(g => g.kind !== 'sector' && qualifies(g));
    const catWords = new Map(open.map(g => [g, g.cats.flatMap(c => distinctiveWords(c.text))]));
    for (const r of rows) {
        if (assigned.has(r) || r.ipo || !r.reason) continue;
        const g = open.find(g => r.family === g.key && keywordsOf(g.key).test(r.reason)) || open.find(g => r.reason.includes(g.key)) ||
            open.find(g => catWords.get(g).some(w => r.reason.includes(w)));
        if (g) { g.extra.push(r); assigned.add(r); }
    }
    // 조건을 못 채운 묶음은 풀어서 다시 기회를 준다 — 기사 배경이 있던 종목은 그 배경을 개별 이유로
    for (const g of [...G.values()]) {
        if (qualifies(g)) continue;
        for (const r of g.core) {
            assigned.delete(r);
            if (!r.reason && r.group && r.group.catalyst) r.reason = r.group.catalyst;
        }
        G.delete(g.key);
    }
    // ④ 남은 업종 묶음 사유 → 업종 그룹
    for (const r of rows) {
        if (assigned.has(r) || r.ipo || r.reason || !r.group || r.group.kind !== 'sector') continue;
        get('업종:' + r.group.name, r.group.name + ' 업종', 'sector').core.push(r); assigned.add(r);
    }
    const flows = [];
    for (const g of G.values()) {
        if (!qualifies(g)) continue;
        const members = g.core.concat(g.extra).sort((a, b) => b.rate - a.rate || b.vol - a.vol);
        // 배경: 가장 많이 나온 기사 배경, 같으면 상승 에너지가 큰 종목의 것
        const tally = new Map();
        for (const c of g.cats) { const t = tally.get(c.text) || { text: c.text, n: 0, e: 0 }; t.n++; t.e = Math.max(t.e, c.energy); tally.set(c.text, t); }
        const cat = [...tally.values()].sort((a, b) => b.n - a.n || b.e - a.e)[0];
        const flow = { key: g.key, label: g.label, kind: g.kind, catalyst: cat ? cat.text : '', members, companies: companies(members),
            energy: members.reduce((s, r) => s + r.energy, 0), vol: members.reduce((s, r) => s + r.vol, 0),
            limitUps: members.filter(r => r.limit).length, streak: 1 };
        // 제목·머리말에 쓸 만한 흐름: 기사 배경이 있거나, 개별 이유가 있는 종목이 있거나, 4개사 이상
        flow.headliner = g.kind !== 'sector' && (!!flow.catalyst || members.some(r => r.reason) || flow.companies >= 4);
        members.forEach(r => { r.flow = flow; });
        flows.push(flow);
    }
    // 업종 묶음은 테마·기사 흐름 뒤로
    flows.sort((a, b) => (a.kind === 'sector') - (b.kind === 'sector') || b.energy - a.energy);
    return flows;
}

// ── 파일 ──
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function tradingDays(publicDir) {
    let isTrading = () => true;
    try { isTrading = require('./tg_common').isKrTradingDay; } catch (_) { /* 휴장일 판정 없이 */ }
    try { return fs.readdirSync(path.join(publicDir, 'data', 'rise-history')).filter(f => /^\d{8}\.json$/.test(f)).map(f => f.slice(0, 8)).filter(d => isTrading(d)).sort(); }
    catch (_) { return []; }
}
// 그날 종가 — 랭킹(close_price) 우선, 시장 스냅샷으로 보충
function closesOn(publicDir, date) {
    const out = new Map();
    try { for (const r of readJson(path.join(publicDir, 'data', 'rise-history', date + '.json')).rankings || []) if (r && r.ticker && num(r.close_price) > 0) out.set(r.ticker, num(r.close_price)); } catch (_) { /* 없음 */ }
    try {
        const mm = readJson(path.join(publicDir, 'data', 'marketmap', date + '.json'));
        if (String(mm.date) === String(date)) for (const it of mm.items || []) if (it && it.ticker && num(it.close_price) > 0 && !out.has(it.ticker)) out.set(it.ticker, num(it.close_price));
    } catch (_) { /* 없음 */ }
    return out;
}
function prevTradingDate(publicDir, date, days) {
    const list = (days || tradingDays(publicDir)).filter(d => d < date);
    return list[list.length - 1] || '';
}

/**
 * 같은 날 시장 스냅샷(marketmap)에만 있는 +10% 종목 — 상류 랭킹이 빠뜨린 종목을 보충한다.
 * 스냅샷 등락률은 기준가가 어긋난 날이 있어, 전 거래일 종가로 다시 계산해 맞는 종목만 쓴다.
 * 사유는 없고, 테마는 그 종목의 과거 급등 기록(stock-history)에서 가져온다.
 */
function snapshotExtras(publicDir, date, rankings, prevCloses) {
    try {
        const mm = readJson(path.join(publicDir, 'data', 'marketmap', date + '.json'));
        if (String(mm.date) !== String(date) || !Array.isArray(mm.items)) return [];
        const pc = prevCloses || closesOn(publicDir, prevTradingDate(publicDir, date));
        const have = new Set((rankings || []).map(r => r && r.ticker));
        const themeOf = t => {
            try { const ev = (readJson(path.join(publicDir, 'data', 'stock-history', t + '.json')).events || []).filter(e => e && e.theme_tag).slice(-1)[0]; return ev ? ev.theme_tag : ''; }
            catch (_) { return ''; }   // 기록 없는 종목
        };
        const out = [];
        for (const r of mm.items) {
            if (!r || !/^[0-9A-Z]{6}$/.test(r.ticker || '') || !r.name || have.has(r.ticker) || num(r.change_rate) < RISE) continue;
            const prev = pc.get(r.ticker), close = num(r.close_price);
            const row = { ticker: r.ticker, name: r.name, market: r.market || '', sector: r.sector || '', change_rate: num(r.change_rate),
                close_price: close, trading_value: num(r.trading_value), trading_volume: num(r.trading_volume),
                theme_tag: themeOf(r.ticker), rise_reason: '', reason_source: 'missing', news: [] };
            if (prev > 0 && close > 0 && Math.abs((close / prev - 1) * 100 - row.change_rate) <= RATE_TOLERANCE) out.push(row);
            // 전일 종가가 없는 가격제한폭 초과 종목 중 최근 상장 표시가 있는 종목 — 상장 첫날로 (등락률은 싣지 않는다)
            else if (!(prev > 0) && row.change_rate > PRICE_LIMIT && listingSign(row)) out.push(row);
        }
        return out;
    } catch (_) { return []; }
}
/** 하루 데이터에 보충 종목과 전 거래일 종가(_prevCloses)를 붙인다 */
function withSnapshot(publicDir, day, days) {
    if (!day || !Array.isArray(day.rankings)) return day;
    const pc = closesOn(publicDir, prevTradingDate(publicDir, String(day.date), days));
    const extra = snapshotExtras(publicDir, String(day.date), day.rankings, pc);
    // 같은 종목의 시장 스냅샷 값 — 랭킹 등락률이 가격제한폭을 넘을 때 대조용
    const alt = new Map();
    try {
        const mm = readJson(path.join(publicDir, 'data', 'marketmap', day.date + '.json'));
        if (String(mm.date) === String(day.date)) for (const it of mm.items || []) if (it && it.ticker && num(it.close_price) > 0) alt.set(it.ticker, { rate: num(it.change_rate), close: num(it.close_price) });
    } catch (_) { /* 스냅샷 없음 */ }
    return { ...day, rankings: extra.length ? day.rankings.concat(extra) : day.rankings, _prevCloses: pc, _altRates: alt };
}

/** 이전 거래일 스냅샷들(최근 → 과거), 확정본만 — 각 날의 대장·전일 종가까지 붙여서 */
function loadHistory(publicDir, date, n = 10) {
    const out = [];
    let cal = {};
    try { cal = readJson(path.join(publicDir, 'data', 'leaders-calendar.json')).days || {}; } catch (_) { /* 캘린더 없음 */ }
    const days = tradingDays(publicDir);
    for (const d of days.filter(x => x < date).reverse()) {
        if (out.length >= n) break;
        try {
            const day = readJson(path.join(publicDir, 'data', 'rise-history', d + '.json'));
            if (day && day.date === d && day.is_final === true && Array.isArray(day.rankings))
                out.push({ ...withSnapshot(publicDir, day, days), _leader: cal[d] && cal[d].stock ? cal[d].stock : null });
        } catch (_) { /* 깨진 파일은 건너뛴다 */ }
    }
    // 상류가 휴장일에 전 거래일을 복제한 경우(같은 랭킹) 연속으로 세지 않는다
    return out.filter((d, i) => !i || !sameRankings(d, out[i - 1]));
}
function sameRankings(a, b) {
    const k = d => (d.rankings || []).map(r => r.ticker + ':' + r.change_rate).sort().join('|');
    return !!a && !!b && k(a) === k(b);
}

/**
 * 하루 이야기
 *   day: rise-history 형식 { date, rankings, _prevCloses? }   opts: { leader, history: [이전 거래일 day…(최근순)], extraRows }
 */
function build(day, opts = {}) {
    const date = String((day && day.date) || '').replace(/\D/g, '').slice(0, 8);
    const leader = opts.leader || null;
    const history = (opts.history || []).filter(d => d && String(d.date) < date);
    const prevCloses = (day && day._prevCloses) || null;
    const { rows, abnormal } = rowsWithLeader(day, { leader, prevCloses }, opts.extraRows);
    const flows = flowsOf(rows);
    const inFlow = new Set(flows.flatMap(f => f.members));
    const solos = rows.filter(r => !inFlow.has(r) && r.reason && !r.ipo);
    const rest = rows.filter(r => !inFlow.has(r) && !r.reason && !r.ipo);
    // 과거 스냅샷에도 같은 규칙 — 그날의 대장까지 반영해야 '전일 N종목'이 그날 원고와 같다
    const pastRows = history.map(d => rowsWithLeader(d, { leader: d._leader || null, prevCloses: d._prevCloses || null }).rows);
    const prev = pastRows[0] || null;
    if (history.length) {
        // 종목 연속 상승(+10%↑)과 흐름 연속일
        // 신규상장일 등락률은 공모가 기준이 아니어서 연속 상승에 넣지 않는다
        const past = pastRows.map(rs => ({ tickers: new Set(rs.filter(r => !r.ipo).map(r => r.ticker)), flows: new Set(flowsOf(rs).map(f => f.key)) }));
        for (const r of rows) { let s = 1; for (const p of past) { if (p.tickers.has(r.ticker)) s++; else break; } r.streak = s; }
        for (const f of flows) { let s = 1; for (const p of past) { if (p.flows.has(f.key)) s++; else break; } f.streak = s; }
    }
    const listed = rows.filter(r => !r.ipo);
    const story = {
        date, rows, abnormal, flows, solos, rest,
        hot: listed.filter(r => r.rate >= HOT), limitUps: listed.filter(r => r.limit), ipos: rows.filter(r => r.ipo), high52: listed.filter(r => r.high52),
        money: listed.slice().sort((a, b) => b.vol - a.vol).slice(0, 5).filter(r => r.vol > 0),
        continuing: listed.filter(r => r.streak >= 2).sort((a, b) => b.streak - a.streak || b.rate - a.rate),
        explained: rows.filter(r => r.reason || (r.flow && r.flow.catalyst)).length,
        prevHot: prev ? prev.filter(r => !r.ipo && r.rate >= HOT).length : null,
        prevDate: history[0] ? String(history[0].date) : '',
        leader: leaderOf(leader, rows, abnormal, prevCloses),
    };
    story.headline = headline(story);
    return story;
}
function leaderOf(leader, rows, abnormal, prevCloses) {
    if (!leader || !leader.name) return null;
    const r = rows.find(x => x.ticker === leader.ticker);
    const rate = r ? r.rate : num(leader.rate ?? leader.change_rate);
    // 목록에 없는 대장의 등락률이 가격제한폭을 넘으면: 전일 종가가 없으면 신규상장, 있으면 거래 재개(기준가 변경)
    const odd = !r && rate > PRICE_LIMIT, hadPrev = !!(prevCloses && prevCloses.get(leader.ticker) > 0);
    // 숫자는 같은 날 목록(날짜별 페이지와 동일)의 값을 쓴다 — 캘린더 값과 소수점이 다를 수 있음
    return { ticker: leader.ticker, name: leader.name, rate,
        vol: r && r.vol ? r.vol : num(leader.vol ?? leader.trading_value),
        ipo: !!(r && r.ipo) || (!r && !!leader.listing_day && !hadPrev) || (odd && !hadPrev), row: r || null,
        resumed: (!r && (abnormal || []).some(a => a.ticker === leader.ticker)) || (odd && hadPrev) };
}

// ── 표현 ──
// 소수 첫째 자리 반올림(사람이 읽는 방식: 11.35 → 11.4, 16.25 → 16.3) — 부동소수 오차 없이 10진 문자열 기준
function round1(v) { const n = num(v), a = Math.round(Number(Math.abs(n) + 'e1')) / 10; return n < 0 ? -a : a; }
function pct(v) { const n = round1(v); return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
// 종목 등락률 표기 — 상한가인데 표기 등락률이 30%를 넘으면(기준가 차이) 숫자 대신 '상한가'
function rateOf(r) { return r && r.limit && round1(r.rate) > 30 ? '상한가' : pct(r ? r.rate : 0); }
function amount(won) {
    const v = num(won);
    if (v >= 1e12) return (Math.round(v / 1e11) / 10).toLocaleString('ko-KR') + '조';
    if (v >= 1e8) return Math.round(v / 1e8).toLocaleString('ko-KR') + '억';
    return '';
}
// 받침에 맞는 조사 — 한글은 받침으로, 영문·숫자는 읽는 소리로 ("형지I&C가", "루트K가", "SK가", "LG가")
function josa(word, withBatchim, without) {
    const w = String(word || '').trim(), c = w.slice(-1), code = c.charCodeAt(0);
    let batchim;
    if (code >= 0xAC00 && code <= 0xD7A3) batchim = (code - 0xAC00) % 28 !== 0;
    else if (/[LMNR]/i.test(c)) batchim = true;                 // 엘·엠·엔·알
    else if (/[0136780]/.test(c)) batchim = true;              // 영·일·삼·육·칠·팔
    else batchim = false;
    // '로/으로'는 ㄹ 받침이면 '로'
    if (withBatchim === '으로' && code >= 0xAC00 && code <= 0xD7A3 && (code - 0xAC00) % 28 === 8) batchim = false;
    return w + (batchim ? withBatchim : without);
}
// 흐름 머리 이름 — 업종 묶음은 '○○ 업종'
function flowTitle(f) { return f.label; }
// 오늘을 한 줄로: "광통신·우주항공 강세"
function headline(s) {
    const top = s.flows.filter(f => f.headliner).slice(0, 2);
    if (top.length) return top.map(flowTitle).join('·') + ' 강세';
    if (s.rows.length) return '뚜렷한 테마 없이 개별 종목 장세';
    return '';
}
// 종목 한 줄의 '왜' — 같은 날 확인된 개별 이유, 없으면 흐름의 기사 배경. 근거 없는 말은 붙이지 않는다
function whyOf(r) {
    if (r.reason) return r.reason;
    if (r.flow && r.flow.kind !== 'sector' && r.flow.catalyst) return r.flow.label + ' 강세 · ' + r.flow.catalyst;
    return '';
}
// 이유가 없을 때 보여줄 분류(테마) — 이유 자리가 아니라 '· ○○ 테마'로 쓴다
function tagOf(r) {
    const t = r.family || r.theme;
    return t && !DISPLAY_JUNK.test(t) ? t : '';
}
function clip(s, n) { const a = Array.from(String(s || '')); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); }

/** 기간(주·월) 요약 — 매일의 흐름을 모아 '자주 주도한 흐름'과 '자주 오른 종목' */
function period(days) {
    const flowDays = new Map(), stockDays = new Map();
    let hot = 0, limit = 0, tradingDays = 0;
    for (const day of days) {
        const s = build(day, { leader: day._leader || null });
        if (!s.rows.length && !(day.rankings || []).length) continue;
        tradingDays++;
        hot += s.hot.length; limit += s.limitUps.length;
        for (const f of s.flows) {
            if (!f.headliner) continue;
            const x = flowDays.get(f.key) || { label: f.label, days: 0, members: 0, energy: 0 };
            x.days++; x.members += f.members.length; x.energy += f.energy; flowDays.set(f.key, x);
        }
        for (const r of s.rows) {
            if (r.ipo) continue;
            const x = stockDays.get(r.ticker) || { name: r.name, days: 0, best: 0 };
            x.days++; x.best = Math.max(x.best, r.rate); stockDays.set(r.ticker, x);
        }
    }
    return {
        tradingDays, hot, limit,
        flows: [...flowDays.values()].sort((a, b) => b.days - a.days || b.energy - a.energy),
        repeat: [...stockDays.values()].filter(x => x.days >= 2).sort((a, b) => b.days - a.days || b.best - a.best),
    };
}

module.exports = {
    RISE, HOT, LIMIT_UP, PRICE_LIMIT, FORBIDDEN, FAMILIES,
    build, period, loadHistory, snapshotExtras, withSnapshot, closesOn, prevTradingDate, rowsOf, flowsOf, parseGroup, cleanReason, goodReason,
    familyOf, themeShort, companyOf, isLimitUp, limitPrice, tick, headline, whyOf, tagOf, josa, flowTitle, pct, rateOf, round1, amount, clip,
};
