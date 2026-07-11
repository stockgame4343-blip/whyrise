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

    // 저장/삭제 직후 WhyAPI override 캐시 동기화 — 5분 캐시·정적 파일 재배포 지연으로
    // 이 클라이언트가 stale 값을 다시 그리지 않게 한다 (entry=null 이면 삭제 반영).
    function _syncApiCache(date, ticker, entry) {
        if (typeof WhyAPI === 'undefined') return Promise.resolve();
        if (WhyAPI.applyLocalOverride) {
            return WhyAPI.applyLocalOverride(date, ticker, entry)
                .catch(function () {});
        }
        if (WhyAPI.invalidateOverrides) WhyAPI.invalidateOverrides(date);
        return Promise.resolve();
    }

    // 로컬 낙관 캐시용 entry — 서버(admin-override.py)는 빈 theme_tag/note 를 키 생략으로
    // 저장하지만, 로컬 캐시 entry 는 '지움'을 명시적 빈 문자열로 들고 간다(replace 시맨틱).
    // 소비자(api.js _shapeRankings, stock.js applyOverrideToEvent)는 비어있지 않은
    // 기여만 적용하므로 빈 값 = 이전 admin 기여 제거 = 원본 노출.
    function _overrideEntry(payload) {
        return {
            rise_reason: (payload && payload.rise_reason) || '',
            theme_tag: (payload && payload.theme_tag) || '',
            note: (payload && payload.note) || '',
        };
    }

    function saveOverride(date, ticker, payload) {
        return fetch('/api/admin-override', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(Object.assign({ date: date, ticker: ticker }, payload)),
        }).then(function (res) {
            return res.json().then(function (data) {
                if (!res.ok) throw new Error(data.error || '저장 실패');
                return _syncApiCache(date, ticker, _overrideEntry(payload))
                    .then(function () { return data; });
            });
        });
    }

    function deleteOverride(date, ticker) {
        return fetch('/api/admin-override?date=' + date + '&ticker=' + ticker, {
            method: 'DELETE',
            credentials: 'same-origin',
        }).then(function (res) {
            if (!res.ok) throw new Error('삭제 실패');
            return res.json().then(function (data) {
                return _syncApiCache(date, ticker, null)
                    .then(function () { return data; });
            });
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
            var payload = {
                rise_reason: $reason.value.trim(),
                theme_tag: $theme.value.trim(),
                note: $note.value.trim(),
            };
            saveOverride(current.date, current.ticker, payload).then(function () {
                close();
                // 2번째 인자 = 저장 값 — 소비자(stock.js 등)가 화면 즉시 반영에 사용
                if (typeof onSaved === 'function') onSaved(current, payload);
            }).catch(function (err) {
                alert('저장 실패: ' + err.message);
            });
        });

        $reset.addEventListener('click', function () {
            if (!confirm('이 종목의 override 를 삭제하시겠습니까?')) return;
            deleteOverride(current.date, current.ticker).then(function () {
                close();
                // 2번째 인자 null = 삭제 — 소비자가 원본 복원/재조회에 사용
                if (typeof onSaved === 'function') onSaved(current, null);
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
