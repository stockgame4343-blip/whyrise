/**
 * 모바일 햄버거 nav 토글. 모든 페이지 공통.
 * PC 에서는 햄버거 자체가 숨겨져 영향 없음.
 */
(function () {
    var btn = document.getElementById('navToggle');
    var nav = document.querySelector('.top-bar__nav');
    if (!btn || !nav) return;

    function setOpen(open) {
        nav.classList.toggle('top-bar__nav--open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        setOpen(!nav.classList.contains('top-bar__nav--open'));
    });

    // 메뉴 항목 클릭 시 자동 닫기
    nav.addEventListener('click', function (e) {
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
