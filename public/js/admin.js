/**
 * 관리자 모드 — 토큰 인증 + 인라인 이유 편집.
 *
 * MVP: 환경변수 ADMIN_TOKEN 1개. /api/admin-login POST → HttpOnly 쿠키 wr_admin.
 * Phase 3 OAuth 도입 시 deprecate.
 */
var Admin = (function () {

    var _state = { authed: false, checked: false };

    function _checkSession() {
        return fetch('/api/admin-login', { method: 'GET', credentials: 'same-origin' })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                _state.authed = !!data.authed;
                _state.checked = true;
                if (_state.authed) document.body.classList.add('admin-on');
                return _state.authed;
            })
            .catch(function () { _state.checked = true; return false; });
    }

    function login(token) {
        return fetch('/api/admin-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ token: token }),
        }).then(function (res) {
            return res.json().then(function (data) {
                if (!res.ok) throw new Error(data.error || '로그인 실패');
                _state.authed = true;
                document.body.classList.add('admin-on');
                return data;
            });
        });
    }

    function logout() {
        return fetch('/api/admin-login', {
            method: 'DELETE',
            credentials: 'same-origin',
        }).then(function () {
            _state.authed = false;
            document.body.classList.remove('admin-on');
        });
    }

    function isLoggedIn() { return _state.authed; }

    function saveOverride(date, ticker, payload) {
        return fetch('/api/admin-override', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(Object.assign({ date: date, ticker: ticker }, payload)),
        }).then(function (res) {
            return res.json().then(function (data) {
                if (!res.ok) throw new Error(data.error || '저장 실패');
                return data;
            });
        });
    }

    function deleteOverride(date, ticker) {
        return fetch('/api/admin-override?date=' + date + '&ticker=' + ticker, {
            method: 'DELETE',
            credentials: 'same-origin',
        }).then(function (res) {
            if (!res.ok) throw new Error('삭제 실패');
            return res.json();
        });
    }

    // 모달 핸들러 — 모든 페이지에서 호출 가능
    function bindEditModal(onSaved) {
        var $modal = document.getElementById('adminEditModal');
        if (!$modal) return;
        var $title = document.getElementById('adminEditTitle');
        var $reason = document.getElementById('adminReasonInput');
        var $theme = document.getElementById('adminThemeInput');
        var $note = document.getElementById('adminNoteInput');
        var $close = document.getElementById('adminEditClose');
        var $save = document.getElementById('adminEditSave');
        var $reset = document.getElementById('adminEditReset');

        var current = { date: null, ticker: null, name: null };

        function open(ctx) {
            if (!_state.authed) {
                alert('관리자 로그인이 필요합니다. /admin 으로 가서 인증해주세요.');
                return;
            }
            current = ctx;
            $title.textContent = (ctx.name || ctx.ticker) + ' — ' + ctx.date + ' 이유 편집';
            $reason.value = ctx.reason || '';
            $theme.value = ctx.theme_tag || '';
            $note.value = ctx.note || '';
            $modal.style.display = 'flex';
            setTimeout(function () { $reason.focus(); }, 50);
        }
        function close() { $modal.style.display = 'none'; }

        $close.addEventListener('click', close);
        $modal.addEventListener('click', function (e) {
            if (e.target === $modal) close();
        });

        $save.addEventListener('click', function () {
            saveOverride(current.date, current.ticker, {
                rise_reason: $reason.value.trim(),
                theme_tag: $theme.value.trim(),
                note: $note.value.trim(),
            }).then(function () {
                close();
                if (typeof onSaved === 'function') onSaved(current);
            }).catch(function (err) {
                alert('저장 실패: ' + err.message);
            });
        });

        $reset.addEventListener('click', function () {
            if (!confirm('이 종목의 override 를 삭제하시겠습니까?')) return;
            deleteOverride(current.date, current.ticker).then(function () {
                close();
                if (typeof onSaved === 'function') onSaved(current);
            }).catch(function (err) { alert('삭제 실패: ' + err.message); });
        });

        return { open: open, close: close };
    }

    return {
        init: _checkSession,
        login: login,
        logout: logout,
        isLoggedIn: isLoggedIn,
        saveOverride: saveOverride,
        deleteOverride: deleteOverride,
        bindEditModal: bindEditModal,
    };
})();

// 자동 세션 체크 (admin.html 외 페이지에서도 — 쿠키 있으면 ✏️ 버튼 노출)
document.addEventListener('DOMContentLoaded', Admin.init);
