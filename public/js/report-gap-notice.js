/**
 * 리포트 갭 안내 — 오늘 첫 집계(stock-rise 빌드) 도착 전, 리포트가 전 거래일
 * 확정본임을 배너로 명시한다. report.js 는 확정 리포트 유지가 설계 원칙이라
 * (어제 빌드 + 오늘 라이브 혼합 금지) 본체를 건드리지 않고 독립 스크립트로 띄운다.
 * 집계 도착(getDates 갱신) 시 자동으로 숨는다 — report.js 본체도 같은 신호로 전진.
 */
(function () {
    'use strict';

    var CHECK_MS = 60 * 1000;             // 갭 여부 재확인 주기 (getDates 는 갭 중 60s 캐시)
    var LIVE_RECHECK_MS = 5 * 60 * 1000;  // '오늘이 실제 거래일인지' 라이브 재확인 주기 (공휴일 오탐 방지)
    var OPEN_MIN = 9 * 60;
    var CLOSE_MIN = 15 * 60 + 30;

    var el = null;
    var timer = null;
    var liveVerify = { t: 0, isTradingDay: false };

    function kst() { return new Date(Date.now() + 9 * 3600000); }

    function todayKST() {
        return kst().toISOString().slice(0, 10).replace(/-/g, '');
    }

    function inMarketWindow() {
        var k = kst();
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < CLOSE_MIN;
    }

    function dateLabel(value) {
        var text = String(value || '');
        if (!/^\d{8}$/.test(text)) return '전 거래일';
        return Number(text.slice(4, 6)) + '월 ' + Number(text.slice(6, 8)) + '일';
    }

    function show(prevDate) {
        if (!el) {
            el = document.createElement('div');
            el.id = 'reportGapNotice';
            el.style.cssText = 'margin:12px 0 4px;padding:10px 14px;border-radius:10px;' +
                'border:1px solid rgba(232,163,61,.35);background:rgba(232,163,61,.10);' +
                'color:#e8a33d;font-size:13px;font-weight:600;line-height:1.55;';
            var head = document.querySelector('.report-head');
            if (head && head.parentNode) head.parentNode.insertBefore(el, head.nextSibling);
            else document.body.insertBefore(el, document.body.firstChild);
        }
        el.textContent = '오늘 리포트 집계 중이에요 — 첫 집계가 도착하면 자동으로 반영돼요. ' +
            '아래는 ' + dateLabel(prevDate) + '(전 거래일) 확정 리포트예요.';
        el.style.display = '';
    }

    function hide() {
        if (el) el.style.display = 'none';
    }

    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(check, CHECK_MS);
    }

    function check() {
        if (typeof WhyAPI === 'undefined' || !inMarketWindow()) {
            hide();
            schedule();
            return;
        }
        WhyAPI.getDates().then(function (dates) {
            var latest = (dates && dates[0]) || '';
            if (!latest || latest >= todayKST()) {
                hide();
                schedule();
                return;
            }
            // 갭 후보 — 공휴일이면 오늘 빌드는 원래 없다. 라이브 거래일이 정말 오늘인지 확인.
            if ((Date.now() - liveVerify.t) < LIVE_RECHECK_MS) {
                if (liveVerify.isTradingDay) show(latest);
                else hide();
                schedule();
                return;
            }
            return WhyAPI.getLiveMarketmap().then(function (live) {
                liveVerify = { t: Date.now(), isTradingDay: !!(live && live.date === todayKST()) };
                if (liveVerify.isTradingDay) show(latest);
                else hide();
                schedule();
            });
        }).catch(function () {
            hide();
            schedule();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', check);
    } else {
        check();
    }
})();
