'use strict';
// 블로그 딥다이브(blog_deep) 검증 회귀 테스트 — node --test scripts/test_blog_deep.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const B = require('./blog_deep');

const m = { kind: 'A', date: '20261127', stock: { name: '서진시스템', annual_confirmed: [{ period: '2025.12', '매출액_억': 10663 }], rise_history: [] },
    computed_context: ['서진시스템 1,656억 계약은 2025년 매출(1조 663억)의 15.5%예요.'] };
const body = '가'.repeat(1300);
const art = (para, title = '1,656억 수주는 얼마나 큰 숫자일까') => ({ title, summary: '요약', sections: [{ heading: '크기', paragraphs: [para, '{{TABLE_FIN}}', '{{CHART_HISTORY}}', body] }] });

test('재료에 있는 숫자(조 단위 표기 포함)는 통과', () => {
    assert.deepEqual(B.verify(art('계약 1,656억 원은 2025년 매출 1조 663억 원의 15.5%다. 11월 27일 공시.'), m), []);
});
test('재료에 없는 숫자·투자 권유·과장어·인사말은 반려', () => {
    const p = B.verify(art('매출의 23.4%다. 지금이 기회, 매수 추천. 무려 오른다. 안녕하세요'), m).join(' | ');
    assert.match(p, /재료에 없는 숫자: 23\.4/);
    assert.match(p, /투자 권유/);
    assert.match(p, /과장 표현/);
    assert.match(p, /인사말/);
});
test('표·차트 자리표시자가 빠지면 반려', () => {
    const a = art('계약 1,656억.'); a.sections[0].paragraphs = ['계약 1,656억.', body];
    assert.ok(B.verify(a, m).some(x => /자리표시자/.test(x)));
});
