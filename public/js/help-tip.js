/**
 * help-tip — 물음표(?) 도움말 팝오버 (공용).
 *
 * 사용법: 설명을 붙일 제목/라벨 옆에 버튼 하나만 추가하면 된다.
 *   <button type="button" class="help-tip"
 *           data-help-title="오늘의 대장"
 *           data-help="설명 문장. 여러 줄은 \n 으로." aria-label="오늘의 대장 설명">?</button>
 *
 * - 클릭하면 팝오버 표시(모바일·PC 공용), 바깥 클릭/ESC/스크롤/리사이즈 시 닫힘.
 * - CSS 는 이 파일이 1회 주입한다(페이지마다 link 추가 불필요). 다크/라이트 자동 대응.
 * - 전역 팝오버 1개만 재사용(불변 마크업 패턴, 이벤트 위임) — 어느 페이지든 동일 동작.
 */
(function () {
    'use strict';
    if (window.__helpTipInit) return;
    window.__helpTipInit = true;

    var EDGE = 8;   // 화면 가장자리 최소 여백(px)
    var GAP = 8;    // 버튼과 팝오버 간격(px)

    var css = [
        '.help-tip{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;',
        'padding:0;margin-left:5px;border:0;background:transparent;color:var(--text-muted,#8b8b8b);',
        'line-height:0;cursor:pointer;vertical-align:middle;flex-shrink:0;-webkit-appearance:none;appearance:none;',
        'transition:color .15s;}',
        '.help-tip svg{width:15px;height:15px;display:block;}',
        '.help-tip:hover{color:var(--wr-accent,#3182F6);}',
        '.help-tip:focus-visible{outline:2px solid var(--wr-accent,#3182F6);outline-offset:2px;border-radius:50%;}',
        '.help-pop{position:fixed;z-index:10000;max-width:280px;padding:12px 14px;border-radius:10px;',
        'background:#1f1f1f;color:rgba(255,255,255,.82);border:1px solid rgba(255,255,255,.14);',
        'box-shadow:0 10px 32px rgba(0,0,0,.38);font-size:12.5px;font-weight:500;line-height:1.55;',
        'font-family:inherit;}',
        '.help-pop__title{font-size:13px;font-weight:800;color:#fff;margin-bottom:5px;}',
        '[data-theme="light"] .help-pop{background:#fff;color:#3a3f47;border-color:rgba(0,0,0,.1);',
        'box-shadow:0 10px 32px rgba(0,0,0,.14);}',
        '[data-theme="light"] .help-pop__title{color:#191919;}',
    ].join('');
    var style = document.createElement('style');
    style.id = 'help-tip-style';
    style.textContent = css;
    document.head.appendChild(style);

    var pop = null;
    var currentBtn = null;

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function ensurePop() {
        if (pop) return pop;
        pop = document.createElement('div');
        pop.className = 'help-pop';
        pop.setAttribute('role', 'tooltip');
        pop.style.display = 'none';
        document.body.appendChild(pop);
        return pop;
    }

    function closePop() {
        if (pop) pop.style.display = 'none';
        currentBtn = null;
    }

    function positionPop(p, btn) {
        var r = btn.getBoundingClientRect();
        var pw = p.offsetWidth, ph = p.offsetHeight;
        var vw = document.documentElement.clientWidth;
        var vh = document.documentElement.clientHeight;
        var left = r.left;
        if (left + pw > vw - EDGE) left = vw - pw - EDGE;
        if (left < EDGE) left = EDGE;
        var top = r.bottom + GAP;                 // 기본은 버튼 아래
        if (top + ph > vh - EDGE && r.top - ph - GAP > EDGE) top = r.top - ph - GAP;  // 아래 부족하면 위로
        p.style.left = Math.round(left) + 'px';
        p.style.top = Math.round(top) + 'px';
    }

    function openPop(btn) {
        var p = ensurePop();
        var title = btn.getAttribute('data-help-title') || '';
        var body = btn.getAttribute('data-help') || '';
        var html = '';
        if (title) html += '<div class="help-pop__title">' + escapeHtml(title) + '</div>';
        html += '<div class="help-pop__body">' + escapeHtml(body).replace(/\n/g, '<br>') + '</div>';
        p.innerHTML = html;
        p.style.display = 'block';
        positionPop(p, btn);
        currentBtn = btn;
    }

    document.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.help-tip') : null;
        if (btn) {
            e.preventDefault();
            e.stopPropagation();
            if (currentBtn === btn) { closePop(); return; }   // 같은 버튼 재클릭 → 토글 닫기
            openPop(btn);
            return;
        }
        if (pop && pop.style.display !== 'none' && !(e.target.closest && e.target.closest('.help-pop'))) closePop();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });
    window.addEventListener('resize', closePop);
    window.addEventListener('scroll', closePop, true);

    // 버튼 안에 info 아이콘(동그라미+i) 주입 — 글자 '?' 의 baseline 정렬 문제를 피하고 완전 중앙 정렬.
    // 각 페이지 HTML 은 그대로 두고(버튼 텍스트 무관) 여기서 일괄 교체한다.
    var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/>' +
        '<line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    function paintIcons() {
        var btns = document.querySelectorAll('.help-tip');
        for (var i = 0; i < btns.length; i++) {
            if (!btns[i].querySelector('svg')) btns[i].innerHTML = ICON;
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', paintIcons);
    } else {
        paintIcons();
    }
})();
