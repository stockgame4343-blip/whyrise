/**
 * 버블맵 — Canvas + 글로시 3D + 물리 시뮬레이션.
 *
 * 데이터: /data/bubbles.json — 전 종목 × 5개 기간(d1/w1/m1/m3/y1) 변동률.
 * 토글: 기간 × 개수(25/50/100) × 시장(ALL/KOSPI/KOSDAQ).
 *
 * 표시 종목 = (시장 필터 → 선택 기간 변동률 절댓값 desc → top N → 검색 dim).
 * 빨강 = 상승 (한국 증시), 파랑 = 하락.
 * 클릭 → /stock/{ticker}.
 */
(function () {
    var canvas = document.getElementById('bubblesCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var tip = document.getElementById('bubbleTip');
    var stat = document.getElementById('bubblesStat');

    var state = {
        all: [],            // 모든 종목 (필터 전)
        period: 'w1',
        count: 50,
        market: 'ALL',
        search: '',
        bubbles: [],
        dragging: null,
        hovered: null,
        w: 0, h: 0, dpr: 1,
    };

    function resize() {
        var $stage = document.getElementById('bubblesStage');
        var rect = $stage.getBoundingClientRect();
        state.w = rect.width;
        state.h = rect.height;
        state.dpr = window.devicePixelRatio || 1;
        canvas.width = state.w * state.dpr;
        canvas.height = state.h * state.dpr;
        canvas.style.width = state.w + 'px';
        canvas.style.height = state.h + 'px';
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(state.dpr, state.dpr);
    }

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

    // ── 색 ─────────────────────────────────────
    // 한국 증시: 빨강(상승), 파랑(하락). 변동률 절댓값 50% 까지 강도 매핑.
    function colorFor(change) {
        var abs = Math.min(Math.abs(change || 0), 50);
        var t = abs / 50;
        if (change >= 0) {
            // 빨강 (#f04452 톤 → 진한 빨강)
            var r = Math.round(240 + (255 - 240) * t);
            var g = Math.round(80 - 50 * t);
            var b = Math.round(82 - 60 * t);
            return { r: r, g: g, b: b };
        } else {
            // 파랑 (#5b9df9 톤 → 진한 파랑)
            var r2 = Math.round(91 - 71 * t);
            var g2 = Math.round(157 - 67 * t);
            var b2 = Math.round(249 - 19 * t);
            return { r: r2, g: g2, b: b2 };
        }
    }

    // ── 필터·정렬 ──────────────────────────────
    function rebuild() {
        var p = state.period;
        var filtered = state.all.filter(function (s) {
            if (state.market !== 'ALL' && s.m !== state.market) return false;
            return s[p] != null;
        });
        // 변동률 절댓값 내림차순 — 상승만 보고 싶다면 desc(s[p]). 사용자는 "상승 TOP" 원해서 desc(s[p]) 사용.
        filtered.sort(function (a, b) { return (b[p] || 0) - (a[p] || 0); });
        var top = filtered.slice(0, state.count);

        var maxAbs = top.reduce(function (m, s) { return Math.max(m, Math.abs(s[p] || 0)); }, 5);
        var shortSide = Math.min(state.w || 1200, state.h || 700);
        var minR = Math.max(20, shortSide * 0.035);
        var maxR = Math.max(70, shortSide * 0.12);

        var byTicker = {};
        state.bubbles.forEach(function (b) { byTicker[b.t] = b; });

        state.bubbles = top.map(function (s) {
            var existing = byTicker[s.t];
            var change = s[p] || 0;
            var r = minR + Math.sqrt(Math.abs(change) / maxAbs) * (maxR - minR);
            return {
                t: s.t, n: s.n, m: s.m, s: s.s, mc: s.mc, p: s.p,
                change: change,
                r: r,
                targetR: r,
                x: existing ? existing.x : state.w / 2 + (Math.random() - 0.5) * state.w * 0.7,
                y: existing ? existing.y : state.h / 2 + (Math.random() - 0.5) * state.h * 0.7,
                vx: existing ? existing.vx : (Math.random() - 0.5) * 2,
                vy: existing ? existing.vy : (Math.random() - 0.5) * 2,
                _dim: false,
            };
        });

        // 검색 dim
        applySearch();

        var up = state.bubbles.filter(function (b) { return b.change >= 0; }).length;
        var dn = state.bubbles.length - up;
        var label = ({ d1: '1일', w1: '1주', m1: '1달', m3: '3달', y1: '1년' })[p];
        if (stat) stat.textContent = label + ' 상승 TOP ' + state.bubbles.length + '  ▲' + up + '  ▼' + dn;
    }

    function applySearch() {
        var q = (state.search || '').toLowerCase().trim();
        state.bubbles.forEach(function (b) {
            if (!q) { b._dim = false; return; }
            var nm = (b.n || '').toLowerCase();
            var tk = (b.t || '').toLowerCase();
            b._dim = !(nm.indexOf(q) !== -1 || tk.indexOf(q) === 0);
        });
    }

    // ── 물리 ───────────────────────────────────
    function physics() {
        var W = state.w, H = state.h;
        var bubbles = state.bubbles;
        for (var i = 0; i < bubbles.length; i++) {
            var b = bubbles[i];
            if (b === state.dragging) continue;
            b.r += (b.targetR - b.r) * 0.1;
            var cx = W / 2, cy = H / 2;
            var dx = cx - b.x, dy = cy - b.y;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 0.1) {
                b.vx += (dx / dist) * 0.015;
                b.vy += (dy / dist) * 0.015;
            }
            b.vx *= 0.95; b.vy *= 0.95;
            b.x += b.vx; b.y += b.vy;
            if (b.x - b.r < 0) { b.x = b.r; b.vx *= -0.6; }
            if (b.x + b.r > W) { b.x = W - b.r; b.vx *= -0.6; }
            if (b.y - b.r < 0) { b.y = b.r; b.vy *= -0.6; }
            if (b.y + b.r > H) { b.y = H - b.r; b.vy *= -0.6; }
            for (var j = i + 1; j < bubbles.length; j++) {
                var o = bubbles[j];
                var ddx = o.x - b.x, ddy = o.y - b.y;
                var d = Math.sqrt(ddx * ddx + ddy * ddy);
                var minD = b.r + o.r + 1;
                if (d < minD && d > 0.001) {
                    var overlap = (minD - d) / 2;
                    var nx = ddx / d, ny = ddy / d;
                    if (b !== state.dragging) { b.x -= nx * overlap; b.vx -= nx * 0.3; b.vy -= ny * 0.3; }
                    if (o !== state.dragging) { o.x += nx * overlap; o.vx += nx * 0.3; o.vy += ny * 0.3; }
                }
            }
        }
    }

    // ── 렌더 (글로시 3D) ───────────────────────
    function draw() {
        ctx.clearRect(0, 0, state.w, state.h);
        state.bubbles.forEach(function (b) {
            var col = colorFor(b.change);
            var isHover = b === state.hovered;
            var alpha = b._dim ? 0.18 : 1;

            // 외곽 글로우
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + (0.15 * alpha) + ')';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' +
                ((isHover ? 0.6 : 0.28) * alpha) + ')';
            ctx.stroke();

            // 메인 그라디언트 (3D 구체)
            var grad = ctx.createRadialGradient(
                b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.1,
                b.x, b.y, b.r
            );
            grad.addColorStop(0, 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + (0.95 * alpha) + ')');
            grad.addColorStop(0.55, 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + (0.72 * alpha) + ')');
            grad.addColorStop(1, 'rgba(' +
                Math.round(col.r * 0.45) + ',' + Math.round(col.g * 0.45) + ',' + Math.round(col.b * 0.45) +
                ',' + (0.88 * alpha) + ')');
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r * 0.92, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();

            // 광택 하이라이트
            var hl = ctx.createRadialGradient(
                b.x - b.r * 0.32, b.y - b.r * 0.36, 0,
                b.x - b.r * 0.32, b.y - b.r * 0.36, b.r * 0.4
            );
            hl.addColorStop(0, 'rgba(255,255,255,' + (0.38 * alpha) + ')');
            hl.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.beginPath();
            ctx.arc(b.x - b.r * 0.32, b.y - b.r * 0.36, b.r * 0.4, 0, Math.PI * 2);
            ctx.fillStyle = hl;
            ctx.fill();

            // 텍스트 (반지름 > 15px 만)
            if (b.r > 15) {
                var pct = (b.change >= 0 ? '+' : '') + b.change.toFixed(1) + '%';
                var pctSize = Math.min(b.r * 0.42, 28);
                var nameSize = Math.min(b.r * 0.28, 14);
                ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = '700 ' + pctSize + 'px -apple-system, system-ui, sans-serif';
                ctx.fillText(pct, b.x, b.y - b.r * 0.1);
                if (b.r > 25) {
                    ctx.font = '500 ' + nameSize + 'px -apple-system, system-ui, sans-serif';
                    ctx.fillStyle = 'rgba(255,255,255,' + (0.88 * alpha) + ')';
                    var nm = b.r > 42 ? b.n : (b.n || '').slice(0, 5);
                    ctx.fillText(nm, b.x, b.y + b.r * 0.32);
                }
            }
        });
    }

    function loop() {
        physics();
        draw();
        requestAnimationFrame(loop);
    }

    // ── 인터랙션 ───────────────────────────────
    function pick(mx, my) {
        for (var i = state.bubbles.length - 1; i >= 0; i--) {
            var b = state.bubbles[i];
            var dx = mx - b.x, dy = my - b.y;
            if (dx * dx + dy * dy < b.r * b.r) return b;
        }
        return null;
    }
    function getPos(e) {
        var rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    function bindCanvas() {
        canvas.addEventListener('mousedown', function (e) {
            var p = getPos(e);
            var b = pick(p.x, p.y);
            if (b) { state.dragging = b; canvas.style.cursor = 'grabbing'; }
        });
        canvas.addEventListener('mousemove', function (e) {
            var p = getPos(e);
            if (state.dragging) {
                state.dragging.vx = (p.x - state.dragging.x) * 0.3;
                state.dragging.vy = (p.y - state.dragging.y) * 0.3;
                state.dragging.x = p.x; state.dragging.y = p.y;
            } else {
                var b = pick(p.x, p.y);
                state.hovered = b;
                canvas.style.cursor = b ? 'pointer' : 'default';
                if (b) {
                    tip.style.opacity = '1';
                    tip.style.left = (p.x + 14) + 'px';
                    tip.style.top = (p.y - 10) + 'px';
                    var sign = b.change >= 0 ? '+' : '';
                    var col = b.change >= 0 ? '#f04452' : '#5b9df9';
                    var mc = b.mc ? (b.mc >= 1e12 ? (b.mc / 1e12).toFixed(1) + '조'
                        : b.mc >= 1e8 ? Math.round(b.mc / 1e8) + '억' : '-') : '-';
                    tip.innerHTML =
                        '<div class="bubble-tip__name">' + b.n + '</div>' +
                        '<div class="bubble-tip__meta">' + b.t + ' · ' + b.m + (b.s ? ' · ' + b.s : '') + '</div>' +
                        '<div class="bubble-tip__row">시총 ' + mc +
                        ' · <span style="color:' + col + ';font-weight:700;">' + sign + b.change.toFixed(2) + '%</span></div>';
                } else {
                    tip.style.opacity = '0';
                }
            }
        });
        canvas.addEventListener('mouseup', function () {
            state.dragging = null;
            canvas.style.cursor = 'pointer';
        });
        canvas.addEventListener('mouseleave', function () {
            state.dragging = null; state.hovered = null;
            tip.style.opacity = '0';
        });
        canvas.addEventListener('click', function (e) {
            var p = getPos(e);
            var b = pick(p.x, p.y);
            if (b && b.t) window.location.href = '/stock/' + b.t;
        });
    }

    function bindToggles() {
        document.querySelectorAll('#periodTabs button').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#periodTabs button').forEach(function (x) { x.classList.remove('active'); });
                btn.classList.add('active');
                state.period = btn.dataset.p; rebuild();
            });
        });
        document.querySelectorAll('#countTabs button').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#countTabs button').forEach(function (x) { x.classList.remove('active'); });
                btn.classList.add('active');
                state.count = parseInt(btn.dataset.c, 10); rebuild();
            });
        });
        document.querySelectorAll('#marketTabs button').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#marketTabs button').forEach(function (x) { x.classList.remove('active'); });
                btn.classList.add('active');
                state.market = btn.dataset.m; rebuild();
            });
        });
        var $s = document.getElementById('bubblesSearch');
        if ($s) $s.addEventListener('input', function () {
            state.search = $s.value; applySearch();
        });
    }

    // ── 데이터 ─────────────────────────────────
    function load() {
        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        fetch('/data/bubbles.json', { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                state.all = data.stocks || [];
                $loading.style.display = 'none';
                rebuild();
            })
            .catch(function (err) {
                $loading.style.display = 'none';
                $msg.textContent = 'bubbles.json 로딩 실패: ' + err.message +
                    ' — 다음 빌드 후 표시됩니다.';
                $msg.style.display = 'flex';
            });
    }

    document.addEventListener('DOMContentLoaded', function () {
        bindThemeToggle();
        bindToggles();
        bindCanvas();
        resize();
        window.addEventListener('resize', function () {
            resize();
            clearTimeout(window._bResize);
            window._bResize = setTimeout(rebuild, 200);
        });
        load();
        loop();
    });
})();
