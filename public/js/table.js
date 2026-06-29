/**
 * 테이블 렌더링 — whyrise 변형 (이유를 hero 컬럼으로, 점수 제거).
 *
 * stock-rise table.js 를 베이스로:
 *  - reason 을 첫 번째 컨텐츠 컬럼(종목명 다음)에 hero 스타일로
 *  - 시가총액 컬럼 제거 (공간 확보)
 *  - 대장점수 컬럼 제거
 *  - localStorage 키 (간접) — ratings 는 whyrise.js 가 관리
 *  - 관리자 모드(✏️) 행 우측 표시 — admin.js 가 활성화
 */
var WhyTable = (function () {

    /** HTML 이스케이프 — XSS 방어. 사용자/3rd-party 텍스트는 항상 통과시킴. */
    function esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    // 모바일에서 finance.naver.com/item/news_read.naver?... 는 네이버가 m.stock.naver.com 404
    // 페이지로 리다이렉트. 모바일 UA 일 때만 n.news.naver.com/mnews/article 형식으로 변환.
    function normalizeNewsLink(s) {
        if (!/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return s;
        if (s.indexOf('finance.naver.com/item/news_read') < 0) return s;
        var a = /[?&]article_id=([0-9]+)/.exec(s);
        var o = /[?&]office_id=([0-9]+)/.exec(s);
        if (!a || !o) return s;
        return 'https://n.news.naver.com/mnews/article/' + o[1] + '/' + a[1];
    }
    function safeLink(href) {
        if (!href) return '';
        var s = String(href).trim();
        if (/^(javascript|data|vbscript):/i.test(s)) return '';
        return esc(normalizeNewsLink(s));
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

    function normalizeKey(s) {
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

    function cleanupNewsTitle(title, stockName) {
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
        var cleaned = cleanupNewsTitle(title, stockName);
        if (!cleaned) return '';
        if (/트럼프/.test(cleaned) && /사진/.test(cleaned)) {
            if (/김정은|정상회담|북미/.test(cleaned)) return '트럼프·김정은 사진 이슈';
            if (/남북경협|대북/.test(normalizeKey(themeShort))) return '트럼프 사진 이슈';
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
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}(?:수출|실적)\s*호조)/,
            /([A-Za-z0-9가-힣·+\-/ ]{0,16}흑자\s*전환)/,
            /(주식\s*병합\s*승인)/,
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

    function dateGapDays(a, b) {
        if (!a || !b || a.length !== 8 || b.length !== 8) return null;
        var da = new Date(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8));
        var db = new Date(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8));
        return Math.abs(da - db) / 86400000;
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

    function isRelevantNewsTitle(title, stockName, themeShort, reasonCore) {
        var titleKey = normalizeKey(cleanupNewsTitle(title, ''));
        if (!titleKey) return false;

        var stockKey = normalizeKey(stockName);
        if (stockKey && titleKey.indexOf(stockKey) >= 0) return true;

        var themeKey = normalizeKey(themeShort);
        if (themeKey && themeKey !== '뉴스' && titleKey.indexOf(themeKey) >= 0) return true;

        var reasonKey = normalizeKey(reasonCore).replace(/이슈$/, '');
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
            if (!isRelevantNewsTitle(title, stockName, themeShort, reasonCore)) continue;
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

    // 상승이유 표시 정리 — 이유 칸을 절대 비우지 않는다(빈칸=오류처럼 보임).
    // 약한 "관련 뉴스"류는 뉴스 제목에서 명확한 사건을 뽑고, 실패하면 "OO 이슈"로 말끝을 닫는다.
    function cleanReasonText(reason, theme, news, stockName, eventDate, relaxDate) {
        var orig = String(reason == null ? '' : reason).trim();
        var t = stripThemeParen(theme);
        var tShort = t.split('/')[0].trim();
        // 합성행(빌드 TOP_N=100 밖 급등주)은 stock-rise 당일 reason 이 없어 raw 뉴스에 의존한다.
        // 종목 기사가 며칠~몇주 전이면 ±4일 게이트에 다 걸려 '테마 이슈'로 폴백되므로,
        // 합성행에 한해 날짜 게이트를 풀어(eventDate='') 종목 기사 제목에서 이슈를 뽑는다.
        // (종목명/테마 매칭 게이트는 유지 — 시황 노이즈는 계속 차단.)
        var ev = relaxDate ? '' : eventDate;
        // 이유가 없으면 테마 기반으로 채움(빈칸 금지). 테마도 없으면 '' (호출부에서 '-').
        if (!orig || orig === '-') return tShort ? (tShort + ' 관련 뉴스') : '';
        // "테마"/"테마 관련 뉴스" placeholder → 실제 테마명
        if (orig === '테마' || /^테마\s*관련\s*(뉴스|이슈|소식)?$/.test(orig)) {
            orig = tShort ? (tShort + ' 관련 뉴스') : orig;
        }

        if (isWeakReasonText(orig)) {
            var reasonCore = issueFromReasonCore(orig, tShort).replace(/\s*이슈$/, '');
            var newsIssue = issueFromNews(news, stockName, tShort, reasonCore, ev);
            if (newsIssue) return newsIssue;
            // 이름/테마 불일치라도 같은날 다수에 등장하는 섹터 카탈리스트(예: 이란 재건) 완화 추출.
            var sectorIssue = sectorCatalystFromNews(news, stockName, tShort, ev);
            if (sectorIssue) return sectorIssue;
            // 그래도 못 뽑고 reason 코어가 일반어면 테마 기반 — 'OO 이슈' 잡탕 대신 테마 관련 뉴스.
            if (tShort && isGenericReasonKey(normalizeKey(reasonCore))) return tShort + ' 관련 뉴스';
        }

        // 끝 '보도'는 제거. 한 단어만 남으면 "이슈"를 붙여 빈약한 라벨처럼 보이지 않게 한다.
        function trimTail(s) {
            var nb = s.replace(/\s*보도\s*$/, '').trim();
            if (!nb || nb === s) return s;
            return (nb.indexOf(' ') >= 0) ? nb : (nb + ' 이슈');
        }
        var r = trimTail(orig);
        // 테마명 중복 제거 — 다단어 좋은 문구로 남을 때만, 그리고 테마 뒤가 단어 경계(공백·점·쉼표·끝)
        // 일 때만. "탈모 치료"가 "탈모 치료제"의 단어 중간에 매칭돼 "제 보험 검토"로 깨지는 것 방지.
        var rTheme = compactSpaces(r).replace(/\s*[\(（][^)）]*[\)）]\s*/g, ' ');
        var afterT = rTheme.charAt(t.length);
        if (t && rTheme.indexOf(t) === 0 && (afterT === '' || /[\s·,]/.test(afterT))) {
            var d = rTheme.slice(t.length).replace(/^[\s·,]+/, '').trim();
            var dFiller = !d || d === '관련' || /^(관련\s*)?(뉴스|이슈|소식)$/.test(d);
            if (!dFiller && d.indexOf(' ') >= 0) r = d;
        }
        // 뉴스 다수에 확정 공시(무상증자 등)가 있는데 빌드 reason 이 그걸 안 담았으면 그걸 우선.
        var corp = dominantCorpAction(news, ev);
        if (corp && _reasonKeyFlat(r).indexOf(_reasonKeyFlat(corp)) < 0) return corp;
        return issueFromReasonCore(r, tShort);
    }

    var _currentData = [];
    var _lastRatings = {};
    var _lastOpts = {};
    /** 정렬 상태 — key: 'change'|'volume'|'cap'|'sector'|'reason', dir: 'asc'|'desc'. 기본: change desc (서버 순서) */
    var _sort = { key: null, dir: 'desc' };

    /** 정렬 적용 — _currentData 를 정렬한 사본 반환. key=null 이면 원본 순서. */
    function applySort(rows) {
        if (!_sort.key) return rows.slice();
        var key = _sort.key;
        var arr = rows.slice();
        // name 키 — 관심 모드면 별 개수 desc 우선, 그 다음 시장+가나다.
        // 일반 모드: 코스피/코스닥 정렬. asc: KOSPI 먼저, desc: KOSDAQ 먼저. 같은 시장 내 가나다.
        if (key === 'name') {
            var marketDir = (_sort.dir === 'desc') ? -1 : 1;
            var watchlist = !!_lastOpts.watchlistMode;
            arr.sort(function (a, b) {
                if (watchlist) {
                    var sa = (_lastRatings[a.ticker] || {}).stars || 0;
                    var sb = (_lastRatings[b.ticker] || {}).stars || 0;
                    if (sa !== sb) return sb - sa;   // 별 desc 우선
                }
                var ma = (a.market === 'KOSPI') ? 0 : 1;
                var mb = (b.market === 'KOSPI') ? 0 : 1;
                if (ma !== mb) return (ma - mb) * marketDir;
                var na = (a.name || '').trim();
                var nb = (b.name || '').trim();
                return na.localeCompare(nb, 'ko-KR');
            });
            return arr;
        }
        var dir = _sort.dir === 'asc' ? 1 : -1;
        arr.sort(function (a, b) {
            var va, vb;
            if (key === 'change')      { va = a.change_rate;  vb = b.change_rate; }
            else if (key === 'volume') { va = a.trading_value; vb = b.trading_value; }
            else if (key === 'cap')    { va = a.market_cap;   vb = b.market_cap; }
            else if (key === 'sector') {
                va = (a.sector || '').trim();
                vb = (b.sector || '').trim();
                if (va < vb) return -1 * dir;
                if (va > vb) return  1 * dir;
                return (b.change_rate || 0) - (a.change_rate || 0);
            }
            else if (key === 'reason') {
                // 태그(theme_tag) 우선, 동률은 rise_reason 알파벳 순
                var ta = (a.theme_tag || '').trim();
                var tb = (b.theme_tag || '').trim();
                if (ta !== tb) {
                    // 빈 태그는 항상 뒤로
                    if (!ta) return 1;
                    if (!tb) return -1;
                    return (ta < tb ? -1 : 1) * dir;
                }
                var ra = (a.rise_reason || '').trim();
                var rb = (b.rise_reason || '').trim();
                if (ra !== rb) {
                    if (!ra) return 1;
                    if (!rb) return -1;
                    return (ra < rb ? -1 : 1) * dir;
                }
                return 0;
            }
            else { va = 0; vb = 0; }
            va = (va == null) ? -Infinity : va;
            vb = (vb == null) ? -Infinity : vb;
            return (va - vb) * dir;
        });
        return arr;
    }

    function shortenTheme(name, maxLen) {
        if (!name) return name;
        maxLen = maxLen || 14;
        var short = name.replace(/\(.*?\)/g, '').trim();
        if (!short) return name;
        if (short.length > maxLen) short = short.substring(0, maxLen) + '…';
        return short;
    }

    function formatNumber(n) {
        if (n == null) return '-';
        return n.toLocaleString('ko-KR');
    }

    function formatAmount(n) {
        if (n == null || n === 0) return '-';
        if (n >= 1e12) return (n / 1e12).toFixed(1) + '조';
        if (n >= 1e8) return Math.round(n / 1e8) + '억';
        if (n >= 1e4) return Math.round(n / 1e4) + '만';
        return formatNumber(n);
    }

    function formatChangeRate(rate) {
        if (rate == null) return '-';
        var sign = rate >= 0 ? '+' : '';
        var arrow = rate >= 0 ? '▲' : '▼';
        var cls = rate >= 0 ? 'cell-change--up' : 'cell-change--down';
        return '<span class="' + cls + '">' + arrow + sign + rate.toFixed(2) + '%</span>';
    }

    function formatCompactDate(yyyymmdd) {
        var s = String(yyyymmdd || '');
        if (s.length !== 8) return '';
        return s.substring(2, 4) + '.' + s.substring(4, 6) + '.' + s.substring(6, 8);
    }

    function starRatingHtml(ticker, ratings) {
        var rating = ratings[ticker] || {};
        var stars = rating.stars || 0;
        var excluded = rating.excluded || false;
        var hasMemo = rating.memo ? true : false;

        var html = '<span class="ctrl-wrap">';
        html += '<button class="ctrl-toggle" type="button" data-ticker="' +
            ticker + '" aria-label="평가">⋯</button>';
        html += '<div class="float-controls" data-ticker="' + ticker + '">';
        html += '<span class="star-rating" data-ticker="' + ticker + '">';
        for (var i = 1; i <= 5; i++) {
            html += '<span class="star' + (i <= stars ? ' star--active' : '') +
                '" data-star="' + i + '">★</span>';
        }
        html += '</span>';
        html += '<button class="exclude-btn' + (excluded ? ' exclude-btn--active' : '') +
            '" data-ticker="' + ticker + '" title="제외">✕</button>';
        html += '<button class="memo-btn' + (hasMemo ? ' memo-btn--has' : '') +
            '" data-ticker="' + ticker + '" title="메모">✎</button>';
        html += '</div></span>';
        return html;
    }

    function miniIndicatorsHtml(ticker, ratings) {
        var rating = ratings[ticker] || {};
        var stars = rating.stars || 0;
        var excluded = rating.excluded || false;
        var hasMemo = rating.memo ? true : false;
        if (!(stars > 0 || excluded || hasMemo)) return '';
        var html = '<span class="mini-indicators">';
        if (stars > 0) html += '<span class="mini-star">★' + stars + '</span>';
        if (excluded) html += '<span class="mini-exclude">✕</span>';
        if (hasMemo) html += '<span class="mini-memo">✎</span>';
        html += '</span>';
        return html;
    }

    function openNews(ticker) {
        var stock = null;
        for (var i = 0; i < _currentData.length; i++) {
            if (_currentData[i].ticker === ticker) { stock = _currentData[i]; break; }
        }
        var $modal = document.getElementById('newsModal');
        var $title = document.getElementById('newsModalTitle');
        var $body = document.getElementById('newsModalBody');
        if (!$modal || !$title || !$body) return;
        $title.textContent = (stock ? stock.name : ticker) + ' 관련 뉴스';
        if (!stock || !stock.news || stock.news.length === 0) {
            $body.innerHTML = '<div class="news-empty">관련 뉴스가 없습니다</div>';
        } else {
            var html = '';
            stock.news.forEach(function (n) {
                html += '<div class="news-item">' +
                    '<a class="news-item__title" href="' + safeLink(n.link) + '" target="_blank" rel="noopener noreferrer">' + esc(n.title) + '</a>' +
                    '<span class="news-item__meta">' +
                    (n.source ? '<span class="news-item__source">' + esc(n.source) + '</span>' : '') +
                    (n.date ? '<span class="news-item__date">' + esc(n.date) + '</span>' : '') +
                    '</span></div>';
            });
            $body.innerHTML = html;
        }
        $modal.style.display = 'flex';
    }

    function closeNews() {
        var $modal = document.getElementById('newsModal');
        if ($modal) $modal.style.display = 'none';
    }

    function render(rankings, ratings, opts) {
        var tbody = document.getElementById('rankingBody');
        if (!tbody) return;
        _currentData = rankings;
        _lastRatings = ratings || {};
        _lastOpts = opts || {};
        ratings = _lastRatings;
        opts = _lastOpts;
        var date = opts.date || '';

        // 정렬 헤더 인디케이터 갱신
        updateSortIndicators();

        if (!rankings || rankings.length === 0) {
            var emptyMsg = (opts && opts.emptyMsg) ||
                '오늘 +15% 이상 오른 종목이 없습니다.';
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:60px;color:var(--text-muted);">' +
                emptyMsg + '</td></tr>';
            return;
        }

        var sortedRows = applySort(rankings);
        var html = '';
        sortedRows.forEach(function (r) {
            var detailUrl = '/stock/' + r.ticker;
            var ratingData = ratings[r.ticker] || {};
            var isExcluded = ratingData.excluded || false;
            var isStarred = (ratingData.stars || 0) > 0;
            var isLimitUp = (r.change_rate != null && r.change_rate >= 29.9);
            var isEdited = r._edited || false;
            var rowClasses = [];
            if (isExcluded) rowClasses.push('row--excluded');
            if (isStarred) rowClasses.push('row--starred');
            if (isLimitUp) rowClasses.push('row--limit-up');
            if (isEdited) rowClasses.push('row--edited');

            var tEsc = esc(r.ticker);
            html += '<tr' + (rowClasses.length ? ' class="' + rowClasses.join(' ') + '"' : '') + ' data-ticker="' + tEsc + '">';
            // # rank
            html += '<td class="cell-rank">' + (r._displayRank != null ? r._displayRank : '') + '</td>';
            // 종목명
            html += '<td class="cell-name"><div class="cell-name__wrap">' +
                '<a href="' + detailUrl + '" class="cell-name__link" data-ticker="' + tEsc + '">' + esc(r.name) + '</a>' +
                miniIndicatorsHtml(r.ticker, ratings) +
                '<span class="cell-name__market">' + esc(r.market) + '</span>' +
                starRatingHtml(r.ticker, ratings) +
                '</div></td>';
            // 이유 (hero) — 태그·이유·편집 모두 한 줄에
            var rawTag = r.theme_tag || '';
            var displayTag = shortenTheme(rawTag);
            var eventDate = opts.watchlistMode ? (r._historyDate || r.date || '') : '';
            var reasonDate = eventDate || date;
            // 이유는 항상 채움(빈칸=오류처럼 보임). 약한 "관련 뉴스"류는 짧은 이슈 문구로 표시.
            var reason = cleanReasonText(r.rise_reason, rawTag, r.news, r.name, reasonDate, r._liveNew) || '-';
            var editDate = eventDate || date;
            var editBtn = '<button class="admin-edit-btn" data-action="admin-edit" data-ticker="' + tEsc +
                '" data-date="' + esc(editDate) + '" title="이유 편집">✏️</button>';
            // 태그 → 그 테마 스크리닝, 이유 텍스트 → 종목 상세. (cell-name 처럼 native <a> 네비)
            html += '<td class="cell-reason">' +
                '<div class="cell-reason__inline">' +
                (displayTag ? '<a class="theme-tag" href="/screening.html?theme=' + encodeURIComponent(rawTag) + '" style="text-decoration:none" title="' + esc(rawTag) + ' 스크리닝">' + esc(displayTag) + '</a>' : '') +
                '<a class="cell-reason__text" href="' + detailUrl + '" data-ticker="' + tEsc + '" style="color:inherit;text-decoration:none" title="' + esc(reason) + '">' + esc(reason) + '</a>' +
                editBtn +
                '</div></td>';
            // 상승률
            var eventDateHtml = eventDate ? '<span class="cell-change__date">' + esc(formatCompactDate(eventDate)) + '</span>' : '';
            html += '<td class="cell-change">' + eventDateHtml + formatChangeRate(r.change_rate) + '</td>';
            // 거래대금
            html += '<td class="cell-volume">' + formatAmount(r.trading_value) + '</td>';
            // 시가총액
            html += '<td class="cell-cap">' + formatAmount(r.market_cap) + '</td>';
            // 섹터 → 그 섹터 스크리닝
            html += '<td class="cell-sector">' + (r.sector ? '<a href="/screening.html?sector=' + encodeURIComponent(r.sector) + '" style="color:inherit;text-decoration:none" title="' + esc(r.sector) + ' 스크리닝">' + esc(r.sector) + '</a>' : '-') + '</td>';
            // 모바일 카드 전용 meta 한 줄 (PC 에선 CSS display:none) — 시장·섹터·시총·거래대금 합쳐서 보존
            var metaParts = [];
            if (r.market) metaParts.push(esc(r.market));
            if (r.sector) metaParts.push('<a href="/screening.html?sector=' + encodeURIComponent(r.sector) + '" style="color:inherit;text-decoration:none">' + esc(r.sector) + '</a>');
            if (r.market_cap) metaParts.push('시총 ' + formatAmount(r.market_cap));
            if (r.trading_value) metaParts.push('거래 ' + formatAmount(r.trading_value));
            html += '<td class="cell-meta-compact">' + metaParts.join(' · ') + '</td>';
            html += '</tr>';
        });
        tbody.innerHTML = html;
    }

    /** 헤더 인디케이터 — 모든 헤더 항상 ▼ 디폴트, 활성 컬럼은 색만 강조 + 방향 따라 ▲▼ 전환. */
    function updateSortIndicators() {
        var ths = document.querySelectorAll('th.th-sort');
        for (var i = 0; i < ths.length; i++) {
            var th = ths[i];
            var key = th.getAttribute('data-sort-key');
            var ind = th.querySelector('.sort-ind');
            var active = (key === _sort.key);
            if (active) {
                th.classList.add('th-sort--active');
                if (ind) ind.textContent = _sort.dir === 'asc' ? '▲' : '▼';
            } else {
                th.classList.remove('th-sort--active');
                if (ind) ind.textContent = '▼';
            }
        }
    }

    /** 헤더 클릭 → 정렬 키 토글 + 리렌더. */
    function bindHeaderSort() {
        var table = document.getElementById('rankingTable');
        if (!table) return;
        var thead = table.querySelector('thead');
        if (!thead) return;
        thead.addEventListener('click', function (e) {
            // # 컬럼 클릭 — 정렬 초기화 (원래 1,2,3 순)
            var resetTh = e.target.closest('th.th-rank-reset');
            if (resetTh) {
                _sort.key = null;
                _sort.dir = 'desc';
                render(_currentData, _lastRatings, _lastOpts);
                return;
            }
            var th = e.target.closest('th.th-sort');
            if (!th) return;
            var key = th.getAttribute('data-sort-key');
            if (!key) return;
            // 같은 키 재클릭 → asc/desc 토글
            if (_sort.key === key) {
                _sort.dir = _sort.dir === 'desc' ? 'asc' : 'desc';
            } else {
                _sort.key = key;
                // 기본 방향: sector/reason 은 asc(가나다), 나머지(상승률/거래대금/시총)는 desc
                // name 은 KOSPI 먼저 = 'asc' (작은 값=KOSPI rank 0)
                _sort.dir = (key === 'sector' || key === 'reason' || key === 'name') ? 'asc' : 'desc';
            }
            render(_currentData, _lastRatings, _lastOpts);
        });
    }
    document.addEventListener('DOMContentLoaded', bindHeaderSort);

    return {
        render: render,
        openNews: openNews,
        closeNews: closeNews,
        formatAmount: formatAmount,
        formatChangeRate: formatChangeRate,
    };
})();
