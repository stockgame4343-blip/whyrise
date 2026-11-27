'use strict';
// 텔레그램 '왜 중요한가'(insight) 회귀 테스트 — node --test scripts/test_insight.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const I = require('./insight');
const ed = require('./tg_editorial');

// 25거래일 지수: 큰 반등 4번(다 5거래일 뒤 더 낮음) 뒤 마지막 날 +8%
function series() {
    const rates = [4.5, -1, -1, -1, -1, -1, 0.5, 4.4, -1, -1, -1, -1, -1, 0.2, 4.6, -1, -1, -1, -1, -1, 4.8, -1, -1, -1, -1, -1, 0.3, 8.1];
    let c = 1000; const out = [];
    rates.forEach((r, i) => { c = c * (1 + r / 100); out.push({ date: '202610' + String(i + 1).padStart(2, '0'), close: c, rate: r }); });
    return out;
}

test('지수: 구간 안 최대면 "최근 N거래일 중", 같은 방향 큰 날의 5거래일 뒤 성적을 붙인다', () => {
    const s = series(), last = s[s.length - 1].date;
    const line = I.indexLine('코스닥', s, last);
    assert.match(line, /^코스닥 \+8\.1%는 최근 28거래일 중 가장 큰 하루 상승이에요\./);
    assert.match(line, /최근 \+4% 이상 오른 4번은 모두 5거래일 뒤 그날보다 낮았어요/);
    assert.equal(I.indexLine('코스닥', s, s[2].date), '');   // ±3% 미만이면 아무 말도 안 한다
});

test('계약: 단일 계약액만 읽고(누적 제외) 확정 연매출 대비 5% 이상만 말한다', () => {
    assert.equal(I.contractEok('블룸에너지향 1656억 SOFC 공급계약 체결'), 1656);
    assert.equal(I.contractEok('2,300억원 규모 공급계약 체결'), 2300);
    assert.equal(I.contractEok('1.2조 규모 수주'), 12000);
    assert.ok(Number.isNaN(I.contractEok('블룸에너지향 누적 수주 3500억 돌파')));
    assert.ok(Number.isNaN(I.contractEok('3분기 매출액 121억')));
    assert.equal(I.contractLine('서진시스템', 1656, { year: '2025', eok: 10663 }), '서진시스템 1,656억 계약은 2025년 매출(1조 663억)의 15.5%예요.');
    assert.equal(I.contractLine('큰회사', 100, { year: '2025', eok: 10000 }), '');
});

test('짧은 지수 한 줄: 최대 여부 + 앞선 같은 방향 큰 날의 5거래일 뒤 (범위 숫자 없이)', () => {
    const s = series(), last = s[s.length - 1].date;
    assert.equal(I.indexLine('코스닥', s, last, true), '코스닥 +8.1%, 최근 28거래일 중 최대 상승. 앞서 +4% 넘게 오른 4번은 5거래일 뒤 모두 더 낮았어요.');
});

test('짧은 마감 캡션: 해석은 딱 한 줄, 기존 캡션보다 짧고 기존 캡션에는 해석 블록이 없다', () => {
    const rows = [['000001', '가', 29.9], ['000002', '나', 25], ['000003', '다', 20], ['000004', '라', 15]].map(([ticker, name, rate]) =>
        ({ ticker, name, change_rate: rate, trading_value: 1e11, theme_tag: '로봇', rise_reason: name + ' 100억 공급계약 체결', reason_source: 'news_extract', reason_kind: 'catalyst' }));
    const day = { date: '20261127', is_final: true, rankings: rows };
    const ins = { lines: ['긴 설명'], short: '코스닥 +8.1%, 최근 60거래일 중 최대 상승.', pick: '가 100억 계약은 2025년 매출(1,000억)의 10.0%예요.' };
    const full = ed.daily('20261127', null, null, {}, day, null, []);
    const compact = ed.dailyCompact('20261127', null, null, {}, day, null, [], ins);
    assert.doesNotMatch(full, /💡/);
    assert.equal((compact.match(/💡/g) || []).length, 1);
    assert.match(compact, /💡 코스닥 \+8\.1%, 최근 60거래일 중 최대 상승\./);
    assert.doesNotMatch(compact, /긴 설명|📎|공유/);
    assert.ok(compact.length < full.length, compact.length + ' < ' + full.length);
});
