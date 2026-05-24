/**
 * 스크리닝 — /data/screening.json 기반 독립 리스트.
 * 홈/상세와 같은 whyrise-ratings 저장소를 사용해 관심·메모를 공유한다.
 */
var WhyScreening = (function () {
    'use strict';

    var STORAGE_KEY = 'whyrise-ratings';
    var WATCHLIST_KEY = 'whyrise-screening-watchlist-mode';
    var THEME_KEY = 'theme';
    var DATA_URL = '/data/screening.json';
    // 모든 종목 시총 lookup — marketmap 컷오프 밖 종목까지 cover. 빌더: scripts/build_mcap_all.py
    var MCAP_ALL_URL = '/data/mcap-all.json';
    var LIMIT = 250;
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };

    // 미집계 보강 — /api/mcap 으로 단일 종목 시총 lazy fetch. localStorage 캐시 24h.
    var MCAP_CACHE_KEY = 'whyrise-mcap-cache';
    var MCAP_CACHE_TTL = 24 * 3600 * 1000;
    var MCAP_FETCH_CONCURRENCY = 5;
    var _mcapInFlight = {};

    // 이유·태그·섹터 빈칸 보강 — stock-history JSON 의 events[0] 에서 채움.
    var META_CACHE_KEY = 'whyrise-history-meta-cache';
    var META_CACHE_TTL = 24 * 3600 * 1000;
    var META_FETCH_CONCURRENCY = 5;
    var _metaInFlight = {};

    var COUNT_LABELS = {
        count_10: '+10%',
        count_15: '+15%',
        count_20: '+20%',
        count_limit: '상한가',
        count_recent: '최근30',
    };

    var state = {
        loaded: false,
        tickers: [],
        sectors: [],
        themes: [],
        ratings: {},
        filtered: [],
        watchlistMode: false,
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

    function normalize(s) {
        return (s == null ? '' : String(s)).toLowerCase().trim();
    }

    function loadRatings() {
        state.ratings = window.WhyRatingsSync ? window.WhyRatingsSync.getCached() : {};
    }

    function saveRatings() {
        if (window.WhyRatingsSync) window.WhyRatingsSync.push(state.ratings);
    }

    function requirePersonal(feature) {
        if (!window.WhyAuth || window.WhyAuth.personalAllowed()) return true;
        window.WhyAuth.requireLogin(feature);
        return false;
    }

    function formatDate(yyyymmdd) {
        var s = String(yyyymmdd || '');
        if (s.length !== 8) return '-';
        return s.substring(2, 4) + '.' + s.substring(4, 6) + '.' + s.substring(6, 8);
    }

    function formatBuiltAt(value) {
        if (!value) return '';
        var s = String(value).trim();
        var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
        if (!m) return s.replace('T', ' ').substring(0, 16);
        return m[1] + '.' + m[2] + '.' + m[3] + ' ' + m[4] + ':' + m[5];
    }

    function formatRate(rate) {
        if (rate == null || isNaN(rate)) return '<span class="screening-rate">-</span>';
        var n = Number(rate);
        var sign = n >= 0 ? '+' : '';
        var arrow = n >= 0 ? '▲' : '▼';
        var cls = n >= 0 ? 'cell-change--up' : 'cell-change--down';
        return '<span class="' + cls + '">' + arrow + sign + n.toFixed(2) + '%</span>';
    }

    function formatRateText(rate) {
        if (rate == null || isNaN(rate)) return '-';
        var n = Number(rate);
        return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
    }

    function formatMcap(v) {
        var n = Number(v || 0);
        if (!n) return '미집계';
        if (n >= 10000) {
            var jo = n / 10000;
            var fixed = jo < 10 ? jo.toFixed(1) : Math.round(jo).toLocaleString('ko-KR');
            return fixed + '조';
        }
        return Math.round(n).toLocaleString('ko-KR') + '억';
    }

    function countValue(row, key) {
        var n = Number(row && row[key]);
        return isNaN(n) ? 0 : n;
    }

    function getControls() {
        return {
            search: $('screeningSearch'),
            countKey: $('screeningCountKey'),
            minCount: $('screeningMinCount'),
            market: $('screeningMarket'),
            sector: $('screeningSector'),
            theme: $('screeningTheme'),
            mcap: $('screeningMcap'),
            sort: $('screeningSort'),
        };
    }

    function getFilters() {
        var c = getControls();
        return {
            query: normalize(c.search && c.search.value),
            countKey: (c.countKey && c.countKey.value) || 'count_10',
            minCount: parseInt((c.minCount && c.minCount.value) || '1', 10) || 1,
            market: (c.market && c.market.value) || '',
            sector: (c.sector && c.sector.value) || '',
            theme: (c.theme && c.theme.value) || '',
            mcap: (c.mcap && c.mcap.value) || '',
            sort: (c.sort && c.sort.value) || 'count_10',
        };
    }

    function inMcapRange(row, range) {
        var mc = Number(row.market_cap || 0);
        if (!range) return true;
        if (range === 'unknown') return mc <= 0;
        if (mc <= 0) return false;
        if (range === 'under_1000') return mc < 1000;
        if (range === '1000_10000') return mc >= 1000 && mc < 10000;
        if (range === '10000_100000') return mc >= 10000 && mc < 100000;
        if (range === 'over_100000') return mc >= 100000;
        return true;
    }

    function hasTheme(row, theme) {
        if (!theme) return true;
        if (row.latest_theme === theme) return true;
        var themes = Array.isArray(row.themes) ? row.themes : [];
        return themes.indexOf(theme) !== -1;
    }

    function matchesQuery(row, query) {
        if (!query) return true;
        var themes = Array.isArray(row.themes) ? row.themes.join(' ') : '';
        var haystack = [
            row.ticker, row.name, row.market, row.sector,
            row.latest_theme, row.latest_reason, themes,
        ].join(' ').toLowerCase();
        return haystack.indexOf(query) !== -1;
    }

    function compareRows(a, b, sortKey, countKey) {
        if (sortKey === 'name') {
            return (a.name || '').localeCompare(b.name || '', 'ko-KR');
        }
        var va;
        var vb;
        if (sortKey === 'market_cap') {
            va = Number(a.market_cap || 0);
            vb = Number(b.market_cap || 0);
        } else if (sortKey === 'avg_rate') {
            va = Number(a.avg_rate || 0);
            vb = Number(b.avg_rate || 0);
        } else if (sortKey === 'latest_date') {
            va = Number(a.latest_date || 0);
            vb = Number(b.latest_date || 0);
        } else {
            va = countValue(a, sortKey || countKey);
            vb = countValue(b, sortKey || countKey);
        }
        if (vb !== va) return vb - va;
        var ca = countValue(a, countKey);
        var cb = countValue(b, countKey);
        if (cb !== ca) return cb - ca;
        var da = Number(a.latest_date || 0);
        var db = Number(b.latest_date || 0);
        if (db !== da) return db - da;
        return (a.name || '').localeCompare(b.name || '', 'ko-KR');
    }

    function _rowMatchesFilters(row, f) {
        if (!row || BLOCKED_TICKERS[row.ticker]) return false;
        if (state.watchlistMode && !((state.ratings[row.ticker] || {}).stars > 0)) return false;
        if (countValue(row, f.countKey) < f.minCount) return false;
        if (f.market && row.market !== f.market) return false;
        if (f.sector && row.sector !== f.sector) return false;
        if (!hasTheme(row, f.theme)) return false;
        if (!inMcapRange(row, f.mcap)) return false;
        if (!matchesQuery(row, f.query)) return false;
        return true;
    }

    function applyFilters() {
        var f = getFilters();
        var out = [];
        for (var i = 0; i < state.tickers.length; i++) {
            var row = state.tickers[i];
            if (!_rowMatchesFilters(row, f)) continue;
            out.push(row);
        }
        out.sort(function (a, b) { return compareRows(a, b, f.sort, f.countKey); });
        state.filtered = out;
        render(out, f);
    }

    function starRatingHtml(ticker) {
        var rating = state.ratings[ticker] || {};
        var stars = rating.stars || 0;
        var excluded = rating.excluded || false;
        var hasMemo = !!rating.memo;
        var tEsc = esc(ticker);
        var html = '<span class="ctrl-wrap">';
        html += '<button class="ctrl-toggle" type="button" data-ticker="' + tEsc + '" aria-label="평가">⋯</button>';
        html += '<div class="float-controls" data-ticker="' + tEsc + '">';
        html += '<span class="star-rating" data-ticker="' + tEsc + '">';
        for (var i = 1; i <= 5; i++) {
            html += '<span class="star' + (i <= stars ? ' star--active' : '') + '" data-star="' + i + '">★</span>';
        }
        html += '</span>';
        html += '<button class="exclude-btn' + (excluded ? ' exclude-btn--active' : '') + '" data-ticker="' + tEsc + '" title="제외">✕</button>';
        html += '<button class="memo-btn' + (hasMemo ? ' memo-btn--has' : '') + '" data-ticker="' + tEsc + '" title="메모">✎</button>';
        html += '</div></span>';
        return html;
    }

    function miniIndicatorsHtml(ticker) {
        var rating = state.ratings[ticker] || {};
        var stars = rating.stars || 0;
        var excluded = !!rating.excluded;
        var hasMemo = !!rating.memo;
        if (!(stars > 0 || excluded || hasMemo)) return '';
        var html = '<span class="mini-indicators">';
        if (stars > 0) html += '<span class="mini-star">★' + stars + '</span>';
        if (excluded) html += '<span class="mini-exclude">✕</span>';
        if (hasMemo) html += '<span class="mini-memo">✎</span>';
        html += '</span>';
        return html;
    }

    function countPillsHtml(row, activeKey) {
        var keys = ['count_10', 'count_15', 'count_20', 'count_limit', 'count_recent'];
        var html = '<div class="screening-counts">';
        keys.forEach(function (key) {
            var active = key === activeKey;
            html += '<span class="' + (active ? 'is-active' : '') + '">' +
                esc(COUNT_LABELS[key]) + ' <b>' + countValue(row, key) + '</b></span>';
        });
        html += '</div>';
        return html;
    }

    function render(rows, filters) {
        var body = $('screeningBody');
        var total = $('screeningTotal');
        var loading = $('screeningLoading');
        if (loading) loading.style.display = 'none';
        if (total) total.textContent = rows.length.toLocaleString('ko-KR') + '종목';
        if (!body) return;

        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="7" class="screening-empty">조건에 맞는 종목이 없습니다.</td></tr>';
            return;
        }

        var html = '';
        rows.slice(0, LIMIT).forEach(function (row, idx) {
            var ticker = esc(row.ticker);
            var rating = state.ratings[row.ticker] || {};
            var rowClasses = [];
            if (rating.excluded) rowClasses.push('row--excluded');
            if ((rating.stars || 0) > 0) rowClasses.push('row--starred');
            if (Number(row.latest_change_rate || 0) >= 29.9) rowClasses.push('row--limit-up');

            var theme = row.latest_theme || '';
            var reason = row.latest_reason || '-';
            var sector = row.sector || '-';
            var market = row.market || '';
            var meta = [];
            if (market) meta.push(esc(market));
            if (sector) meta.push(esc(sector));
            meta.push('최근 ' + formatDate(row.latest_date) + ' ' + formatRateText(row.latest_change_rate));
            meta.push('시총 ' + formatMcap(row.market_cap));
            meta.push('평균 ' + (row.avg_rate != null ? Number(row.avg_rate).toFixed(2) + '%' : '-'));

            html += '<tr' + (rowClasses.length ? ' class="' + rowClasses.join(' ') + '"' : '') + ' data-ticker="' + ticker + '">';
            html += '<td class="cell-rank">' + (idx + 1) + '</td>';
            html += '<td class="cell-name"><div class="cell-name__wrap">' +
                '<a href="/stock/' + ticker + '" class="cell-name__link" data-ticker="' + ticker + '">' + esc(row.name) + '</a>' +
                miniIndicatorsHtml(row.ticker) +
                '<span class="cell-name__market">' + esc(market) + '</span>' +
                starRatingHtml(row.ticker) +
                '</div></td>';
            html += '<td class="cell-reason"><div class="cell-reason__inline">' +
                (theme ? '<button class="theme-tag screening-theme-tag" type="button" data-theme="' + esc(theme) + '">' + esc(theme) + '</button>' : '') +
                '<span class="cell-reason__text">' + esc(reason) + '</span>' +
                '</div></td>';
            html += '<td class="cell-counts">' + countPillsHtml(row, filters.countKey) + '</td>';
            html += '<td class="cell-change"><span class="screening-date">' + formatDate(row.latest_date) + '</span>' + formatRate(row.latest_change_rate) + '</td>';
            html += '<td class="cell-cap">' + formatMcap(row.market_cap) + '</td>';
            html += '<td class="cell-sector">' + esc(sector) + '</td>';
            html += '<td class="cell-meta-compact">' + meta.join(' · ') + '</td>';
            html += '</tr>';
        });
        body.innerHTML = html;
        backfillMissingMcap(rows.slice(0, LIMIT));
        backfillMissingMeta(rows.slice(0, LIMIT));
    }

    // ── 미집계 시총 lazy fetch ─────────────────────────────────
    function _loadMcapCache() {
        try {
            var c = JSON.parse(localStorage.getItem(MCAP_CACHE_KEY) || '{}');
            var now = Date.now();
            // 만료 청소
            var dirty = false;
            for (var k in c) {
                if (!c[k] || (now - (c[k].ts || 0)) > MCAP_CACHE_TTL) {
                    delete c[k];
                    dirty = true;
                }
            }
            if (dirty) {
                try { localStorage.setItem(MCAP_CACHE_KEY, JSON.stringify(c)); } catch (e) {}
            }
            return c;
        } catch (e) { return {}; }
    }
    function _saveMcapEntry(cache, ticker, mc) {
        cache[ticker] = { v: mc, ts: Date.now() };
        try { localStorage.setItem(MCAP_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
    }
    // backfill 결과 채워진 row 가 더 이상 현재 필터(미집계 등)에 안 맞으면 DOM 에서 제거.
    // rank·총종목 카운트도 즉시 재매김 — applyFilters 통째 호출보다 row 점프 적음.
    // 현재 결과 리스트(state.filtered) 에 있는 row 만 처리 (LIMIT 밖·다른 필터 화면 무관).
    function _refilterAfterBackfill(ticker, row) {
        var idx = -1;
        for (var i = 0; i < state.filtered.length; i++) {
            if (state.filtered[i].ticker === ticker) { idx = i; break; }
        }
        if (idx < 0) return;
        var f = getFilters();
        if (_rowMatchesFilters(row, f)) return;
        var trs = document.querySelectorAll('#screeningBody tr[data-ticker="' + ticker + '"]');
        for (var k = 0; k < trs.length; k++) trs[k].parentNode.removeChild(trs[k]);
        state.filtered.splice(idx, 1);
        var rankCells = document.querySelectorAll('#screeningBody tr .cell-rank');
        for (var j = 0; j < rankCells.length; j++) rankCells[j].textContent = (j + 1);
        var totalEl = document.getElementById('screeningTotal');
        if (totalEl) totalEl.textContent = state.filtered.length.toLocaleString('ko-KR') + '종목';
    }

    function _backfillCell(ticker, mc) {
        // 같은 ticker 행의 시총 셀 + 모바일 meta-compact 동기화
        var rows = document.querySelectorAll('tr[data-ticker="' + ticker + '"]');
        for (var i = 0; i < rows.length; i++) {
            var tr = rows[i];
            var cap = tr.querySelector('.cell-cap');
            if (cap) cap.textContent = formatMcap(mc);
            var meta = tr.querySelector('.cell-meta-compact');
            if (meta) {
                meta.textContent = meta.textContent.replace(/시총\s+[^·]+/, '시총 ' + formatMcap(mc));
            }
        }
    }
    function backfillMissingMcap(rows) {
        if (!rows || !rows.length) return;
        var cache = _loadMcapCache();
        // 캐시에 있는 ticker 는 즉시 적용 — state.tickers 의 원본도 갱신해 정렬·필터에 반영
        rows.forEach(function (r) {
            if ((!r.market_cap || r.market_cap <= 0) && cache[r.ticker]) {
                r.market_cap = cache[r.ticker].v || 0;
                _backfillCell(r.ticker, r.market_cap);
                _refilterAfterBackfill(r.ticker, r);
            }
        });
        // 캐시에 없고 진행중도 아닌 ticker 만 fetch 후보
        var need = rows.filter(function (r) {
            return (!r.market_cap || r.market_cap <= 0)
                && !cache[r.ticker]
                && !_mcapInFlight[r.ticker];
        });
        if (!need.length) return;
        var idx = 0;
        function next() {
            if (idx >= need.length) return;
            var row = need[idx++];
            var t = row.ticker;
            _mcapInFlight[t] = true;
            fetch('/api/mcap?ticker=' + encodeURIComponent(t))
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    var mc = (d && typeof d.market_cap === 'number') ? d.market_cap : 0;
                    var sectorFromHtml = (d && typeof d.sector === 'string') ? d.sector : '';
                    _saveMcapEntry(cache, t, mc);
                    // state 원본 갱신 → 다음 필터·정렬에 반영
                    var updated = null;
                    state.tickers.forEach(function (row2) {
                        if (row2.ticker !== t) return;
                        if (!row2.market_cap || row2.market_cap <= 0) row2.market_cap = mc;
                        if (!row2.sector && sectorFromHtml) row2.sector = sectorFromHtml;
                        updated = row2;
                    });
                    if (mc > 0) _backfillCell(t, mc);
                    if (sectorFromHtml) _backfillMetaCells(t, { sector: sectorFromHtml });
                    if (updated) _refilterAfterBackfill(t, updated);
                })
                .catch(function () {})
                .then(function () {
                    delete _mcapInFlight[t];
                    next();
                });
        }
        for (var k = 0; k < Math.min(MCAP_FETCH_CONCURRENCY, need.length); k++) next();
    }

    // ── 빈 이유·태그·섹터 lazy fetch ───────────────────────────
    function _loadMetaCache() {
        try {
            var c = JSON.parse(localStorage.getItem(META_CACHE_KEY) || '{}');
            var now = Date.now();
            var dirty = false;
            for (var k in c) {
                if (!c[k] || (now - (c[k].ts || 0)) > META_CACHE_TTL) {
                    delete c[k];
                    dirty = true;
                }
            }
            if (dirty) {
                try { localStorage.setItem(META_CACHE_KEY, JSON.stringify(c)); } catch (e) {}
            }
            return c;
        } catch (e) { return {}; }
    }
    function _saveMetaEntry(cache, ticker, meta) {
        cache[ticker] = { v: meta, ts: Date.now() };
        try { localStorage.setItem(META_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
    }
    function _backfillMetaCells(ticker, meta) {
        // PC: cell-reason__inline (theme 태그 + reason 텍스트), cell-sector 텍스트.
        // sector 만 전달된 경우(mcap fetch 결과) inline 은 안 건드림 — 기존 reason 보존.
        // 모바일 cell-meta-compact 의 sector 부분은 다음 render 사이클에서 자연 반영.
        var rows = document.querySelectorAll('tr[data-ticker="' + ticker + '"]');
        for (var i = 0; i < rows.length; i++) {
            var tr = rows[i];
            if (meta.reason || meta.theme) {
                var inline = tr.querySelector('.cell-reason__inline');
                if (inline) {
                    inline.innerHTML = '';
                    if (meta.theme) {
                        var btn = document.createElement('button');
                        btn.className = 'theme-tag screening-theme-tag';
                        btn.type = 'button';
                        btn.setAttribute('data-theme', meta.theme);
                        btn.textContent = meta.theme;
                        inline.appendChild(btn);
                    }
                    var span = document.createElement('span');
                    span.className = 'cell-reason__text';
                    span.textContent = meta.reason || '-';
                    inline.appendChild(span);
                }
            }
            if (meta.sector) {
                var sectorCell = tr.querySelector('.cell-sector');
                if (sectorCell) sectorCell.textContent = meta.sector;
            }
        }
    }
    function _isMetaMissing(row) {
        return !row.latest_reason || !row.latest_theme || !row.sector;
    }
    function backfillMissingMeta(rows) {
        if (!rows || !rows.length) return;
        var cache = _loadMetaCache();
        // 캐시 적용 — state 원본도 비어있을 때만 채움 (실값 덮어쓰기 X)
        rows.forEach(function (r) {
            var entry = cache[r.ticker];
            if (!entry || !entry.v) return;
            var m = entry.v;
            if (!r.latest_reason && m.reason) r.latest_reason = m.reason;
            if (!r.latest_theme && m.theme) r.latest_theme = m.theme;
            if (!r.sector && m.sector) r.sector = m.sector;
            if (m.reason || m.theme || m.sector) _backfillMetaCells(r.ticker, m);
            _refilterAfterBackfill(r.ticker, r);
        });
        // fetch 후보 — 한 항목이라도 비어있고 캐시 없는 ticker
        var need = rows.filter(function (r) {
            return _isMetaMissing(r) && !cache[r.ticker] && !_metaInFlight[r.ticker];
        });
        if (!need.length) return;
        var idx = 0;
        function next() {
            if (idx >= need.length) return;
            var t = need[idx++].ticker;
            _metaInFlight[t] = true;
            fetch('/data/stock-history/' + encodeURIComponent(t) + '.json')
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    var meta = { reason: '', theme: '', sector: '' };
                    var ev = (d && d.events && d.events[0]) || null;
                    if (ev) {
                        meta.reason = ev.rise_reason || '';
                        meta.theme = ev.theme_tag || '';
                        meta.sector = ev.sector || '';
                    }
                    _saveMetaEntry(cache, t, meta);
                    var updated = null;
                    state.tickers.forEach(function (row2) {
                        if (row2.ticker !== t) return;
                        if (!row2.latest_reason && meta.reason) row2.latest_reason = meta.reason;
                        if (!row2.latest_theme && meta.theme) row2.latest_theme = meta.theme;
                        if (!row2.sector && meta.sector) row2.sector = meta.sector;
                        updated = row2;
                    });
                    if (meta.reason || meta.theme || meta.sector) _backfillMetaCells(t, meta);
                    if (updated) _refilterAfterBackfill(t, updated);
                })
                .catch(function () {})
                .then(function () {
                    delete _metaInFlight[t];
                    next();
                });
        }
        for (var k = 0; k < Math.min(META_FETCH_CONCURRENCY, need.length); k++) next();
    }

    function populateSelects(data) {
        var sectorSel = $('screeningSector');
        var themeSel = $('screeningTheme');
        if (sectorSel) {
            var sectorHtml = '<option value="">전체 섹터</option>';
            (data.sectors || []).forEach(function (sector) {
                sectorHtml += '<option value="' + esc(sector) + '">' + esc(sector) + '</option>';
            });
            sectorSel.innerHTML = sectorHtml;
        }
        if (themeSel) {
            var themeHtml = '<option value="">전체 테마</option>';
            (data.themes || []).forEach(function (item) {
                var name = typeof item === 'string' ? item : item.theme;
                var count = item && item.tickers ? item.tickers : 0;
                if (!name) return;
                themeHtml += '<option value="' + esc(name) + '">' + esc(name) +
                    (count ? ' (' + count + ')' : '') + '</option>';
            });
            themeSel.innerHTML = themeHtml;
        }
    }

    function updateMeta(data) {
        var meta = $('screeningUpdatedAt');
        if (!meta) return;
        var built = formatBuiltAt(data && data.built_at);
        meta.textContent = built || '';
    }

    /** URL 쿼리(?sector=…&theme=…&cnt=…&min=…&cap=…&market=…&q=…) → select 값 동기화.
     * 리포트·종목상세 같은 다른 페이지에서 점프했을 때 필터 자동 적용. */
    function applyUrlQueryFilters() {
        var qs;
        try { qs = new URLSearchParams(window.location.search); }
        catch (e) { return; }
        if (!qs || !qs.toString()) return;
        var c = getControls();
        var sector = qs.get('sector');
        if (sector && c.sector) c.sector.value = sector;
        var theme = qs.get('theme');
        if (theme && c.theme) c.theme.value = theme;
        var market = qs.get('market');
        if (market && c.market) c.market.value = market;
        var cap = qs.get('cap');
        if (cap && c.mcap) c.mcap.value = cap;
        var minN = parseInt(qs.get('min') || '', 10);
        if (!isNaN(minN) && minN > 0 && c.minCount) c.minCount.value = String(minN);
        var cnt = qs.get('cnt');
        if (cnt && c.countKey) {
            var key = cnt.indexOf('count_') === 0 ? cnt : 'count_' + cnt;
            var valid = ['count_10', 'count_15', 'count_20', 'count_limit', 'count_recent'];
            if (valid.indexOf(key) >= 0) {
                c.countKey.value = key;
                if (c.sort) c.sort.value = key;       // 디폴트 정렬도 같은 키로
            }
        }
        var q = qs.get('q');
        if (q && c.search) c.search.value = q;
    }

    function _loadMcapAll() {
        // edge 캐시 사용 — 모든 사용자가 같은 정적 파일을 받음
        return fetch(MCAP_ALL_URL)
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; });
    }

    function _applyMcapAll(mcapAll) {
        if (!mcapAll || !mcapAll.items) return 0;
        var items = mcapAll.items;
        var filled = 0;
        for (var i = 0; i < state.tickers.length; i++) {
            var r = state.tickers[i];
            if (r && (!r.market_cap || r.market_cap <= 0)) {
                var v = items[r.ticker];
                if (typeof v === 'number' && v > 0) {
                    r.market_cap = v;
                    filled++;
                }
            }
        }
        return filled;
    }

    function loadData() {
        return Promise.all([
            fetch(DATA_URL, { cache: 'no-store' }).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            }),
            _loadMcapAll(),
        ]).then(function (results) {
            var data = results[0];
            var mcapAll = results[1];
            state.tickers = data.tickers || [];
            state.sectors = data.sectors || [];
            state.themes = data.themes || [];
            state.loaded = true;
            _applyMcapAll(mcapAll);   // 빈 시총 정적 lookup 으로 채우기 (filter·sort 전에)
            populateSelects(data);
            applyUrlQueryFilters();
            updateMeta(data);
            applyFilters();
        });
    }

    function suppressHover(target) {
        var wrap = target && target.closest ? target.closest('.ctrl-wrap') : null;
        if (!wrap) return;
        wrap.classList.add('ctrl-wrap--just-acted');
        setTimeout(function () { wrap.classList.remove('ctrl-wrap--just-acted'); }, 700);
    }

    function getRowName(ticker) {
        for (var i = 0; i < state.tickers.length; i++) {
            if (state.tickers[i].ticker === ticker) return state.tickers[i].name || ticker;
        }
        return ticker;
    }

    function openMemo(ticker) {
        var modal = $('memoModal');
        var title = $('memoModalTitle');
        var area = $('memoTextarea');
        if (!modal || !area) return;
        if (title) title.textContent = getRowName(ticker) + ' 메모';
        area.value = (state.ratings[ticker] || {}).memo || '';
        area.setAttribute('data-ticker', ticker);
        modal.style.display = 'flex';
        setTimeout(function () { area.focus(); }, 50);
    }

    function bindControls() {
        var controls = getControls();
        var searchTimer = null;
        var watchBtn = $('screeningWatchBtn');

        if (watchBtn) {
            try { state.watchlistMode = localStorage.getItem(WATCHLIST_KEY) === '1'; }
            catch (e) {}
            watchBtn.classList.toggle('is-active', state.watchlistMode);
            watchBtn.setAttribute('aria-pressed', state.watchlistMode ? 'true' : 'false');
            window.addEventListener('whyrise:auth', function () {
                if (window.WhyAuth && !window.WhyAuth.personalAllowed() && state.watchlistMode) {
                    state.watchlistMode = false;
                    watchBtn.classList.remove('is-active');
                    watchBtn.setAttribute('aria-pressed', 'false');
                    try { localStorage.setItem(WATCHLIST_KEY, '0'); } catch (e) {}
                    applyFilters();
                }
            });
            watchBtn.addEventListener('click', function () {
                if (!requirePersonal('watchlist')) return;
                state.watchlistMode = !state.watchlistMode;
                watchBtn.classList.toggle('is-active', state.watchlistMode);
                watchBtn.setAttribute('aria-pressed', state.watchlistMode ? 'true' : 'false');
                try { localStorage.setItem(WATCHLIST_KEY, state.watchlistMode ? '1' : '0'); }
                catch (e) {}
                applyFilters();
            });
        }

        if (controls.search) {
            controls.search.addEventListener('input', function () {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(applyFilters, 80);
            });
        }

        ['minCount', 'market', 'sector', 'theme', 'mcap', 'sort'].forEach(function (key) {
            if (controls[key]) controls[key].addEventListener('change', applyFilters);
        });

        if (controls.countKey) {
            controls.countKey.addEventListener('change', function () {
                if (controls.sort) controls.sort.value = controls.countKey.value;
                applyFilters();
            });
        }

        var reset = $('screeningReset');
        if (reset) {
            reset.addEventListener('click', function () {
                if (controls.search) controls.search.value = '';
                state.watchlistMode = false;
                if (watchBtn) {
                    watchBtn.classList.remove('is-active');
                    watchBtn.setAttribute('aria-pressed', 'false');
                }
                try { localStorage.setItem(WATCHLIST_KEY, '0'); } catch (e) {}
                if (controls.countKey) controls.countKey.value = 'count_10';
                if (controls.minCount) controls.minCount.value = '1';
                if (controls.market) controls.market.value = '';
                if (controls.sector) controls.sector.value = '';
                if (controls.theme) controls.theme.value = '';
                if (controls.mcap) controls.mcap.value = '';
                if (controls.sort) controls.sort.value = 'count_10';
                applyFilters();
            });
        }
    }

    function bindTableEvents() {
        var body = $('screeningBody');
        if (!body) return;
        body.addEventListener('click', function (e) {
            var star = e.target.closest('.star');
            if (star) {
                if (!requirePersonal('interest')) return;
                var starWrap = star.closest('.star-rating');
                var ticker = starWrap && starWrap.getAttribute('data-ticker');
                var n = parseInt(star.getAttribute('data-star'), 10);
                if (!ticker || !n) return;
                state.ratings[ticker] = state.ratings[ticker] || {};
                state.ratings[ticker].stars = state.ratings[ticker].stars === n ? 0 : n;
                saveRatings();
                suppressHover(star);
                applyFilters();
                return;
            }

            var exclude = e.target.closest('.exclude-btn');
            if (exclude) {
                if (!requirePersonal('exclude')) return;
                var t2 = exclude.getAttribute('data-ticker');
                if (!t2) return;
                state.ratings[t2] = state.ratings[t2] || {};
                state.ratings[t2].excluded = !state.ratings[t2].excluded;
                saveRatings();
                suppressHover(exclude);
                applyFilters();
                return;
            }

            var memo = e.target.closest('.memo-btn');
            if (memo) {
                if (!requirePersonal('memo')) return;
                openMemo(memo.getAttribute('data-ticker'));
                return;
            }

            var toggle = e.target.closest('.ctrl-toggle');
            if (toggle) {
                var wrap = toggle.closest('.ctrl-wrap');
                if (wrap) wrap.classList.toggle('is-open');
                return;
            }

            var theme = e.target.closest('.screening-theme-tag');
            if (theme) {
                var themeSel = $('screeningTheme');
                if (themeSel) {
                    themeSel.value = theme.getAttribute('data-theme') || '';
                    applyFilters();
                }
            }
        });
    }

    function bindMemoModal() {
        var modal = $('memoModal');
        var close = $('memoModalClose');
        var save = $('memoSave');
        var del = $('memoDelete');
        var area = $('memoTextarea');
        if (!modal || !area) return;

        function hide() { modal.style.display = 'none'; }
        if (close) close.addEventListener('click', hide);
        modal.addEventListener('click', function (e) { if (e.target === modal) hide(); });

        if (save) {
            save.addEventListener('click', function () {
                if (!requirePersonal('memo')) return;
                var ticker = area.getAttribute('data-ticker');
                if (!ticker) return;
                state.ratings[ticker] = state.ratings[ticker] || {};
                state.ratings[ticker].memo = area.value.trim();
                saveRatings();
                applyFilters();
                hide();
            });
        }

        if (del) {
            del.addEventListener('click', function () {
                if (!requirePersonal('memo')) return;
                var ticker = area.getAttribute('data-ticker');
                if (!ticker) return;
                if (state.ratings[ticker]) delete state.ratings[ticker].memo;
                saveRatings();
                applyFilters();
                hide();
            });
        }
    }

    function bindThemeToggle() {
        var btn = $('themeToggle');
        if (!btn) return;
        btn.addEventListener('click', function () {
            var cur = document.documentElement.getAttribute('data-theme') || 'dark';
            var next = cur === 'light' ? 'dark' : 'light';
            if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
            localStorage.setItem(THEME_KEY, next);
        });
    }

    function bindStorageSync() {
        window.addEventListener('storage', function (e) {
            if (e.key !== STORAGE_KEY) return;
            loadRatings();
            applyFilters();
        });
        window.addEventListener('whyrise:ratings-updated', function (e) {
            state.ratings = (e.detail && e.detail.ratings) || {};
            applyFilters();
        });
    }

    function showError(message) {
        var msg = $('screeningMessage');
        var loading = $('screeningLoading');
        if (loading) loading.style.display = 'none';
        if (msg) {
            msg.textContent = message;
            msg.style.display = 'block';
        }
    }

    function init() {
        loadRatings();
        bindThemeToggle();
        bindControls();
        bindTableEvents();
        bindMemoModal();
        bindStorageSync();

        loadData().then(function () {
            if (window.WhyRatingsSync) {
                window.WhyRatingsSync.pull().then(function (result) {
                    if (result && result.ratings) {
                        state.ratings = result.ratings;
                        applyFilters();
                    }
                });
            }
        }).catch(function (err) {
            showError('스크리닝 데이터 로딩 실패: ' + (err.message || err));
        });
    }

    return { init: init };
})();

document.addEventListener('DOMContentLoaded', WhyScreening.init);
