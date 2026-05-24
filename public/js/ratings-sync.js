/**
 * Account-scoped ratings sync.
 *
 * Once Google OAuth is configured, /api/ratings requires a signed user session
 * and stores data under that user's KV key. Until OAuth envs are connected, the
 * API keeps legacy single-user behavior so the live site does not break.
 */
(function () {
    'use strict';

    var ENDPOINT = '/api/ratings';
    var DEBOUNCE_MS = 300;

    var _disabled = false;
    var _pushTimer = null;
    var _ratings = {};

    function clone(obj) {
        try { return JSON.parse(JSON.stringify(obj || {})); }
        catch (e) { return {}; }
    }

    function notify() {
        try {
            window.dispatchEvent(new CustomEvent('whyrise:ratings-updated', {
                detail: { ratings: clone(_ratings) },
            }));
        } catch (e) {}
    }

    function setCached(ratings, shouldNotify) {
        _ratings = clone(ratings);
        if (shouldNotify) notify();
    }

    function authReady() {
        if (window.WhyAuth && window.WhyAuth.ready) return window.WhyAuth.ready;
        return Promise.resolve({ loginEnabled: false, authed: false });
    }

    function canSync(auth) {
        if (!auth || !auth.loginEnabled) return true;
        return !!auth.authed;
    }

    function doPush(ratings) {
        if (_disabled) return;
        setCached(ratings, false);
        authReady().then(function (auth) {
            if (!canSync(auth)) return;
            try {
                fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ratings: _ratings || {} }),
                    credentials: 'same-origin',
                }).then(function (r) {
                    if (r.status === 401) {
                        setCached({}, true);
                        return;
                    }
                    if (r.status === 503) _disabled = true;
                }).catch(function () {});
            } catch (e) {}
        });
    }

    function push(ratings, immediate) {
        if (_disabled) return;
        if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
        if (immediate) { doPush(ratings); return; }
        _pushTimer = setTimeout(function () {
            _pushTimer = null;
            doPush(ratings);
        }, DEBOUNCE_MS);
    }

    function pull() {
        if (_disabled) return Promise.resolve(null);
        return authReady().then(function (auth) {
            if (!canSync(auth)) {
                setCached({}, true);
                return { ratings: {}, updated_at: 0, source: 'auth_required' };
            }
            return fetch(ENDPOINT, { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
                .then(function (r) {
                    if (r.status === 401) {
                        setCached({}, true);
                        return { ratings: {}, updated_at: 0, source: 'auth_required' };
                    }
                    if (r.status === 503) { _disabled = true; return null; }
                    if (!r.ok) return null;
                    return r.json();
                })
                .then(function (j) {
                    if (!j || !j.ok) return j && j.source ? j : null;
                    setCached(j.ratings || {}, true);
                    return { ratings: clone(_ratings), updated_at: j.updated_at || 0, source: 'remote' };
                })
                .catch(function () { return null; });
        });
    }

    window.WhyRatingsSync = {
        pull: pull,
        push: push,
        getCached: function () { return clone(_ratings); },
        setCached: function (ratings) { setCached(ratings, true); },
        isDisabled: function () { return _disabled; },
    };
})();
