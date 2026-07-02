/**
 * 방문자 카운터 + 집계 heartbeat — N명 보는 중 · 누적 N명.
 *
 * /api/track POST: 페이지뷰(pv)·유입(ref)·체류시간(dur) 같이 전송.
 *   - 첫 pulse(페이지 로드) → pv:true + ref(외부 유입)
 *   - 3분마다 + 이탈 시 → dur(이 세션 활성 체류초)
 * /api/stats GET 으로 위젯 카운트 갱신. KV 미연결 시 위젯 자동 숨김.
 */
(function () {
    var SID_KEY = 'wr_sid';
    var FIRST_KEY = 'wr_first_added';
    var REFRESH_MS = 180 * 1000;  // 3분

    // ── 세션 활성 체류시간 누적(탭 보일 때만) ──
    var activeMs = 0;
    var resumeAt = (document.visibilityState === 'visible') ? Date.now() : 0;
    function activeSec() {
        var ms = activeMs + (resumeAt ? (Date.now() - resumeAt) : 0);
        return Math.round(ms / 1000);
    }

    function getSid() {
        var sid = null;
        try { sid = localStorage.getItem(SID_KEY); } catch (e) {}
        if (!sid) {
            sid = (window.crypto && crypto.randomUUID)
                ? crypto.randomUUID()
                : (Date.now() + '-' + Math.random().toString(36).slice(2));
            try { localStorage.setItem(SID_KEY, sid); } catch (e) {}
        }
        return sid;
    }

    function extRef() {
        // utm 우선 — 텔레그램 앱 등은 referrer 를 안 보내므로 utm 이 유일한 유입 신호
        try {
            var q = new URLSearchParams(location.search);
            var u = q.get('utm_source');
            if (u) {
                var c = q.get('utm_campaign') || '';
                return 'utm:' + u + (c ? '/' + c : '');   // 예: utm:telegram/daily
            }
        } catch (e) {}
        var r = document.referrer || '';
        if (!r) return '';
        try { if (new URL(r).hostname === location.hostname) return ''; } catch (e) {}
        return r;
    }

    function track(isPageview) {
        var sid = getSid();
        var first = false;
        try { first = !localStorage.getItem(FIRST_KEY); } catch (e) {}
        var payload = { sid: sid, first: first, dur: activeSec() };
        if (isPageview) { payload.pv = true; payload.ref = extRef(); }
        return fetch('/api/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store',
        }).then(function (r) {
            if (r.ok && first) {
                try { localStorage.setItem(FIRST_KEY, '1'); } catch (e) {}
            }
        }).catch(function () {});
    }

    function fetchStats() {
        return fetch('/api/stats', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
                if (!j || !j.ok) return;
                var $row = document.getElementById('visitorRow');
                var $online = document.getElementById('visitorOnline');
                var $unique = document.getElementById('visitorUnique');
                if ($online) $online.textContent = j.online;
                if ($unique) $unique.textContent = j.unique;
                if ($row) $row.style.display = '';
            })
            .catch(function () {});
    }

    function pulse(isPageview) {
        track(isPageview).then(fetchStats);
    }

    // 이탈 직전 체류시간 한 번 더 보냄(sendBeacon — unload 안전)
    function flushDur() {
        try {
            var sid = getSid();
            var data = JSON.stringify({ sid: sid, dur: activeSec() });
            if (navigator.sendBeacon) {
                navigator.sendBeacon('/api/track', new Blob([data], { type: 'application/json' }));
            }
        } catch (e) {}
    }

    document.addEventListener('DOMContentLoaded', function () {
        pulse(true);   // 첫 pulse = 페이지뷰 + 유입
        setInterval(function () {
            if (document.visibilityState === 'hidden') return;   // 백그라운드 탭 스킵
            pulse(false);
        }, REFRESH_MS);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                resumeAt = Date.now();
                pulse(false);
            } else {
                if (resumeAt) { activeMs += Date.now() - resumeAt; resumeAt = 0; }
                flushDur();
            }
        });
        window.addEventListener('pagehide', flushDur);
    });
})();
