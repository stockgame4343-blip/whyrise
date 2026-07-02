/**
 * 종목 페이지 — /stock/{ticker} (rewrite 로 ?ticker=... 도착)
 *
 * 인덱스 (public/data/stock-history/{ticker}.json) 에서 events 읽어 타임라인 렌더.
 * 관리자 모드일 때 각 event 카드 우측에 ✏️ 편집 버튼.
 */
(function () {
    // 현재가 라이브 — 장중 60초 폴링 (단일 종목 /api/current-price, marketmap 미포함 종목도 커버)
    var PRICE_POLL_MS = 60 * 1000;
    var KST_OFFSET = 9 * 60, OPEN_MIN = 8 * 60, CLOSE_MIN = 15 * 60 + 30; // NXT 시작 08:00부터 현재가 폴링
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

    function escapeRegex(s) {
        return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function compactSpaces(s) {
        return String(s || '').replace(/\s+/g, ' ').trim();
    }

    function stripThemeParen(theme) {
        return String(theme || '').replace(/\s*[\(（][^)）]*[\)）]\s*$/, '').trim();
    }

    function normalizeReasonKey(s) {
        return stripThemeParen(s)
            .replace(/\s+/g, '')
            .replace(/[()（）/·,_-]/g, '')
            .toLowerCase();
    }

    function issueFromReasonCore(reason, themeShort) {
        var r = compactSpaces(reason).replace(/\s*[\(（][^)）]*[\)）]\s*/g, ' ').trim();
        var m = /^(.+?)\s*관련\s*(뉴스|이슈|소식)$/.exec(r);
        if (!m) return r;
        var core = compactSpaces(m[1]);
        if ((!core || core === '테마') && themeShort) core = themeShort;
        if (!core) return r;
        return core + ' 이슈';
    }

    function cleanupIssueTitle(title, stockName) {
        var s = compactSpaces(title)
            .replace(/\[[^\]]+\]/g, ' ')
            .replace(/\((?:종합|상보|1보|2보|속보)[^)）]*[\)）]/g, ' ')
            .replace(/[“”"']/g, '')
            .replace(/…/g, ' ')
            .replace(/[?!]/g, ' ');
        if (stockName) {
            s = s.replace(new RegExp(escapeRegex(stockName), 'g'), ' ');
        }
        return compactSpaces(s);
    }

    function polishIssuePhrase(s) {
        var r = compactSpaces(s)
            .replace(/^[,，·:;\-\s]+/, '')
            .replace(/^(거래소|공시|단독)\s*/, '')
            .replace(/^(서|에서)\s+/, '')
            .replace(/\s*(?:에|로|으로|따라)\s*$/, '')
            .replace(/\s*(?:주|株|관련주)?\s*(?:상한가|급등|강세|상승|불기둥|다시 난다).*$/, '');
        r = compactSpaces(r);
        if (!r || r.length < 3) return '';
        if (/^(상한가|급등|강세|상승|불기둥)$/.test(r)) return '';
        if (/주가|목표가|수익률|매매거래 정지|거래 정지|가동 중단/.test(r)) return '';
        if (r.length > 24) {
            var parts = r.split(/\s+/);
            while (parts.length > 1 && parts.join(' ').length > 24) parts.shift();
            r = parts.join(' ');
        }
        return r;
    }

    function extractIssueFromTitle(title, stockName, themeShort) {
        var cleaned = cleanupIssueTitle(title, stockName);
        if (!cleaned) return '';
        if (/트럼프/.test(cleaned) && /사진/.test(cleaned)) {
            if (/김정은|정상회담|북미/.test(cleaned)) return '트럼프·김정은 사진 이슈';
            if (/남북경협|대북/.test(normalizeReasonKey(themeShort))) return '트럼프 사진 이슈';
        }

        var parts = [cleaned];
        cleaned.split(/[,.，;:]/).forEach(function (p) { parts.push(p); });
        cleaned.split(/\s+(?:에|로|으로|따라|속에)\s+/).forEach(function (p) { parts.push(p); });

        var patterns = [
            /([가-힣]{2,6}\s*재건)/,
            /([가-힣]{2,8}\s*(?:반사이익|정책\s*모멘텀|정책\s*수혜))/,
            /(건보\s*적용\s*논의)/,
            /(국제유가\s*(?:하락|급락))/,
            /(유가\s*(?:하락|급락))/,
            /(주식\s*병합\s*승인)/,
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}(?:수출|실적)\s*호조)/,
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}흑자\s*전환)/,
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}(?:공급\s*계약|대형\s*수주|수주)\s*체결)/,
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}(?:영업이익|영업익|수주)\s*공시)/,
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}(?:매각|인수|합병)\s*(?:검토|추진|재추진|논의|체결|결정|합의)?)/,
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}(?:설계사|협력사|사업자|공급사)\s*선정)/,
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}(?:데이터|기술|제품|신제품|플랫폼|서비스)\s*공개)/,
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}(?:대표이사|대표집행임원|대표)\s*(?:선임|사임))/,
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}(?:유증|CB|전환사채|대여금)\s*(?:병행|발행|출자전환))/,
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}(?:승인|선정|체결|공시|소각|상장|선임|사임|공개|출시|참가|논의|검토|추진|확대|호조|개선|서프라이즈|공략|전환|채비|등록))/
        ];

        for (var i = 0; i < parts.length; i++) {
            var part = compactSpaces(parts[i]);
            if (!part) continue;
            for (var j = 0; j < patterns.length; j++) {
                var m = patterns[j].exec(part);
                if (!m) continue;
                var issue = polishIssuePhrase(m[1]);
                if (issue) return issue;
            }
        }
        return '';
    }

    function isGenericReasonKey(key) {
        return !key || /^(뉴스|테마|실적|투자|공급|협력|승인|매출|신약|지분|건설)$/.test(key);
    }

    function compactIssueDate(s) {
        return String(s || '').replace(/[^0-9]/g, '').slice(0, 8);
    }

    function isNearEventNews(n, eventDate) {
        if (!eventDate) return true;
        var gap = dateGapDays(compactIssueDate(n && n.date), compactIssueDate(eventDate));
        return gap !== null && gap <= 4;
    }

    function isWeakReasonText(reason) {
        return /관련\s*(뉴스|이슈|소식)$/.test(reason) ||
            /^(증권사 리포트 공개|투자심리 개선 영향)$/.test(reason);
    }

    function isRelevantIssueTitle(title, stockName, themeShort, reasonCore) {
        var titleKey = normalizeReasonKey(cleanupIssueTitle(title, ''));
        if (!titleKey) return false;

        var stockKey = normalizeReasonKey(stockName);
        if (stockKey && titleKey.indexOf(stockKey) >= 0) return true;

        var themeKey = normalizeReasonKey(themeShort);
        if (themeKey && themeKey !== '뉴스' && titleKey.indexOf(themeKey) >= 0) return true;

        var reasonKey = normalizeReasonKey(reasonCore).replace(/이슈$/, '');
        if (!isGenericReasonKey(reasonKey) && titleKey.indexOf(reasonKey) >= 0) return true;

        return false;
    }

    // 거래소 규제/순환 공시 — 급등의 '원인'이 아니므로 이유에서 제외(조회공시·거래정지 등).
    function isNoiseRegulatoryTitle(title) {
        return /조회공시|현저한\s*시황\s*변동|투자주의|투자경고|투자위험|단기과열|불성실공시|관리종목|상장폐지|정리매매|매매거래\s*정지|주권매매거래\s*정지|거래\s*정지|거래\s*재개/.test(String(title || ''));
    }

    // 이름/테마 불일치라도 같은날(±4일) 다수(≥2건)에 동일 카탈리스트가 잡히면 섹터 무브로 보고 채택.
    // (예: '조선' 테마인데 철강주 '이란 재건' 호재로 동반 급등 — 빌드 reason/테마로는 못 잡는 경우.)
    function sectorCatalystFromNews(news, stockName, themeShort, eventDate) {
        if (!Array.isArray(news)) return '';
        var freq = {};
        for (var i = 0; i < news.length; i++) {
            if (!isNearEventNews(news[i], eventDate)) continue;
            var title = (news[i] && news[i].title) || '';
            if (isNoiseRegulatoryTitle(title)) continue;
            var issue = extractIssueFromTitle(title, stockName, themeShort);
            if (issue && issue.length >= 3) freq[issue] = (freq[issue] || 0) + 1;
        }
        var best = '', bestN = 0;
        for (var k in freq) { if (freq[k] > bestN) { bestN = freq[k]; best = k; } }
        return bestN >= 2 ? best : '';
    }

    function issueFromNews(news, stockName, themeShort, reasonCore, eventDate) {
        if (!Array.isArray(news)) return '';
        for (var i = 0; i < news.length && i < 3; i++) {
            if (!isNearEventNews(news[i], eventDate)) continue;
            var title = news[i] && news[i].title;
            if (isNoiseRegulatoryTitle(title)) continue;
            if (!isRelevantIssueTitle(title, stockName, themeShort, reasonCore)) continue;
            var issue = extractIssueFromTitle(title, stockName, themeShort);
            if (issue) return issue;
        }
        return '';
    }

    // 확정 공시류 강한 카탈리스트 — 제목에 명확히 잡히는 이벤트. 뉴스 다수(≥2건)에 등장하면
    // 빌드 reason 이 부차 사유를 골랐어도(예: 가온전선 무상증자인데 '수주 공시') 이걸 우선한다.
    var CORP_ACTIONS = [
        ['무상증자', /무상\s*증자/], ['유상증자', /유상\s*증자/],
        ['자사주 소각', /자사주\s*(?:소각|매입\s*후\s*소각)/],
        ['액면분할', /액면\s*분할/], ['액면병합', /액면\s*병합|주식\s*병합/],
    ];
    function _reasonKeyFlat(s) { return String(s || '').replace(/\s/g, ''); }
    function _daysApartReason(a, b) {
        function toD(s) { s = String(s || '').replace(/[^0-9]/g, '').slice(0, 8); return s.length === 8 ? new Date(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8)) : null; }
        var da = toD(a), db = toD(b);
        return (da && db) ? Math.abs((da - db) / 86400000) : 0;
    }
    function dominantCorpAction(news, eventDate) {
        if (!Array.isArray(news)) return '';
        var counts = {};
        for (var i = 0; i < news.length; i++) {
            var n = news[i] || {};
            if (_daysApartReason(n.date, eventDate) > 4) continue;   // 이벤트 ±4일 근처 기사만
            var title = String(n.title || '');
            for (var j = 0; j < CORP_ACTIONS.length; j++) {
                if (CORP_ACTIONS[j][1].test(title)) counts[CORP_ACTIONS[j][0]] = (counts[CORP_ACTIONS[j][0]] || 0) + 1;
            }
        }
        var best = '', bestN = 0;
        for (var k in counts) { if (counts[k] > bestN) { bestN = counts[k]; best = k; } }
        return bestN >= 2 ? best : '';
    }

    // 상승이유 표시 정리 — 홈처럼 약한 "관련 뉴스"류를 짧은 이슈 문구로 바꾼다.
    function cleanReasonText(reason, theme, news, stockName, eventDate) {
        var orig = String(reason == null ? '' : reason).trim();
        var t = stripThemeParen(theme);
        var tShort = t.split('/')[0].trim();
        if (!orig || orig === '-') return tShort ? (tShort + ' 관련 뉴스') : '';
        if (orig === '테마' || /^테마\s*관련\s*(뉴스|이슈|소식)?$/.test(orig)) {
            orig = tShort ? (tShort + ' 관련 뉴스') : orig;
        }

        if (isWeakReasonText(orig)) {
            var reasonCore = issueFromReasonCore(orig, tShort).replace(/\s*이슈$/, '');
            var newsIssue = issueFromNews(news, stockName, tShort, reasonCore, eventDate);
            if (newsIssue) return newsIssue;
            // 이름/테마 불일치라도 같은날 다수에 등장하는 섹터 카탈리스트(예: 이란 재건) 완화 추출.
            var sectorIssue = sectorCatalystFromNews(news, stockName, tShort, eventDate);
            if (sectorIssue) return sectorIssue;
            // 그래도 못 뽑고 reason 코어가 일반어면 테마 기반 — 'OO 이슈' 잡탕 대신 테마 관련 뉴스.
            if (tShort && isGenericReasonKey(normalizeReasonKey(reasonCore))) return tShort + ' 관련 뉴스';
        }

        function trimTail(s) {
            var nb = s.replace(/\s*보도\s*$/, '').trim();
            if (!nb || nb === s) return s;
            return (nb.indexOf(' ') >= 0) ? nb : (nb + ' 이슈');
        }
        var r = trimTail(orig);
        var rTheme = compactSpaces(r).replace(/\s*[\(（][^)）]*[\)）]\s*/g, ' ');
        // 테마명 중복 제거는 테마 뒤가 단어 경계(공백·점·쉼표·끝)일 때만 — "탈모 치료"가 "탈모 치료제"의
        // 단어 중간에 prefix 매칭돼 "제 보험 검토"처럼 깨지는 것 방지.
        var afterT = rTheme.charAt(t.length);
        if (t && rTheme.indexOf(t) === 0 && (afterT === '' || /[\s·,]/.test(afterT))) {
            var d = rTheme.slice(t.length).replace(/^[\s·,]+/, '').trim();
            var dFiller = !d || d === '관련' || /^(관련\s*)?(뉴스|이슈|소식)$/.test(d);
            if (!dFiller && d.indexOf(' ') >= 0) r = d;
        }
        // 뉴스 다수에 확정 공시(무상증자 등)가 있는데 빌드 reason 이 그걸 안 담았으면 그걸 우선.
        var corp = dominantCorpAction(news, eventDate);
        if (corp && _reasonKeyFlat(r).indexOf(_reasonKeyFlat(corp)) < 0) return corp;
        return issueFromReasonCore(r, tShort);
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
            var r = cleanReasonText(e.rise_reason || '', e.theme_tag || '', e.news || [], _stockName || '', e.date || '');
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

        // 공유 — 모바일은 네이티브 공유 시트, 데스크톱은 링크 복사 (+utm 으로 유입 측정)
        var $share = document.getElementById('stockShareBtn');
        if ($share && ticker) {
            $share.style.display = '';
            if (!$share.dataset.bound) {
                $share.dataset.bound = '1';
                $share.addEventListener('click', function () {
                    var url = 'https://orgo.kr/stock/' + ticker + '?utm_source=share';
                    var shareTitle = (_stockName || ticker) + ' 왜 오름? - ORGO';
                    if (navigator.share) {
                        navigator.share({ title: shareTitle, url: url }).catch(function () {});
                        return;
                    }
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(url).then(function () {
                            var $label = $share.querySelector('span');
                            if (!$label) return;
                            $label.textContent = '복사됨';
                            setTimeout(function () { $label.textContent = '공유'; }, 1600);
                        }).catch(function () {});
                    }
                });
            }
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
                evaluateTodayEvent(meta);   // 오늘(실시간) 급등 이벤트 주입/갱신/제거
            }).catch(function () {}).then(function () {
                if (isMarketOpenKST()) setTimeout(tick, PRICE_POLL_MS);
            });
        }
        tick();
    }

    function sourceBadge(source, confidence) {
        // reason_source: stockrise | admin | news | naver | theme | pattern | dart | llm
        // 배지 = "이 사유는 근거가 확인됨" 신호로만 사용 — 테마/패턴(기본 추정 경로)은 배지 없음.
        // 이유 텍스트 뒤에 인라인으로 붙는다 (2026-07-03 카드 2행 정리).
        var labels = {
            'stockrise': { text: '검증', cls: 'badge--filled' },
            'admin':     { text: '관리자', cls: 'badge--admin' },
            'news':      { text: '뉴스', cls: 'badge--news' },
            'naver':     { text: '뉴스', cls: 'badge--news' },
            'llm':       { text: 'AI', cls: 'badge--news' },
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
    var NEWS_RALLY_RE = /상한가|급등|신고가|불기둥|껑충|上|강세|들썩|오름세|날았다/;
    // 상승 이유가 되는 사건 키워드
    var NEWS_CATALYST = ['수주', '계약', '공급', '양산', '납품', '인수', '합병', '매각', '지분', '투자', '유치',
        '임상', '승인', '허가', 'fda', '식약처', '특허', '기술이전', '상용화', '출시', '공개',
        '선정', '체결', 'mou', '협약', '협력', '동맹', '흑자', '턴어라운드', '호실적', '최대 실적',
        '어닝', '무상증자', '자사주', '소각', '증설', '수출', '진출', '재가동',
        '목표가', '신제품', '개발', '도입', '확대', '정책', '추경', '발족',
        '영업익', '영업이익', '매출', '실적', '적자 축소', '배당',
        '취득', '장내매수', '수혜', '1위', '공략', '채비', '건보', '적용', '논의', '유가', '국제유가', '등록'];
    // ※ 가격/시총 마일스톤어('돌파'·'신고가'·'경신')는 의도적으로 카탈리스트에서 제외 —
    //   "시총 1천조 돌파", "신고가 경신"은 왜 올랐는지 설명이 아니라 가격 결과일 뿐이라
    //   '이유 있는 특징주' 게이트를 단독으로 통과시키면 안 됨. (사용자 피드백 2026-06-15)
    // 시황 노이즈 — 종목 아닌 시장 전체 기사
    var NEWS_NOISE = ['관련주', '테마주', '관련株', '급등주',
        '마감', '시황', '브리핑', '개장', '출발', '증시', '랠리', '마켓뷰', '오늘의',
        '코스피', '코스닥', '톺아보기', '딥다이브', '핫종목', '[알림]', '[인사]', '베스트리포트',
        '순매수', '매도세', '추격', '회복', '재탈환', '반등'];
    // 묶음 신호 — 종목명이 없는 기사에서만 차단 (이름이 있으면 "동반 상한가" 시황도 그 종목 기사)
    var NEWS_BUNDLE = ['동반', '일제히', '줄줄이', '잇단', '무더기', '나란히'];
    // 악재·역방향 — 상승 이유 설명에 부적합
    var NEWS_NEGATIVE = ['급락', '하락', '약세', '↓', '감소', '우려', '리스크', '불확실', '소송', '제재',
        '담합', '고발', '조사', '갈등', '논란', '경고', '버블', '분개', '실망', '상폐', '수상',
        '주가조작', '시세조종', '손절', '불황', '위기', '파업', '화재', '유증', '유상증자',
        '표류', '암초', '난항', '먹구름', '적신호', '급제동', '쇼크', '안갯속', '소외', '괴리',
        '의혹', '구설', '뒷말', '적자전환', '먹튀'];
    // 카탈리스트 의미 반전 — "증설 연기"처럼 호재 키워드를 뒤집는 단어는 점수 불문 차단
    var NEWS_REVERSAL = ['연기', '중단', '취소', '철회', '결렬', '무산', '보류', '지연'];
    var NEWS_POSITIVE_OVERRIDE = ['적자 축소', '흑자', '유가 하락', '국제유가 하락', '유가 급락', '국제유가 급락'];
    // 루틴 단신 — 수상·캠페인·인사 등 주가 영향 낮은 정형 기사
    var NEWS_ROUTINE = ['게시판', '캠페인', '어워드', '협력사', '선임', '임명', '부고', '주총', '연속'];
    var NEWS_PER_EVENT = 2;        // 급등 카드 1장당 최대 노출 기사 수 (그 날의 상승 이유 기사)
    // 날짜 하드 게이트 — 이벤트별 news 풀은 날짜 스코프가 없어(그 종목 1년치 뉴스가 섞임) 점수만 보면
    // 8개월 전 호재도 박힌다. "그 급등일의 이유 기사"여야 하므로 기사 날짜가 급등일과 N일 이내여야만 채택.
    // (주말·공휴일 갭 고려 ±4일. 날짜 없는 기사는 그 날짜의 기사임을 보장 못 하므로 제외.)
    var NEWS_MAX_GAP_DAYS = 4;
    var NEWS_DUP_JACCARD = 0.5;    // 제목 토큰 자카드 유사도 — 동일 사건 변형 기사 묶음 기준
    var NEWS_EVENT_BOOST_DIV = 15; // 이벤트 등락률 가중 분모 — +30% 사건 기사 = +2점 (영향 큰 상승 우선)
    var NEWS_GATE_NAMED = 6.5;     // 게이트: 종목명 포함 기사 최저 점수 (악재 하드차단 전제로 완화)
    var NEWS_GATE_FILL = 5.5;      // 보충 기사 최저 점수
    var NEWS_GATE_THEME = 6.0;     // 종목명 없는 테마형 기사(본문/묶음 기사 후보) 최저 점수
    // 제목 선두 "주어," 패턴 — 주어가 다른 회사명이면 타종목 기사
    var NEWS_LEAD_TAG_RE = /^\s*[\[(【][^\])】]{0,24}[\])】]\s*/;
    var NEWS_SUBJECT_RE = /^([^,，]{2,20})[,，]\s/;

    function importantTokens() {
        var source = Array.prototype.slice.call(arguments).join(' ');
        var seen = {};
        var tokens = cleanNewsText(source).split(NEWS_SPLIT_RE).filter(function (token) {
            if (!token || token.length < 2 || seen[token]) return false;
            if (NEWS_NUMERIC_RE.test(token)) return false;
            if (NEWS_TOKEN_STOP.indexOf(token) >= 0) return false;
            seen[token] = true;
            return true;
        });
        if (/남북\s*경협|남북경협|대북/.test(source)) {
            ['트럼프', '김정은', '북미', '북한', '정상회담', '비핵화'].forEach(function (token) {
                if (!seen[token]) {
                    seen[token] = true;
                    tokens.push(token);
                }
            });
        }
        return tokens.slice(0, 12);
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
        var rawRally = NEWS_RALLY_RE.test(title);
        var rally = hasName && !causal && rawRally;
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
        var themeArticle = !hasName && tok > 0 && (causal || rawRally || cat > 0);
        if (themeArticle) score += 3;
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
            if (hasName) {
                otherSubject = nameLower ? !nameInTitle(subjLower, nameLower) : true;
            } else {
                var thematicSubject = /주$|株$|관련주|테마주/.test(subjLower);
                for (var ti = 0; ti < tokens.length && !thematicSubject; ti++) {
                    var tokenLower = String(tokens[ti] || '').toLowerCase();
                    if (tokenLower && (subjLower.indexOf(tokenLower) >= 0 || tokenLower.indexOf(subjLower.replace(/\s+/g, '')) >= 0)) {
                        thematicSubject = true;
                    }
                }
                otherSubject = !thematicSubject;
            }
        }
        // 게이트: 기본은 종목명 포함 기사. 다만 코데즈컴바인/남북경협처럼 제목엔 종목명이 없어도
        // 해당 종목 뉴스 묶음 안에서 테마·사건일·상승 신호가 맞는 기사는 테마형 근거로 허용한다.
        // 이름 없는 일반 시황·정책·잡음 기사는 noise/routine/주어/점수 조건으로 계속 제외한다.
        // '이유 없는' 단순 시세중계("OO 12% 급등", "OO 상한가")는 제외 —
        // 인과(…소식에 급등)·카탈리스트(수주·임상·실적…)·테마 중 하나라도 있어야 '이유 있는 특징주'로 채택.
        // (rally= 급등표현만 있고 이유 없는 기사 → 단독 통과 금지. 사용자 피드백 2026-06-15)
        var hasReason = causal || cat > 0 || tok > 0;
        // 악재(negApplies)는 점수 불문 하드 차단 — 문턱을 낮춰도 "관리종목 우려·실적↓" 류가 새지 않게.
        var ok = dateOk && !reversed && !otherSubject && !negApplies &&
            ((hasName && hasReason && score >= NEWS_GATE_NAMED) ||
             (themeArticle && hasReason && noise === 0 && routine === 0 && score >= NEWS_GATE_THEME));
        // 보충 후보: 이름 포함 + 인과/카탈리스트(이유 명시) + 타사주어·노이즈·악재·루틴 없음
        var fill = dateOk && !reversed && !otherSubject && hasName && (causal || cat > 0) &&
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

    // 1년 경계 (compact 'YYYYMMDD') — 이 이전 이벤트는 딤드(영구 보관하되 '오래됨' 인지)
    function archiveCutoff() {
        var d = new Date(Date.now() - 365 * 24 * 3600 * 1000);
        return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
    }

    function renderEventCard(ev, ticker, nameLower) {
        var rowClass = '';
        if (ev._live) rowClass = ' event-card--live';
        else if (ev.reason_status === 'edited') rowClass = ' row--edited';
        else if (ev.reason_status === 'missing') rowClass = ' row--missing';
        var archived = !ev._live && ev.date && String(ev.date) < archiveCutoff();
        if (archived) rowClass += ' event-card--archived';
        var rate = (ev.change_rate || 0);
        var rateLabel = (rate >= 29.9) ? '<span class="event-card__limit">상한가</span>' : '';
        var hi52w = ev.is_52w_high ? '<span class="event-card__highflag">52주 신고가</span>' : '';
        var reasonText = (ev.reason_status === 'missing') ? '' :
            cleanReasonText(ev.rise_reason, ev.theme_tag, ev.news, _stockName, ev.date);
        // 2행 구조: 1행 = 날짜·등락률·종가·이벤트태그(상한가/52주) / 2행 = 테마태그 + 이유 + 출처배지
        var themeHtml = ev.theme_tag
            ? '<a class="event-card__theme" href="/screening.html?theme=' + encodeURIComponent(ev.theme_tag) + '" style="text-decoration:none" title="' + esc(ev.theme_tag) + ' 스크리닝">' + esc(ev.theme_tag) + '</a>'
            : '';
        var reasonHtml = reasonText
            ? '<span class="' + reasonClass(ev.reason_status, ev.reason_confidence) + '">' + esc(reasonText) + '</span>'
            : '';
        var reasonRow = (themeHtml || reasonHtml)
            ? '<div class="event-card__reason-row">' + themeHtml + reasonHtml +
              sourceBadge(ev.reason_source, ev.reason_confidence) + '</div>'
            : '';
        // 라이브 카드는 미확정이라 편집 버튼 숨김(확정 후 일반 카드에서 편집)
        var editBtn = ev._live ? '' :
            ('<button class="admin-edit-btn event-card__edit" data-action="admin-edit" data-ticker="' +
            esc(ticker) + '" data-date="' + esc(ev.date) + '" title="이유 편집">✏️ 편집</button>');

        return '<article class="event-card' + rowClass + '">' +
            '<div class="event-card__top">' +
            '<span class="event-card__date">' + formatDate(ev.date) + '</span>' +
            (archived ? '<span class="event-card__archived-flag" title="1년 이전 기록 — 횟수·스크리닝 집계 제외">1년+ 경과</span>' : '') +
            '<span class="event-card__rate">+' + rate.toFixed(2) + '%</span>' +
            '<span class="event-card__price">종가 ' +
            (ev.close_price ? ev.close_price.toLocaleString('ko-KR') : '-') +
            '원</span>' +
            rateLabel +
            hi52w +
            editBtn +
            '</div>' +
            reasonRow +
            renderEventNews(ev, nameLower) +
            '</article>';
    }

    // ── 오늘(실시간) 급등 이벤트 주입 ───────────────────────────────────────
    // 홈은 오늘 빌드({date}.json)로 당일 +15% 급등주(이유·뉴스)를 바로 보여주지만, 상세는
    // stock-history(주로 마감 후 build-history 생성)만 읽어 '오늘'이 빠진다. → 오늘 빌드에서
    // 이유·뉴스를, 현재가 폴링에서 실시간 등락률을 가져와 타임라인 맨 위에 '오늘(실시간)' 카드를
    // 주입. 15% 미만으로 빠지면 제거. 마감 후 build-history가 stock-history에 확정하면(=오늘 날짜
    // 이벤트 존재) 주입을 멈추고 그 확정분을 사용(중복 방지·자연 교체).
    var TODAY_LIVE_CUTOFF = 15;   // 홈 CUTOFF 와 일치 (사용자 확정 2026-06-17)
    var _ticker = '';
    var _baseEvents = [];         // stock-history 의 확정 events (타임라인 베이스)
    var _todayEvent = null;       // 합성된 오늘 라이브 이벤트 (없으면 null)

    function _ymd(s) { return String(s || '').replace(/[^0-9]/g, '').slice(0, 8); }
    function _todayKST() {
        return new Date(Date.now() + KST_OFFSET * 60000).toISOString().slice(0, 10).replace(/-/g, '');
    }

    function makeTodayEvent(date, rate, price, row) {
        return {
            date: date,
            change_rate: rate,
            close_price: price != null ? price : ((row && row.close_price) || null),
            rise_reason: (row && row.rise_reason) || '',
            reason_status: (row && row.rise_reason) ? 'filled' : 'missing',
            reason_confidence: 'high',
            reason_source: '',        // 라이브 카드는 '실시간' 배지로 표기 — 출처 배지 생략
            theme_tag: (row && row.theme_tag) || '',
            sector: (row && row.sector) || '',
            news: (row && row.news) || [],
            is_52w_high: !!(row && row.high_52w_date && _ymd(row.high_52w_date) === date),
            _live: true,
        };
    }

    function rerenderTimeline() {
        var merged = _todayEvent ? [_todayEvent].concat(_baseEvents) : _baseEvents;
        renderEvents(merged, _ticker);
        // 오늘 라이브 이벤트가 있으면 'stock-history 미빌드' 안내 메시지 숨김
        var $msg = document.getElementById('message');
        if ($msg && _todayEvent) $msg.style.display = 'none';
    }

    // meta = getCurrentPrice 응답 {price, change_rate, ...}. 현재가 폴링 tick 에서 매번 호출.
    function evaluateTodayEvent(meta) {
        var date = _todayKST();
        // 이미 stock-history(확정)에 오늘 이벤트가 있으면 라이브 주입 안 함(중복 방지)
        var hasToday = _baseEvents.some(function (e) { return _ymd(e.date) === date; });
        var rate = meta ? Number(meta.change_rate) : NaN;
        // 15% 미만이거나 확정분 있으면 today 이벤트 제거(실시간 넣었다 뺐다)
        if (hasToday || !(rate >= TODAY_LIVE_CUTOFF)) {
            if (_todayEvent) { _todayEvent = null; rerenderTimeline(); }
            return;
        }
        var price = meta ? meta.price : null;
        // 오늘 빌드에서 이유·뉴스 — getDates()[0]==오늘 이어야 오늘 빌드 존재(아니면 시세만)
        WhyAPI.getDates().then(function (dts) {
            var latest = (Array.isArray(dts) ? dts[0] : (dts && dts.dates && dts.dates[0])) || '';
            if (latest !== date) {
                _todayEvent = makeTodayEvent(date, rate, price, null);
                rerenderTimeline();
                return;
            }
            return WhyAPI.getRankings(date).then(function (data) {
                var row = ((data && data.rankings) || []).find(function (r) { return r.ticker === _ticker; });
                _todayEvent = makeTodayEvent(date, rate, price, row || null);
                rerenderTimeline();
            });
        }).catch(function () {
            _todayEvent = makeTodayEvent(date, rate, price, null);
            rerenderTimeline();
        });
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
        var row = $mount.closest('.stock-header__actions');
        wrap.classList.add('ctrl-wrap--just-acted');
        if (_headerRatingSuppressTimer) clearTimeout(_headerRatingSuppressTimer);
        var release = function () {
            wrap.classList.remove('ctrl-wrap--just-acted');
        };
        _headerRatingSuppressTimer = setTimeout(release, 2000);
        if (row) row.addEventListener('mouseleave', release, { once: true });
    }

    /** 패널(.float-controls) 구조는 메인 홈(table.js starRatingHtml) 과 동일 — 호버/탭 동작 통일.
        트리거만 ⋯ 대신 네이버·공유와 같은 pill 버튼('관심'). 별점·메모·제외 중 하나라도 있으면 is-set. */
    function renderHeaderRating(ticker) {
        var $mount = document.getElementById('stockHeaderRating');
        if (!$mount) return;
        var ratings = loadRatings();
        var rating = ratings[ticker] || {};
        var stars = rating.stars || 0;
        var hasMemo = !!(rating.memo && rating.memo.trim());
        var excluded = !!rating.excluded;
        var isSet = stars > 0 || hasMemo || excluded;
        var html = '<span class="ctrl-wrap">';
        html += '<button class="ctrl-toggle' + (isSet ? ' is-set' : '') + '" type="button" data-ticker="' + ticker + '" aria-label="관심·메모" title="별점·메모·제외">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="' + (isSet ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' +
            '<span>관심</span></button>';
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
                _ticker = ticker;
                _baseEvents = [];
                WhyAPI.getCurrentPrice(ticker)
                    .then(function (meta) {
                        var name = (meta && meta.name) || ticker;
                        var market = (meta && meta.market) || '';
                        // stats 는 null — '+15% 0회' 한 줄만 덩그러니 렌더되는 것 방지
                        renderHeader(name, market, null);
                        renderEvents([], ticker);
                        // 이미 받아온 라이브 시세를 그대로 표시
                        renderPriceStat(meta);
                        $msg.textContent = '최근 1년간 +10% 이상 급등 기록이 없는 종목입니다.';
                        $msg.style.display = 'block';
                        // 이력 없는 종목도 오늘 +15% 면 '오늘(실시간)' 카드 주입(rerenderTimeline 이 메시지 숨김).
                        if (isMarketOpenKST()) startPricePolling(ticker);
                        else evaluateTodayEvent(meta);
                    })
                    .catch(function () {
                        // API 실패는 '기록 없음' 과 구분 — 정상 종목을 기록 없음으로 오인시키지 않음
                        document.getElementById('stockTitle').innerHTML = '<strong>' + esc(ticker) + '</strong> 왜 오름?';
                        $msg.textContent = '종목 정보를 불러오지 못했습니다. 잠시 후 새로고침 해주세요.';
                        $msg.style.display = 'block';
                    });
                return;
            }
            _ticker = ticker;
            _baseEvents = history.events || [];
            renderHeader(history.name || ticker, history.market || '', history.stats || {});
            var $sum = document.getElementById('stockSummary');
            if ($sum) {
                var summary = buildSummary(history.events || []);
                $sum.textContent = summary || '';
                $sum.style.display = summary ? 'block' : 'none';
            }
            rerenderTimeline();          // 베이스 타임라인 즉시 렌더(오늘 라이브 이벤트는 폴링이 주입)
            startPricePolling(ticker);   // 현재가 폴링 + 오늘(실시간) 급등 이벤트 주입/갱신
            bindAdminEdit(history);
        }).catch(function (err) {
            $loading.style.display = 'none';
            $msg.textContent = '로딩 실패: ' + err.message;
            $msg.style.display = 'block';
        });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
