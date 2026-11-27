'use strict';
// 상류 끊김 감시(upstream_watch) 회귀 테스트 — node --test scripts/test_upstream_watch.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const W = require('./upstream_watch');

test('있어야 할 확정일: 거래일 17시 뒤 = 오늘, 그 전·주말·휴일 = 직전 거래일', () => {
    assert.equal(W.expectedDate('20261127', '19:00'), '20261127');
    assert.equal(W.expectedDate('20261127', '08:30'), '20261126');
    assert.equal(W.expectedDate('20261128', '19:00'), '20261127');   // 토요일
    assert.equal(W.expectedDate('20261130', '08:30'), '20261127');   // 월요일 아침 → 금요일
    assert.equal(W.expectedDate('20261225', '19:00'), '20261224');   // 성탄절 휴장
});

test('10/22 이후 멈춤 재현: 11/26 저녁 기준 25거래일, 상류 연속 실패와 함께 알린다', () => {
    const lag = W.tradingDaysBetween('20261022', '20261126');
    assert.equal(lag, 25);
    const lines = W.report('20261126', { expected: '20261126', latest: '20261022', final: '20261022', lag,
        runs: { failures: 40, lastSuccess: '2026-10-22T12:55:21Z', lastUrl: 'https://github.com/x/runs/1' } });
    assert.match(lines[0], /25거래일째/);
    assert.ok(lines.some(l => /40회 연속 실패 — 마지막 성공 2026-10-22/.test(l)));
});

test('정상(지연 0)이면 아무것도 보내지 않는다', () => {
    assert.deepEqual(W.report('20261127', { expected: '20261127', final: '20261127', lag: 0 }), []);
});
