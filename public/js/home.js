/**
 * 홈샘플6 — 중앙형 랜딩과 TODAY 3카드를 위한 전용 데이터 렌더러.
 */
(function () {
    'use strict';

    var CORE = typeof WhyReportCore !== 'undefined' ? WhyReportCore : null;
    var LIVE_POLL_MS = 15 * 1000;
    var LIVE_RETRY_MS = 30 * 1000;
    var STATUS_RECHECK_MS = 5 * 60 * 1000;

    var state = {
        date: '',
        baseRows: [],
        response: null,
        liveTimer: null,
        liveFetching: false,
    };

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function number(value) {
        if (CORE) return CORE.num(value);
        var parsed = Number(value);
        return isFinite(parsed) ? parsed : 0;
    }

    function rate(value) {
        var parsed = number(value);
        return (parsed >= 0 ? '+' : '') + parsed.toFixed(1) + '%';
    }

    function amount(value) {
        var parsed = number(value);
        if (!parsed) return '-';
        if (parsed >= 1e12) return (parsed / 1e12).toFixed(1) + '조';
        if (parsed >= 1e8) return Math.round(parsed / 1e8).toLocaleString('ko-KR') + '억';
        if (parsed >= 1e4) return Math.round(parsed / 1e4).toLocaleString('ko-KR') + '만';
        return Math.round(parsed).toLocaleString('ko-KR');
    }

    function volume(value) {
        var parsed = number(value);
        if (!parsed) return '—';
        if (parsed >= 1e8) return (parsed / 1e8).toFixed(1) + '억주';
        if (parsed >= 1e4) {
            var unit = parsed / 1e4;
            return (unit >= 100 ? Math.round(unit) : unit.toFixed(1)) + '만주';
        }
        return Math.round(parsed).toLocaleString('ko-KR') + '주';
    }

    function volumeOf(row) {
        var parsed = number(row && row.trading_volume);
        if (!parsed && number(row && row.close_price) > 0) {
            parsed = number(row && row.trading_value) / number(row && row.close_price);
        }
        return volume(parsed);
    }

    function fullDateLabel(value) {
        var text = String(value || '');
        if (!/^\d{8}$/.test(text)) return '최신 거래일';
        return Number(text.slice(0, 4)) + '년 ' +
            Number(text.slice(4, 6)) + '월 ' +
            Number(text.slice(6, 8)) + '일';
    }

    function timeLabel(value) {
        var match = /(?:T|\s)(\d{2}):(\d{2})/.exec(String(value || ''));
        return match ? match[1] + ':' + match[2] : '';
    }

    function reasonOf(row) {
        return String(row && (row.rise_reason || row.reason || row.latest_reason) || '').trim() ||
            '상승 이유 분석 중';
    }

    function detailUrl(row) {
        return '/stock/' + encodeURIComponent(row && row.ticker || '');
    }

    function screeningUrl(type, name) {
        var param = type === 'theme' ? 'theme' : 'sector';
        return '/screening.html?' + param + '=' + encodeURIComponent(name || '');
    }

    function setText(id, value) {
        var node = document.getElementById(id);
        if (node) node.textContent = value;
    }

    function phaseOf(response, live) {
        if (live && live.market_status === 'OPEN') return '장중';
        if (live && live.market_status === 'CLOSE') return '마감';
        if (response && response.mode === 'intraday' && !response.is_final) return '장중';
        return '마감';
    }

    function renderStatus(date, response, live) {
        var phase = phaseOf(response, live);
        var status = document.getElementById('home2MarketStatus');
        if (status) {
            status.classList.remove('is-live', 'is-closed', 'is-delayed');
            status.classList.add(phase === '장중' ? 'is-live' : 'is-closed');
        }
        setText('home2Date', fullDateLabel(date) + ' · ' + phase);

        var updated = live && live.updated_at ? live.updated_at : (response && response.collected_at);
        var clock = timeLabel(updated);
        setText('home2UpdatedAt', clock ? phase + ' ' + clock + ' 기준' : fullDateLabel(date) + ' 기준');
    }

    function tagList(row) {
        var tags = [];
        var seen = {};
        function add(value) {
            var text = String(value || '').trim();
            if (!text || seen[text]) return;
            seen[text] = true;
            tags.push(text);
        }
        add(row && row.sector);
        (CORE ? CORE.themeTags(row) : []).forEach(add);
        return tags.slice(0, 3);
    }

    function renderLeader(leader, riseCount, limitCount) {
        setText('home2StatStocks', riseCount + '개');
        setText('home2StatLimit', limitCount + '개');

        var target = document.getElementById('home2HeroLeader');
        if (!target) return;
        if (!leader) {
            target.innerHTML =
                '<p class="home6-card-empty">선정 기준을 충족한 대장주가 아직 없어요.</p>';
            return;
        }

        var tags = tagList(leader).map(function (tag) {
            return '<span>' + esc(tag) + '</span>';
        }).join('');

        target.innerHTML =
            '<a class="home6-leader-detail" href="' + esc(detailUrl(leader)) + '">' +
                '<span class="home6-leader-detail__tags">' + tags + '</span>' +
                '<span class="home6-leader-detail__top">' +
                    '<strong>' + esc(leader.name || leader.ticker) + '</strong>' +
                    '<b>' + esc(rate(leader.change_rate)) + '</b>' +
                '</span>' +
                '<span class="home6-leader-detail__reason">' + esc(reasonOf(leader)) + '</span>' +
                '<span class="home6-leader-detail__metrics">' +
                    '<span><small>거래대금</small><strong>' + esc(amount(leader.trading_value)) + '</strong></span>' +
                    '<span><small>시가총액</small><strong>' + esc(amount(leader.market_cap)) + '</strong></span>' +
                '</span>' +
            '</a>';
    }

    function representativeOf(group) {
        if (!group || !Array.isArray(group.stocks) || !group.stocks.length) return null;
        return group.stocks.slice().sort(function (a, b) {
            return number(b.trading_value) - number(a.trading_value) ||
                number(b.change_rate) - number(a.change_rate);
        })[0];
    }

    function renderGroup(type, groups) {
        var targetId = type === 'theme' ? 'home2ThemeFeature' : 'home2SectorFeature';
        var actionId = type === 'theme' ? 'home2ThemeAction' : 'home2SectorAction';
        var target = document.getElementById(targetId);
        var action = document.getElementById(actionId);
        var top = Array.isArray(groups) ? groups.slice(0, 3) : [];
        var group = top[0];
        if (!target) return;

        if (!group) {
            target.innerHTML =
                '<p class="home6-card-empty">3종목 이상 함께 오른 ' +
                (type === 'theme' ? '테마' : '섹터') + '가 아직 없어요.</p>';
            if (action) {
                action.href = '/screening.html';
                action.innerHTML = (type === 'theme' ? '테마' : '섹터') + ' 전체보기 <span>→</span>';
            }
            return;
        }

        var stock = representativeOf(group);
        var href = screeningUrl(type, group.name || group.key);
        if (action) {
            action.href = href;
            action.innerHTML = esc(group.name || group.key) + ' 전체보기 <span>→</span>';
        }

        var more = top.slice(1).map(function (item, index) {
            var itemHref = screeningUrl(type, item.name || item.key);
            return '<a class="home6-group-feature__row" href="' + esc(itemHref) + '">' +
                '<span><i>' + (index + 2) + '위</i><strong>' + esc(item.name || item.key) + '</strong></span>' +
                '<small>' + item.count + '종목 · 평균 ' + esc(rate(item.avgRate)) + '</small>' +
            '</a>';
        }).join('');

        target.innerHTML =
            '<a class="home6-group-feature__primary" href="' + esc(href) + '">' +
                '<span class="home6-group-feature__primary-head">' +
                    '<span class="home6-group-feature__rank">1위</span>' +
                    '<strong>' + esc(group.name || group.key) + '</strong>' +
                    '<small>' + group.count + '종목 · 평균 ' + esc(rate(group.avgRate)) + '</small>' +
                '</span>' +
                (stock ?
                    '<span class="home6-group-feature__representative">' +
                    '<span><small>대표주</small><strong>' + esc(stock.name || stock.ticker) + '</strong></span>' +
                    '<b>' + esc(rate(stock.change_rate)) + '</b>' +
                    '</span>' : '') +
            '</a>' +
            (more ? '<span class="home6-group-feature__more">' + more + '</span>' : '');
    }

    function renderWhy(riseRows) {
        var target = document.getElementById('home6WhyList');
        if (!target) return;
        var sorted = riseRows.slice().sort(function (a, b) {
            return number(b.change_rate) - number(a.change_rate) ||
                number(b.trading_value) - number(a.trading_value);
        }).slice(0, 6);

        if (!sorted.length) {
            target.innerHTML = '<p class="home6-card-empty">+15% 이상 오른 종목이 아직 없어요.</p>';
            return;
        }

        target.innerHTML = sorted.map(function (row, index) {
            var tag = tagList(row)[0] || '기타';
            return '<a class="home6-why-row" href="' + esc(detailUrl(row)) + '">' +
                '<span class="home6-why-row__rank">' + (index + 1) + '</span>' +
                '<strong class="home6-why-row__name">' + esc(row.name || row.ticker) + '</strong>' +
                '<span class="home6-why-row__context">' +
                    '<span class="theme-tag">' + esc(tag) + '</span>' +
                    '<span class="home6-why-row__reason">' + esc(reasonOf(row)) + '</span>' +
                '</span>' +
                '<b class="home6-why-row__rate">' + esc(rate(row.change_rate)) + '</b>' +
                '<span class="home6-why-row__metric">' +
                    '<small>거래대금</small>' +
                    '<strong>' + esc(amount(row.trading_value)) + '</strong>' +
                '</span>' +
                '<span class="home6-why-row__metric">' +
                    '<small>시총</small>' +
                    '<strong>' + esc(amount(row.market_cap)) + '</strong>' +
                '</span>' +
            '</a>';
        }).join('');
    }

    function renderMarket(rows, date, response, live) {
        if (!CORE) throw new Error('report-core unavailable');
        var riseRows = CORE.activeRiseRows(rows);
        var sectors = CORE.buildGroups(riseRows, 'sector');
        var themes = CORE.buildGroups(riseRows, 'theme');
        var leader = CORE.pickLeader(riseRows, sectors, themes);
        var limitCount = riseRows.filter(CORE.isLimitUp).length;

        renderStatus(date, response, live);
        renderLeader(leader, riseRows.length, limitCount);
        renderGroup('sector', sectors);
        renderGroup('theme', themes);
        renderWhy(riseRows);
    }

    function renderFailure() {
        var status = document.getElementById('home2MarketStatus');
        if (status) {
            status.classList.remove('is-live', 'is-closed');
            status.classList.add('is-delayed');
        }
        setText('home2Date', '데이터 연결 지연');
        setText('home2UpdatedAt', '잠시 후 다시 확인해 주세요');
        setText('home2StatStocks', '—');
        setText('home2StatLimit', '—');
        ['home2HeroLeader', 'home2SectorFeature', 'home2ThemeFeature', 'home6WhyList'].forEach(function (id) {
            var target = document.getElementById(id);
            if (target) target.innerHTML = '<p class="home6-card-empty">데이터를 불러오지 못했어요.</p>';
        });
    }

    function kstClock() {
        return new Date(Date.now() + 9 * 60 * 60 * 1000);
    }

    function isNxtLeadIn() {
        var now = kstClock();
        var minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
        return minutes >= 8 * 60 && minutes < 9 * 60;
    }

    function isRegularMarketWindow() {
        var now = kstClock();
        var day = now.getUTCDay();
        var minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
        return day !== 0 && day !== 6 && minutes >= 9 * 60 && minutes < 15 * 60 + 30;
    }

    function scheduleLive(delay) {
        clearTimeout(state.liveTimer);
        state.liveTimer = setTimeout(refreshLive, delay);
    }

    function refreshLive() {
        clearTimeout(state.liveTimer);
        state.liveTimer = null;
        if (!state.date || state.liveFetching || typeof WhyAPI.getLiveMarketmap !== 'function') return;
        if (document.visibilityState === 'hidden') {
            scheduleLive(LIVE_POLL_MS);
            return;
        }
        if (isNxtLeadIn()) {
            scheduleLive(60 * 1000);
            return;
        }

        state.liveFetching = true;
        WhyAPI.getLiveMarketmap().then(function (live) {
            state.liveFetching = false;
            if (live && live.date === state.date) {
                var overlaid = CORE.overlayRankings(state.baseRows, live.map);
                renderMarket(overlaid, state.date, state.response, live);
            }
            if (isRegularMarketWindow()) {
                scheduleLive(live && live.market_status === 'CLOSE' ? STATUS_RECHECK_MS : LIVE_POLL_MS);
            }
        }).catch(function () {
            state.liveFetching = false;
            if (isRegularMarketWindow()) scheduleLive(LIVE_RETRY_MS);
        });
    }

    function bindTheme() {
        var button = document.getElementById('themeToggle');
        if (!button) return;
        function syncState() {
            var light = document.documentElement.getAttribute('data-theme') === 'light';
            button.setAttribute('aria-pressed', light ? 'true' : 'false');
        }
        syncState();
        button.addEventListener('click', function () {
            var light = document.documentElement.getAttribute('data-theme') === 'light';
            if (light) document.documentElement.removeAttribute('data-theme');
            else document.documentElement.setAttribute('data-theme', 'light');
            localStorage.setItem('theme', light ? 'dark' : 'light');
            syncState();
        });
    }

    function bindSearch() {
        var input = document.getElementById('heroSearch');
        var button = document.getElementById('home2SearchSubmit');
        var suggest = document.getElementById('heroSuggest');
        var feedback = document.getElementById('home2SearchFeedback');
        if (!input) return;

        function setFeedback(message) {
            if (!feedback) return;
            feedback.textContent = message || '';
            feedback.hidden = !message;
        }

        function firstSuggestion() {
            return suggest && !suggest.hidden ? suggest.querySelector('li') : null;
        }

        function attemptSearch() {
            var query = input.value.trim();
            if (!query) {
                setFeedback('종목명 또는 종목코드를 입력해 주세요.');
                input.focus();
                return;
            }
            var first = firstSuggestion();
            if (first) {
                window.location.href = '/stock/' + first.getAttribute('data-ticker');
                return;
            }
            var results = typeof WhySearch !== 'undefined' && WhySearch.search
                ? WhySearch.search(query, 1)
                : [];
            if (results.length) {
                window.location.href = '/stock/' + results[0].ticker;
                return;
            }
            if (typeof WhySearch !== 'undefined' && WhySearch.isReady && !WhySearch.isReady()) {
                setFeedback('검색 데이터를 불러오는 중이에요. 잠시 후 다시 눌러 주세요.');
                input.focus();
                return;
            }
            setFeedback('검색 결과를 찾지 못했어요. 종목명이나 코드를 확인해 주세요.');
            input.focus();
        }

        input.addEventListener('input', function () { setFeedback(''); });
        input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' && !firstSuggestion()) attemptSearch();
        });
        if (button) button.addEventListener('click', attemptSearch);
    }

    function bindScrollCue() {
        var cue = document.querySelector('.home6-scroll-cue');
        var target = document.getElementById('home6Today');
        if (!cue || !target) return;
        cue.addEventListener('click', function (event) {
            event.preventDefault();
            var reduced = window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
        });
    }

    function rotateHeadlineStocks() {
        var rotator = document.querySelector('.home6-stock-rotator');
        var label = document.getElementById('home6RotatingStock');
        if (!rotator || !label) return;

        var stocks = [
            '삼성전자',
            'SK하이닉스',
            '현대차',
            'NAVER',
            '카카오',
            '셀트리온',
            '한미반도체',
            '에코프로비엠',
            '두산에너빌리티',
            '한화에어로스페이스',
            'LG에너지솔루션',
            '삼성바이오로직스',
            '기아',
            'POSCO홀딩스',
            '크래프톤',
            '두산로보틱스',
            '주성엔지니어링',
            'SK네트웍스',
            '후성',
            '삼성전기',
            '대우건설',
            '디앤디파마텍',
            '삼화콘덴서',
            '제주반도체',
            'SK',
            '져스텍',
            '금호건설'
        ];

        function applyWordSize(element, name) {
            element.classList.remove('is-long', 'is-xlong');
            var length = String(name || '').length;
            if (length >= 9) element.classList.add('is-xlong');
            else if (length >= 7) element.classList.add('is-long');
        }

        var index = Math.floor(Math.random() * stocks.length);
        label.textContent = stocks[index];
        applyWordSize(label, stocks[index]);
        var changing = false;
        var reduced = window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced) return;

        window.setInterval(function () {
            if (changing) return;
            changing = true;
            index = (index + 1) % stocks.length;

            var outgoing = label;
            var incoming = document.createElement('em');
            incoming.textContent = stocks[index];
            applyWordSize(incoming, stocks[index]);
            rotator.appendChild(incoming);

            if (!outgoing.animate || !incoming.animate) {
                outgoing.remove();
                incoming.id = 'home6RotatingStock';
                label = incoming;
                changing = false;
                return;
            }

            var timing = {
                duration: 760,
                easing: 'cubic-bezier(.16, 1, .3, 1)',
                fill: 'both'
            };
            var outgoingAnimation = outgoing.animate([
                { transform: 'translateY(0)', opacity: 1, filter: 'blur(0)' },
                { transform: 'translateY(-112%)', opacity: 0, filter: 'blur(4px)' }
            ], timing);
            var incomingAnimation = incoming.animate([
                { transform: 'translateY(112%)', opacity: 0, filter: 'blur(4px)' },
                { transform: 'translateY(0)', opacity: 1, filter: 'blur(0)' }
            ], timing);

            Promise.all([
                outgoingAnimation.finished,
                incomingAnimation.finished
            ]).then(function () {
                outgoing.remove();
                incoming.id = 'home6RotatingStock';
                label = incoming;
                changing = false;
            }).catch(function () {
                outgoing.remove();
                incoming.id = 'home6RotatingStock';
                label = incoming;
                changing = false;
            });
        }, 3600);
    }

    function loadMarket() {
        if (!CORE || typeof WhyAPI === 'undefined') {
            renderFailure();
            return;
        }
        WhyAPI.getDates().then(function (dates) {
            if (!dates || !dates.length) throw new Error('거래일 없음');
            state.date = dates[0];
            return WhyAPI.getRankings(state.date, 'ALL');
        }).then(function (response) {
            state.response = response || {};
            state.baseRows = Array.isArray(state.response.rankings) ? state.response.rankings : [];
            renderMarket(state.baseRows, state.date, state.response, null);
            refreshLive();
        }).catch(renderFailure);
    }

    document.addEventListener('DOMContentLoaded', function () {
        bindTheme();
        bindSearch();
        bindScrollCue();
        rotateHeadlineStocks();
        loadMarket();
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && state.date && !state.liveTimer) refreshLive();
        });
    });
})();
