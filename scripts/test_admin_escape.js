/**
 * public/admin.html referrer 싱크 XSS 회귀 테스트 (stdlib only, DOM·네트워크 없음).
 *
 * 소스 문자열 존재 검사가 아니라, 페이지 인라인 스크립트에서 escHtml 함수와
 * referrer 렌더 문장(var refs = ...)을 그대로 추출해 Node vm 에서 실제 실행한다.
 * 악성 host 가 렌더 결과에 raw 마크업으로 나타나면 실패.
 *
 * 실행: node scripts/test_admin_escape.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

// marker 에서 시작하는 function 선언을 중괄호 균형으로 끝까지 추출
function extractFunction(src, marker) {
    const start = src.indexOf(marker);
    if (start < 0) throw new Error('추출 실패(admin.html 구조 변경?): ' + marker);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error('중괄호 불균형: ' + marker);
}

// marker 에서 시작하는 문장을 괄호 깊이 0 의 세미콜론까지 추출
function extractStatement(src, marker) {
    const start = src.indexOf(marker);
    if (start < 0) throw new Error('추출 실패(admin.html 구조 변경?): ' + marker);
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === ';' && depth === 0) return src.slice(start, i + 1);
    }
    throw new Error('문장 끝(;) 미발견: ' + marker);
}

const escHtmlSrc = extractFunction(html, 'function escHtml');
const refsSrc = extractStatement(html, 'var refs =');

const context = vm.createContext({});
vm.runInContext(
    escHtmlSrc + '\nfunction renderRefs(j) {\n' + refsSrc + '\nreturn refs;\n}',
    context, { filename: 'admin-inline.js' }
);

// 1) escHtml 단위 — HTML 특수문자 5종 전부 치환, null/undefined 는 빈 문자열
assert.strictEqual(context.escHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
assert.strictEqual(context.escHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
assert.strictEqual(context.escHtml(null), '');
assert.strictEqual(context.escHtml(undefined), '');

// 2) referrer 렌더 — 악성 host 는 결과 문자열에 raw 로 존재할 수 없다
const IMG_PAYLOAD = '<img src=x onerror=alert(1)>';
const out = context.renderRefs({ referrers: [
    { host: IMG_PAYLOAD, count: 3 },
    { host: '"onmouseover=alert(1)//', count: 2 },
    { host: 'news.naver.com', count: 1 },
] });
assert.ok(!out.includes(IMG_PAYLOAD), 'img 페이로드가 raw 로 렌더됨: ' + out);
assert.ok(!out.includes('<img'), '이스케이프 누락 — <img 태그 생성됨');
assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), '이스케이프된 페이로드 없음');
assert.ok(out.includes('&quot;onmouseover=alert(1)//'), '따옴표 이스케이프 누락');
assert.ok(out.includes('<span>news.naver.com</span>'), '정상 host 렌더 회귀');

// 3) tripwire — 신뢰 템플릿 태그(ul/li/span/b)를 걷어낸 뒤 raw <> 가 남으면 escape 경로 이탈
const stripped = out.replace(/<\/?(ul|li|span|b)(\s[^>]*)?>/g, '');
assert.ok(!/[<>]/.test(stripped), '템플릿 외 raw 마크업 발견: ' + stripped);

// 4) count 는 Number 강제 — 문자열 페이로드는 0 으로 무력화
const outCount = context.renderRefs({
    referrers: [{ host: 'a.com', count: '<script>alert(1)</script>' }],
});
assert.ok(outCount.includes('<b>0</b>'), 'count 숫자 강제 회귀: ' + outCount);
assert.ok(!outCount.includes('<script'), 'count 경유 마크업 주입');

// 5) 유입 없음 fallback 분기 유지
const empty = context.renderRefs({ referrers: [] });
assert.ok(/^<p /.test(empty), '빈 referrers fallback 회귀: ' + empty);

console.log('OK — admin.html referrer 이스케이프 회귀 테스트 통과');
