/**
 * 종목 페이지 — /stock/{ticker} (rewrite 로 ?ticker=... 도착)
 *
 * 인덱스 (public/data/stock-history/{ticker}.json) 에서 events 읽어 타임라인 렌더.
 * 관리자 모드일 때 각 event 카드 우측에 ✏️ 편집 버튼.
 */
(function () {
    // 현재가 라이브 — 장중 60초 폴링 (단일 종목 /api/current-price, marketmap 미포함 종목도 커버)
    var PRICE_POLL_MS = 60 * 1000;
    var KST_OFFSET = 9 * 60, OPEN_MIN = 9 * 60, CLOSE_MIN = 15 * 60 + 30;
    function isMarketOpenKST() {
        var k = new Date(Date.now() + KST_OFFSET * 60000);
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < CLOSE_MIN;
    }

    /** HTML 이스케이프 — XSS 방어. 사용자/3rd-party 텍스트는 항상 통과시킴. */
    function esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function getTicker() {
        var qs = new URLSearchParams(window.location.search);
        var t = qs.get('ticker');
        // 6자리 숫자 or 알파/숫자 (KRX 신코드) 만 허용. XSS 방어.
        if (t && /^[0-9A-Z]{6}$/i.test(t)) return t;
        // /stock/008420 직접 접근 (rewrite 미동작) 백업
        var m = window.location.pathname.match(/\/stock\/([0-9A-Z]{6})/i);
        return m ? m[1] : null;
    }

    function formatDate(yyyymmdd) {
        if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
        var y = yyyymmdd.slice(0, 4);
        var m = parseInt(yyyymmdd.slice(4, 6), 10);
        var d = parseInt(yyyymmdd.slice(6, 8), 10);
        var DAYS = ['일','월','화','수','목','금','토'];
        var dt = new Date(parseInt(y,10), m - 1, d);
        return y + '. ' + m + '. ' + d + ' (' + DAYS[dt.getDay()] + ')';
    }

    function topByFreq(items, getKey) {
        var count = {};
        items.forEach(function (it) {
            var k = getKey(it);
            if (!k) return;
            count[k] = (count[k] || 0) + 1;
        });
        var keys = Object.keys(count);
        if (!keys.length) return null;
        keys.sort(function (a, b) { return count[b] - count[a]; });
        return { key: keys[0], count: count[keys[0]] };
    }

    function buildSummary(events) {
        if (!events || !events.length) return '';
        // 가장 빈번한 theme_tag (filled 사건 위주, fallback 전체)
        var filledEvents = events.filter(function (e) {
            return e.reason_status === 'filled' || e.reason_status === 'edited';
        });
        var sourceEvents = filledEvents.length ? filledEvents : events;
        var topTheme = topByFreq(sourceEvents, function (e) { return e.theme_tag || ''; });
        // 가장 빈번한 reason (missing / "52주 신고가 도달" 같은 placeholder 제외)
        var GENERIC = ['52주 신고가 도달', '상한가 — 사유 미수집', '-', ''];
        var topReason = topByFreq(filledEvents, function (e) {
            var r = e.rise_reason || '';
            if (GENERIC.indexOf(r) >= 0) return '';
            return r;
        });

        var parts = [];
        if (topTheme && topTheme.key) parts.push(topTheme.key);
        if (topReason && topReason.key) parts.push(topReason.key);
        if (!parts.length) {
            // 둘 다 없으면 sector 기반 폴백
            var topSector = topByFreq(events, function (e) { return e.sector || ''; });
            if (topSector && topSector.key) parts.push(topSector.key);
        }
        return parts.join(' · ');
    }

    function renderHeader(name, market, stats) {
        var $title = document.getElementById('stockTitle');
        var $market = document.getElementById('stockMarket');
        var $stats = document.getElementById('stockStats');
        var pageTitle = name + ' 왜 오름? - ORGO';
        var pageDesc = name + '의 최근 1년 급등 날짜와 이유·뉴스.';
        document.getElementById('pageTitle').textContent = pageTitle;
        document.getElementById('pageDesc').setAttribute('content', pageDesc);
        var ticker = getTicker() || '';
        var $can = document.getElementById('pageCanonical');
        if ($can && ticker) $can.setAttribute('href', 'https://orgo.kr/stock/' + ticker);
        var $ogT = document.getElementById('pageOgTitle');
        if ($ogT) $ogT.setAttribute('content', pageTitle);
        var $ogD = document.getElementById('pageOgDesc');
        if ($ogD) $ogD.setAttribute('content', pageDesc);

        $title.innerHTML = '<strong>' + esc(name) + '</strong> 왜 오름?';
        if (market) $market.textContent = market;
        _stockName = name;

        // 네이버 증권 바로가기 (PC 버전 finance.naver.com)
        var $naver = document.getElementById('stockNaverLink');
        if ($naver && ticker) {
            $naver.href = 'https://finance.naver.com/item/main.naver?code=' + ticker;
            $naver.style.display = '';
        }

        // 관심 별점 표시 (whyrise-ratings localStorage 와 동기화)
        if (ticker) renderHeaderRating(ticker);

        if (!stats) { $stats.innerHTML = ''; return; }
        var html = '';
        // 핵심 지표 우선 — count_10 (1년 총 횟수), count_15, count_recent (최근 30일)
        if (stats.count_10 != null) {
            html += '<div class="stock-header__stat">' +
                '<span class="stock-header__stat-label">+10% 이상 (1년)</span>' +
                '<span class="stock-header__stat-value">' + stats.count_10 + '회</span></div>';
        }
        html += '<div class="stock-header__stat">' +
            '<span class="stock-header__stat-label">+15% 이상</span>' +
            '<span class="stock-header__stat-value">' + (stats.count_15 || 0) + '회</span></div>';
        if (stats.count_20 != null) {
            html += '<div class="stock-header__stat">' +
                '<span class="stock-header__stat-label">+20% 이상</span>' +
                '<span class="stock-header__stat-value">' + stats.count_20 + '회</span></div>';
        }
        if (stats.count_limit != null) {
            html += '<div class="stock-header__stat">' +
                '<span class="stock-header__stat-label">상한가</span>' +
                '<span class="stock-header__stat-value">' + stats.count_limit + '회</span></div>';
        }
        if (stats.count_recent != null) {
            html += '<div class="stock-header__stat">' +
                '<span class="stock-header__stat-label">최근 30일</span>' +
                '<span class="stock-header__stat-value">' + stats.count_recent + '회</span></div>';
        }
        if (stats.avg_rate != null) {
            html += '<div class="stock-header__stat">' +
                '<span class="stock-header__stat-label">평균 상승률</span>' +
                '<span class="stock-header__stat-value stock-header__stat-value--rise">+' +
                stats.avg_rate.toFixed(1) + '%</span></div>';
        }
        $stats.innerHTML = html;
    }

    // 현재가·오늘 등락률 스탯 — stats 그리드 맨 앞에 삽입/갱신. '왜 오름?' 페이지에 '지금 얼마' 제공.
    function renderPriceStat(meta) {
        if (!meta || meta.price == null) return;
        var $stats = document.getElementById('stockStats');
        if (!$stats) return;
        var el = document.getElementById('stockPriceStat');
        if (!el) {
            el = document.createElement('div');
            el.className = 'stock-header__stat';
            el.id = 'stockPriceStat';
            $stats.insertBefore(el, $stats.firstChild);
        }
        var rate = Number(meta.change_rate || 0);
        var sign = rate > 0 ? '+' : '';
        var cls = rate > 0 ? ' stock-header__stat-value--rise' : '';
        el.innerHTML = '<span class="stock-header__stat-label">현재가' + (isMarketOpenKST() ? ' (라이브)' : '') + '</span>' +
            '<span class="stock-header__stat-value' + cls + '">' +
            Number(meta.price).toLocaleString('ko-KR') + '원 ' + sign + rate.toFixed(2) + '%</span>';
    }

    // 장중엔 60초 폴링, 마감 후엔 1회(=종가)로 종료. 탭 숨김 동안은 fetch 스킵.
    function startPricePolling(ticker) {
        function tick() {
            if (document.visibilityState === 'hidden') {
                setTimeout(tick, PRICE_POLL_MS);
                return;
            }
            WhyAPI.getCurrentPrice(ticker).then(function (meta) {
                renderPriceStat(meta);
            }).catch(function () {}).then(function () {
                if (isMarketOpenKST()) setTimeout(tick, PRICE_POLL_MS);
            });
        }
        tick();
    }

    function sourceBadge(source, confidence) {
        // reason_source: stockrise | admin | news | naver | theme | pattern | dart
        var labels = {
            'stockrise': { text: '검증', cls: 'badge--filled' },
            'admin':     { text: '관리자', cls: 'badge--admin' },
            'news':      { text: '뉴스', cls: 'badge--news' },
            'naver':     { text: '뉴스', cls: 'badge--news' },
            'theme':     { text: '테마', cls: 'badge--theme' },
            'pattern':   { text: '패턴', cls: 'badge--pattern' },
        };
        var info = labels[source];
        if (!info) return '';
        return '<span class="event-card__source-badge ' + info.cls + '">' + info.text + '</span>';
    }

    function reasonClass(status, confidence) {
        if (status === 'edited') return 'event-card__reason event-card__reason--edited';
        if (status === 'missing') return 'event-card__reason event-card__reason--missing';
        if (confidence === 'low') return 'event-card__reason event-card__reason--low';
        if (confidence === 'mid') return 'event-card__reason event-card__reason--mid';
        return 'event-card__reason event-card__reason--high';
    }

    function groupByYear(events) {
        // 50건 이상이면 연도별 그루핑, 아니면 단일 그룹
        if (!events.length) return [];
        if (events.length < 50) return [{ year: null, events: events }];
        var grouped = {};
        events.forEach(function (ev) {
            var y = (ev.date || '').slice(0, 4);
            if (!grouped[y]) grouped[y] = [];
            grouped[y].push(ev);
        });
        return Object.keys(grouped).sort().reverse().map(function (y) {
            return { year: y, events: grouped[y] };
        });
    }

    //#region news-pure — 순수 함수 영역(DOM 비의존). scripts/test_event_news.js 가 이 블록을 추출해 Node 검증.
    // 모바일에서 finance.naver.com/item/news_read.naver?... 는 네이버가 m.stock.naver.com 404
    // 페이지로 리다이렉트시킴. 모바일 UA 일 때만 n.news.naver.com/mnews/article 형식으로 변환.
    // PC 는 기존 finance.naver.com 페이지 그대로.
    function normalizeNewsLink(s) {
        if (!/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return s;
        if (s.indexOf('finance.naver.com/item/news_read') < 0) return s;
        var a = /[?&]article_id=([0-9]+)/.exec(s);
        var o = /[?&]office_id=([0-9]+)/.exec(s);
        if (!a || !o) return s;
        return 'https://n.news.naver.com/mnews/article/' + o[1] + '/' + a[1];
    }
    function safeLink(href) {
        // javascript:/data: 스킴 차단
        if (!href) return '';
        var s = String(href).trim();
        if (/^(javascript|data|vbscript):/i.test(s)) return '';
        return esc(normalizeNewsLink(s));
    }

    var _newsDecodeBox = null;
    function cleanNewsText(s) {
        var text = String(s || '').trim();
        if (text.indexOf('&') >= 0 && typeof document !== 'undefined' && document.createElement) {
            _newsDecodeBox = _newsDecodeBox || document.createElement('textarea');
            _newsDecodeBox.innerHTML = text;
            text = _newsDecodeBox.value;
        }
        return text.replace(/\s+/g, ' ').trim();
    }

    function formatDateCompact(yyyymmdd) {
        var s = String(yyyymmdd || '');
        if (s.length !== 8) return s;
        return s.slice(0, 4) + '.' + s.slice(4, 6) + '.' + s.slice(6, 8);
    }

    function newsKeys(n) {
        // 쿼리스트링 유지 — 네이버 금융 링크는 기사 ID가 쿼리(article_id)에 있어
        // ?를 자르면 모든 기사가 같은 키로 충돌한다 (해시만 제거)
        var link = String((n && n.link) || '').trim().split('#')[0].toLowerCase();
        var title = cleanNewsText((n && n.title) || '').toLowerCase().replace(/\s+/g, ' ');
        return { link: link, title: title };
    }

    // ── 주요 기사 선별 — "왜 올랐는가"를 설명하는 기사만 통과시키는 점수 게이트 ──
    // 이름만 들어간 무관 기사(악재 실적·시황·타종목 묶음·동일 사건 도배)가 그대로 노출되던 것을
    // 인과 패턴/카탈리스트 가점 + 노이즈·악재 감점 + 유사 제목 클러스터 dedup 으로 교체.
    var NEWS_SPLIT_RE = /[\s,·()\[\]{}<>:;|/\\"‘’“”'…]+/;
    var NEWS_NUMERIC_RE = /^[0-9.]+%?$/;
    // 테마 토큰 추출 제외어 — 일반 금융 단어는 타종목 기사를 끌어들이므로 토큰화하지 않음
    var NEWS_TOKEN_STOP = ['관련', '기대', '소식', '상승', '급등', '상한가', '특징주', '실시간', '거래량',
        '코스피', '코스닥', '뉴스', '보도', '공시', '발표', '영업이익', '영업익', '실적', '매출',
        '결정', '증가', '개선', '전년', '분기', '이유', '종목', '주가', '리포트', '증권사'];
    // 인과 구조 제목 — "…소식에 급등" 류 (왜 올랐는지 직접 설명하는 기사의 시그니처)
    var NEWS_CAUSAL_RE = /(소식|기대감|기대|효과|수혜|호재|영향|훈풍|모멘텀|전망|부각)(에|에도|으로|속)|에\s*['"‘“]?(급등|강세|상한가|상승|上|껑충|불기둥|신고가)|힘입|덕분/;
    // 급등 표현 — 종목명과 함께 나오면 "이 종목의 급등을 다룬 기사" 신호 (동반 상한가 시황 구제)
    var NEWS_RALLY_RE = /상한가|급등|신고가|불기둥|껑충|上|강세/;
    // 상승 이유가 되는 사건 키워드
    var NEWS_CATALYST = ['수주', '계약', '공급', '양산', '납품', '인수', '합병', '매각', '지분', '투자', '유치',
        '임상', '승인', '허가', 'fda', '식약처', '특허', '기술이전', '상용화', '출시', '공개',
        '선정', '체결', 'mou', '협약', '협력', '동맹', '흑자', '턴어라운드', '호실적', '최대 실적',
        '어닝', '무상증자', '자사주', '소각', '증설', '수출', '진출', '돌파', '신고가', '재가동',
        '목표가', '신제품', '개발', '도입', '확대', '정책', '추경', '발족',
        '영업익', '영업이익', '매출', '실적', '적자 축소', '경신', '배당',
        '취득', '장내매수', '수혜', '1위'];
    // 시황 노이즈 — 종목 아닌 시장 전체 기사
    var NEWS_NOISE = ['관련주', '테마주', '관련株', '급등주',
        '마감', '시황', '브리핑', '개장', '출발', '증시', '랠리', '마켓뷰', '오늘의',
        '코스피', '코스닥', '톺아보기', '딥다이브', '핫종목', '[알림]', '[인사]', '베스트리포트',
        '순매수', '매도세', '추격', '회복', '재탈환', '반등'];
    // 묶음 신호 — 종목명이 없는 기사에서만 차단 (이름이 있으면 "동반 상한가" 시황도 그 종목 기사)
    var NEWS_BUNDLE = ['동반', '일제히', '줄줄이', '잇단', '무더기', '나란히', '들썩'];
    // 악재·역방향 — 상승 이유 설명에 부적합
    var NEWS_NEGATIVE = ['급락', '하락', '약세', '↓', '감소', '우려', '리스크', '불확실', '소송', '제재',
        '담합', '고발', '조사', '갈등', '논란', '경고', '버블', '분개', '실망', '상폐', '수상',
        '주가조작', '시세조종', '손절', '불황', '위기', '파업', '화재', '유증', '유상증자',
        '표류', '암초', '난항', '먹구름', '적신호', '급제동', '쇼크', '안갯속', '소외', '괴리',
        '의혹', '구설', '뒷말', '적자전환', '먹튀'];
    // 카탈리스트 의미 반전 — "증설 연기"처럼 호재 키워드를 뒤집는 단어는 점수 불문 차단
    var NEWS_REVERSAL = ['연기', '중단', '취소', '철회', '결렬', '무산', '보류', '지연'];
    var NEWS_POSITIVE_OVERRIDE = ['적자 축소', '흑자'];  // '적자' 계열 중 호재 표현
    // 루틴 단신 — 수상·캠페인·인사 등 주가 영향 낮은 정형 기사
    var NEWS_ROUTINE = ['게시판', '캠페인', '어워드', '협력사', '선임', '임명', '부고', '주총', '연속'];
    var NEWS_PER_EVENT = 2;        // 급등 카드 1장당 최대 노출 기사 수 (그 날의 상승 이유 기사)
    // 날짜 하드 게이트 — 이벤트별 news 풀은 날짜 스코프가 없어(그 종목 1년치 뉴스가 섞임) 점수만 보면
    // 8개월 전 호재도 박힌다. "그 급등일의 이유 기사"여야 하므로 기사 날짜가 급등일과 N일 이내여야만 채택.
    // (주말·공휴일 갭 고려 ±4일. 날짜 없는 기사는 그 날짜의 기사임을 보장 못 하므로 제외.)
    var NEWS_MAX_GAP_DAYS = 4;
    var NEWS_DUP_JACCARD = 0.5;    // 제목 토큰 자카드 유사도 — 동일 사건 변형 기사 묶음 기준
    var NEWS_EVENT_BOOST_DIV = 15; // 이벤트 등락률 가중 분모 — +30% 사건 기사 = +2점 (영향 큰 상승 우선)
    var NEWS_GATE_NAMED = 7;       // 게이트: 종목명 포함 기사 최저 점수
    var NEWS_GATE_FILL = 5.5;      // 보충 기사 최저 점수
    // 제목 선두 "주어," 패턴 — 주어가 다른 회사명이면 타종목 기사
    var NEWS_LEAD_TAG_RE = /^\s*[\[(【][^\])】]{0,24}[\])】]\s*/;
    var NEWS_SUBJECT_RE = /^([^,，]{2,20})[,，]\s/;

    function importantTokens() {
        var source = Array.prototype.slice.call(arguments).join(' ');
        var seen = {};
        return cleanNewsText(source).split(NEWS_SPLIT_RE).filter(function (token) {
            if (!token || token.length < 2 || seen[token]) return false;
            if (NEWS_NUMERIC_RE.test(token)) return false;
            if (NEWS_TOKEN_STOP.indexOf(token) >= 0) return false;
            seen[token] = true;
            return true;
        }).slice(0, 8);
    }

    function countHits(lowerTitle, keywords) {
        var hits = 0;
        for (var i = 0; i < keywords.length; i++) {
            if (lowerTitle.indexOf(keywords[i]) >= 0) hits++;
        }
        return hits;
    }

    // 종목명-제목 매칭(경계 인식) — 짧은 지주사명("LG","SK","DB" 등)이 자회사 기사
    // ("LGU＋","LG전자","SK하이닉스")에 substring 으로 오인 매치되는 것을 막는다.
    // 매치 직후 글자가 한글/영문/숫자면(=다른 고유명사로 이어짐) 불일치로 보고 다음 후보를 찾는다.
    // 공백·문장부호·%·끝 등 경계로 끝나야 "그 종목"을 가리키는 매치로 인정.
    var NAME_BOUNDARY_RE = /[a-z0-9가-힣]/;
    function nameInTitle(lowerTitle, nameLower) {
        if (!nameLower) return false;
        var from = 0, idx;
        while ((idx = lowerTitle.indexOf(nameLower, from)) >= 0) {
            var after = lowerTitle.charAt(idx + nameLower.length);
            if (!after || !NAME_BOUNDARY_RE.test(after)) return true;
            from = idx + 1;
        }
        return false;
    }

    function titleTokenSet(lowerTitle) {
        var set = {};
        lowerTitle.split(NEWS_SPLIT_RE).forEach(function (w) {
            if (w.length >= 2) set[w] = true;
        });
        return set;
    }

    function jaccardOver(aSet, bSet, threshold) {
        var inter = 0, union = 0, k;
        for (k in aSet) { union++; if (bSet[k]) inter++; }
        for (k in bSet) { if (!aSet[k]) union++; }
        return union > 0 && (inter / union) >= threshold;
    }

    function dateGapDays(a, b) {
        if (!a || !b || a.length !== 8 || b.length !== 8) return null;
        var da = new Date(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8));
        var db = new Date(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8));
        return Math.abs(da - db) / 86400000;
    }

    function scoreNews(title, lowerTitle, nameLower, tokens, dayGap, eventRate) {
        var score = 0;
        var hasName = nameInTitle(lowerTitle, nameLower);
        if (hasName) score += 4;
        var causal = NEWS_CAUSAL_RE.test(title);
        if (causal) score += 3;
        // 종목명 + 급등 표현 = 인과 기사가 아니어도 "이 종목의 급등을 다룬" 기사
        var rally = hasName && !causal && NEWS_RALLY_RE.test(title);
        if (rally) score += 1.5;
        var cat = countHits(lowerTitle, NEWS_CATALYST);
        score += Math.min(cat, 2) * 2;
        // 금액 명시(1883억 수주 등) = 규모 있는 사건 — 부수 기사(MOU 등)보다 우선
        if (cat > 0 && /\d[\d,.]*\s*(억|조)/.test(title)) score += 1;
        // 토큰: 정방향 포함 또는 제목 단어(3자+)가 테마 토큰에 포함(예: '태양광' ⊂ '태양광에너지')
        var words = lowerTitle.split(NEWS_SPLIT_RE).filter(function (w) { return w.length >= 3; });
        var tok = 0;
        tokens.forEach(function (t) {
            var tl = t.toLowerCase();
            if (lowerTitle.indexOf(tl) >= 0) { tok++; return; }
            for (var i = 0; i < words.length; i++) {
                if (tl.indexOf(words[i]) >= 0) { tok++; return; }
            }
        });
        score += Math.min(tok, 3) * 1.5;
        // 사건 당일 기사 우대. 날짜는 아래 dateOk 에서 하드 컷 — 여기선 당일 기사에 가점만.
        if (dayGap === 0) score += 1;
        // 날짜 하드 게이트: 급등일과 NEWS_MAX_GAP_DAYS 이내 + 날짜 명시된 기사만 후보
        var dateOk = dayGap !== null && dayGap <= NEWS_MAX_GAP_DAYS;
        // 영향 큰 상승(상한가)의 기사일수록 우선 — +30% 사건 = +2점
        score += Math.min(Math.max(eventRate || 0, 0), 30) / NEWS_EVENT_BOOST_DIV;
        // 시황 노이즈 감점 — 종목명이 제목에 있으면("후성 20% 급등…관련주 강세") 종목 기사로 보고 가볍게,
        // 이름 없으면(시장 전체 브리핑) 무겁게 감점.
        var noise = countHits(lowerTitle, NEWS_NOISE);
        score -= noise * (hasName ? 1 : 2.5);
        var bundle = countHits(lowerTitle, NEWS_BUNDLE);
        if (!hasName) score -= bundle * 2.5;   // 이름 없는 묶음 기사 = 타종목/테마 전체 기사
        var routine = countHits(lowerTitle, NEWS_ROUTINE);
        score -= Math.min(routine, 2) * 2;
        var neg = countHits(lowerTitle, NEWS_NEGATIVE);
        var negApplies = neg > 0 && countHits(lowerTitle, NEWS_POSITIVE_OVERRIDE) === 0;
        if (negApplies) score -= Math.min(neg, 2) * 2;
        // 의미 반전(연기·중단·취소 등) — 호재 키워드가 있어도 상승 이유가 될 수 없음
        var reversed = countHits(lowerTitle, NEWS_REVERSAL) > 0;
        // 타종목 기사 차단: 제목 선두 "주어,"의 주어에 이 종목명이 없으면 다른 회사 단독 기사일 확률↑.
        // 카드별 임베드는 "이 종목 급등 이유"라 단정하므로, 제목에 이름이 있어도(예: "파미셀, …두산…")
        // 주어가 다른 종목이면 차단한다 — 이름 포함/미포함 모두 동일 적용 (정밀도 우선).
        var otherSubject = false;
        var subjMatch = title.replace(NEWS_LEAD_TAG_RE, '').match(NEWS_SUBJECT_RE);
        if (subjMatch) {
            var subjLower = subjMatch[1].toLowerCase();
            otherSubject = nameLower ? !nameInTitle(subjLower, nameLower) : true;
        }
        // 게이트: 제목에 종목명이 있는 기사만 채택한다. 카드별 임베드는 "이 종목이 그 날 왜 올랐나"를
        // 단정하므로, 이름조차 없는 시황·정책·테마 묶음 기사("삼성전자 신고가…반도체株 웃었다",
        // "밸류업 지수 1위")는 이유 근거로 부적합 → 제외. (이름 포함 + 이유 신호 + 날짜·주어 조건)
        var ok = dateOk && !reversed && !otherSubject && hasName &&
            (causal || rally || cat > 0 || tok > 0) && score >= NEWS_GATE_NAMED;
        // 보충 후보: 이름 포함 + 인과/카탈리스트 + 타사주어·노이즈·악재·루틴 없음
        var fill = dateOk && !reversed && !otherSubject && hasName && (causal || rally || cat > 0) &&
            noise === 0 && routine === 0 && !negApplies && score >= NEWS_GATE_FILL;
        return { ok: ok, fill: fill, score: score };
    }

    // ── 이벤트 1건의 "왜 올랐는가" 기사 선별 — 그 급등일에 박을 기사를 점수 게이트로 고른다 ──
    // 상단 묶음(collectMajorNews) 대신, 급등마다 해당 날짜의 이유 기사를 카드에 직접 붙인다.
    // 1순위: 이유 게이트(ok) 통과 기사. 그게 0건일 때만 2순위(fill: 이름+인과/카탈리스트, 노이즈·악재 없음).
    // 둘 다 없으면 빈 배열 — 수급/패턴 급등처럼 기사 없는 날은 억지로 노이즈를 박지 않는다(정직성 우선).
    function pickEventNews(ev, nameLower) {
        var tokens = importantTokens(ev.theme_tag, ev.sector, ev.rise_reason);
        var evDate = String(ev.date || '').replace(/[^0-9]/g, '').slice(0, 8);
        var evRate = Number(ev.change_rate || 0);
        var seen = {};
        var cands = [];
        (ev.news || []).forEach(function (n) {
            var keys = newsKeys(n);
            if ((!keys.link && !keys.title) || seen[keys.link] || seen[keys.title]) return;
            var title = cleanNewsText(n.title);
            var href = safeLink(n.link);
            if (!title || !href) return;
            if (keys.link) seen[keys.link] = true;
            if (keys.title) seen[keys.title] = true;
            var lowerTitle = title.toLowerCase();
            var newsDate = String(n.date || '').replace(/[^0-9]/g, '').slice(0, 8);
            var r = scoreNews(title, lowerTitle, nameLower, tokens,
                dateGapDays(newsDate, evDate), evRate);
            cands.push({
                title: title,
                href: href,
                source: cleanNewsText(n.source),
                newsDate: newsDate,
                score: r.score,
                ok: r.ok,
                fill: r.fill,
                tokenSet: titleTokenSet(lowerTitle),
            });
        });
        cands.sort(function (a, b) { return b.score - a.score; });

        function isDup(c, picked) {
            for (var i = 0; i < picked.length; i++) {
                if (jaccardOver(c.tokenSet, picked[i].tokenSet, NEWS_DUP_JACCARD)) return true;
            }
            return false;
        }

        var picked = [];
        // 1순위: 이유 게이트 통과 기사 (점수 내림차순으로 이미 정렬됨)
        cands.forEach(function (c) {
            if (picked.length >= NEWS_PER_EVENT) return;
            if (!c.ok || isDup(c, picked)) return;
            picked.push(c);
        });
        // 2순위: 통과 기사가 0건일 때만 보충 (이름매치 + 인과/카탈리스트, 노이즈·악재 없음)
        if (!picked.length) {
            cands.forEach(function (c) {
                if (picked.length >= NEWS_PER_EVENT) return;
                if (!c.fill || isDup(c, picked)) return;
                picked.push(c);
            });
        }
        return picked;
    }
    //#endregion news-pure

    function renderEventNews(ev, nameLower) {
        var picks = pickEventNews(ev, nameLower);
        if (!picks.length) return '';
        var html = '<div class="event-card__news"><span class="event-card__news-label">이날 관련 기사</span>';
        picks.forEach(function (p) {
            html += '<a class="event-card__news-item" href="' + p.href + '" target="_blank" rel="noopener noreferrer">' +
                '<span class="event-card__news-title">' + esc(p.title) + '</span>' +
                '<span class="event-card__news-meta">' +
                (p.source ? '<span class="event-card__news-source">' + esc(p.source) + '</span>' : '') +
                (p.newsDate ? '<span>' + esc(formatDateCompact(p.newsDate)) + '</span>' : '') +
                '</span></a>';
        });
        html += '</div>';
        return html;
    }

    function renderEventCard(ev, ticker, nameLower) {
        var rowClass = '';
        if (ev.reason_status === 'edited') rowClass = ' row--edited';
        else if (ev.reason_status === 'missing') rowClass = ' row--missing';
        var rate = (ev.change_rate || 0);
        var rateLabel = (rate >= 29.9) ? '<span class="event-card__limit">상한가</span>' : '';
        var hi52w = ev.is_52w_high ? '<span class="event-card__highflag">52주 신고가</span>' : '';
        var reasonText = (ev.reason_status === 'missing') ? '' : (ev.rise_reason || '');
        var reasonHtml = reasonText
            ? '<div class="' + reasonClass(ev.reason_status, ev.reason_confidence) + '">' + esc(reasonText) + '</div>'
            : '';

        return '<article class="event-card' + rowClass + '">' +
            '<div class="event-card__top">' +
            '<span class="event-card__date">' + formatDate(ev.date) + '</span>' +
            '<span class="event-card__rate">+' + rate.toFixed(2) + '%</span>' +
            rateLabel +
            hi52w +
            '<span class="event-card__price">종가 ' +
            (ev.close_price ? ev.close_price.toLocaleString('ko-KR') : '-') +
            '원</span>' +
            (ev.theme_tag ? '<span class="event-card__theme">' + esc(ev.theme_tag) + '</span>' : '') +
            sourceBadge(ev.reason_source, ev.reason_confidence) +
            '<button class="admin-edit-btn event-card__edit" data-action="admin-edit" data-ticker="' +
            esc(ticker) + '" data-date="' + esc(ev.date) + '" title="이유 편집">✏️ 편집</button>' +
            '</div>' +
            reasonHtml +
            renderEventNews(ev, nameLower) +
            '</article>';
    }

    function renderEvents(events, ticker) {
        var $tl = document.getElementById('timeline');
        if (!events || !events.length) {
            $tl.innerHTML = '<div class="event-empty">최근 1년간 +10% 이상 기록이 없습니다.</div>';
            return;
        }
        var nameLower = cleanNewsText(_stockName || '').toLowerCase();
        var groups = groupByYear(events);
        var html = '';
        groups.forEach(function (g) {
            if (g.year) {
                html += '<h2 class="timeline__year">' + g.year + '년 — ' + g.events.length + '건</h2>';
            }
            g.events.forEach(function (ev) {
                html += renderEventCard(ev, ticker, nameLower);
            });
        });
        $tl.innerHTML = html;
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

    function bindAdminEdit(history) {
        var modal = Admin.bindEditModal(function () {
            // 편집 후: 페이지 새로고침이 가장 단순 (인덱스 재빌드 후 반영되는 구조)
            // overrides 는 즉시 반영되지만 stock-history 인덱스는 cron 후 갱신.
            // 일단 단순히 reload — 다음 인덱스 빌드까지는 일자별 페이지에서만 보임.
            location.reload();
        });
        document.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-action="admin-edit"]');
            if (!btn) return;
            e.preventDefault();
            var ticker = btn.getAttribute('data-ticker');
            var date = btn.getAttribute('data-date');
            var ev = (history.events || []).find(function (x) { return x.date === date; }) || {};
            modal.open({
                date: date,
                ticker: ticker,
                name: history.name || ticker,
                reason: ev.rise_reason || '',
                theme_tag: ev.theme_tag || '',
                note: ev.note || '',
            });
        });
    }

    function bindNewsModal() {
        var $modal = document.getElementById('newsModal');
        var $close = document.getElementById('newsModalClose');
        if ($close) $close.addEventListener('click', function () { $modal.style.display = 'none'; });
        if ($modal) $modal.addEventListener('click', function (e) {
            if (e.target === $modal) $modal.style.display = 'none';
        });
    }

    // 관심 별점 + 메모 — localStorage 키는 메인(index.html) 의 whyrise.js 와 공유.
    var RATINGS_KEY = 'whyrise-ratings';
    var _stockName = '';
    var _ratings = {};
    var _headerRatingSuppressTimer = null;

    function loadRatings() {
        _ratings = window.WhyRatingsSync ? window.WhyRatingsSync.getCached() : _ratings;
        return _ratings || {};
    }
    function saveRatings(r) {
        _ratings = r || {};
        if (window.WhyRatingsSync) window.WhyRatingsSync.push(_ratings);
    }
    function requirePersonal(feature) {
        if (!window.WhyAuth || window.WhyAuth.personalAllowed()) return true;
        window.WhyAuth.requireLogin(feature);
        return false;
    }

    function suppressHeaderRatingHover() {
        var $mount = document.getElementById('stockHeaderRating');
        if (!$mount) return;
        var wrap = $mount.querySelector('.ctrl-wrap');
        if (!wrap) return;
        var row = $mount.closest('.stock-header__title-row');
        wrap.classList.add('ctrl-wrap--just-acted');
        if (_headerRatingSuppressTimer) clearTimeout(_headerRatingSuppressTimer);
        var release = function () {
            wrap.classList.remove('ctrl-wrap--just-acted');
        };
        _headerRatingSuppressTimer = setTimeout(release, 2000);
        if (row) row.addEventListener('mouseleave', release, { once: true });
    }

    /** 메인 홈(table.js starRatingHtml) 과 동일한 HTML 구조 — 호버/탭 동작 메인과 통일. */
    function renderHeaderRating(ticker) {
        var $mount = document.getElementById('stockHeaderRating');
        if (!$mount) return;
        var ratings = loadRatings();
        var rating = ratings[ticker] || {};
        var stars = rating.stars || 0;
        var hasMemo = !!(rating.memo && rating.memo.trim());
        var excluded = !!rating.excluded;
        var html = '<span class="ctrl-wrap">';
        html += '<button class="ctrl-toggle" type="button" data-ticker="' + ticker + '" aria-label="평가">⋯</button>';
        html += '<div class="float-controls" data-ticker="' + ticker + '">';
        html += '<span class="star-rating" data-ticker="' + ticker + '">';
        for (var i = 1; i <= 5; i++) {
            html += '<span class="star' + (i <= stars ? ' star--active' : '') + '" data-star="' + i + '">★</span>';
        }
        html += '</span>';
        html += '<button class="exclude-btn' + (excluded ? ' exclude-btn--active' : '') + '" data-ticker="' + ticker + '" title="제외">✕</button>';
        html += '<button class="memo-btn' + (hasMemo ? ' memo-btn--has' : '') + '" data-ticker="' + ticker + '" title="메모">✎</button>';
        html += '</div></span>';
        $mount.innerHTML = html;
        $mount.removeAttribute('hidden');
    }

    /** 마운트 안에서 메인 whyrise.js bindRatingsEvents 와 동일한 이벤트 위임. */
    function bindHeaderRating() {
        var $mount = document.getElementById('stockHeaderRating');
        if (!$mount) return;
        $mount.addEventListener('click', function (e) {
            var ticker = getTicker();
            if (!ticker) return;
            // 별점
            var star = e.target.closest('.star');
            if (star) {
                e.preventDefault();
                e.stopPropagation();
                if (!requirePersonal('interest')) {
                    suppressHeaderRatingHover();
                    return;
                }
                var n = parseInt(star.getAttribute('data-star'), 10);
                if (!n) return;
                var ratings = loadRatings();
                ratings[ticker] = ratings[ticker] || {};
                if (ratings[ticker].stars === n) ratings[ticker].stars = 0;
                else ratings[ticker].stars = n;
                saveRatings(ratings);
                renderHeaderRating(ticker);
                suppressHeaderRatingHover();
                return;
            }
            // 제외
            var ex = e.target.closest('.exclude-btn');
            if (ex) {
                e.preventDefault();
                e.stopPropagation();
                if (!requirePersonal('exclude')) {
                    suppressHeaderRatingHover();
                    return;
                }
                var r2 = loadRatings();
                r2[ticker] = r2[ticker] || {};
                r2[ticker].excluded = !r2[ticker].excluded;
                saveRatings(r2);
                renderHeaderRating(ticker);
                suppressHeaderRatingHover();
                return;
            }
            // 메모
            var memo = e.target.closest('.memo-btn');
            if (memo) {
                e.preventDefault();
                e.stopPropagation();
                suppressHeaderRatingHover();
                if (!requirePersonal('memo')) return;
                openMemo(ticker);
                return;
            }
            // 모바일 ⋯ 토글
            var toggle = e.target.closest('.ctrl-toggle');
            if (toggle) {
                e.preventDefault();
                e.stopPropagation();
                var wrap = toggle.closest('.ctrl-wrap');
                if (!wrap) return;
                wrap.classList.toggle('is-open');
                return;
            }
        });
    }

    function openMemo(ticker) {
        var $modal = document.getElementById('memoModal');
        var $title = document.getElementById('memoModalTitle');
        var $area = document.getElementById('memoTextarea');
        if (!$modal || !$area) return;
        var ratings = loadRatings();
        var rating = ratings[ticker] || {};
        if ($title) $title.textContent = (_stockName || ticker) + ' 메모';
        $area.value = rating.memo || '';
        $area.setAttribute('data-ticker', ticker);
        $modal.style.display = 'flex';
        setTimeout(function () { $area.focus(); }, 50);
    }

    function bindMemoModal() {
        var $modal = document.getElementById('memoModal');
        if (!$modal) return;
        var $close = document.getElementById('memoModalClose');
        var $save = document.getElementById('memoSave');
        var $del = document.getElementById('memoDelete');
        var $area = document.getElementById('memoTextarea');
        if ($close) $close.addEventListener('click', function () { $modal.style.display = 'none'; });
        $modal.addEventListener('click', function (e) { if (e.target === $modal) $modal.style.display = 'none'; });
        if ($save) $save.addEventListener('click', function () {
            if (!requirePersonal('memo')) return;
            var ticker = $area.getAttribute('data-ticker');
            if (!ticker) return;
            var ratings = loadRatings();
            ratings[ticker] = ratings[ticker] || {};
            ratings[ticker].memo = $area.value.trim();
            saveRatings(ratings);
            renderHeaderRating(ticker);
            $modal.style.display = 'none';
        });
        if ($del) $del.addEventListener('click', function () {
            if (!requirePersonal('memo')) return;
            var ticker = $area.getAttribute('data-ticker');
            if (!ticker) return;
            var ratings = loadRatings();
            if (ratings[ticker]) delete ratings[ticker].memo;
            saveRatings(ratings);
            renderHeaderRating(ticker);
            $modal.style.display = 'none';
        });
    }

    function init() {
        bindThemeToggle();
        bindNewsModal();
        bindHeaderRating();
        bindMemoModal();
        window.addEventListener('whyrise:ratings-updated', function (e) {
            _ratings = (e.detail && e.detail.ratings) || {};
            var current = getTicker();
            if (current) renderHeaderRating(current);
        });

        var ticker = getTicker();
        if (!ticker) {
            document.getElementById('stockTitle').textContent = '종목 코드가 없습니다';
            return;
        }

        // 서버 별점 동기화 — KV pull 후 머지되면 별점 다시 그림.
        if (window.WhyRatingsSync) {
            window.WhyRatingsSync.pull().then(function (result) {
                if (result && result.ratings) {
                    _ratings = result.ratings;
                    renderHeaderRating(ticker);
                }
            });
        }

        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        $loading.style.display = 'block';

        WhyAPI.getStockHistory(ticker).then(function (history) {
            $loading.style.display = 'none';
            if (!history) {
                // stock-history 미빌드 (1년간 +10% 미달 등) — 네이버 메타 즉석 fetch fallback
                WhyAPI.getCurrentPrice(ticker)
                    .then(function (meta) {
                        var name = (meta && meta.name) || ticker;
                        var market = (meta && meta.market) || '';
                        // stats 는 null — '+15% 0회' 한 줄만 덩그러니 렌더되는 것 방지
                        renderHeader(name, market, null);
                        renderEvents([], ticker);
                        // 이미 받아온 라이브 시세를 그대로 표시 + 장중이면 폴링 지속
                        renderPriceStat(meta);
                        if (isMarketOpenKST()) startPricePolling(ticker);
                        $msg.textContent = '최근 1년간 +10% 이상 급등 기록이 없는 종목입니다.';
                        $msg.style.display = 'block';
                    })
                    .catch(function () {
                        // API 실패는 '기록 없음' 과 구분 — 정상 종목을 기록 없음으로 오인시키지 않음
                        document.getElementById('stockTitle').innerHTML = '<strong>' + esc(ticker) + '</strong> 왜 오름?';
                        $msg.textContent = '종목 정보를 불러오지 못했습니다. 잠시 후 새로고침 해주세요.';
                        $msg.style.display = 'block';
                    });
                return;
            }
            renderHeader(history.name || ticker, history.market || '', history.stats || {});
            startPricePolling(ticker);   // 현재가 스탯 — 장중 60초 폴링, 마감 후 1회(종가)
            var $sum = document.getElementById('stockSummary');
            if ($sum) {
                var summary = buildSummary(history.events || []);
                $sum.textContent = summary || '';
                $sum.style.display = summary ? 'block' : 'none';
            }
            renderEvents(history.events || [], ticker);
            bindAdminEdit(history);
        }).catch(function (err) {
            $loading.style.display = 'none';
            $msg.textContent = '로딩 실패: ' + err.message;
            $msg.style.display = 'block';
        });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
