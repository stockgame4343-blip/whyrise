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
            '12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>' +
            '<span class="top-bar__tg-label">구독</span>';
        var toggle = document.getElementById('themeToggle');
        if (toggle) right.insertBefore(link, toggle);
        else right.appendChild(link);
    }

    // 텔레그램 채널 링크 — 푸터(footer__copy 위)에도 라벨 링크. 푸터 있는 페이지만(시각화·admin 제외).
    function injectFooterTelegram() {
        var copy = document.querySelector('.footer__copy');
        if (!copy || document.querySelector('.footer__tg')) return;
        var link = document.createElement('a');
        link.className = 'footer__tg';
        link.href = 'https://t.me/whyorgo';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.innerHTML =
            '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">' +
            '<path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 ' +
            '3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 ' +
            '12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>' +
            '<span>텔레그램 채널 — 오늘의 시황 브리핑 받기</span>';
        copy.parentNode.insertBefore(link, copy);
    }

    // ── 본문 텔레그램 CTA — 콘텐츠를 소비한 직후 지점에 구독 유도 카드 주입 ──────────
    // 상단 아이콘·푸터 링크는 눈에 안 띄어 전환이 약함 → "방금 본 이 정리를 매일 보내준다"는
    // 맥락형 카드를 페이지별 본문 위치에 넣는다. 클릭은 Vercel Analytics 커스텀 이벤트(tg_cta)로
    // 집계(성과 측정). 스타일은 CSS 버전 갱신 없이 전 페이지(사전 렌더 종목 상세 포함) 적용되도록
    // 여기서 <style> 로 주입한다.
    var TG_URL = 'https://t.me/whyorgo';
    var TG_ICON =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
        '<path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 ' +
        '3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 ' +
        '12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>';

    function injectCtaStyles() {
        if (document.getElementById('orgoTgCtaCss')) return;
        var st = document.createElement('style');
        st.id = 'orgoTgCtaCss';
        st.textContent =
            '.orgo-tg-cta{display:flex;align-items:center;gap:12px;margin:18px 0;padding:14px 16px;' +
            'border-radius:14px;background:rgba(42,171,238,.09);border:1px solid rgba(42,171,238,.28);' +
            'text-decoration:none;color:inherit;transition:background .15s}' +
            '.orgo-tg-cta:hover{background:rgba(42,171,238,.16)}' +
            '.orgo-tg-cta__icon{flex:0 0 auto;width:38px;height:38px;border-radius:50%;background:#2AABEE;' +
            'color:#fff;display:flex;align-items:center;justify-content:center}' +
            '.orgo-tg-cta__text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}' +
            '.orgo-tg-cta__text strong{font-size:14.5px;font-weight:700;line-height:1.35;word-break:keep-all}' +
            '.orgo-tg-cta__text small{font-size:12.5px;opacity:.68;line-height:1.35;word-break:keep-all}' +
            '.orgo-tg-cta__btn{flex:0 0 auto;padding:9px 16px;border-radius:999px;background:#2AABEE;' +
            'color:#fff;font-size:13px;font-weight:700;white-space:nowrap}' +
            '@media (max-width:480px){.orgo-tg-cta{gap:10px;padding:12px 13px}' +
            '.orgo-tg-cta__btn{padding:8px 13px;font-size:12.5px}}';
        document.head.appendChild(st);
    }

    function buildCta(spot, title, sub) {
        var link = document.createElement('a');
        link.className = 'orgo-tg-cta';
        link.href = TG_URL;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('data-spot', spot);
        link.setAttribute('aria-label', 'ORGO 텔레그램 채널 구독 (새 창에서 열림)');
        link.innerHTML =
            '<span class="orgo-tg-cta__icon">' + TG_ICON + '</span>' +
            '<span class="orgo-tg-cta__text"><strong>' + title + '</strong><small>' + sub + '</small></span>' +
            '<span class="orgo-tg-cta__btn">무료 구독</span>';
        link.addEventListener('click', function () {
            try { window.va && window.va('event', { name: 'tg_cta', data: { spot: spot } }); } catch (e) {}
        });
        return link;
    }

    function injectContentCta() {
        if (document.querySelector('.orgo-tg-cta')) return;
        var path = location.pathname;
        var spec = null;
        if (path === '/' || /^\/index(\.html)?$/.test(path)) {
            // 홈 — '오늘 오른 종목' 미리보기 리스트 바로 아래(섹션 컨테이너 안 → 프레임 폭 유지)
            spec = { spot: 'home', anchor: '#home6WhyList',
                title: '이 브리핑, 매일 마감 후 텔레그램으로',
                sub: '오늘의 대장 · 주도주 TOP5 · 핫테마 — 무료 채널' };
        } else if (/^\/report(\.html)?$/.test(path)) {
            spec = { spot: 'report', anchor: '#leaderSection',
                title: '오늘의 대장, 매일 마감 후 텔레그램으로',
                sub: '매일 15:45 대장 카드 · 핫테마 정리 발송' };
        } else if (/^\/rise(\.html)?$/.test(path)) {
            spec = { spot: 'rise', anchor: 'main.layout-main',
                title: '오늘 오른 이유 정리, 내일도 받아보세요',
                sub: '매일 마감 후 오늘의 대장 · 주도주 TOP5 · 핫테마' };
        } else if (/^\/stock\//.test(path) || /^\/stock(\.html)?$/.test(path)) {
            spec = { spot: 'stock', anchor: '#timeline',
                title: '이런 급등 이슈, 매일 정리해서 보내드려요',
                sub: '장 마감 후 오늘의 대장 · 핫테마 브리핑' };
        } else if (/^\/(sample2|calendar2)(\.html)?$/.test(path)) {
            spec = { spot: 'calendar', anchor: '.cal-foot',
                title: '매일의 대장, 마감 직후 텔레그램으로',
                sub: '15:45 대장 확정 카드 발송' };
        }
        if (!spec) return;
        var anchor = document.querySelector(spec.anchor);
        if (!anchor || !anchor.parentNode) return;
        injectCtaStyles();
        anchor.parentNode.insertBefore(buildCta(spec.spot, spec.title, spec.sub), anchor.nextSibling);
    }

    // '오른종목'(/rise.html) nav 링크 주입 — 홈 링크 바로 뒤. /rise 경로에서 active.
    function injectRiseNav() {
        if (nav.querySelector('[data-nav="rise"]')) return;
        var home = nav.querySelector('a[href="/"]');
        var link = document.createElement('a');
        link.className = 'top-bar__link';
        link.setAttribute('data-nav', 'rise');
        link.href = '/rise.html';
        link.textContent = '오른종목';
        var path = location.pathname;
        if (path === '/rise.html' || path === '/rise') link.classList.add('top-bar__link--active');
        if (home && home.nextSibling) nav.insertBefore(link, home.nextSibling);
        else if (home) nav.appendChild(link);
        else nav.insertBefore(link, nav.firstChild);
    }

    injectRiseNav();
    injectThemeItem();
    injectTelegram();
    injectFooterTelegram();
    try { injectContentCta(); } catch (e) {}
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
