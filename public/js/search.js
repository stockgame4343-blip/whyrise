/**
 * 검색 자동완성 — index.json (ticker → name) 기반.
 *
 * 한글 substring + 초성 매칭 단순 버전.
 * Hero 검색바와 종목 페이지 미니 검색바 둘 다 같은 input id="heroSearch" 를 씀.
 */
var WhySearch = (function () {

    var _index = null;            // { ticker: name }
    var _stats = null;            // optional — 자주 오른 횟수 등

    var KO_INITIALS = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

    function initialOf(ch) {
        var code = ch.charCodeAt(0);
        if (code < 0xAC00 || code > 0xD7A3) return ch;
        return KO_INITIALS[Math.floor((code - 0xAC00) / (21 * 28))];
    }

    function toInitials(s) {
        var out = '';
        for (var i = 0; i < s.length; i++) out += initialOf(s.charAt(i));
        return out;
    }

    function isInitialQuery(q) {
        for (var i = 0; i < q.length; i++) {
            if (KO_INITIALS.indexOf(q.charAt(i)) === -1) return false;
        }
        return q.length > 0;
    }

    function matches(name, query) {
        if (!query) return false;
        var n = name.toLowerCase();
        var q = query.toLowerCase();
        if (n.indexOf(q) !== -1) return true;
        if (isInitialQuery(query)) {
            return toInitials(name).indexOf(query) !== -1;
        }
        return false;
    }

    function search(query, limit) {
        if (!_index) return [];
        if (!query || !query.trim()) return [];
        limit = limit || 10;
        var results = [];
        var keys = Object.keys(_index);
        for (var i = 0; i < keys.length; i++) {
            var ticker = keys[i];
            var entry = _index[ticker];
            var name = typeof entry === 'string' ? entry : entry.name;
            if (matches(name, query) || ticker.indexOf(query) === 0) {
                var count = (entry && typeof entry === 'object') ? (entry.count || 0) : 0;
                results.push({ ticker: ticker, name: name, count: count });
                if (results.length >= limit * 3) break;  // pre-filter widening
            }
        }
        results.sort(function (a, b) { return b.count - a.count; });
        return results.slice(0, limit);
    }

    function bindInput(inputEl, suggestEl) {
        if (!inputEl || !suggestEl) return;
        var activeIdx = -1;

        function render(results) {
            if (!results.length) { suggestEl.hidden = true; suggestEl.innerHTML = ''; return; }
            var html = '';
            results.forEach(function (r, idx) {
                html += '<li data-ticker="' + r.ticker + '" class="' + (idx === activeIdx ? 'active' : '') + '">' +
                    '<span><strong>' + r.name + '</strong> <span class="ticker">' + r.ticker + '</span></span>' +
                    (r.count > 0 ? '<span class="badge">+15% ' + r.count + '회</span>' : '') +
                    '</li>';
            });
            suggestEl.innerHTML = html;
            suggestEl.hidden = false;
        }

        function go(ticker) {
            if (!ticker) return;
            window.location.href = '/stock/' + ticker;
        }

        inputEl.addEventListener('input', function () {
            activeIdx = -1;
            var q = inputEl.value.trim();
            if (!q) { suggestEl.hidden = true; return; }
            var results = search(q, 10);
            render(results);
        });

        inputEl.addEventListener('keydown', function (e) {
            var items = suggestEl.querySelectorAll('li');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                activeIdx = Math.min(items.length - 1, activeIdx + 1);
                items.forEach(function (it, i) { it.classList.toggle('active', i === activeIdx); });
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                activeIdx = Math.max(-1, activeIdx - 1);
                items.forEach(function (it, i) { it.classList.toggle('active', i === activeIdx); });
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (activeIdx >= 0 && items[activeIdx]) {
                    go(items[activeIdx].getAttribute('data-ticker'));
                } else {
                    var first = suggestEl.querySelector('li');
                    if (first) go(first.getAttribute('data-ticker'));
                }
            } else if (e.key === 'Escape') {
                suggestEl.hidden = true;
            }
        });

        suggestEl.addEventListener('click', function (e) {
            var li = e.target.closest('li');
            if (li) go(li.getAttribute('data-ticker'));
        });

        document.addEventListener('click', function (e) {
            if (!suggestEl.contains(e.target) && e.target !== inputEl) {
                suggestEl.hidden = true;
            }
        });
    }

    function init() {
        var inputEl = document.getElementById('heroSearch');
        var suggestEl = document.getElementById('heroSuggest');
        if (!inputEl || !suggestEl) return;
        WhyAPI.getStockIndex().then(function (idx) {
            _index = idx || {};
        });
        bindInput(inputEl, suggestEl);
    }

    return { init: init, search: search };
})();

document.addEventListener('DOMContentLoaded', WhySearch.init);
