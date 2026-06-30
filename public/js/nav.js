/**
 * Shared top navigation: mobile drawer, theme mirror item, and theme icon sync.
 */
(function () {
    'use strict';

    // Vercel Web Analytics — 정적 사이트용 스크립트 주입(@vercel/analytics 의 inject() 동등).
    // 빌드 단계가 없어 npm 패키지를 못 쓰므로 Vercel 이 자동 서빙하는 /_vercel/insights/script.js 를 로드.
    // (Vercel 대시보드에서 프로젝트 Analytics 를 켜야 실제 수집이 시작된다.)
    (function () {
        if (window.__vaInjected) return;
        window.__vaInjected = true;
        window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
        var s = document.createElement('script');
        s.defer = true;
        s.src = '/_vercel/insights/script.js';
        document.head.appendChild(s);
    })();

    var btn = document.getElementById('navToggle');
    var nav = document.querySelector('.top-bar__nav');
    if (!btn || !nav) return;

    var moonIcon =
        '<svg class="theme-toggle__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    var sunIcon =
        '<svg class="theme-toggle__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="4"/>' +
        '<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }

    function updateThemeIcons() {
        var theme = currentTheme();
        var icon = theme === 'light' ? sunIcon : moonIcon;
        var label = theme === 'light' ? '라이트 모드' : '다크 모드';
        var title = theme === 'light' ? '라이트 모드, 다크 모드로 전환' : '다크 모드, 라이트 모드로 전환';
        var orig = document.getElementById('themeToggle');
        if (orig) {
            orig.innerHTML = icon;
            orig.setAttribute('title', title);
            orig.setAttribute('aria-label', title);
        }
        var item = nav.querySelector('.top-bar__theme-item');
        if (item) {
            item.innerHTML = icon + '<span class="top-bar__theme-item-label">' + label + '</span>';
            item.setAttribute('aria-label', title);
        }
    }

    function injectThemeItem() {
        var orig = document.getElementById('themeToggle');
        if (!orig || nav.querySelector('.top-bar__theme-item')) return;
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'top-bar__link top-bar__theme-item';
        item.addEventListener('click', function (e) {
            e.stopPropagation();
            orig.click();
        });
        nav.appendChild(item);
    }

    // 텔레그램 채널 링크 — 전 페이지 상단(top-bar__right)에 주입. 스타일은 whyrise.css(.top-bar__tg).
    function injectTelegram() {
        var right = document.querySelector('.top-bar__right');
        if (!right || right.querySelector('.top-bar__tg')) return;
        var link = document.createElement('a');
        link.className = 'top-bar__tg';
        link.href = 'https://t.me/whyorgo';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = '텔레그램 채널 — 오늘의 시황 브리핑';
        link.setAttribute('aria-label', 'ORGO 텔레그램 채널 (새 창에서 열림)');
        link.innerHTML =
            '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
            '<path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 ' +
            '3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 ' +
            '12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>';
        var toggle = document.getElementById('themeToggle');
        if (toggle) right.insertBefore(link, toggle);
        else right.appendChild(link);
    }

    injectThemeItem();
    injectTelegram();
    updateThemeIcons();

    try {
        new MutationObserver(updateThemeIcons).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme'],
        });
    } catch (e) {}
    window.addEventListener('storage', function (e) {
        if (e.key === 'theme') updateThemeIcons();
    });

    function setOpen(open) {
        nav.classList.toggle('top-bar__nav--open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        setOpen(!nav.classList.contains('top-bar__nav--open'));
    });

    nav.addEventListener('click', function (e) {
        if (e.target.closest('.top-bar__theme-item')) return;
        if (e.target.closest('a')) setOpen(false);
    });

    document.addEventListener('click', function (e) {
        if (!nav.classList.contains('top-bar__nav--open')) return;
        if (nav.contains(e.target) || btn.contains(e.target)) return;
        setOpen(false);
    });

    window.addEventListener('resize', function () {
        if (window.innerWidth > 768) setOpen(false);
    });
})();
