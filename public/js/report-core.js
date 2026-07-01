/**
 * ORGO 리포트 공용 파생 로직.
 * 리포트와 랜딩이 같은 입력에서 같은 대장주·주도 섹터·핫 테마를 내도록 한곳에서 관리한다.
 */
var WhyReportCore = (function () {
    'use strict';

    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };
    var RISE_CUTOFF = 15;
    var LEADER_VOLUME_PEER_RATIO = 0.5;
    var LEADER_VOLUME_TOP_N = 5;
    var LEADER_MIN_VALUE = 3000 * 1e8;
    var LEADER_RATE_CAP = 30;
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

    function pickLeader(rows, sectors, themes) {
        var candidates = (rows || []).filter(function (row) {
            return isActiveRow(row, RISE_CUTOFF) && num(row.trading_value) > 0;
        });
        if (!candidates.length) return null;

        var maps = groupMaps(sectors, themes);
        var maxVolume = Math.max.apply(null, candidates.map(function (row) {
            return num(row.trading_value);
        }));
        var volumeTop = {};
        candidates.slice().sort(function (a, b) {
            return num(b.trading_value) - num(a.trading_value) || capRate(b) - capRate(a);
        }).slice(0, LEADER_VOLUME_TOP_N).forEach(function (row) {
            volumeTop[row.ticker] = 1;
        });
        var peers = candidates.filter(function (row) {
            return num(row.trading_value) >= maxVolume * LEADER_VOLUME_PEER_RATIO ||
                volumeTop[row.ticker];
        });
        var maxChange = Math.max.apply(null, peers.map(capRate));
        function score(row) {
            var volumeScore = maxVolume > 0 ? num(row.trading_value) / maxVolume : 0;
            var changeScore = maxChange > 0 ? capRate(row) / maxChange : 0;
            return volumeScore * 70 + changeScore * 30;
        }
        peers.sort(function (a, b) {
            return score(b) - score(a) ||
                num(b.trading_value) - num(a.trading_value) ||
                capRate(b) - capRate(a);
        });
        if (!peers[0] || num(peers[0].trading_value) < LEADER_MIN_VALUE) return null;

        var leader = Object.assign({}, peers[0]);
        leader._leaderScore = score(peers[0]);
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
            leaderMinValue: LEADER_MIN_VALUE,
            groupMin: GROUP_MIN,
        },
        num: num,
        capRate: capRate,
        themeTags: themeTags,
        isActiveRow: isActiveRow,
        activeRiseRows: activeRiseRows,
        buildGroups: buildGroups,
        pickLeader: pickLeader,
        overlayRankings: overlayRankings,
        isLimitUp: isLimitUp,
    };
})();
