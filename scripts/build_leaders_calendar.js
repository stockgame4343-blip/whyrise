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

// report.js 와 동일 상수
const BLOCKED = { '003060': 1, '018700': 1, '007460': 1 };
const RISE_CUTOFF = 15;
const LEADER_CUTOFF = 20;
const GROUP_MIN = 3;

function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

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

function pickLeader(rows) {
    var cands = (rows || []).filter(function (r) {
        return !BLOCKED[r.ticker] && num(r.change_rate) >= LEADER_CUTOFF && num(r.trading_value) > 0;
    });
    if (!cands.length) return null;
    var maxVol = Math.max.apply(null, cands.map(function (r) { return num(r.trading_value); }));
    var peers = cands.filter(function (r) { return num(r.trading_value) >= maxVol * 0.7; });
    var maxChg = Math.max.apply(null, peers.map(function (r) { return num(r.change_rate); }));
    function score(r) {
        var v = maxVol > 0 ? num(r.trading_value) / maxVol : 0;
        var c = maxChg > 0 ? num(r.change_rate) / maxChg : 0;
        return v * 70 + c * 30;
    }
    peers.sort(function (a, b) {
        return score(b) - score(a) ||
            num(b.trading_value) - num(a.trading_value) ||
            num(b.change_rate) - num(a.change_rate);
    });
    return peers[0];
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
    try { existing = (JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}).days || {}; } catch (e) { existing = {}; }
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
            const rk = day.rankings || [];
            const active = rk.filter(function (r) { return isActive(r, RISE_CUTOFF); });
            const sectors = buildGroups(active, 'sector');
            const themes = buildGroups(active, 'theme');
            const leader = pickLeader(rk);
            days[d] = {
                stock: leader ? {
                    ticker: leader.ticker, name: leader.name, rate: Math.round(num(leader.change_rate) * 10) / 10,
                    sector: String(leader.sector || '').trim(), theme: themeOf(leader),
                } : null,
                sector: sectors[0] ? {
                    name: sectors[0].key, count: sectors[0].count,
                    avgRate: Math.round(sectors[0].avgRate * 10) / 10, top: sectors[0].top,
                } : null,
                theme: themes[0] ? {
                    name: themes[0].key, count: themes[0].count,
                    avgRate: Math.round(themes[0].avgRate * 10) / 10, top: themes[0].top,
                } : null,
            };
            console.log(d, '|주:', days[d].stock && days[d].stock.name, '|섹:', days[d].sector && days[d].sector.name, '|테:', days[d].theme && days[d].theme.name);
        } catch (e) {
            console.error('  skip', d, e.message);
        }
    }
    // 기존 + 신규 합치기(신규가 같은 날짜는 갱신, 기존-only 옛 날짜는 보존 → 누적)
    const mergedDays = Object.assign({}, existing, days);
    const payload = { built_at: new Date().toISOString().slice(0, 19), days: mergedDays };
    fs.writeFileSync(OUT, JSON.stringify(payload), 'utf8');
    const before = Object.keys(existing).length, after = Object.keys(mergedDays).length;
    console.log('\nwrote', OUT, '—', after, 'days (기존', before, '+ 신규계산', Object.keys(days).length, ', 옛날 fetch생략', skipped, '→ 누적', after, ')');
}

main().catch(function (e) { console.error(e); process.exit(1); });
