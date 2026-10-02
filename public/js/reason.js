/**
 * 상승 이유 표시 규칙 (리스트·종목 상세·홈 공통) — window.OrgoReason
 *
 * 서버(scripts/reason_extract.py, stock-rise collector)가 '같은 날 기사 근거'로 만든 사유를 그대로 보여주고
 * 근거 기사가 있으면 출처 표시와 링크를 붙인다.
 * 근거가 없으면 빈칸 대신 가장 그럴듯한 단서를 흐리게 + 라벨로 보여준다 (unknown=true, hint=true):
 *   키워드 추정 사유('수주 공시' 등) → '추정' / 테마 → '○○ 관련주' / 업종.
 */
(function () {
    'use strict';
    var TRUSTED_SOURCES = { llm: 1, news_headline: 1, news_extract: 1, admin: 1 };
    var TEMPLATE_RE = new RegExp(
        '(?:관련\\s*(?:뉴스|이슈|소식)|뉴스|보도|이슈|공시|발표|언급|관련|기록|급증|증가|테마\\s*강세|테마|테마\\s*상한가)$' +
        '|^(?:MOU 체결|계약 체결|공급 계약 체결|납품 계약 체결|라이선스 계약|흑자 전환|자사주 매입|자사주 소각|' +
        '특허 취득|임상 3상 진입|실적 서프라이즈|경영진 교체|자본 구조 변경|주주환원 정책|테마 대장주|테마 관련주|' +
        '관세 정책 관련|국책사업 관련|보조금 관련|정부 정책 관련|증권사 리포트 공개|외국인·기관 순매수|기관 순매수|' +
        '외국인 순매수|상한가 — 사유 미수집|시장 관심 증가|이유 분석 대기중|관련 뉴스 없음|투자심리 개선 영향|바이오|52주 신고가 도달|신약/임상|실적 호조|대형 수주|호재 기대)$' +
        '|상승률\\s*1위|1위로\\s*마감');
    // '방산'·'로봇/자동화' 같은 분류명(띄어쓰기 없는 짧은 말·슬래시 나열)도 이유가 아니다
    function isTpl(r) {
        r = String(r || '').trim();
        return !r || r === '-' || TEMPLATE_RE.test(r) || /^\S{1,10}$/.test(r) || /^\S+(?:\/\S+)+$/.test(r);
    }
    var KIND_LABEL = {
        move: '기사', catalyst: '기사', analyst: '리포트', rebound: '기사', delisting: '정리매매',
        sector: '업종', theme: '테마', ipo: '신규상장', related: '', none: ''
    };
    var UNKNOWN = '이유 확인 중';
    // 단서로도 못 쓰는 제네릭 문구 — 이때는 테마·업종으로 대신 보여준다
    var GENERIC_RE = /^(?:거래량\s*(?:증가|급증)|거래대금\s*증가|시장 관심 증가|상한가 — 사유 미수집|이유 분석 대기중|관련 뉴스 없음|투자심리 개선 영향|테마 관련 뉴스|테마 관련 이슈|테마 대장주|테마 관련주|관련주 언급|상장 이슈|바이오|-)$|테마\s*(?:강세|상한가)$|상승률\s*1위|1위로\s*마감|52주 신고가|^실적 호조$|^호재 기대$/;
    var CATALYST_RE = /공급|계약|수주|특허|승인|허가|임상|기술\s*이전|인수|합병|실적|흑자|영업\s*익|매출|자사주|배당|선정|MOU|출시|수출|양산|상장|병합|분할|재개/;
    var THEME_JUNK = /^(?:거래량|거래대금|보도|테마|뉴스|구성|주요종목|기타|현장|관련|이슈)$/;

    function themeShort(t) {
        return String(t || '').replace(/\s*[\(（][^)）]*[\)）]/g, '').split('/')[0].trim();
    }

    /** 근거 없는 행의 단서 — { text, label } */
    function hint(row) {
        var rh = row.reason_hint;
        if (rh && rh.text) return { text: String(rh.text), label: '최근 이슈', link: /^https:\/\//.test(String(rh.link || '')) ? rh.link : '', linkTitle: String(rh.title || '') };
        // 가격제한폭(30%)을 넘는 상승 — 액면병합·감자 뒤 거래 재개로 기준가가 바뀐 경우
        if (Number(row.change_rate) > 30.5) return { text: '거래 재개·기준가 변경 영향', label: '추정' };
        var cands = [row.reason_previous, row.rise_reason];
        for (var i = 0; i < cands.length; i++) {
            var c = String(cands[i] || '').replace(/^전일 사유 · /, '').trim();
            if (c && !GENERIC_RE.test(c) && c.length <= 24 && !/^관련 보도:/.test(c)) {
                // '로봇/자동화' 같은 분류명은 테마 단서로
                if ((/^\S{1,10}$/.test(c) || /^\S+(?:\/\S+)+$/.test(c)) && !CATALYST_RE.test(c)) return { text: themeShort(c) + ' 관련주', label: '테마' };
                return { text: c, label: '추정' };
            }
        }
        var tag = themeShort(row.theme_tag);
        if (tag && !THEME_JUNK.test(tag) && !/신규\s*상장/.test(tag) && tag.length >= 2 && !/^\d+\s*(?:일|주|개월|년)?$/.test(tag)) {
            return { text: tag + ' 관련주', label: '테마' };
        }
        var sector = String(row.sector || '').trim();
        if (sector) return { text: sector, label: '업종' };
        return { text: '개별 종목 상승', label: '' };
    }

    function trusted(row) {
        if (!row) return false;
        if (row.reason_status === 'edited' || row.reason_source === 'admin') return true;
        if (TRUSTED_SOURCES[row.reason_source]) return true;
        return row.reason_origin === 'news' || row.reason_origin === 'toss';
    }

    function evidence(row) {
        var list = (row && row.reason_evidence) || [];
        for (var i = 0; i < list.length; i++) {
            var it = list[i] || {};
            if (/^https:\/\//.test(String(it.link || ''))) return it;
        }
        return null;
    }

    // 상장 첫날: 가격제한폭(±30%)을 넘는 상승은 신규상장 첫날뿐 (정리매매 제외)
    function listingDay(row) {
        if (!row || Number(row.change_rate) <= 30.5 || /^정리매매/.test(String(row.rise_reason || ''))) return false;
        var tags = [row.theme_tag].concat(row.theme_tags || []).join(' ');
        return /신규\s*상장/.test(tags);
    }

    /** row → { text, unknown, label, link, linkTitle } */
    function display(row) {
        var reason = String((row && row.rise_reason) || '').trim();
        if (!trusted(row) && isTpl(reason)) reason = '';
        if (reason.indexOf('전일 사유 · ') === 0 && isTpl(reason.slice(8))) reason = '';
        if (!reason && listingDay(row)) {
            return { text: '상장 첫날 (공모가 대비)', unknown: false, label: '신규상장', link: '', linkTitle: '' };
        }
        var ev = reason ? evidence(row) : null;
        var label = '';
        if (reason) {
            if (row.reason_source === 'llm') label = 'AI';
            else if (row.reason_origin === 'toss' && row.reason_source === 'stockrise') label = '토스 AI';
            else if (row.reason_kind && KIND_LABEL[row.reason_kind] !== undefined) label = KIND_LABEL[row.reason_kind];
            else if (ev) label = '기사';
        }
        if (!reason) {
            var h = hint(row || {});
            return { text: h.text, unknown: true, hint: true, label: h.label, link: h.link || '', linkTitle: h.linkTitle || '' };
        }
        return {
            text: reason,
            unknown: false,
            label: label,
            link: ev ? ev.link : '',
            linkTitle: ev ? String(ev.title || '') + (ev.source ? ' · ' + ev.source : '') : ''
        };
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /** 표시용 작은 HTML 조각 — 출처 라벨(링크) */
    function sourceHtml(d) {
        if (!d || !d.label) return '';
        if (d.hint && d.link) {
            return '<a class="reason-src reason-src--hint" href="' + esc(d.link) + '" target="_blank" rel="noopener nofollow" title="' +
                esc((d.linkTitle || '') + ' — 같은 날 기사가 없어 최근 재료를 보여줘요') + '">' + esc(d.label) + ' ↗</a>';
        }
        if (d.hint) return '<span class="reason-src reason-src--hint" title="같은 날 기사 근거를 찾지 못해 키워드·테마로 추정한 표시예요">' + esc(d.label) + '</span>';
        if (d.link) {
            return '<a class="reason-src" href="' + esc(d.link) + '" target="_blank" rel="noopener nofollow" title="' +
                esc(d.linkTitle || '근거 기사') + '">' + esc(d.label) + ' ↗</a>';
        }
        return '<span class="reason-src reason-src--plain">' + esc(d.label) + '</span>';
    }

    var api = { display: display, sourceHtml: sourceHtml, isTemplate: isTpl, UNKNOWN: UNKNOWN };
    // 브라우저(window.OrgoReason)와 Node(텔레그램·발행실 스크립트) 공용
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else window.OrgoReason = api;
})();
