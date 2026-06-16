/**
 * 샘플1 — 리포트의 오늘의 대장(대장주/대장섹터/대장테마)을 월간 캘린더로 표시.
 */
var WhySample1 = (function () {
    'use strict';

    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };
    var RISE_CUTOFF = 15;
    var LEADER_CUTOFF = 20;
    var GROUP_MIN = 3;
    var TYPE_LABEL = {
        stock: '대장주',
        sector: '대장섹터',
        theme: '대장테마',
    };

    var state = {
        dates: [],
        months: [],
        monthKey: '',
        activeType: 'stock',
        selectedDate: '',
        dayCache: {},
        monthCache: {},
    };

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function num(v) {
        var n = Number(v);
        return isFinite(n) ? n : 0;
    }

    function pct(n, digits) {
        if (n == null || isNaN(n)) return '-';
        digits = digits == null ? 2 : digits;
        n = Number(n);
        return (n >= 0 ? '+' : '') + n.toFixed(digits) + '%';
    }

    function fmtAmount(n) {
        n = Number(n || 0);
        if (!n) return '-';
        if (n >= 1e12) return (n / 1e12).toFixed(1) + '조';
        if (n >= 1e8) return Math.round(n / 1e8).toLocaleString('ko-KR') + '억';
        if (n >= 1e4) return Math.round(n / 1e4).toLocaleString('ko-KR') + '만';
        return n.toLocaleString('ko-KR');
    }

    function formatMonth(monthKey) {
        if (!monthKey || monthKey.length !== 6) return '-';
        return monthKey.slice(0, 4) + '. ' + Number(monthKey.slice(4, 6)) + '.';
    }

    function formatDate(date) {
        if (!date || date.length !== 8) return '-';
        var days = ['일', '월', '화', '수', '목', '금', '토'];
        var d = new Date(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)));
        return date.slice(0, 4) + '. ' + Number(date.slice(4, 6)) + '. ' + Number(date.slice(6, 8)) + '. ' + days[d.getDay()];
    }

    function stockUrl(ticker) {
        return '/stock/' + encodeURIComponent(ticker);
    }

    function screeningUrl(type, key) {
        var params = ['cnt=count_15', 'min=1'];
        if (type === 'sector') params.push('sector=' + encodeURIComponent(key));
        if (type === 'theme') params.push('theme=' + encodeURIComponent(key));
        return '/screening.html?' + params.join('&');
    }

    function themeTags(row) {
        var out = [];
        var seen = {};
        function add(v) {
            v = String(v || '').trim();
            if (!v || seen[v]) return;
            seen[v] = 1;
            out.push(v);
        }
        if (Array.isArray(row && row.theme_tags)) row.theme_tags.forEach(add);
        add(row && row.theme_tag);
        return out;
    }

    function themeOf(row) {
        var tags = themeTags(row);
        return tags.length ? tags[0] : '';
    }

    function isActiveRow(row, cutoff) {
        if (!row || !row.ticker || BLOCKED_TICKERS[row.ticker]) return false;
        return num(row.change_rate) >= cutoff;
    }

    function activeRiseRows(rankings) {
        return (rankings || []).filter(function (row) {
            return isActiveRow(row, RISE_CUTOFF);
        });
    }

    function buildGroups(rows, type) {
        var by = {};
        rows.forEach(function (row) {
            var keys = type === 'theme' ? themeTags(row) : [String(row.sector || '').trim()];
            var rowSeen = {};
            keys.forEach(function (key) {
                if (!key || rowSeen[key]) return;
                rowSeen[key] = 1;
                if (!by[key]) {
                    by[key] = {
                        key: key,
                        type: type,
                        count: 0,
                        sumRate: 0,
                        totalVolume: 0,
                        stocks: [],
                        _tickers: {},
                    };
                }
                if (by[key]._tickers[row.ticker]) return;
                by[key]._tickers[row.ticker] = 1;
                by[key].count += 1;
                by[key].sumRate += num(row.change_rate);
                by[key].totalVolume += num(row.trading_value);
                by[key].stocks.push(row);
            });
        });

        return Object.keys(by).map(function (key) {
            var g = by[key];
            g.avgRate = g.count ? g.sumRate / g.count : 0;
            g.stocks.sort(function (a, b) {
                return num(b.change_rate) - num(a.change_rate) ||
                    num(b.trading_value) - num(a.trading_value);
            });
            delete g._tickers;
            return g;
        }).filter(function (g) {
            return g.count >= GROUP_MIN;
        }).sort(function (a, b) {
            return b.count - a.count ||
                b.avgRate - a.avgRate ||
                b.totalVolume - a.totalVolume;
        });
    }

    function groupMaps(sectors, themes) {
        var sectorMap = {};
        var themeMap = {};
        sectors.forEach(function (g) { sectorMap[g.key] = g; });
        themes.forEach(function (g) { themeMap[g.key] = g; });
        return { sector: sectorMap, theme: themeMap };
    }

    function pickLeader(rows, sectors, themes) {
        var candidates = (rows || []).filter(function (row) {
            return num(row.change_rate) >= LEADER_CUTOFF && num(row.trading_value) > 0;
        });
        if (!candidates.length) return null;
        var maps = groupMaps(sectors, themes);
        var maxVolume = Math.max.apply(null, candidates.map(function (row) { return num(row.trading_value); }));
        var volumePeers = candidates.filter(function (row) {
            return num(row.trading_value) >= maxVolume * 0.7;
        });
        var maxChange = Math.max.apply(null, volumePeers.map(function (row) { return num(row.change_rate); }));
        function score(row) {
            var volumeScore = maxVolume > 0 ? num(row.trading_value) / maxVolume : 0;
            var changeScore = maxChange > 0 ? num(row.change_rate) / maxChange : 0;
            return volumeScore * 70 + changeScore * 30;
        }
        var sorted = volumePeers.slice().sort(function (a, b) {
            return score(b) - score(a) ||
                num(b.trading_value) - num(a.trading_value) ||
                num(b.change_rate) - num(a.change_rate);
        });
        var leader = Object.assign({}, sorted[0]);
        leader._leaderScore = score(sorted[0]);
        leader._sectorCount = maps.sector[leader.sector] ? maps.sector[leader.sector].count : 1;
        leader._themeCount = 1;
        themeTags(leader).forEach(function (tag) {
            if (maps.theme[tag]) leader._themeCount = Math.max(leader._themeCount, maps.theme[tag].count);
        });
        return leader;
    }

    function hashString(str) {
        str = String(str || '');
        var h = 2166136261;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
        }
        return h >>> 0;
    }

    function colorStyle(key, type) {
        var seed = hashString(type + ':' + key);
        var hue = seed % 360;
        var sat = 58 + (seed % 18);
        var light = 54 + (seed % 10);
        return '--item-h:' + hue + ';--item-s:' + sat + '%;--item-l:' + light + '%;';
    }

    function itemFromStock(row) {
        if (!row) return null;
        var reason = row.rise_reason || themeOf(row) || row.sector || '';
        return {
            type: 'stock',
            key: row.name || row.ticker,
            title: row.name || row.ticker,
            href: stockUrl(row.ticker),
            meta: pct(row.change_rate) + ' · 거래 ' + fmtAmount(row.trading_value),
            sub: reason,
            ticker: row.ticker,
        };
    }

    function itemFromGroup(group, type) {
        if (!group) return null;
        var top = group.stocks && group.stocks[0];
        return {
            type: type,
            key: group.key,
            title: group.key,
            href: screeningUrl(type, group.key),
            meta: group.count + '종목 · 평균 ' + pct(group.avgRate, 1),
            sub: top ? ((top.name || top.ticker) + ' ' + pct(top.change_rate, 1)) : '',
        };
    }

    function itemFromCalendarStock(stock) {
        if (!stock) return null;
        return {
            type: 'stock',
            key: stock.name || stock.ticker,
            title: stock.name || stock.ticker,
            href: stockUrl(stock.ticker),
            meta: pct(stock.rate, 1),
            sub: stock.ticker || '',
            ticker: stock.ticker,
        };
    }

    function itemFromCalendarGroup(group, type) {
        if (!group) return null;
        return {
            type: type,
            key: group.name,
            title: group.name,
            href: screeningUrl(type, group.name),
            meta: group.count + '종목 · 평균 ' + pct(group.avgRate, 1),
            sub: '',
        };
    }

    function recordFromCalendar(date, raw) {
        raw = raw || {};
        return {
            date: date,
            total: 0,
            stock: itemFromCalendarStock(raw.stock),
            sector: itemFromCalendarGroup(raw.sector, 'sector'),
            theme: itemFromCalendarGroup(raw.theme, 'theme'),
        };
    }

    function deriveDay(date, day) {
        var rankings = (day && day.rankings) || [];
        var riseRows = activeRiseRows(rankings);
        var sectors = buildGroups(riseRows, 'sector');
        var themes = buildGroups(riseRows, 'theme');
        var leader = pickLeader(riseRows, sectors, themes);
        return {
            date: date,
            total: riseRows.length,
            stock: itemFromStock(leader),
            sector: itemFromGroup(sectors[0], 'sector'),
            theme: itemFromGroup(themes[0], 'theme'),
        };
    }

    function monthDates(monthKey) {
        return state.dates.filter(function (d) { return String(d).slice(0, 6) === monthKey; });
    }

    function getDay(date) {
        if (state.dayCache[date]) return Promise.resolve(state.dayCache[date]);
        return WhyAPI.getRankings(date).then(function (day) {
            var rec = deriveDay(date, day || {});
            state.dayCache[date] = rec;
            return rec;
        });
    }

    function loadMonth(monthKey) {
        if (state.monthCache[monthKey]) return Promise.resolve(state.monthCache[monthKey]);
        var dates = monthDates(monthKey);
        return Promise.all(dates.map(getDay)).then(function (records) {
            var byDate = {};
            records.forEach(function (rec) { byDate[rec.date] = rec; });
            state.monthCache[monthKey] = byDate;
            return byDate;
        });
    }

    function makeMonths(dates) {
        var out = [];
        var seen = {};
        dates.forEach(function (date) {
            var key = String(date || '').slice(0, 6);
            if (!key || seen[key]) return;
            seen[key] = 1;
            out.push(key);
        });
        return out;
    }

    function applyCalendarIndex(payload) {
        var days = payload && payload.days;
        if (!days || typeof days !== 'object') return false;
        var dates = Object.keys(days).filter(function (date) {
            return /^\d{8}$/.test(date);
        }).sort().reverse();
        if (!dates.length) return false;
        var months = {};
        dates.forEach(function (date) {
            var monthKey = date.slice(0, 6);
            if (!months[monthKey]) months[monthKey] = {};
            months[monthKey][date] = recordFromCalendar(date, days[date]);
        });
        state.dates = dates;
        state.months = makeMonths(dates);
        state.monthCache = months;
        state.monthKey = state.months[0] || '';
        return !!state.monthKey;
    }

    function loadCalendarIndex() {
        return fetch('/data/leaders-calendar.json?v=20260616a')
            .then(function (res) {
                if (!res.ok) return null;
                return res.json();
            })
            .catch(function () { return null; });
    }

    function currentRecords() {
        return state.monthCache[state.monthKey] || {};
    }

    function currentTradingDates() {
        return monthDates(state.monthKey);
    }

    function renderMonthHeader() {
        var label = $('sampleMonthLabel');
        var meta = $('sampleRangeMeta');
        var prev = $('sampleMonthPrev');
        var next = $('sampleMonthNext');
        var idx = state.months.indexOf(state.monthKey);
        var trading = currentTradingDates();
        if (label) label.textContent = formatMonth(state.monthKey);
        if (meta) {
            var records = currentRecords();
            var shown = trading.filter(function (date) {
                return records[date] && records[date][state.activeType];
            }).length;
            meta.textContent = '거래일 ' + trading.length + '일 · 표시 ' + shown + '일';
        }
        if (prev) prev.disabled = idx < 0 || idx >= state.months.length - 1;
        if (next) next.disabled = idx <= 0;
    }

    function renderTabs() {
        document.querySelectorAll('[data-sample-type]').forEach(function (btn) {
            var active = btn.getAttribute('data-sample-type') === state.activeType;
            btn.classList.toggle('seg__btn--active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        var badge = $('sampleLegendType');
        if (badge) badge.textContent = TYPE_LABEL[state.activeType] || '';
    }

    function renderCalendar() {
        var el = $('sampleCalendar');
        if (!el) return;
        var records = currentRecords();
        var year = Number(state.monthKey.slice(0, 4));
        var month = Number(state.monthKey.slice(4, 6));
        var first = new Date(year, month - 1, 1);
        var lastDate = new Date(year, month, 0).getDate();
        var startOffset = first.getDay();
        var totalCells = Math.ceil((startOffset + lastDate) / 7) * 7;
        var html = '';
        for (var i = 0; i < totalCells; i++) {
            var dayNum = i - startOffset + 1;
            var inMonth = dayNum >= 1 && dayNum <= lastDate;
            var dateKey = inMonth ?
                String(year) + String(month).padStart(2, '0') + String(dayNum).padStart(2, '0') : '';
            var rec = dateKey ? records[dateKey] : null;
            var item = rec && rec[state.activeType];
            var selected = dateKey && dateKey === state.selectedDate;
            var cls = 'sample1-cell';
            if (!inMonth) cls += ' sample1-cell--blank';
            if (item) cls += ' sample1-cell--has-item';
            if (selected) cls += ' sample1-cell--selected';
            var style = item ? colorStyle(item.key, state.activeType) : '';
            var label = item ? (formatDate(dateKey) + ' ' + item.title) : (inMonth ? formatDate(dateKey) : '빈 날짜');
            html += '<button class="' + cls + '" type="button" ' +
                (dateKey ? 'data-date="' + esc(dateKey) + '" ' : '') +
                (item ? '' : 'disabled ') +
                (style ? 'style="' + esc(style) + '" ' : '') +
                'aria-label="' + esc(label) + '">' +
                '<span class="sample1-cell__day">' + (inMonth ? dayNum : '') + '</span>' +
                (item ? '<span class="sample1-cell__body">' +
                    '<strong class="sample1-cell__name">' + esc(item.title) + '</strong>' +
                    '<span class="sample1-cell__meta">' + esc(item.meta) + '</span>' +
                '</span>' : '') +
            '</button>';
        }
        el.innerHTML = html;
    }

    function legendRows() {
        var counts = {};
        var records = currentRecords();
        currentTradingDates().forEach(function (date) {
            var rec = records[date];
            var item = rec && rec[state.activeType];
            if (!item) return;
            if (!counts[item.key]) counts[item.key] = { item: item, count: 0 };
            counts[item.key].count += 1;
        });
        return Object.keys(counts).map(function (key) {
            return counts[key];
        }).sort(function (a, b) {
            return b.count - a.count || a.item.title.localeCompare(b.item.title, 'ko-KR');
        });
    }

    function renderLegend() {
        var el = $('sampleLegend');
        if (!el) return;
        var rows = legendRows();
        if (!rows.length) {
            el.innerHTML = '<div class="sample1-empty">표시할 항목이 없습니다.</div>';
            return;
        }
        el.innerHTML = rows.slice(0, 12).map(function (row) {
            return '<a class="sample1-legend__item" href="' + esc(row.item.href || '#') + '" style="' + esc(colorStyle(row.item.key, state.activeType)) + '">' +
                '<span class="sample1-legend__swatch"></span>' +
                '<span class="sample1-legend__name">' + esc(row.item.title) + '</span>' +
                '<strong class="sample1-legend__count">' + row.count + '</strong>' +
            '</a>';
        }).join('');
    }

    function detailTile(item, type) {
        if (!item) {
            return '<article class="sample1-detail-tile sample1-detail-tile--empty">' +
                '<span class="sample1-detail-tile__label">' + esc(TYPE_LABEL[type]) + '</span>' +
                '<strong>없음</strong>' +
            '</article>';
        }
        return '<article class="sample1-detail-tile" style="' + esc(colorStyle(item.key, type)) + '">' +
            '<span class="sample1-detail-tile__label">' + esc(TYPE_LABEL[type]) + '</span>' +
            '<a class="sample1-detail-tile__title" href="' + esc(item.href) + '">' + esc(item.title) + '</a>' +
            '<span class="sample1-detail-tile__meta">' + esc(item.meta) + '</span>' +
            (item.sub ? '<span class="sample1-detail-tile__sub">' + esc(item.sub) + '</span>' : '') +
        '</article>';
    }

    function renderDetail() {
        var dateEl = $('sampleSelectedDate');
        var detail = $('sampleDetail');
        if (!detail) return;
        var records = currentRecords();
        var rec = records[state.selectedDate];
        if (dateEl) dateEl.textContent = state.selectedDate ? formatDate(state.selectedDate) : '-';
        if (!rec) {
            detail.innerHTML = '<div class="sample1-empty">선택된 거래일이 없습니다.</div>';
            return;
        }
        detail.innerHTML = detailTile(rec.stock, 'stock') +
            detailTile(rec.sector, 'sector') +
            detailTile(rec.theme, 'theme');
    }

    function selectDefaultDate() {
        var records = currentRecords();
        var dates = currentTradingDates();
        var typed = dates.filter(function (date) {
            return records[date] && records[date][state.activeType];
        });
        state.selectedDate = typed[0] || dates[0] || '';
    }

    function renderAll() {
        renderMonthHeader();
        renderTabs();
        renderCalendar();
        renderLegend();
        renderDetail();
    }

    function showLoading(show) {
        var loading = $('sampleLoading');
        var content = $('sampleContent');
        if (loading) loading.style.display = show ? 'block' : 'none';
        if (content) content.style.display = show ? 'none' : 'block';
    }

    function showMessage(text) {
        var el = $('sampleMessage');
        if (!el) return;
        el.textContent = text || '';
        el.style.display = text ? 'block' : 'none';
    }

    function loadCurrentMonth() {
        showLoading(true);
        showMessage('');
        return loadMonth(state.monthKey).then(function () {
            selectDefaultDate();
            renderAll();
            showLoading(false);
        }).catch(function (err) {
            showLoading(false);
            showMessage('캘린더 로딩 실패: ' + (err && err.message ? err.message : err));
        });
    }

    function shiftMonth(delta) {
        var idx = state.months.indexOf(state.monthKey);
        var nextIdx = idx + delta;
        if (nextIdx < 0 || nextIdx >= state.months.length) return;
        state.monthKey = state.months[nextIdx];
        state.selectedDate = '';
        loadCurrentMonth();
    }

    function bindEvents() {
        var prev = $('sampleMonthPrev');
        var next = $('sampleMonthNext');
        var cal = $('sampleCalendar');
        if (prev) prev.addEventListener('click', function () { shiftMonth(1); });
        if (next) next.addEventListener('click', function () { shiftMonth(-1); });
        document.querySelectorAll('[data-sample-type]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var type = btn.getAttribute('data-sample-type');
                if (!TYPE_LABEL[type] || type === state.activeType) return;
                state.activeType = type;
                selectDefaultDate();
                renderAll();
            });
        });
        if (cal) {
            cal.addEventListener('click', function (e) {
                var btn = e.target.closest('[data-date]');
                if (!btn || btn.disabled) return;
                state.selectedDate = btn.getAttribute('data-date');
                renderCalendar();
                renderDetail();
            });
        }
    }

    function init() {
        bindEvents();
        showLoading(true);
        loadCalendarIndex().then(function (index) {
            if (applyCalendarIndex(index)) return loadCurrentMonth();
            if (!window.WhyAPI || !WhyAPI.getDates || !WhyAPI.getRankings) {
                throw new Error('API 로딩 실패');
            }
            return WhyAPI.getDates().then(function (dates) {
                state.dates = Array.isArray(dates) ? dates : [];
                state.months = makeMonths(state.dates);
                state.monthKey = state.months[0] || '';
                if (!state.monthKey) throw new Error('거래일 데이터 없음');
                return loadCurrentMonth();
            });
        }).catch(function (err) {
            showLoading(false);
            showMessage('캘린더 로딩 실패: ' + (err && err.message ? err.message : err));
        });
    }

    function initWithApiOnly() {
        if (!window.WhyAPI || !WhyAPI.getDates || !WhyAPI.getRankings) {
            showLoading(false);
            showMessage('API 로딩 실패');
            return;
        }
        WhyAPI.getDates().then(function (dates) {
            state.dates = Array.isArray(dates) ? dates : [];
            state.months = makeMonths(state.dates);
            state.monthKey = state.months[0] || '';
            if (!state.monthKey) throw new Error('거래일 데이터 없음');
            return loadCurrentMonth();
        }).catch(function (err) {
            showLoading(false);
            showMessage('캘린더 로딩 실패: ' + (err && err.message ? err.message : err));
        });
    }

    document.addEventListener('DOMContentLoaded', init);

    return {
        deriveDay: deriveDay,
        pickLeader: pickLeader,
        buildGroups: buildGroups,
        colorStyle: colorStyle,
        applyCalendarIndex: applyCalendarIndex,
        initWithApiOnly: initWithApiOnly,
    };
})();
