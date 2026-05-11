// 재사용 캘린더 팝오버 — 거래일만 활성화된 월별 그리드
// 사용:
//   DatePicker.open({ trigger, dates, current, onSelect })
//     trigger:  팝오버 위치 기준 DOM 엘리먼트
//     dates:    YYYYMMDD 문자열 배열 (정렬 무관, 데이터 보유 거래일)
//     current:  YYYYMMDD — 현재 선택값 (옵션)
//     onSelect: function(YYYYMMDD)
(function () {
    'use strict';

    var $popover = null;
    var state = null;

    function open(opts) {
        close();
        var dates = opts.dates || [];
        var datesSet = {};
        dates.forEach(function (d) { datesSet[d] = true; });
        var sorted = dates.slice().sort();
        var latest = sorted.length ? sorted[sorted.length - 1] : null;
        var anchor = opts.current || latest;
        var d = anchor ? parseDate(anchor) : todayParts();

        state = {
            dates: dates,
            datesSet: datesSet,
            current: opts.current || null,
            latest: latest,
            onSelect: opts.onSelect,
            viewYear: d.y,
            viewMonth: d.m
        };

        $popover = document.createElement('div');
        $popover.className = 'date-picker';
        $popover.setAttribute('role', 'dialog');
        $popover.setAttribute('aria-label', '날짜 선택');
        document.body.appendChild($popover);

        render();
        position(opts.trigger);
        $popover.addEventListener('click', onClick);

        // 다음 tick 에 바인딩 — 트리거 클릭이 곧장 outside 로 잡히는 걸 방지
        setTimeout(function () {
            document.addEventListener('mousedown', onOutside, true);
            document.addEventListener('keydown', onKey);
            window.addEventListener('resize', close);
            window.addEventListener('scroll', close, true);
        }, 0);
    }

    function close() {
        if (!$popover) return;
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', close);
        window.removeEventListener('scroll', close, true);
        if ($popover.parentNode) $popover.parentNode.removeChild($popover);
        $popover = null;
        state = null;
    }

    function onOutside(e) {
        if (!$popover) return;
        if ($popover.contains(e.target)) return;
        close();
    }

    function onKey(e) {
        if (e.key === 'Escape') close();
    }

    function parseDate(s) {
        return {
            y: +s.substring(0, 4),
            m: +s.substring(4, 6) - 1,
            d: +s.substring(6, 8)
        };
    }

    function todayParts() {
        var t = new Date();
        return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() };
    }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    function fmt(y, m, d) {
        return '' + y + pad2(m + 1) + pad2(d);
    }

    function formatLatestShort() {
        if (!state.latest) return '-';
        var p = parseDate(state.latest);
        return (p.m + 1) + '/' + p.d;
    }

    function render() {
        var y = state.viewYear;
        var m = state.viewMonth;
        var first = new Date(y, m, 1);
        var startWeekday = first.getDay();
        var daysInMonth = new Date(y, m + 1, 0).getDate();

        var html = '';
        html += '<div class="date-picker__head">';
        html += '<button type="button" class="date-picker__nav" data-act="prev-month" aria-label="이전 달">‹</button>';
        html += '<span class="date-picker__title">' + y + '년 ' + (m + 1) + '월</span>';
        html += '<button type="button" class="date-picker__nav" data-act="next-month" aria-label="다음 달">›</button>';
        html += '</div>';

        html += '<div class="date-picker__grid">';
        var weekdays = ['일', '월', '화', '수', '목', '금', '토'];
        for (var w = 0; w < 7; w++) {
            var wcls = 'date-picker__weekday';
            if (w === 0) wcls += ' date-picker__weekday--sun';
            if (w === 6) wcls += ' date-picker__weekday--sat';
            html += '<div class="' + wcls + '">' + weekdays[w] + '</div>';
        }
        for (var i = 0; i < startWeekday; i++) {
            html += '<div class="date-picker__cell date-picker__cell--empty"></div>';
        }
        for (var d = 1; d <= daysInMonth; d++) {
            var ds = fmt(y, m, d);
            var weekday = (startWeekday + d - 1) % 7;
            var cls = 'date-picker__cell';
            if (weekday === 0) cls += ' date-picker__cell--sun';
            if (weekday === 6) cls += ' date-picker__cell--sat';
            var has = !!state.datesSet[ds];
            cls += has ? ' date-picker__cell--has' : ' date-picker__cell--none';
            if (ds === state.current) cls += ' date-picker__cell--current';
            if (ds === state.latest) cls += ' date-picker__cell--latest';
            html += '<button type="button" class="' + cls + '" data-date="' + ds + '"' +
                (has ? '' : ' disabled') + '>' + d + '</button>';
        }
        html += '</div>';

        html += '<div class="date-picker__foot">';
        html += '<button type="button" class="date-picker__quick" data-act="latest">최신 (' +
            formatLatestShort() + ')</button>';
        html += '</div>';

        $popover.innerHTML = html;
    }

    function onClick(e) {
        var btn = e.target.closest ? e.target.closest('[data-act],[data-date]') : null;
        if (!btn) return;
        var act = btn.getAttribute('data-act');
        if (act === 'prev-month') {
            state.viewMonth--;
            if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
            render();
            return;
        }
        if (act === 'next-month') {
            state.viewMonth++;
            if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
            render();
            return;
        }
        if (act === 'latest') {
            var fn = state.onSelect;
            var latest = state.latest;
            close();
            if (fn && latest) fn(latest);
            return;
        }
        var date = btn.getAttribute('data-date');
        if (date && state.datesSet[date]) {
            var sel = state.onSelect;
            close();
            if (sel) sel(date);
        }
    }

    function position(trigger) {
        if (!trigger) return;
        var rect = trigger.getBoundingClientRect();
        var pop = $popover.getBoundingClientRect();
        var pad = 8;
        var top = rect.bottom + 6;
        var left = rect.left + (rect.width / 2) - (pop.width / 2);
        var maxLeft = window.innerWidth - pop.width - pad;
        if (left < pad) left = pad;
        if (left > maxLeft) left = maxLeft;
        if (top + pop.height > window.innerHeight - pad) {
            var topUp = rect.top - pop.height - 6;
            if (topUp >= pad) top = topUp;
        }
        $popover.style.position = 'fixed';
        $popover.style.top = top + 'px';
        $popover.style.left = left + 'px';
    }

    window.DatePicker = { open: open, close: close };
})();
