/**
 * 주도주2 — 주도주/버블맵/트리맵 세부 메뉴 통합.
 *
 * - 주도섹터/핫테마: 기존 flowmap 로직 그대로 사용
 * - 시총/거래량/상승률: 기존 버블맵/트리맵 marketmap 로직 사용
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'whyrise-leaders2-state-v2';
    var LEADER_METRICS = { sector: 1, theme: 1 };
    var MARKET_METRICS = { mcap: 1, volume: 1, change: 1 };

    var ENGINES = {
        flow: '/flowmap.html?embed=leaders2&v=20260524j',
        bubble: '/bubbles2.html?embed=leaders2&v=20260524j',
        tree: '/treemap.html?embed=leaders2&v=20260524j',
    };

    var $stack = document.getElementById('leaders2Stack');
    var $loading = document.getElementById('leaders2Loading');
    var $date = document.getElementById('leaders2Date');
    var $liveWrap = document.getElementById('leaders2LiveWrap');
    var $live = document.getElementById('leaders2Live');
    var $ringFg = document.getElementById('leaders2RingFg');
    var $prev = document.getElementById('leaders2DatePrev');
    var $next = document.getElementById('leaders2DateNext');
    var $back = document.getElementById('leaders2Back');
    var $save = document.getElementById('leaders2Save');
    var $marketControls = document.getElementById('leaders2MarketControls');
    var frames = {};
    var syncTimer = null;
    var pendingDate = '';

    var state = readState();

    function readState() {
        var base = {
            view: 'tree',
            metric: 'sector',
            market: 'ALL',
            period: '1d',
            date: '',
        };
        try {
            var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            Object.keys(base).forEach(function (key) {
                if (saved[key]) base[key] = saved[key];
            });
        } catch (err) {}
        if (base.view !== 'bubble' && base.view !== 'tree') base.view = 'tree';
        if (!LEADER_METRICS[base.metric] && !MARKET_METRICS[base.metric]) base.metric = 'sector';
        if (['ALL', 'KOSPI', 'KOSDAQ'].indexOf(base.market) < 0) base.market = 'ALL';
        if (['1d', '1w', '1m', '3m', '1y'].indexOf(base.period) < 0) base.period = '1d';
        if (!/^\d{8}$/.test(base.date)) base.date = '';
        return base;
    }

    function saveState() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }

    function applyTheme(theme) {
        if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
        else document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('theme', theme);
        Object.keys(frames).forEach(function (key) {
            var frame = frames[key];
            applyFrameTheme(frame);
            if (frame && frame.classList.contains('is-active')) nudgeFrame(frame);
        });
    }

    function applyFrameTheme(frame) {
        if (!frame || !frame.contentDocument) return;
        if (currentTheme() === 'light') frame.contentDocument.documentElement.setAttribute('data-theme', 'light');
        else frame.contentDocument.documentElement.removeAttribute('data-theme');
    }

    function bindThemeToggle() {
        var btn = document.getElementById('themeToggle');
        if (!btn) return;
        btn.addEventListener('click', function () {
            applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
        });
    }

    function isMarketMetric() {
        return !!MARKET_METRICS[state.metric];
    }

    function engineForState() {
        if (LEADER_METRICS[state.metric]) return 'flow';
        return state.view === 'tree' ? 'tree' : 'bubble';
    }

    function queryAll(sel) {
        return Array.prototype.slice.call(document.querySelectorAll(sel));
    }

    function setActive(selector, attr, value) {
        queryAll(selector).forEach(function (btn) {
            var on = btn.getAttribute(attr) === value;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
    }

    function setDisabled(selector, disabled) {
        queryAll(selector).forEach(function (btn) {
            btn.disabled = disabled;
            btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        });
    }

    function updateControls() {
        var marketEnabled = isMarketMetric();
        setActive('[data-view]', 'data-view', state.view);
        setActive('[data-metric]', 'data-metric', state.metric);
        setActive('[data-market]', 'data-market', state.market);
        setActive('[data-period]', 'data-period', state.period);
        setDisabled('[data-market], [data-period]', !marketEnabled);
        if ($marketControls) {
            $marketControls.hidden = false;
            $marketControls.classList.toggle('is-disabled', !marketEnabled);
            $marketControls.setAttribute('aria-disabled', marketEnabled ? 'false' : 'true');
        }
    }

    function embedCss() {
        return [
            'html,body{height:100%;}',
            'body.leaders2-embedded{margin:0!important;overflow:hidden!important;}',
            'body.leaders2-embedded .top-bar{display:none!important;}',
            'body.leaders2-embedded .tmap-bar{display:none!important;}',
            'body.leaders2-embedded .tmap-stage{min-height:0!important;}',
            'body.leaders2-embedded .date-picker{z-index:9999!important;}',
        ].join('\n');
    }

    function prepareFrame(name, frame) {
        try {
            var doc = frame.contentDocument;
            if (!doc || !doc.body) return;
            doc.body.classList.add('leaders2-embedded');
            applyFrameTheme(frame);
            var style = doc.getElementById('leaders2EmbedStyle');
            if (!style) {
                style = doc.createElement('style');
                style.id = 'leaders2EmbedStyle';
                doc.head.appendChild(style);
            }
            style.textContent = embedCss();
            frame.classList.add('is-loaded');
            driveActiveFrame();
        } catch (err) {
            frame.classList.add('is-loaded');
        }
    }

    function ensureFrame(name) {
        if (frames[name]) return frames[name];
        var frame = document.createElement('iframe');
        frame.className = 'leaders2-frame';
        frame.title = name === 'flow' ? '주도 섹터와 핫 테마' : (name === 'tree' ? '트리맵' : '버블맵');
        frame.loading = name === 'flow' ? 'eager' : 'lazy';
        frame.setAttribute('referrerpolicy', 'same-origin');
        frame.setAttribute('data-engine', name);
        frame.addEventListener('load', function () {
            prepareFrame(name, frame);
        });
        frames[name] = frame;
        $stack.appendChild(frame);
        frame.src = ENGINES[name];
        return frame;
    }

    function clickInFrame(frame, selector) {
        try {
            var el = frame.contentDocument && frame.contentDocument.querySelector(selector);
            if (el) {
                el.click();
                return true;
            }
        } catch (err) {}
        return false;
    }

    function textInFrame(frame, selector, fallback) {
        try {
            var el = frame.contentDocument && frame.contentDocument.querySelector(selector);
            return el ? (el.textContent || '').trim() : fallback;
        } catch (err) {
            return fallback;
        }
    }

    function visibleInFrame(frame, selector) {
        try {
            var el = frame.contentDocument && frame.contentDocument.querySelector(selector);
            if (!el) return false;
            var style = frame.contentWindow.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        } catch (err) {
            return false;
        }
    }

    function nudgeFrame(frame) {
        try {
            setTimeout(function () {
                frame.contentWindow.dispatchEvent(new frame.contentWindow.Event('resize'));
            }, 80);
        } catch (err) {}
    }

    function getBridge() {
        var frame = frames[engineForState()];
        try {
            return frame && frame.contentWindow && frame.contentWindow.WhyRiseTmapBridge;
        } catch (err) {
            return null;
        }
    }

    function applySelectedDate(bridge) {
        if (!bridge || !state.date || !bridge.getDates || !bridge.gotoDate) return;
        if (pendingDate && pendingDate === state.date) return;
        var dates = bridge.getDates() || [];
        if (dates.indexOf(state.date) < 0) return;
        if (bridge.getCurrentDate && bridge.getCurrentDate() === state.date) return;
        pendingDate = state.date;
        bridge.gotoDate(state.date);
    }

    function syncChrome() {
        var bridge = getBridge();
        var frame = frames[engineForState()];
        var chrome = bridge && bridge.getChrome ? bridge.getChrome() : null;
        if (!frame) return;
        if (bridge) applySelectedDate(bridge);

        if (bridge && bridge.getCurrentDate) {
            var currentDate = bridge.getCurrentDate();
            var dates = bridge.getDates ? (bridge.getDates() || []) : [];
            if (pendingDate) {
                if (currentDate === pendingDate || dates.indexOf(pendingDate) < 0) pendingDate = '';
            }
            if (!pendingDate && currentDate && currentDate !== state.date) {
                state.date = currentDate;
                saveState();
            }
        }

        if ($date) $date.textContent = chrome && chrome.dateText ? chrome.dateText : textInFrame(frame, '#tmapDate', '—');
        if ($live) $live.textContent = chrome && chrome.liveText ? chrome.liveText : textInFrame(frame, '#tmapLiveLabel', 'LIVE');
        if ($liveWrap && chrome) $liveWrap.classList.toggle('tmap-live--idle', !!chrome.liveIdle);
        if ($ringFg && chrome) {
            $ringFg.style.transition = chrome.ringTransition || '';
            $ringFg.style.strokeDashoffset = chrome.ringDashoffset || '';
        }
        if ($prev && chrome) $prev.disabled = !!chrome.prevDisabled;
        if ($next && chrome) $next.disabled = !!chrome.nextDisabled;
        if ($back) $back.hidden = chrome ? !chrome.backVisible : !visibleInFrame(frame, '#tmapBack');
        if ($loading) {
            var loaded = frame.classList.contains('is-loaded');
            var innerLoading = chrome ? chrome.loadingVisible : visibleInFrame(frame, '#tmapLoading');
            $loading.style.display = loaded && !innerLoading ? 'none' : '';
        }
    }

    function beginSync() {
        if (syncTimer) clearInterval(syncTimer);
        syncChrome();
        syncTimer = setInterval(syncChrome, 500);
    }

    function driveActiveFrame() {
        var engine = engineForState();
        var frame = frames[engine];
        if (!frame || !frame.classList.contains('is-loaded')) return;
        var bridge = getBridge();
        if (!bridge) return;

        if (engine === 'flow') {
            if (bridge.setMode) bridge.setMode(state.metric);
            if (bridge.setView) bridge.setView(state.view);
        } else {
            if (bridge.setSort) bridge.setSort(state.metric);
            if (bridge.setFilter) bridge.setFilter(state.market);
            if (bridge.setPeriod) bridge.setPeriod(state.period);
        }
        applySelectedDate(bridge);

        syncChrome();
    }

    function showActiveFrame() {
        var engine = engineForState();
        var existingActiveFrame = frames[engine];
        var wasActive = existingActiveFrame && existingActiveFrame.classList.contains('is-active');
        Object.keys(ENGINES).forEach(function (name) {
            var frame = frames[name];
            if (!frame) return;
            var on = name === engine;
            frame.classList.toggle('is-active', on);
            frame.setAttribute('aria-hidden', on ? 'false' : 'true');
        });
        var activeFrame = ensureFrame(engine);
        activeFrame.classList.add('is-active');
        activeFrame.setAttribute('aria-hidden', 'false');
        if ($loading) $loading.style.display = activeFrame.classList.contains('is-loaded') ? 'none' : '';
        driveActiveFrame();
        if (wasActive === false && activeFrame.classList.contains('is-loaded')) nudgeFrame(activeFrame);
        beginSync();
    }

    function applyState() {
        saveState();
        updateControls();
        showActiveFrame();
    }

    function dateAtBridgeIndex(bridge) {
        if (!bridge || !bridge.getDates || !bridge.getDateIndex) return '';
        var dates = bridge.getDates() || [];
        var index = bridge.getDateIndex();
        return dates[index] || '';
    }

    function relayAction(action, fallbackSelector) {
        var bridge = getBridge();
        var frame = frames[engineForState()];
        if (bridge && bridge[action]) {
            var isDateNav = action === 'prevDate' || action === 'nextDate';
            if (isDateNav) pendingDate = '';
            bridge[action]();
            if (isDateNav) {
                var targetDate = dateAtBridgeIndex(bridge);
                if (targetDate) {
                    state.date = targetDate;
                    pendingDate = targetDate;
                    saveState();
                }
            }
        } else if (frame && fallbackSelector) {
            clickInFrame(frame, fallbackSelector);
        }
        setTimeout(syncChrome, 120);
    }

    function openDatePicker() {
        var bridge = getBridge();
        if (!bridge || !window.DatePicker || !bridge.getDates) return;
        var dates = bridge.getDates() || [];
        if (!dates.length) return;
        DatePicker.open({
            trigger: $date,
            dates: dates,
            current: (bridge.getCurrentDate && bridge.getCurrentDate()) || state.date || dates[0],
            onSelect: function (picked) {
                state.date = picked;
                pendingDate = picked;
                saveState();
                if (bridge.gotoDate) bridge.gotoDate(picked);
                setTimeout(syncChrome, 120);
            },
        });
    }

    function bindControls() {
        queryAll('[data-view]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.view = btn.getAttribute('data-view');
                applyState();
            });
        });
        queryAll('[data-metric]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.metric = btn.getAttribute('data-metric');
                applyState();
            });
        });
        queryAll('[data-market]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                if (!isMarketMetric()) return;
                state.market = btn.getAttribute('data-market');
                applyState();
            });
        });
        queryAll('[data-period]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                if (!isMarketMetric()) return;
                state.period = btn.getAttribute('data-period');
                applyState();
            });
        });

        if ($prev) $prev.addEventListener('click', function () { relayAction('prevDate', '#tmapDatePrev'); });
        if ($next) $next.addEventListener('click', function () { relayAction('nextDate', '#tmapDateNext'); });
        if ($date) $date.addEventListener('click', openDatePicker);
        if ($back) $back.addEventListener('click', function () { relayAction('reset', '#tmapBack'); });
        if ($save) $save.addEventListener('click', function () { relayAction('save', '#tmapSave'); });
    }

    function init() {
        bindThemeToggle();
        bindControls();
        applyState();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
