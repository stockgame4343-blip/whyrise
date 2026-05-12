/**
 * 트리맵 — finviz.com/map 스타일.
 *
 * D3 treemap (squarify) — 면적 = 시가총액, 색 = 상승률.
 * 섹터/테마별 그룹핑. 각 셀: 종목명·상승률 큰 글씨.
 */
(function () {
    if (typeof d3 === 'undefined') {
        console.error('d3 not loaded');
        return;
    }

    var CUTOFF = 15;

    var state = {
        rankings: [],
        groupBy: 'sector',
        searchTerm: '',
    };

    function bindThemeToggle() {
        var $btn = document.getElementById('themeToggle');
        if (!$btn) return;
        $btn.addEventListener('click', function () {
            var cur = document.documentElement.getAttribute('data-theme') || 'dark';
            var next = cur === 'light' ? 'dark' : 'light';
            if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('theme', next);
        });
    }

    function shadeColor(rate) {
        // 15% (옅) → 30% (진) 빨강 톤
        var t = Math.max(0, Math.min(1, (rate - 15) / 15));
        // RGB: (218,46,60) → (179, 30, 42)
        var r = Math.round(220 - 40 * t);
        var g = Math.round(68 - 38 * t);
        var b = Math.round(82 - 40 * t);
        return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    function fmtCap(n) {
        if (n == null || n === 0) return '-';
        if (n >= 1e12) return (n / 1e12).toFixed(1) + '조';
        if (n >= 1e8) return Math.round(n / 1e8) + '억';
        return n.toLocaleString('ko-KR');
    }

    function stage() {
        var $stage = document.getElementById('treeStage');
        return { w: $stage.clientWidth, h: $stage.clientHeight };
    }

    function render() {
        var $svg = d3.select('#treeSvg');
        $svg.selectAll('*').remove();

        var s = stage();
        $svg.attr('viewBox', '0 0 ' + s.w + ' ' + s.h)
            .attr('width', s.w).attr('height', s.h);

        var rankings = state.rankings.filter(function (r) {
            return r.change_rate != null && r.change_rate >= CUTOFF;
        });

        if (!rankings.length) {
            $svg.append('text')
                .attr('x', s.w / 2).attr('y', s.h / 2)
                .attr('text-anchor', 'middle')
                .attr('fill', 'currentColor').attr('opacity', 0.4)
                .attr('font-size', 16)
                .text('오늘 +15% 이상 오른 종목이 없습니다.');
            return;
        }

        var groupKey = state.groupBy;

        // 계층 데이터: root → group → leaves. 면적 = 상승률 (사용자 요청).
        var groups = d3.group(rankings, function (d) { return d[groupKey === 'theme' ? 'theme_tag' : 'sector'] || '기타'; });
        var root = d3.hierarchy({
            name: 'root',
            children: Array.from(groups, function (entry) {
                return {
                    name: entry[0],
                    children: entry[1].map(function (r) {
                        // 상승률 - 14 (15% 컷오프 기준) 으로 차이 강조. 14는 모두 양수 보장.
                        return Object.assign({}, r, { value: Math.max(1, (r.change_rate || 0) - 14) });
                    }),
                };
            }),
        }).sum(function (d) { return d.value; })
          .sort(function (a, b) { return b.value - a.value; });

        var layout = d3.treemap()
            .size([s.w, s.h])
            .paddingOuter(4)
            .paddingTop(20)        // 그룹 라벨 공간
            .paddingInner(2)
            .round(true);
        layout(root);

        // 그룹 박스
        var groupG = $svg.append('g').attr('class', 'tree-groups');
        groupG.selectAll('rect')
            .data(root.children || [])
            .join('rect')
            .attr('x', function (d) { return d.x0; })
            .attr('y', function (d) { return d.y0; })
            .attr('width', function (d) { return d.x1 - d.x0; })
            .attr('height', function (d) { return d.y1 - d.y0; })
            .attr('fill', 'rgba(255,255,255,0.03)')
            .attr('stroke', 'rgba(255,255,255,0.06)')
            .attr('stroke-width', 1);

        // 그룹 라벨
        groupG.selectAll('text')
            .data(root.children || [])
            .join('text')
            .attr('x', function (d) { return d.x0 + 8; })
            .attr('y', function (d) { return d.y0 + 14; })
            .attr('fill', 'rgba(255,255,255,0.55)')
            .attr('font-size', 11)
            .attr('font-weight', 700)
            .attr('letter-spacing', 0.4)
            .attr('text-transform', 'uppercase')
            .text(function (d) {
                var w = d.x1 - d.x0;
                var max = Math.max(3, Math.floor(w / 8));
                var name = d.data.name || '';
                return name.length > max ? name.slice(0, max - 1) + '…' : name;
            });

        // 종목 셀
        var leaves = root.leaves();
        var leafG = $svg.append('g').attr('class', 'tree-leaves')
            .selectAll('g').data(leaves).join('g')
            .attr('class', 'tree-leaf')
            .style('cursor', 'pointer')
            .on('click', function (event, d) { openModal(d.data); });

        leafG.append('rect')
            .attr('x', function (d) { return d.x0; })
            .attr('y', function (d) { return d.y0; })
            .attr('width', function (d) { return d.x1 - d.x0; })
            .attr('height', function (d) { return d.y1 - d.y0; })
            .attr('fill', function (d) { return shadeColor(d.data.change_rate); })
            .attr('stroke', 'rgba(0,0,0,0.4)')
            .attr('stroke-width', 1);

        // 종목명
        leafG.append('text')
            .attr('class', 'tree-leaf-name')
            .attr('x', function (d) { return (d.x0 + d.x1) / 2; })
            .attr('y', function (d) { return (d.y0 + d.y1) / 2 - 6; })
            .attr('text-anchor', 'middle')
            .attr('fill', '#fff')
            .attr('font-weight', 700)
            .attr('pointer-events', 'none')
            .attr('font-size', function (d) {
                var w = d.x1 - d.x0;
                var h = d.y1 - d.y0;
                var minDim = Math.min(w, h);
                return Math.max(0, Math.min(18, minDim * 0.18));
            })
            .text(function (d) {
                var w = d.x1 - d.x0;
                var h = d.y1 - d.y0;
                if (w < 50 || h < 32) return '';
                var max = Math.max(2, Math.floor(w / 9));
                var nm = d.data.name || '';
                return nm.length > max ? nm.slice(0, max - 1) + '…' : nm;
            });

        // 상승률
        leafG.append('text')
            .attr('class', 'tree-leaf-rate')
            .attr('x', function (d) { return (d.x0 + d.x1) / 2; })
            .attr('y', function (d) { return (d.y0 + d.y1) / 2 + 14; })
            .attr('text-anchor', 'middle')
            .attr('fill', '#fff')
            .attr('font-weight', 800)
            .attr('pointer-events', 'none')
            .attr('font-size', function (d) {
                var w = d.x1 - d.x0;
                var h = d.y1 - d.y0;
                var minDim = Math.min(w, h);
                return Math.max(0, Math.min(22, minDim * 0.24));
            })
            .text(function (d) {
                var w = d.x1 - d.x0;
                var h = d.y1 - d.y0;
                if (w < 40 || h < 28) return '';
                return '+' + d.data.change_rate.toFixed(1) + '%';
            });

        // hover title (네이티브 툴팁)
        leafG.append('title').text(function (d) {
            return d.data.name + ' (' + d.data.ticker + ')\n' +
                '+' + d.data.change_rate.toFixed(2) + '%\n' +
                (d.data.rise_reason || '') + '\n' +
                '시총 ' + fmtCap(d.data.market_cap);
        });

        applySearch();
    }

    function applySearch() {
        var q = (state.searchTerm || '').toLowerCase().trim();
        d3.selectAll('.tree-leaf')
            .classed('dim', function (d) {
                if (!q) return false;
                var name = (d.data.name || '').toLowerCase();
                var tk = (d.data.ticker || '').toLowerCase();
                return !(name.indexOf(q) !== -1 || tk.indexOf(q) === 0);
            });
    }

    function bindGroupToggle() {
        var btns = document.querySelectorAll('.group-btn');
        btns.forEach(function (b) {
            b.addEventListener('click', function () {
                var g = b.getAttribute('data-group');
                if (g === state.groupBy) return;
                state.groupBy = g;
                btns.forEach(function (x) { x.classList.toggle('active', x === b); });
                render();
            });
        });
    }

    function bindSearch() {
        var $s = document.getElementById('treeSearch');
        if (!$s) return;
        $s.addEventListener('input', function () {
            state.searchTerm = $s.value;
            applySearch();
        });
    }

    // 모달
    function openModal(d) {
        var $modal = document.getElementById('bubbleModal');
        if (!$modal) return;
        document.getElementById('modalName').textContent = d.name || d.ticker;
        document.getElementById('modalTicker').textContent = d.ticker || '';
        document.getElementById('modalRate').textContent = '+' + d.change_rate.toFixed(2) + '%';
        document.getElementById('modalReason').textContent = d.rise_reason || '이유 미수집';
        document.getElementById('modalMeta').innerHTML =
            '<dt>섹터</dt><dd>' + (d.sector || '-') + '</dd>' +
            '<dt>테마</dt><dd>' + (d.theme_tag || '-') + '</dd>' +
            '<dt>시가총액</dt><dd>' + fmtCap(d.market_cap) + '</dd>' +
            '<dt>시장</dt><dd>' + (d.market || '-') + '</dd>';
        document.getElementById('modalCta').setAttribute('href', '/stock/' + d.ticker);
        $modal.style.display = 'flex';
    }
    function closeModal() { document.getElementById('bubbleModal').style.display = 'none'; }
    function bindModal() {
        document.getElementById('bubbleModalClose').addEventListener('click', closeModal);
        document.getElementById('bubbleModalOverlay').addEventListener('click', closeModal);
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
    }

    function loadAndRender() {
        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        $loading.style.display = 'flex';

        WhyAPI.getDates().then(function (dates) {
            if (!dates || !dates.length) throw new Error('거래일 데이터 없음');
            return WhyAPI.getRankings(dates[0]).then(function (data) {
                state.rankings = data.rankings || [];
                var n = state.rankings.filter(function (r) { return r.change_rate >= CUTOFF; }).length;
                document.getElementById('treeCount').textContent = n;
                var d = dates[0];
                document.getElementById('treeDate').textContent =
                    d.slice(0,4) + '.' + d.slice(4,6) + '.' + d.slice(6,8);
                $loading.style.display = 'none';
                render();
                window.addEventListener('resize', function () {
                    clearTimeout(window._trResize);
                    window._trResize = setTimeout(render, 250);
                });
            });
        }).catch(function (err) {
            $loading.style.display = 'none';
            $msg.textContent = '데이터 로딩 실패: ' + err.message;
            $msg.style.display = 'flex';
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        bindThemeToggle();
        bindGroupToggle();
        bindSearch();
        bindModal();
        loadAndRender();
    });
})();
