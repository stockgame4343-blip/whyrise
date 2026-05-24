/**
 * Shared top navigation: mobile drawer, theme mirror item, and theme icon sync.
 */
(function () {
    'use strict';

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

    injectThemeItem();
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
