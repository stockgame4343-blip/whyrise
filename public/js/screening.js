/**
 * 스크리닝 페이지 — /screening.html
 *
 * /data/screening.json 한 번 fetch → 필터(횟수/섹터/테마/시총) 클라이언트 적용 →
 * WhyTable.render 로 홈과 동일한 행 UI 표시. 관심·메모·제외는 whyrise-ratings
 * localStorage 키 + WhyRatingsSync 로 홈/종목상세와 자동 공유.
 */
var WhyScreening = (function () {

    var STORAGE_KEY = 'whyrise-ratings';
    var THEME_KEY = 'theme';
    var INDEX_URL = '/data/screening.json';

    // 횟수 칩 정의 — kind 키는 screening.json 의 count_* 필드명과 일치
    var COUNT_KINDS = [
        { kind: '15',     label: '+15% 이상',      field: 'count_15' },
        { kind: '10',     label: '+10% 이상',      field: 'count_10' },
        { kind: '20',     label: '+20% 이상',      field: 'count_20' },
        { kind: 'limit',  label: '상한가',          field: 'count_limit' },
        { kind: 'recent', label: '최근 30일',       field: 'count_recent' },
    ];
    var COUNT_STEPS = [1, 3, 5, 10];

    // 시총 분류 (억원 단위) — screening.json 의 market_cap 과 일치
    var CAP_RANGES = {
        all:   { min: 0,      max: Infinity },
        small: { min: 1,      max: 20000 },        // 0 (정보없음) 제외
        mid:   { min: 20000,  max: 100000 },
        large: { min: 100000, max: Infinity },
    };

    var state = {
        loaded: false,
        tickers: [],
        sectors: [],
        themes: [],
        ratings: {},
        filters: {
            countKind: '15',
            countMin: 1,
            sector: '',
            theme: '',
            cap: 'all',
        },
    };

    function loadRatings() {
        try { state.ratings = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
        catch (e) { state.ratings = {}; }
    }
    function saveRatings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.ratings)); }
        catch (e) {}
        if (window.WhyRatingsSync) window.WhyRatingsSync.push(state.ratings);
    }

    /** URL 쿼리 → state.filters */
    function syncFromURL() {
        var qs = new URLSearchParams(window.location.search);
        var cnt = qs.get('cnt');
        if (cnt) {
            // 유효 kind 만 적용
            for (var i = 0; i < COUNT_KINDS.length; i++) {
                if (COUNT_KINDS[i].kind === cnt) { state.filters.countKind = cnt; break; }
            }
        }
        var min = parseInt(qs.get('min') || '', 10);
        if (!isNaN(min) && min >= 0) state.filters.countMin = min;
        var sec = qs.get('sector') || '';
        if (sec) state.filters.sector = sec;
        var thm = qs.get('theme') || '';
        if (thm) state.filters.theme = thm;
        var cap = qs.get('cap') || '';
        if (CAP_RANGES[cap]) state.filters.cap = cap;
    }
    /** state.filters → URL (history.replaceState — 뒤로가기 폭증 방지) */
    function syncToURL() {
        var f = state.filters;
        var qs = new URLSearchParams();
        if (f.countKind !== '15' || f.countMin !== 1) {
            qs.set('cnt', f.countKind);
            qs.set('min', String(f.countMin));
        }
        if (f.sector) qs.set('sector', f.sector);
        if (f.theme) qs.set('theme', f.theme);
        if (f.cap && f.cap !== 'all') qs.set('cap', f.cap);
        var q = qs.toString();
        var url = window.location.pathname + (q ? ('?' + q) : '') + window.location.hash;
        window.history.replaceState(null, '', url);
    }

    function loadIndex() {
        return fetch(INDEX_URL, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                state.tickers = data.tickers || [];
                state.sectors = data.sectors || [];
                state.themes = data.themes || [];
                state.loaded = true;
            });
    }

    /** 필터 통과 종목 추출. */
    function applyFilters() {
        var f = state.filters;
        var capRange = CAP_RANGES[f.cap] || CAP_RANGES.all;
        var kindInfo = COUNT_KINDS.find(function (k) { return k.kind === f.countKind; }) || COUNT_KINDS[0];
        var countField = kindInfo.field;
        var minCnt = f.countMin > 0 ? f.countMin : 0;
        var out = [];
        for (var i = 0; i < state.tickers.length; i++) {
            var t = state.tickers[i];
            if (minCnt > 0 && (t[countField] || 0) < minCnt) continue;
            if (f.sector && t.sector !== f.sector) continue;
            if (f.theme && (!t.themes || t.themes.indexOf(f.theme) < 0)) continue;
            var mc = t.market_cap || 0;
            if (mc < capRange.min || mc >= capRange.max) continue;
            out.push(t);
        }
        return out;
    }

    /** screening.json 행 → WhyTable.render 가 기대하는 ranking 행 객체. */
    function mapToRankingRows(rows) {
        return rows.map(function (t) {
            return {
                ticker: t.ticker,
                name: t.name,
                market: t.market || '',
                sector: t.sector || '',
                change_rate: (t.latest_change_rate != null) ? t.latest_change_rate : null,
                trading_value: null,
                market_cap: t.market_cap || null,
                rise_reason: t.latest_reason || '',
                theme_tag: t.latest_theme || '',
                news: [],
            };
        });
    }

    function applyFiltersAndRender() {
        if (!state.loaded) return;
        var filtered = applyFilters();
        var rows = mapToRankingRows(filtered);
        rows.forEach(function (r, i) { r._displayRank = i + 1; });

        var $count = document.getElementById('resultCount');
        if ($count) {
            $count.textContent = '조건 일치 ' + rows.length.toLocaleString('ko-KR') + '개';
        }

        var $loading = document.getElementById('loading');
        if ($loading) $loading.style.display = 'none';

        WhyTable.render(rows, state.ratings, {
            date: '',
            emptyMsg: '조건에 맞는 종목이 없습니다. 필터를 조정해 보세요.',
        });
        updateActiveCount();
    }

    // ─── 필터 UI 렌더 ────────────────────────────────

    function renderCountFilters() {
        var $wrap = document.getElementById('countFilters');
        if (!$wrap) return;
        var html = '';
        COUNT_KINDS.forEach(function (k) {
            var isActive = (state.filters.countKind === k.kind);
            html += '<div class="filter-count-row' + (isActive ? ' filter-count-row--active' : '') + '" data-kind="' + k.kind + '">';
            html += '<button type="button" class="filter-count-row__chip" data-kind="' + k.kind + '">' + k.label + '</button>';
            html += '<div class="filter-count-row__steps">';
            COUNT_STEPS.forEach(function (n) {
                var stepActive = (isActive && state.filters.countMin === n);
                html += '<button type="button" class="filter-count-step' +
                    (stepActive ? ' filter-count-step--active' : '') +
                    '" data-kind="' + k.kind + '" data-min="' + n + '">' + n + '회+</button>';
            });
            html += '</div></div>';
        });
        $wrap.innerHTML = html;
    }

    function populateSectorSelect() {
        var $sel = document.getElementById('sectorSelect');
        if (!$sel) return;
        // 기존 옵션 (전체 섹터) 보존 후 추가
        var html = '<option value="">전체 섹터</option>';
        state.sectors.forEach(function (s) {
            html += '<option value="' + s.replace(/"/g, '&quot;') + '"' +
                (state.filters.sector === s ? ' selected' : '') + '>' + s + '</option>';
        });
        $sel.innerHTML = html;
    }

    function populateThemeSelect() {
        var $sel = document.getElementById('themeSelect');
        if (!$sel) return;
        var html = '<option value="">전체 테마</option>';
        state.themes.forEach(function (t) {
            var name = t.theme;
            var count = t.tickers || 0;
            html += '<option value="' + name.replace(/"/g, '&quot;') + '"' +
                (state.filters.theme === name ? ' selected' : '') + '>' +
                name + ' (' + count + ')</option>';
        });
        $sel.innerHTML = html;
    }

    function updateCapChips() {
        var $chips = document.querySelectorAll('#capChips .cap-chip');
        for (var i = 0; i < $chips.length; i++) {
            var c = $chips[i];
            var active = (c.getAttribute('data-cap') === state.filters.cap);
            c.classList.toggle('cap-chip--active', active);
            c.setAttribute('aria-checked', active ? 'true' : 'false');
        }
    }

    function updateActiveCount() {
        var $badge = document.getElementById('filterActiveCount');
        if (!$badge) return;
        var n = 0;
        var f = state.filters;
        if (!(f.countKind === '15' && f.countMin === 1)) n++;
        if (f.sector) n++;
        if (f.theme) n++;
        if (f.cap && f.cap !== 'all') n++;
        if (n > 0) {
            $badge.textContent = String(n);
            $badge.hidden = false;
        } else {
            $badge.hidden = true;
        }
    }

    // ─── 필터 이벤트 ────────────────────────────────

    function bindFilterEvents() {
        // 횟수 칩 — 칩 클릭 = 그 kind 로 토글, 단계 버튼 클릭 = kind + min 설정
        var $countWrap = document.getElementById('countFilters');
        if ($countWrap) {
            $countWrap.addEventListener('click', function (e) {
                var stepBtn = e.target.closest('.filter-count-step');
                if (stepBtn) {
                    var kind = stepBtn.getAttribute('data-kind');
                    var min = parseInt(stepBtn.getAttribute('data-min'), 10);
                    if (state.filters.countKind === kind && state.filters.countMin === min) {
                        // 재클릭 → 비활성 (min=0)
                        state.filters.countMin = 0;
                    } else {
                        state.filters.countKind = kind;
                        state.filters.countMin = min || 1;
                    }
                    renderCountFilters();
                    syncToURL();
                    applyFiltersAndRender();
                    return;
                }
                var chip = e.target.closest('.filter-count-row__chip');
                if (chip) {
                    var kind2 = chip.getAttribute('data-kind');
                    if (state.filters.countKind === kind2) {
                        // 같은 kind 재클릭 → 활성/비활성 토글
                        state.filters.countMin = state.filters.countMin > 0 ? 0 : 1;
                    } else {
                        state.filters.countKind = kind2;
                        if (state.filters.countMin <= 0) state.filters.countMin = 1;
                    }
                    renderCountFilters();
                    syncToURL();
                    applyFiltersAndRender();
                }
            });
        }

        // 섹터 / 테마 드롭다운
        var $sectorSel = document.getElementById('sectorSelect');
        if ($sectorSel) $sectorSel.addEventListener('change', function () {
            state.filters.sector = $sectorSel.value || '';
            syncToURL();
            applyFiltersAndRender();
        });
        var $themeSel = document.getElementById('themeSelect');
        if ($themeSel) $themeSel.addEventListener('change', function () {
            state.filters.theme = $themeSel.value || '';
            syncToURL();
            applyFiltersAndRender();
        });

        // 시총 칩
        var $capChips = document.getElementById('capChips');
        if ($capChips) $capChips.addEventListener('click', function (e) {
            var btn = e.target.closest('.cap-chip');
            if (!btn) return;
            state.filters.cap = btn.getAttribute('data-cap') || 'all';
            updateCapChips();
            syncToURL();
            applyFiltersAndRender();
        });

        // 초기화
        var $reset = document.getElementById('filterReset');
        if ($reset) $reset.addEventListener('click', function () {
            state.filters = {
                countKind: '15', countMin: 1,
                sector: '', theme: '', cap: 'all',
            };
            renderCountFilters();
            populateSectorSelect();
            populateThemeSelect();
            updateCapChips();
            syncToURL();
            applyFiltersAndRender();
        });
    }

    // ─── 모바일 필터 토글 ─────────────────────────────

    function bindMobileToggle() {
        var $btn = document.getElementById('filterToggle');
        var $panel = document.getElementById('screeningFilters');
        if (!$btn || !$panel) return;
        $btn.addEventListener('click', function () {
            var open = !$panel.classList.contains('screening-filters--open');
            $panel.classList.toggle('screening-filters--open', open);
            $btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
    }

    // ─── 별점 / 메모 / 제외 / ⋯ 이벤트 (whyrise.js 패턴 그대로) ─────

    function bindRatingsEvents() {
        var $body = document.getElementById('rankingBody');
        if (!$body) return;
        $body.addEventListener('click', function (e) {
            var star = e.target.closest('.star');
            if (star) {
                var ticker = star.parentNode.getAttribute('data-ticker');
                var n = parseInt(star.getAttribute('data-star'), 10);
                if (!ticker || !n) return;
                state.ratings[ticker] = state.ratings[ticker] || {};
                if (state.ratings[ticker].stars === n) state.ratings[ticker].stars = 0;
                else state.ratings[ticker].stars = n;
                saveRatings();
                applyFiltersAndRender();
                return;
            }
            var ex = e.target.closest('.exclude-btn');
            if (ex) {
                var t2 = ex.getAttribute('data-ticker');
                state.ratings[t2] = state.ratings[t2] || {};
                state.ratings[t2].excluded = !state.ratings[t2].excluded;
                saveRatings();
                applyFiltersAndRender();
                return;
            }
            var memo = e.target.closest('.memo-btn');
            if (memo) {
                openMemo(memo.getAttribute('data-ticker'));
                return;
            }
            var toggle = e.target.closest('.ctrl-toggle');
            if (toggle) {
                toggle.parentNode.classList.toggle('is-open');
                return;
            }
        });
    }

    function getStockEntry(ticker) {
        for (var i = 0; i < state.tickers.length; i++) {
            if (state.tickers[i].ticker === ticker) return state.tickers[i];
        }
        return null;
    }

    function openMemo(ticker) {
        var $modal = document.getElementById('memoModal');
        var $title = document.getElementById('memoModalTitle');
        var $area = document.getElementById('memoTextarea');
        if (!$modal || !$area) return;
        var entry = getStockEntry(ticker);
        if ($title) $title.textContent = (entry ? entry.name : ticker) + ' 메모';
        var rating = state.ratings[ticker] || {};
        $area.value = rating.memo || '';
        $area.setAttribute('data-ticker', ticker);
        $modal.style.display = 'flex';
        setTimeout(function () { $area.focus(); }, 50);
    }

    function bindMemoModal() {
        var $modal = document.getElementById('memoModal');
        var $close = document.getElementById('memoModalClose');
        var $save = document.getElementById('memoSave');
        var $del = document.getElementById('memoDelete');
        var $area = document.getElementById('memoTextarea');
        if (!$modal) return;
        if ($close) $close.addEventListener('click', function () { $modal.style.display = 'none'; });
        $modal.addEventListener('click', function (e) { if (e.target === $modal) $modal.style.display = 'none'; });
        if ($save) $save.addEventListener('click', function () {
            var ticker = $area.getAttribute('data-ticker');
            if (!ticker) return;
            state.ratings[ticker] = state.ratings[ticker] || {};
            state.ratings[ticker].memo = $area.value.trim();
            saveRatings();
            applyFiltersAndRender();
            $modal.style.display = 'none';
        });
        if ($del) $del.addEventListener('click', function () {
            var ticker = $area.getAttribute('data-ticker');
            if (!ticker) return;
            if (state.ratings[ticker]) delete state.ratings[ticker].memo;
            saveRatings();
            applyFiltersAndRender();
            $modal.style.display = 'none';
        });
    }

    function bindNewsModal() {
        var $modal = document.getElementById('newsModal');
        var $close = document.getElementById('newsModalClose');
        if ($close) $close.addEventListener('click', WhyTable.closeNews);
        if ($modal) $modal.addEventListener('click', function (e) {
            if (e.target === $modal) WhyTable.closeNews();
        });
    }

    function bindThemeToggle() {
        var $btn = document.getElementById('themeToggle');
        if (!$btn) return;
        $btn.addEventListener('click', function () {
            var cur = document.documentElement.getAttribute('data-theme') || 'dark';
            var next = cur === 'light' ? 'dark' : 'light';
            if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
            localStorage.setItem(THEME_KEY, next);
        });
    }

    // ─── 다른 탭에서 별점/메모 변경 시 자동 반영 ───────

    function bindStorageSync() {
        window.addEventListener('storage', function (e) {
            if (e.key !== STORAGE_KEY) return;
            loadRatings();
            applyFiltersAndRender();
        });
    }

    function showError(msg) {
        var $msg = document.getElementById('message');
        var $loading = document.getElementById('loading');
        if ($loading) $loading.style.display = 'none';
        if ($msg) {
            $msg.textContent = msg;
            $msg.style.display = 'block';
        }
    }

    function init() {
        loadRatings();
        bindThemeToggle();
        bindFilterEvents();
        bindMobileToggle();
        bindRatingsEvents();
        bindMemoModal();
        bindNewsModal();
        bindStorageSync();

        syncFromURL();

        loadIndex().then(function () {
            renderCountFilters();
            populateSectorSelect();
            populateThemeSelect();
            updateCapChips();
            applyFiltersAndRender();

            // 서버 별점 동기화 — 머지되면 다시 그림
            if (window.WhyRatingsSync) {
                window.WhyRatingsSync.pull().then(function (result) {
                    if (result && result.source === 'remote') {
                        loadRatings();
                        applyFiltersAndRender();
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
