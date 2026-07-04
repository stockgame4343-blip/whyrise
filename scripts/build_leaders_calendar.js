/**
 * 일자별 '오늘의 대장' 3종(대장주/대장섹터/대장테마) precompute
 *   → public/data/leaders-calendar.json  (캘린더(샘플2)가 읽는 작은 인덱스)
 *
 * stock-rise 일별 랭킹 JSON(약 334KB×수십일)을 클라가 통째로 받지 않도록 빌드 때 미리 계산한다.
 * 대장 산출 로직은 public/js/report.js 의 pickLeader/buildGroups 와 동일(결과 일치 목적).
 *
 *   node scripts/build_leaders_calendar.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const RAW = 'https://raw.githubusercontent.com/stockgame4343-blip/stock-rise/master/public/data';
const OUT = path.resolve(__dirname, '..', 'public', 'data', 'leaders-calendar.json');
const RISE_DIR = path.resolve(__dirname, '..', 'public', 'data', 'rise-history');  // 백필 날짜별 (4/13 이전)
const MM_DIR = path.resolve(__dirname, '..', 'public', 'data', 'marketmap');       // 일자별 대형주 스냅샷 — +5%대 대장 후보 공급

// report.js / report-core.js 와 동일 상수
const BLOCKED = { '003060': 1, '018700': 1, '007460': 1 };
const RISE_CUTOFF = 15;
// ── 대장주 황금식 (2026-07 개편) ──
// 점수(상승 에너지) = 거래대금(원) × 상승률(%, 30캡). 컷 계단(+15% 등) 없이 단일 곱셈으로
// "상승에 실린 돈"이 가장 큰 종목이 대장 — 거래대금 2배 = 상승률 2배 등가.
const LEADER_MIN_RATE = 5;        // 후보 최소 상승률(%) — 이 밑은 대장 자격 없음
const LEADER_MIN_SCORE = 8e12;    // 최소 상승 에너지(원×%) — 예: 3,000억×+27% ≈ 1조×+8%. 미달이면 그날 대장 없음
const LEADER_RATE_CAP = 30;       // 대장주 비교용 상승률 캡(%). +30% 초과(이벤트성)는 비교에서만 캡, 후보는 유지
const GROUP_MIN = 3;

function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
// 대장주 비교 전용: 상승률을 LEADER_RATE_CAP(=30%)로 상한 (report.js capRate 와 동일).
function capRate(r) { return Math.min(num(r && r.change_rate), LEADER_RATE_CAP); }

function themeTags(row) {
    var out = [], seen = {};
    function add(v) { v = String(v || '').trim(); if (!v || seen[v]) return; seen[v] = 1; out.push(v); }
    if (Array.isArray(row && row.theme_tags)) row.theme_tags.forEach(add);
    add(row && row.theme_tag);
    return out;
}
function themeOf(row) { var t = themeTags(row); return t.length ? t[0] : ''; }

function isActive(row, cutoff) {
    if (!row || !row.ticker || BLOCKED[row.ticker]) return false;
    return num(row.change_rate) >= cutoff;
}

function buildGroups(rows, type) {
    var by = {};
    rows.forEach(function (row) {
        var keys = type === 'theme' ? themeTags(row) : [String(row.sector || '').trim()];
        var rowSeen = {};
        keys.forEach(function (key) {
            if (!key || rowSeen[key]) return;
            rowSeen[key] = 1;
            if (!by[key]) by[key] = { key: key, count: 0, sumRate: 0, totalVolume: 0, _t: {}, top: '', topRate: -1 };
            if (by[key]._t[row.ticker]) return;
            by[key]._t[row.ticker] = 1;
            by[key].count += 1;
            by[key].sumRate += num(row.change_rate);
            by[key].totalVolume += num(row.trading_value);
            // 그룹 내 '대장' = 상승률 최고(동률은 거래대금)
            var cr = num(row.change_rate);
            if (cr > by[key].topRate) { by[key].topRate = cr; by[key].top = row.name; }
        });
    });
    return Object.keys(by).map(function (k) {
        var g = by[k]; g.avgRate = g.count ? g.sumRate / g.count : 0; return g;
    }).filter(function (g) { return g.count >= GROUP_MIN; })
      .sort(function (a, b) {
          return b.count - a.count || b.avgRate - a.avgRate || b.totalVolume - a.totalVolume;
      });
}

// 상승 에너지 — 대장주 점수 그 자체 (원 × %)
function leaderEnergy(r) { return num(r && r.trading_value) * capRate(r); }

// extraRows: 급등 랭킹 밖 후보(marketmap 대형주 +5%대 등).
// ticker 중복 시 상승 에너지 큰 쪽 '숫자'를 신뢰(랭킹 원본의 거래대금 결손 방어 — 예: 20260506 삼성전자
// 거래대금이 랭킹엔 80억, marketmap 엔 14.1조), 상승이유·테마 등 서술 필드는 랭킹 쪽을 유지한다.
function pickLeader(rows, extraRows) {
    var byTicker = {};
    var order = [];
    (rows || []).concat(extraRows || []).forEach(function (r) {
        if (!r || !r.ticker || BLOCKED[r.ticker]) return;
        if (!(num(r.change_rate) >= LEADER_MIN_RATE && num(r.trading_value) > 0)) return;
        var prev = byTicker[r.ticker];
        if (!prev) { byTicker[r.ticker] = r; order.push(r.ticker); return; }
        if (leaderEnergy(r) > leaderEnergy(prev)) {
            byTicker[r.ticker] = Object.assign({}, prev, {
                change_rate: r.change_rate,
                trading_value: r.trading_value,
                close_price: r.close_price != null ? r.close_price : prev.close_price,
                market_cap: r.market_cap != null ? r.market_cap : prev.market_cap,
            });
        }
    });
    var pool = order.map(function (t) { return byTicker[t]; });
    if (!pool.length) return null;
    // 상승률은 캡값으로 비교 — +500% 이벤트 종목도 +30%로 환산돼 대장 독식 방지.
    pool.sort(function (a, b) {
        return leaderEnergy(b) - leaderEnergy(a) ||
            num(b.trading_value) - num(a.trading_value) ||
            capRate(b) - capRate(a);
    });
    if (leaderEnergy(pool[0]) < LEADER_MIN_SCORE) return null;   // 에너지 미달 → 그날은 대장주 없음
    return pool[0];
}

// 일자별 marketmap 스냅샷 → 대장 후보 행(+4%↑ — 후보 컷 5% 직전까지). 파일 없으면 [] (2025-04 이전 등).
function loadMarketRows(date) {
    try {
        var data = JSON.parse(fs.readFileSync(path.join(MM_DIR, date + '.json'), 'utf8'));
        return ((data && data.items) || []).filter(function (it) {
            return it && it.ticker && num(it.change_rate) >= 4;
        }).map(function (it) {
            return {
                ticker: it.ticker, name: it.name, market: it.market || '',
                sector: it.sector || '', rise_reason: '',
                change_rate: it.change_rate, close_price: it.close_price,
                trading_value: it.trading_value,
                market_cap: num(it.market_cap) * 1e8,   // 억원 → 원
            };
        });
    } catch (e) { return []; }
}

// rankings 행 배열 → 그날 대장 3종 (stock-rise·rise-history 공통)
function leadersFromRows(rk, extraRows) {
    rk = rk || [];
    var active = rk.filter(function (r) { return isActive(r, RISE_CUTOFF); });
    var sectors = buildGroups(active, 'sector');
    var themes = buildGroups(active, 'theme');
    var leader = pickLeader(rk, extraRows);
    return {
        stock: leader ? {
            ticker: leader.ticker, name: leader.name, rate: Math.round(num(leader.change_rate) * 10) / 10,
            market: String(leader.market || '').trim(),
            sector: String(leader.sector || '').trim(), theme: themeOf(leader),
            vol: Math.round(num(leader.trading_value)), reason: String(leader.rise_reason || '').trim(),
        } : null,
        sector: sectors[0] ? {
            name: sectors[0].key, count: sectors[0].count,
            avgRate: Math.round(sectors[0].avgRate * 10) / 10, top: sectors[0].top,
            vol: Math.round(sectors[0].totalVolume),
        } : null,
        theme: themes[0] ? {
            name: themes[0].key, count: themes[0].count,
            avgRate: Math.round(themes[0].avgRate * 10) / 10, top: themes[0].top,
            vol: Math.round(themes[0].totalVolume),
        } : null,
    };
}

function fetchJson(url) {
    return new Promise(function (resolve, reject) {
        https.get(url, { headers: { 'User-Agent': 'whyrise-build' } }, function (res) {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

async function main() {
    // 누적(merge) — 기존 캘린더를 읽어 두고 새 날짜만 계산해 합친다.
    // stock-rise 데이터는 무한 보관이라 dates.json 이 날마다 길어진다(시작일 2026-04-13).
    // 매 빌드에서 누적 전체를 다시 받으면 시간이 갈수록 무거워지므로, 이미 가진 옛 날은 건너뛰고
    // (merge 가 보존) 새 날 + 최근 2일(정정·장중갱신 반영)만 fetch 한다. → 시간이 지날수록 1년치에 수렴.
    var existing = {};
    // --rebuild: 누적 캐시 무시하고 전 일자 재계산 — 대장 산출 로직이 바뀐 뒤 1회 실행용
    const REBUILD = process.argv.includes('--rebuild');
    if (!REBUILD) {
        try { existing = (JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}).days || {}; } catch (e) { existing = {}; }
    }
    const have = new Set(Object.keys(existing));
    const dates = await fetchJson(RAW + '/dates.json');
    if (!Array.isArray(dates) || !dates.length) throw new Error('no dates');
    const refresh = new Set(dates.slice().sort().slice(-2)); // 최근 2거래일은 항상 재계산
    const days = {};
    let skipped = 0;
    for (const d of dates) {
        if (have.has(d) && !refresh.has(d)) { skipped++; continue; }  // 이미 보유한 옛 날 → fetch 생략(merge 가 유지)
        try {
            const day = await fetchJson(RAW + '/' + d + '.json');
            days[d] = leadersFromRows(day.rankings || [], loadMarketRows(d));
            console.log(d, '|주:', days[d].stock && days[d].stock.name, '|섹:', days[d].sector && days[d].sector.name, '|테:', days[d].theme && days[d].theme.name);
        } catch (e) {
            console.error('  skip', d, e.message);
        }
    }

    // 백필(stock-rise 미커버 = 4/13 이전) — 로컬 rise-history 로 과거 대장 계산. 네트워크 불필요.
    const srMin = dates.slice().sort()[0];   // stock-rise 최소일 (≈20260413)
    let backfilled = 0;
    try {
        const localFiles = fs.readdirSync(RISE_DIR).filter(function (f) { return /^\d{8}\.json$/.test(f); });
        for (const f of localFiles) {
            const d = f.slice(0, 8);
            if (d >= srMin) continue;                          // stock-rise 가 커버 → 위에서 처리됨
            if (have.has(d) && !refresh.has(d)) { skipped++; continue; }  // 이미 보유 → merge 가 유지
            try {
                const day = JSON.parse(fs.readFileSync(path.join(RISE_DIR, f), 'utf8'));
                days[d] = leadersFromRows(day.rankings || [], loadMarketRows(d));
                backfilled++;
            } catch (e) { console.error('  skip(local)', d, e.message); }
        }
        console.log('백필 대장 계산:', backfilled, '일 (rise-history, <' + srMin + ')');
    } catch (e) {
        console.error('rise-history dir 없음:', e.message);
    }
    // 기존 + 신규 합치기(신규가 같은 날짜는 갱신, 기존-only 옛 날짜는 보존 → 누적)
    const mergedDays = Object.assign({}, existing, days);
    const payload = { built_at: new Date().toISOString().slice(0, 19), days: mergedDays };
    fs.writeFileSync(OUT, JSON.stringify(payload), 'utf8');
    const before = Object.keys(existing).length, after = Object.keys(mergedDays).length;
    console.log('\nwrote', OUT, '—', after, 'days (기존', before, '+ 신규계산', Object.keys(days).length, ', 옛날 fetch생략', skipped, '→ 누적', after, ')');
}

// 직접 실행(node build_leaders_calendar.js)일 때만 빌드. require 로 불러쓸 땐 함수만 노출(텔레그램 봇 등 재사용).
if (require.main === module) {
    main().catch(function (e) { console.error(e); process.exit(1); });
}

module.exports = {
    leadersFromRows, buildGroups, pickLeader, loadMarketRows, leaderEnergy, themeOf, themeTags, isActive,
    fetchJson, num, capRate,
    RISE_CUTOFF, LEADER_MIN_RATE, LEADER_MIN_SCORE, GROUP_MIN, RAW,
};
