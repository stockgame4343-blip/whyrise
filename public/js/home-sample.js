/**
 * home-sample (홈샘플) — 랜딩형 홈 제안 페이지 로직.
 *
 * 정식 홈(whyrise.js)과 달리 전체 테이블/관심/뉴스모달을 끌어오지 않고,
 * WhyAPI 만 사용해 "맛보기" 컴팩트 리스트 + 오늘의 대장(종목/섹터/테마)을 렌더한다.
 * 검색(search.js)·내비(nav.js)는 동일 마크업/ID 로 그대로 재사용.
 */
(function () {
    'use strict';

    var TOP_N = 12;                // 미리보기 노출 종목 수
    var PLACEHOLDER_THEME = '분야'; // stock-rise placeholder 테마 (이유로 쓰지 않음)

    // ── 유틸 ──────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fmtRate(v) {
        var n = Number(v) || 0;
        return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
    }
    function fmtAmount(won) {
        var n = Number(won) || 0;
        if (n >= 1e12) return (n / 1e12).toFixed(1) + '조';
        if (n >= 1e8) return Math.round(n / 1e8).toLocaleString() + '억';
        if (n >= 1e4) return Math.round(n / 1e4).toLocaleString() + '만';
        return n.toLocaleString();
    }
    function fmtDateLabel(date, res) {
        var s = String(date || '');
        if (s.length !== 8) return '—';
        var m = parseInt(s.slice(4, 6), 10);
        var d = parseInt(s.slice(6, 8), 10);
        var phase = (res && res.mode === 'intraday' && !res.is_final) ? '장중' : '마감';
        return m + '월 ' + d + '일 · ' + phase + ' 기준';
    }
    // 상승이유 표시 — '강세/기대/수혜' 등 가격 자극·예측 표현 금지(유사투자자문 미신고).
    // rise_reason(사실 집계)만 노출하고, 없으면 중립 문구.
    function cleanReason(r) {
        var reason = (r.rise_reason || '').trim();
        if (reason) return reason;
        return '이유 분석 중';
    }
    function detailUrl(ticker) { return '/stock/' + ticker; }

    // ── 테마 토글 (bubbles2/flowmap 와 동일 패턴) ──────
    function bindTheme() {
        var btn = document.getElementById('themeToggle');
        if (!btn) return;
        btn.addEventListener('click', function () {
            var cur = document.documentElement.getAttribute('data-theme') || 'dark';
            var next = cur === 'light' ? 'dark' : 'light';
            if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('theme', next);
        });
    }

    // ── ① 컴팩트 리스트 렌더 ──────────────────────────
    function renderList(rankings) {
        var el = document.getElementById('hsTopList');
        if (!el) return;
        var rows = rankings.slice().sort(function (a, b) {
            return (b.change_rate || 0) - (a.change_rate || 0);
        }).slice(0, TOP_N);

        if (!rows.length) {
            el.innerHTML = '<div class="hs-skeleton" style="padding:28px;text-align:center;color:var(--text-muted)">표시할 종목이 없어요.</div>';
            return;
        }

        var html = rows.map(function (r, i) {
            var tag = (r.theme_tag || '').trim();
            var tagHtml = (tag && tag !== PLACEHOLDER_THEME)
                ? '<span class="hs-row__tag">' + esc(tag) + '</span>' : '';
            return '' +
                '<a class="hs-row" href="' + esc(detailUrl(r.ticker)) + '">' +
                    '<span class="hs-row__rank">' + (i + 1) + '</span>' +
                    '<span class="hs-row__main">' +
                        '<span class="hs-row__name">' + esc(r.name) +
                            '<span class="compact-row__market">' + esc(r.market || '') + '</span>' +
                        '</span>' +
                        '<span class="hs-row__reason">' + esc(cleanReason(r)) + '</span>' +
                    '</span>' +
                    '<span class="hs-row__right">' +
                        tagHtml +
                        '<span class="hs-row__rate">' + fmtRate(r.change_rate) + '</span>' +
                    '</span>' +
                '</a>';
        }).join('');
        el.innerHTML = html;
    }

    // ── ② 오늘의 대장 계산 ────────────────────────────
    function computeLeaders(rankings) {
        var stock = null;
        var secMap = {}, thMap = {};
        rankings.forEach(function (r) {
            var rate = Number(r.change_rate) || 0;
            var vol = Number(r.trading_value) || 0;
            if (!stock || rate > (Number(stock.change_rate) || 0) ||
                (rate === (Number(stock.change_rate) || 0) && vol > (Number(stock.trading_value) || 0))) {
                stock = r;
            }
            var sec = (r.sector || '').trim();
            if (sec) accumulate(secMap, sec, r, rate, vol);
            var th = (r.theme_tag || '').trim();
            if (th && th !== PLACEHOLDER_THEME) accumulate(thMap, th, r, rate, vol);
        });
        return { stock: stock, sector: pickGroup(secMap), theme: pickGroup(thMap) };
    }
    function accumulate(map, key, r, rate, vol) {
        var g = map[key] || (map[key] = { name: key, count: 0, sum: 0, vol: 0, top: null });
        g.count++; g.sum += rate; g.vol += vol;
        if (!g.top || rate > (Number(g.top.change_rate) || 0)) g.top = r;
    }
    function pickGroup(map) {
        var best = null;
        Object.keys(map).forEach(function (k) {
            var g = map[k];
            if (!best || g.count > best.count || (g.count === best.count && g.vol > best.vol)) best = g;
        });
        if (best) best.avg = best.sum / best.count;
        return best;
    }

    // ── ② 대장 카드 렌더 ──────────────────────────────
    var STAR = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">' +
        '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01z"/></svg>';

    function cardShell(kind, inner, href) {
        var open = href ? '<a class="hs-leader glass" href="' + esc(href) + '">' : '<div class="hs-leader glass hs-leader--empty">';
        var close = href ? '</a>' : '</div>';
        return open +
            '<span class="hs-leader__top">' +
                '<span class="hs-leader__crown">' + STAR + '</span>' +
                '<span class="hs-leader__kind">' + esc(kind) + '</span>' +
            '</span>' + inner + close;
    }
    function emptyCard(kind) {
        return cardShell(kind,
            '<span class="hs-leader__name">집계 대기 중</span>' +
            '<span class="hs-leader__meta">아직 충분한 급등 종목이 없어요.</span>', null);
    }

    function renderLeaders(leaders) {
        var el = document.getElementById('hsLeaders');
        if (!el) return;
        var cards = [];

        // 대장 종목
        if (leaders.stock) {
            var s = leaders.stock;
            cards.push(cardShell('대장 종목',
                '<span class="hs-leader__name">' + esc(s.name) +
                    '<span class="hs-leader__rate">' + fmtRate(s.change_rate) + '</span>' +
                '</span>' +
                '<span class="hs-leader__meta">' + esc(cleanReason(s)) + '</span>',
                detailUrl(s.ticker)));
        } else { cards.push(emptyCard('대장 종목')); }

        // 대장 섹터
        if (leaders.sector) {
            var sec = leaders.sector;
            cards.push(cardShell('대장 섹터',
                '<span class="hs-leader__name">' + esc(sec.name) +
                    '<span class="hs-leader__rate">평균 ' + fmtRate(sec.avg) + '</span>' +
                '</span>' +
                '<span class="hs-leader__meta">급등 <b>' + sec.count + '</b>개 · 대표 <b>' + esc(sec.top.name) + '</b></span>',
                '/screening.html?sector=' + encodeURIComponent(sec.name)));
        } else { cards.push(emptyCard('대장 섹터')); }

        // 대장 테마
        if (leaders.theme) {
            var th = leaders.theme;
            cards.push(cardShell('대장 테마',
                '<span class="hs-leader__name">' + esc(th.name) +
                    '<span class="hs-leader__rate">평균 ' + fmtRate(th.avg) + '</span>' +
                '</span>' +
                '<span class="hs-leader__meta">급등 <b>' + th.count + '</b>개 · 대표 <b>' + esc(th.top.name) + '</b></span>',
                '/screening.html?theme=' + encodeURIComponent(th.name)));
        } else { cards.push(emptyCard('대장 테마')); }

        el.innerHTML = cards.join('');
    }

    function showMessage(msg) {
        var el = document.getElementById('hsMessage');
        if (!el) return;
        el.textContent = msg;
        el.hidden = false;
    }

    // ── 부트 ─────────────────────────────────────────
    function boot() {
        bindTheme();
        WhyAPI.getDates().then(function (dates) {
            if (!dates || !dates.length) throw new Error('no-dates');
            var date = dates[0];
            return WhyAPI.getRankings(date, 'ALL').then(function (res) {
                var rk = (res && res.rankings) || [];
                var dateEl = document.getElementById('hsTopDate');
                if (dateEl) dateEl.textContent = fmtDateLabel(date, res);
                renderList(rk);
                renderLeaders(computeLeaders(rk));
            });
        }).catch(function () {
            var list = document.getElementById('hsTopList');
            if (list) list.innerHTML = '<div class="hs-skeleton" style="padding:28px;text-align:center;color:var(--text-muted)">데이터를 불러오지 못했어요.</div>';
            renderLeaders({ stock: null, sector: null, theme: null });
            showMessage('데이터를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
        });
    }

    document.addEventListener('DOMContentLoaded', boot);
})();
