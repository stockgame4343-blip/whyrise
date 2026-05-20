/**
 * 관심 별점·메모 서버 동기화 — /api/ratings (Vercel KV 단일 키).
 *
 * - localStorage 키 `whyrise-ratings` 와 서버를 머지 (서버 데이터 우선).
 * - 변경 시 push(ratings) — 300ms debounce 후 POST.
 * - 503/네트워크 실패 시 자동 비활성화 (오프라인 모드).
 *
 * 본인만 쓰는 사이트 전제 — 인증 없이 GET/POST 호출.
 */
(function () {
    var STORAGE_KEY = 'whyrise-ratings';
    var ENDPOINT = '/api/ratings';
    var DEBOUNCE_MS = 300;

    var _disabled = false;
    var _pushTimer = null;

    function getLocal() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
        catch (e) { return {}; }
    }
    function setLocal(r) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(r)); } catch (e) {}
    }

    function doPush(ratings) {
        if (_disabled) return;
        try {
            fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ratings: ratings || {} }),
                credentials: 'same-origin',
            }).then(function (r) {
                if (r.status === 503) _disabled = true;
            }).catch(function () { /* silent */ });
        } catch (e) { /* silent */ }
    }

    /** 외부에서 변경 발생을 알릴 때 호출. 300ms debounce 후 POST. */
    function push(ratings, immediate) {
        if (_disabled) return;
        if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
        if (immediate) { doPush(ratings); return; }
        _pushTimer = setTimeout(function () {
            _pushTimer = null;
            doPush(ratings);
        }, DEBOUNCE_MS);
    }

    /**
     * 페이지 로드 시 호출 — 서버에서 GET 해서 로컬 머지.
     * 반환: Promise<{ratings, updated_at, source}|null>
     *   source: 'remote' (서버 덮어쓴 경우) / 'local' (서버 비어 로컬 푸시) / 'empty' / null(실패)
     */
    function pull() {
        if (_disabled) return Promise.resolve(null);
        return fetch(ENDPOINT, { method: 'GET', credentials: 'same-origin' })
            .then(function (r) {
                if (r.status === 503) { _disabled = true; return null; }
                if (!r.ok) return null;
                return r.json();
            })
            .then(function (j) {
                if (!j || !j.ok) return null;
                var remote = j.ratings || {};
                var local = getLocal();
                var remoteCount = Object.keys(remote).length;
                var localCount = Object.keys(local).length;

                if (remoteCount > 0) {
                    // 서버 데이터 우선 — 로컬 덮어쓰기 (LWW)
                    setLocal(remote);
                    return { ratings: remote, updated_at: j.updated_at || 0, source: 'remote' };
                }
                if (localCount > 0) {
                    // 서버 비어 있는데 로컬 데이터 있으면 즉시 업로드 (최초 마이그레이션)
                    push(local, true);
                    return { ratings: local, updated_at: 0, source: 'local' };
                }
                return { ratings: {}, updated_at: 0, source: 'empty' };
            })
            .catch(function () { return null; });
    }

    window.WhyRatingsSync = {
        pull: pull,
        push: push,
        isDisabled: function () { return _disabled; },
    };
})();
