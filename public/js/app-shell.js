(function () {
    'use strict';

    if (window.__orgoMobileNav) return;
    window.__orgoMobileNav = true;

    var TAB_ITEMS = [
        {
            key: 'home',
            href: '/',
            label: '홈',
            icon: '<path d="M3 10.8 12 3l9 7.8"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-6h5v6"/>'
        },
        {
            key: 'rise',
            href: '/rise.html',
            label: '오른종목',
            icon: '<path d="m4 16 5-5 4 4 7-8"/><path d="M14 7h6v6"/>'
        },
        {
            key: 'report',
            href: '/report.html',
            label: '리포트',
            icon: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 10h8M8 14h8M8 18h5"/><path d="M15 3v4h4"/>'
        },
        {
            key: 'calendar',
            href: '/sample2.html',
            label: '캘린더',
            icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'
        },
        {
            key: 'visual',
            href: '/leaders2.html',
            label: '시각화',
            icon: '<rect x="3" y="13" width="5" height="8" rx="1"/><rect x="10" y="8" width="5" height="13" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/>'
        }
    ];

    function activeTab(pathname) {
        if (pathname === '/' || pathname === '/index.html') return 'home';
        if (/\/(?:rise|stock)(?:\.html|\/|$)/.test(pathname)) return 'rise';
        if (/\/report(?:\.html|\/|$)/.test(pathname)) return 'report';
        if (/\/(?:sample2|calendar2)(?:\.html|\/|$)/.test(pathname)) return 'calendar';
        if (/\/(?:leaders2|flowmap|bubbles2|treemap)(?:\.html|\/|$)/.test(pathname)) return 'visual';
        return '';
    }

    function clearLegacyInstall() {
        document.querySelectorAll('.app-install-button, .app-install-sheet').forEach(function (node) {
            node.remove();
        });

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(function (registrations) {
                registrations.forEach(function (registration) {
                    var worker = registration.active || registration.waiting || registration.installing;
                    if (worker && /\/sw\.js(?:$|\?)/.test(worker.scriptURL)) registration.unregister();
                });
            }).catch(function () {});
        }

        if ('caches' in window) {
            caches.keys().then(function (keys) {
                keys.filter(function (key) {
                    return key.indexOf('orgo-app-') === 0;
                }).forEach(function (key) {
                    caches.delete(key);
                });
            }).catch(function () {});
        }
    }

    function createTabbar() {
        if (!document.body || document.querySelector('.app-tabbar')) return;
        var active = activeTab(location.pathname);
        if (active === 'visual') return;
        var nav = document.createElement('nav');
        nav.className = 'app-tabbar';
        nav.setAttribute('aria-label', '모바일 주요 메뉴');
        nav.setAttribute('data-html2canvas-ignore', 'true');
        nav.setAttribute('data-orgo-capture-exclude', 'true');
        nav.innerHTML = TAB_ITEMS.map(function (item) {
            var current = item.key === active ? ' aria-current="page"' : '';
            return '<a class="app-tabbar__item" href="' + item.href + '"' + current + '>' +
                '<svg viewBox="0 0 24 24" aria-hidden="true">' + item.icon + '</svg>' +
                '<span class="app-tabbar__label">' + item.label + '</span>' +
                '</a>';
        }).join('');
        document.body.appendChild(nav);
    }

    function setCaptureMode(active) {
        document.documentElement.classList.toggle('orgo-capture-active', active);
    }

    window.addEventListener('orgo:capture-start', function () { setCaptureMode(true); });
    window.addEventListener('orgo:capture-end', function () { setCaptureMode(false); });
    window.addEventListener('beforeprint', function () { setCaptureMode(true); });
    window.addEventListener('afterprint', function () { setCaptureMode(false); });

    clearLegacyInstall();
    createTabbar();
})();
