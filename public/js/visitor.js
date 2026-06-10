/**
 * 방문자 카운터 — N명 보는 중 · 누적 N명.
 *
 * 3분마다 /api/track POST 로 heartbeat + /api/stats GET 으로 카운트 갱신.
 * KV 미연결 시 ok:false → 위젯 자동 숨김.
 */
(function () {
    var SID_KEY = 'wr_sid';
    var FIRST_KEY = 'wr_first_added';
    var REFRESH_MS = 180 * 1000;  // 3분

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

    function track() {
        var sid = getSid();
        var first = false;
        try { first = !localStorage.getItem(FIRST_KEY); } catch (e) {}
        return fetch('/api/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sid: sid, first: first }),
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

    function pulse() {
        track().then(fetchStats);
    }

    document.addEventListener('DOMContentLoaded', function () {
        pulse();
        setInterval(function () {
            // 백그라운드 탭은 '보는 중' 이 아님 — heartbeat 스킵 (집계 부풀림 + 불필요 KV 쓰기 방지)
            if (document.visibilityState === 'hidden') return;
            pulse();
        }, REFRESH_MS);
        // 복귀 즉시 1회 — 5분 TTL 안에 다시 잡히도록
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') pulse();
        });
    });
})();
