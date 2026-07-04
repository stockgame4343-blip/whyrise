/**
 * ORGO 리포트 공용 파생 로직.
 * 리포트와 랜딩이 같은 입력에서 같은 대장주·주도 섹터·핫 테마를 내도록 한곳에서 관리한다.
 */
var WhyReportCore = (function () {
    'use strict';

    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };
    var RISE_CUTOFF = 15;
    // ── 대장주 황금식 (2026-07 개편) ──
    // 점수(상승 에너지) = 거래대금(원) × 상승률(%, 30캡). 컷 계단(+15% 등) 없이 단일 곱셈으로
    // "상승에 실린 돈"이 가장 큰 종목이 대장 — 거래대금 2배 = 상승률 2배 등가.
    // 초대형주(삼성전자·SK하이닉스 등)는 +5~10% 라도 거래대금이 수조원이면 자연히 1등이 되고,
    // 저거래 급등주는 에너지 미달로 걸러진다. 후보 풀은 급등 랭킹(+10%↑) + marketmap 대형주(+5%↑) 병합.
    var LEADER_MIN_RATE = 5;          // 후보 최소 상승률(%) — 이 밑은 대장 자격 없음
    var LEADER_RATE_CAP = 30;         // 비교용 상승률 캡 — 신규상장 등 이벤트성 초과분 왜곡 방지
    var LEADER_MIN_SCORE = 8e12;      // 최소 상승 에너지(원×%) — 예: 3,000억×+27% ≈ 1조×+8%. 미달이면 그날 대장 없음
    var GROUP_MIN = 3;

    function num(value) {
        var parsed = Number(value);
        return isFinite(parsed) ? parsed : 0;
    }

    function capRate(row) {
        return Math.min(num(row && row.change_rate), LEADER_RATE_CAP);
    }

    function themeTags(row) {
        var out = [];
        var seen = {};
        function add(value) {
            var name = String(value || '').trim();
            if (!name || name === '분야' || seen[name]) return;
            seen[name] = 1;
            out.push(name);
        }
        if (Array.isArray(row && row.theme_tags)) row.theme_tags.forEach(add);
        add(row && row.theme_tag);
        return out;
    }

    function isActiveRow(row, cutoff) {
        if (!row || !row.ticker || BLOCKED_TICKERS[row.ticker]) return false;
        return num(row.change_rate) >= (cutoff == null ? RISE_CUTOFF : cutoff);
    }

    function activeRiseRows(rows) {
        return (rows || []).filter(function (row) {
            return isActiveRow(row, RISE_CUTOFF);
        });
    }

    function buildGroups(rows, type) {
        var by = {};
        (rows || []).forEach(function (row) {
            var keys = type === 'theme' ? themeTags(row) : [String(row.sector || '').trim()];
            var rowSeen = {};
            keys.forEach(function (key) {
                if (!key || rowSeen[key]) return;
                rowSeen[key] = 1;
                if (!by[key]) {
                    by[key] = {
                        key: key,
                        name: key,
                        type: type,
                        count: 0,
                        sumRate: 0,
                        rateSum: 0,
                        totalVolume: 0,
                        valueSum: 0,
                        stocks: [],
                        _tickers: {},
                    };
                }
                if (by[key]._tickers[row.ticker]) return;
                by[key]._tickers[row.ticker] = 1;
                by[key].count += 1;
                by[key].sumRate += num(row.change_rate);
                by[key].rateSum = by[key].sumRate;
                by[key].totalVolume += num(row.trading_value);
                by[key].valueSum = by[key].totalVolume;
                by[key].stocks.push(row);
            });
        });

        return Object.keys(by).map(function (key) {
            var group = by[key];
            group.avgRate = group.count ? group.sumRate / group.count : 0;
            group.stocks.sort(function (a, b) {
                return num(b.change_rate) - num(a.change_rate) ||
                    num(b.trading_value) - num(a.trading_value);
            });
            delete group._tickers;
            return group;
        }).filter(function (group) {
            return group.count >= GROUP_MIN;
        }).sort(function (a, b) {
            return b.count - a.count ||
                b.avgRate - a.avgRate ||
                b.totalVolume - a.totalVolume;
        });
    }

    function groupMaps(sectors, themes) {
        var sectorMap = {};
        var themeMap = {};
        (sectors || []).forEach(function (group) { sectorMap[group.key] = group; });
        (themes || []).forEach(function (group) { themeMap[group.key] = group; });
        return { sector: sectorMap, theme: themeMap };
    }

    // 상승 에너지 — 대장주 점수 그 자체 (원 × %)
    function leaderEnergy(row) {
        return num(row && row.trading_value) * capRate(row);
    }

    // extraRows: 급등 랭킹 밖 후보(marketmap 대형주 +5%대 등).
    // ticker 중복 시 상승 에너지 큰 쪽 '숫자'를 신뢰(랭킹 원본의 거래대금 결손 방어),
    // 상승이유·테마 등 서술 필드는 랭킹 쪽을 유지한다.
    function pickLeader(rows, sectors, themes, extraRows) {
        var byTicker = {};
        var order = [];
        (rows || []).concat(extraRows || []).forEach(function (row) {
            if (!row || !row.ticker || BLOCKED_TICKERS[row.ticker]) return;
            if (!(num(row.change_rate) >= LEADER_MIN_RATE && num(row.trading_value) > 0)) return;
            var prev = byTicker[row.ticker];
            if (!prev) { byTicker[row.ticker] = row; order.push(row.ticker); return; }
            if (leaderEnergy(row) > leaderEnergy(prev)) {
                byTicker[row.ticker] = Object.assign({}, prev, {
                    change_rate: row.change_rate,
                    trading_value: row.trading_value,
                    close_price: row.close_price != null ? row.close_price : prev.close_price,
                    market_cap: row.market_cap != null ? row.market_cap : prev.market_cap,
                });
            }
        });
        var pool = order.map(function (t) { return byTicker[t]; });
        if (!pool.length) return null;

        pool.sort(function (a, b) {
            return leaderEnergy(b) - leaderEnergy(a) ||
                num(b.trading_value) - num(a.trading_value) ||
                capRate(b) - capRate(a);
        });
        if (leaderEnergy(pool[0]) < LEADER_MIN_SCORE) return null;

        var maps = groupMaps(sectors, themes);
        var leader = Object.assign({}, pool[0]);
        leader._leaderScore = leaderEnergy(pool[0]);
        leader._sectorCount = maps.sector[leader.sector] ? maps.sector[leader.sector].count : 1;
        leader._themeCount = 1;
        themeTags(leader).forEach(function (tag) {
            if (maps.theme[tag]) leader._themeCount = Math.max(leader._themeCount, maps.theme[tag].count);
        });
        return leader;
    }

    function overlayRankings(rows, liveMap) {
        if (!liveMap) return rows || [];
        return (rows || []).map(function (row) {
            var live = liveMap[row.ticker];
            if (!live) return row;
            var next = Object.assign({}, row);
            if (live.change_rate != null) next.change_rate = live.change_rate;
            if (live.close_price != null) next.close_price = live.close_price;
            if (live.trading_value != null) next.trading_value = live.trading_value;
            if (live.market_cap != null) next.market_cap = live.market_cap * 1e8;
            return next;
        });
    }

    function isLimitUp(row) {
        return num(row && row.change_rate) >= 29.9;
    }

    return {
        constants: {
            riseCutoff: RISE_CUTOFF,
            leaderMinRate: LEADER_MIN_RATE,
            leaderMinScore: LEADER_MIN_SCORE,
            groupMin: GROUP_MIN,
        },
        num: num,
        capRate: capRate,
        leaderEnergy: leaderEnergy,
        themeTags: themeTags,
        isActiveRow: isActiveRow,
        activeRiseRows: activeRiseRows,
        buildGroups: buildGroups,
        pickLeader: pickLeader,
        overlayRankings: overlayRankings,
        isLimitUp: isLimitUp,
    };
})();
