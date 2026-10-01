/**
 * 상승 이유 표시 규칙 (리스트·종목 상세·홈 공통) — window.OrgoReason
 *
 * 서버(scripts/reason_extract.py, stock-rise collector)가 '같은 날 기사 근거'로 만든 사유를 그대로 보여주고,
 * 뉴스 키워드만 보고 만든 옛 템플릿('수주 공시'·'정책 관련 뉴스'·'거래량 증가' 등)은
 * 틀릴 수 있어 '이유 확인 중'으로 표시한다. 근거 기사가 있으면 출처 표시와 링크를 붙인다.
 */
(function () {
    'use strict';
    var TRUSTED_SOURCES = { llm: 1, news_headline: 1, news_extract: 1, admin: 1 };
    var TEMPLATE_RE = new RegExp(
        '(?:관련\\s*(?:뉴스|이슈|소식)|뉴스|보도|이슈|공시|발표|언급|관련|기록|급증|증가|테마\\s*강세)$' +
        '|^(?:MOU 체결|계약 체결|공급 계약 체결|납품 계약 체결|라이선스 계약|흑자 전환|자사주 매입|자사주 소각|' +
        '특허 취득|임상 3상 진입|실적 서프라이즈|경영진 교체|자본 구조 변경|주주환원 정책|테마 대장주|테마 관련주|' +
        '관세 정책 관련|국책사업 관련|보조금 관련|정부 정책 관련|증권사 리포트 공개|외국인·기관 순매수|기관 순매수|' +
        '외국인 순매수|상한가 — 사유 미수집|시장 관심 증가|이유 분석 대기중|관련 뉴스 없음|투자심리 개선 영향|바이오)$');
    var KIND_LABEL = {
        move: '기사', catalyst: '기사', analyst: '리포트', rebound: '기사', delisting: '정리매매',
        sector: '업종', theme: '테마', ipo: '신규상장', related: '', none: ''
    };
    var UNKNOWN = '이유 확인 중';

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

    /** row → { text, unknown, label, link, linkTitle } */
    function display(row) {
        var reason = String((row && row.rise_reason) || '').trim();
        if (!trusted(row) && (!reason || reason === '-' || TEMPLATE_RE.test(reason))) reason = '';
        if (reason.indexOf('전일 사유 · ') === 0 && TEMPLATE_RE.test(reason.slice(8))) reason = '';
        var ev = reason ? evidence(row) : null;
        var label = '';
        if (reason) {
            if (row.reason_source === 'llm') label = 'AI';
            else if (row.reason_origin === 'toss' && row.reason_source === 'stockrise') label = '토스 AI';
            else if (row.reason_kind && KIND_LABEL[row.reason_kind] !== undefined) label = KIND_LABEL[row.reason_kind];
            else if (ev) label = '기사';
        }
        return {
            text: reason || UNKNOWN,
            unknown: !reason,
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
        if (d.link) {
            return '<a class="reason-src" href="' + esc(d.link) + '" target="_blank" rel="noopener nofollow" title="' +
                esc(d.linkTitle || '근거 기사') + '">' + esc(d.label) + ' ↗</a>';
        }
        return '<span class="reason-src reason-src--plain">' + esc(d.label) + '</span>';
    }

    var api = { display: display, sourceHtml: sourceHtml, isTemplate: function (r) { return TEMPLATE_RE.test(String(r || '').trim()); }, UNKNOWN: UNKNOWN };
    // 브라우저(window.OrgoReason)와 Node(텔레그램·발행실 스크립트) 공용
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else window.OrgoReason = api;
})();
