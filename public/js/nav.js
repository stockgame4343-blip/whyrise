/**
 * 모바일 햄버거 nav 토글. 모든 페이지 공통.
 * PC 에서는 햄버거 자체가 숨겨져 영향 없음.
 */
(function () {
    var btn = document.getElementById('navToggle');
    var nav = document.querySelector('.top-bar__nav');
    if (!btn || !nav) return;

    (function injectLeaders2Item() {
        if (nav.querySelector('a[href="/leaders2.html"]')) return;
        var anchor = nav.querySelector('a[href="/flowmap.html"]');
        if (!anchor) return;
        var item = document.createElement('a');
        item.href = '/leaders2.html';
        item.className = 'top-bar__link';
        item.textContent = '주도주2';
        if (window.location.pathname === '/leaders2.html') {
            item.classList.add('top-bar__link--active');
        }
        anchor.insertAdjacentElement('afterend', item);
    })();

    // 모바일 햄버거 drawer 안에 테마 토글 아이템 주입 — PC 에서는 CSS 로 숨김.
    // 본래 PC 우측의 #themeToggle 버튼은 그대로 두고, drawer 용 분신을 만들어 같은 동작을 위임.
    (function injectThemeItem() {
        var orig = document.getElementById('themeToggle');
        if (!orig || nav.querySelector('.top-bar__theme-item')) return;
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'top-bar__link top-bar__theme-item';
        item.setAttribute('aria-label', '다크/라이트 모드 전환');
        item.innerHTML =
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' +
            '<span class="top-bar__theme-item-label">다크/라이트 모드</span>';
        item.addEventListener('click', function (e) {
            e.stopPropagation();
            orig.click();  // 페이지별 bindThemeToggle 이 이미 #themeToggle 에 바인딩됨
        });
        nav.appendChild(item);
    })();

    function setOpen(open) {
        nav.classList.toggle('top-bar__nav--open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        setOpen(!nav.classList.contains('top-bar__nav--open'));
    });

    // 메뉴 항목 클릭 시 자동 닫기 (단, 테마 아이템은 닫지 않음 — 토글 후에도 메뉴 유지)
    nav.addEventListener('click', function (e) {
        if (e.target.closest('.top-bar__theme-item')) return;
        if (e.target.closest('a')) setOpen(false);
    });

    // 외부 클릭 시 닫기
    document.addEventListener('click', function (e) {
        if (!nav.classList.contains('top-bar__nav--open')) return;
        if (nav.contains(e.target) || btn.contains(e.target)) return;
        setOpen(false);
    });

    // resize → PC 폭으로 가면 강제 닫기
    window.addEventListener('resize', function () {
        if (window.innerWidth > 768) setOpen(false);
    });
})();
