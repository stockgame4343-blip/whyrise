/**
 * 주도주2 — existing visualizers in one shell.
 */
(function () {
    'use strict';

    var VIEWS = {
        flow: {
            label: '주도주',
            title: '주도주',
            src: '/flowmap.html?embed=leaders2',
        },
        bubble: {
            label: '버블맵',
            title: '버블맵',
            src: '/bubbles2.html?embed=leaders2',
        },
        tree: {
            label: '트리맵',
            title: '트리맵',
            src: '/treemap.html?embed=leaders2',
        },
    };

    var STORAGE_KEY = 'whyrise-leaders2-view';
    var $tabs = Array.prototype.slice.call(document.querySelectorAll('.leaders2-tab'));
    var $stack = document.getElementById('leaders2Stack');
    var $loading = document.getElementById('leaders2Loading');
    var frames = {};
    var active = localStorage.getItem(STORAGE_KEY) || 'flow';
    if (!VIEWS[active]) active = 'flow';

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }

    function applyTheme(theme) {
        if (theme === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        localStorage.setItem('theme', theme);
        Object.keys(frames).forEach(function (key) {
            var frame = frames[key];
            if (!frame || !frame.contentDocument) return;
            if (theme === 'light') frame.contentDocument.documentElement.setAttribute('data-theme', 'light');
            else frame.contentDocument.documentElement.removeAttribute('data-theme');
        });
    }

    function bindThemeToggle() {
        var btn = document.getElementById('themeToggle');
        if (!btn) return;
        btn.addEventListener('click', function () {
            applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
        });
    }

    function embedCss() {
        return [
            'html,body{height:100%;}',
            'body.leaders2-embedded{margin:0!important;overflow:hidden!important;}',
            'body.leaders2-embedded .top-bar{display:none!important;}',
            'body.leaders2-embedded .tmap-bar{border-top:0!important;}',
            'body.leaders2-embedded .tmap-bar__inner{max-width:none!important;padding-left:16px!important;padding-right:16px!important;}',
            'body.leaders2-embedded .tmap-stage{min-height:0!important;}',
            'body.leaders2-embedded .date-picker{z-index:9999!important;}',
            '@media (max-width:768px){',
            'body.leaders2-embedded .tmap-bar__inner{padding-left:10px!important;padding-right:10px!important;}',
            'body.leaders2-embedded .tmap-bar__right{justify-content:flex-start!important;}',
            '}',
        ].join('\n');
    }

    function nudgeFrame(frame) {
        try {
            frame.contentWindow.dispatchEvent(new Event('resize'));
            setTimeout(function () {
                frame.contentWindow.dispatchEvent(new Event('resize'));
            }, 220);
        } catch (err) {}
    }

    function markLoaded(key) {
        if (key === active && $loading) $loading.style.display = 'none';
        var frame = frames[key];
        if (frame) frame.classList.add('is-loaded');
    }

    function prepareFrame(key, frame) {
        try {
            var doc = frame.contentDocument;
            if (!doc || !doc.body) {
                markLoaded(key);
                return;
            }
            doc.body.classList.add('leaders2-embedded');
            if (currentTheme() === 'light') doc.documentElement.setAttribute('data-theme', 'light');
            else doc.documentElement.removeAttribute('data-theme');

            var style = doc.getElementById('leaders2EmbedStyle');
            if (!style) {
                style = doc.createElement('style');
                style.id = 'leaders2EmbedStyle';
                doc.head.appendChild(style);
            }
            style.textContent = embedCss();
            markLoaded(key);
            nudgeFrame(frame);
        } catch (err) {
            markLoaded(key);
        }
    }

    function ensureFrame(key) {
        if (frames[key]) return frames[key];
        var view = VIEWS[key];
        var frame = document.createElement('iframe');
        frame.className = 'leaders2-frame';
        frame.title = view.title;
        frame.loading = key === 'flow' ? 'eager' : 'lazy';
        frame.setAttribute('referrerpolicy', 'same-origin');
        frame.setAttribute('data-view', key);
        frame.addEventListener('load', function () {
            prepareFrame(key, frame);
        });
        frames[key] = frame;
        $stack.appendChild(frame);
        frame.src = view.src;
        return frame;
    }

    function updateTabs(key) {
        $tabs.forEach(function (tab) {
            var on = tab.getAttribute('data-view') === key;
            tab.classList.toggle('is-active', on);
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
        });
    }

    function setView(key) {
        if (!VIEWS[key] || !$stack) return;
        active = key;
        localStorage.setItem(STORAGE_KEY, key);
        updateTabs(key);
        if ($loading) $loading.style.display = frames[key] && frames[key].classList.contains('is-loaded') ? 'none' : '';
        Object.keys(frames).forEach(function (name) {
            frames[name].classList.toggle('is-active', name === key);
            frames[name].setAttribute('aria-hidden', name === key ? 'false' : 'true');
        });
        var frame = ensureFrame(key);
        Object.keys(frames).forEach(function (name) {
            frames[name].classList.toggle('is-active', name === key);
            frames[name].setAttribute('aria-hidden', name === key ? 'false' : 'true');
        });
        nudgeFrame(frame);
    }

    function bindTabs() {
        $tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                setView(tab.getAttribute('data-view'));
            });
        });
    }

    function init() {
        bindThemeToggle();
        bindTabs();
        setView(active);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
