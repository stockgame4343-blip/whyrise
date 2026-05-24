/**
 * Whyrise account state.
 *
 * Public browsing stays open. Personal actions (watchlist, memo, exclude) are
 * allowed only after Google login once OAuth envs are configured.
 */
(function () {
    'use strict';

    var ME_URL = '/api/me';
    var LOGIN_URL = '/api/auth-google';
    var LOGOUT_URL = '/api/auth-logout';
    var LEGACY_RATINGS_KEY = 'whyrise-ratings';

    var state = {
        loaded: false,
        loginEnabled: false,
        authed: false,
        user: null,
    };
    var readyResolve;
    var ready = new Promise(function (resolve) { readyResolve = resolve; });
    var modal;

    function currentNext() {
        return window.location.pathname + window.location.search + window.location.hash;
    }

    function clearPersonalCache() {
        try {
            localStorage.removeItem(LEGACY_RATINGS_KEY);
            localStorage.removeItem('whyrise-watchlist-mode');
            localStorage.removeItem('whyrise-screening-watchlist-mode');
        } catch (e) {}
    }

    function dispatch() {
        try {
            window.dispatchEvent(new CustomEvent('whyrise:auth', { detail: getState() }));
        } catch (e) {}
    }

    function getState() {
        return {
            loaded: state.loaded,
            loginEnabled: state.loginEnabled,
            authed: state.authed,
            user: state.user,
        };
    }

    function refresh() {
        return fetch(ME_URL, { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
                state.loaded = true;
                state.loginEnabled = !!(j && j.login_enabled);
                state.authed = !!(j && j.authed);
                state.user = state.authed ? (j.user || null) : null;
                if (state.loginEnabled && !state.authed) clearPersonalCache();
                renderAuthControls();
                dispatch();
                readyResolve(getState());
                return getState();
            })
            .catch(function () {
                state.loaded = true;
                renderAuthControls();
                readyResolve(getState());
                return getState();
            });
    }

    function login() {
        window.location.href = LOGIN_URL + '?next=' + encodeURIComponent(currentNext());
    }

    function logout() {
        clearPersonalCache();
        window.location.href = LOGOUT_URL + '?next=' + encodeURIComponent(currentNext());
    }

    function personalAllowed() {
        return !state.loginEnabled || state.authed;
    }

    function featureText(feature) {
        if (feature === 'memo') return '메모는 로그인 후 내 계정에 저장됩니다.';
        if (feature === 'watchlist') return '관심종목은 로그인 후 내 계정에서 볼 수 있습니다.';
        if (feature === 'exclude') return '제외 표시는 로그인 후 내 계정에 저장됩니다.';
        return '관심종목과 메모는 로그인 후 내 계정에 저장됩니다.';
    }

    function ensureModal() {
        if (modal) return modal;
        modal = document.createElement('div');
        modal.className = 'modal-overlay auth-modal';
        modal.style.display = 'none';
        modal.innerHTML =
            '<div class="modal auth-modal__box" role="dialog" aria-modal="true" aria-labelledby="authModalTitle">' +
                '<div class="modal__header">' +
                    '<h3 class="modal__title" id="authModalTitle">로그인이 필요합니다</h3>' +
                    '<button class="modal__close auth-modal__close" type="button" aria-label="닫기">&times;</button>' +
                '</div>' +
                '<div class="modal__body auth-modal__body">' +
                    '<p class="auth-modal__text"></p>' +
                    '<div class="auth-modal__actions">' +
                        '<button class="auth-modal__login" type="button">Google로 계속하기</button>' +
                        '<button class="auth-modal__cancel" type="button">닫기</button>' +
                    '</div>' +
                '</div>' +
            '</div>';
        document.body.appendChild(modal);
        modal.addEventListener('click', function (e) {
            if (e.target === modal || e.target.closest('.auth-modal__close') || e.target.closest('.auth-modal__cancel')) {
                hideModal();
            }
            if (e.target.closest('.auth-modal__login')) login();
        });
        return modal;
    }

    function showModal(feature) {
        if (!state.loginEnabled) return true;
        var m = ensureModal();
        var title = m.querySelector('#authModalTitle');
        var text = m.querySelector('.auth-modal__text');
        var loginBtn = m.querySelector('.auth-modal__login');
        if (title) title.textContent = '로그인이 필요합니다';
        if (text) text.textContent = featureText(feature);
        if (loginBtn) loginBtn.style.display = '';
        m.style.display = 'flex';
        setTimeout(function () {
            var btn = m.querySelector('.auth-modal__login');
            if (btn) btn.focus();
        }, 30);
        return false;
    }

    function hideModal() {
        if (modal) modal.style.display = 'none';
    }

    function requireLogin(feature) {
        if (personalAllowed()) return true;
        if (!state.loaded) {
            refresh().then(function () {
                if (!personalAllowed()) showModal(feature);
            });
            return false;
        }
        return showModal(feature);
    }

    function shortName() {
        var user = state.user || {};
        var name = user.name || user.email || '';
        return name.split('@')[0].split(' ')[0] || '계정';
    }

    function ensureTopButton() {
        var right = document.querySelector('.top-bar__right');
        if (!right) return null;
        var btn = right.querySelector('.top-bar__auth');
        if (btn) return btn;
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'top-bar__auth';
        var hamburger = right.querySelector('.top-bar__hamburger');
        right.insertBefore(btn, hamburger || right.firstChild);
        btn.addEventListener('click', function () {
            if (state.authed) logout();
            else login();
        });
        return btn;
    }

    function ensureDrawerButton() {
        var nav = document.querySelector('.top-bar__nav');
        if (!nav) return null;
        var btn = nav.querySelector('.top-bar__auth-item');
        if (btn) return btn;
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'top-bar__link top-bar__auth-item';
        var theme = nav.querySelector('.top-bar__theme-item');
        nav.insertBefore(btn, theme || null);
        btn.addEventListener('click', function () {
            if (state.authed) logout();
            else login();
        });
        return btn;
    }

    function renderAuthControls() {
        var top = ensureTopButton();
        var drawer = ensureDrawerButton();
        if (!state.loginEnabled) {
            if (top) top.hidden = true;
            if (drawer) drawer.hidden = true;
            return;
        }
        var label = state.authed ? '로그아웃' : '로그인';
        var title = state.authed ? (shortName() + ' - 로그아웃') : 'Google 로그인';
        if (top) {
            top.hidden = false;
            top.textContent = label;
            top.title = title;
            top.classList.toggle('top-bar__auth--authed', state.authed);
        }
        if (drawer) {
            drawer.hidden = false;
            drawer.textContent = label;
            drawer.classList.toggle('top-bar__auth-item--authed', state.authed);
        }
    }

    function showAuthErrorFromUrl() {
        var params;
        try { params = new URLSearchParams(window.location.search); }
        catch (e) { return; }
        var reason = params.get('auth');
        if (!reason || reason === 'cancelled') return;
        var msg = '로그인을 완료하지 못했습니다.';
        if (reason === 'setup_missing') msg = 'Google 로그인 환경변수 설정이 필요합니다.';
        ensureModal();
        var title = modal.querySelector('#authModalTitle');
        var text = modal.querySelector('.auth-modal__text');
        var loginBtn = modal.querySelector('.auth-modal__login');
        if (title) title.textContent = '로그인 확인';
        if (text) text.textContent = msg;
        if (loginBtn) loginBtn.style.display = reason === 'setup_missing' ? 'none' : '';
        modal.style.display = 'flex';
        params.delete('auth');
        var qs = params.toString();
        var next = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
        window.history.replaceState({}, '', next);
    }

    window.WhyAuth = {
        ready: ready,
        refresh: refresh,
        getState: getState,
        getUser: function () { return state.user; },
        isAuthed: function () { return state.authed; },
        isLoginEnabled: function () { return state.loginEnabled; },
        personalAllowed: personalAllowed,
        requireLogin: requireLogin,
        login: login,
        logout: logout,
        clearPersonalCache: clearPersonalCache,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            renderAuthControls();
            showAuthErrorFromUrl();
        });
    } else {
        renderAuthControls();
        showAuthErrorFromUrl();
    }
    refresh();
})();
