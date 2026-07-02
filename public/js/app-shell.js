(function () {
    'use strict';

    if (window.__orgoAppShell) return;
    window.__orgoAppShell = true;

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

    function createTabbar() {
        if (!document.body || document.querySelector('.app-tabbar')) return;
        var active = activeTab(location.pathname);
        var nav = document.createElement('nav');
        nav.className = 'app-tabbar';
        nav.setAttribute('aria-label', '앱 주요 메뉴');
        nav.innerHTML = TAB_ITEMS.map(function (item) {
            var current = item.key === active ? ' aria-current="page"' : '';
            return '<a class="app-tabbar__item" href="' + item.href + '"' + current + '>' +
                '<svg viewBox="0 0 24 24" aria-hidden="true">' + item.icon + '</svg>' +
                '<span class="app-tabbar__label">' + item.label + '</span>' +
                '</a>';
        }).join('');
        document.body.classList.add('has-app-tabbar');
        document.body.appendChild(nav);
    }

    var deferredInstallPrompt = null;

    function isStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches ||
            window.navigator.standalone === true;
    }

    function isIos() {
        return /iphone|ipad|ipod/i.test(navigator.userAgent);
    }

    function installButton() {
        return document.querySelector('.app-install-button');
    }

    function removeInstallButton() {
        var button = installButton();
        if (button) button.remove();
    }

    function showIosGuide() {
        if (document.querySelector('.app-install-sheet')) return;
        var sheet = document.createElement('aside');
        sheet.className = 'app-install-sheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-label', 'ORGO 앱 설치 안내');
        sheet.innerHTML =
            '<div class="app-install-sheet__top">' +
                '<div><strong>ORGO를 홈 화면에 추가</strong>' +
                '<p>Safari 아래쪽의 공유 버튼을 누른 뒤<br><b>홈 화면에 추가</b>를 선택해 주세요.</p></div>' +
                '<button type="button" aria-label="닫기">&times;</button>' +
            '</div>';
        sheet.querySelector('button').addEventListener('click', function () {
            sheet.remove();
        });
        document.body.appendChild(sheet);
    }

    function createInstallButton() {
        if (isStandalone() || installButton()) return;
        var right = document.querySelector('.top-bar__right');
        if (!right) return;
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'app-install-button';
        button.setAttribute('aria-label', 'ORGO 앱 설치');
        button.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></svg>' +
            '<span class="app-install-button__label">앱 설치</span>';
        button.addEventListener('click', async function () {
            if (deferredInstallPrompt) {
                deferredInstallPrompt.prompt();
                var choice = await deferredInstallPrompt.userChoice;
                deferredInstallPrompt = null;
                if (choice && choice.outcome === 'accepted') removeInstallButton();
                return;
            }
            if (isIos()) showIosGuide();
        });
        var theme = document.getElementById('themeToggle');
        right.insertBefore(button, theme || right.firstChild);
    }

    window.addEventListener('beforeinstallprompt', function (event) {
        event.preventDefault();
        deferredInstallPrompt = event;
        createInstallButton();
    });

    window.addEventListener('appinstalled', function () {
        deferredInstallPrompt = null;
        removeInstallButton();
    });

    createTabbar();
    if (isIos() && !isStandalone()) createInstallButton();

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
        });
    }
})();
