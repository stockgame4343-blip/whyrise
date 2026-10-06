'use strict';
// 저녁 운영 점검(ops_check.js) — 빠진 게 있을 때만 운영자 DM, 빌드가 없으면 한 줄로 이유만
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspect, report } = require('./ops_check');
const tg = require('./tg_common');

const D = '20261006';
function repo(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
    for (const [p, v] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
        fs.writeFileSync(path.join(root, p), JSON.stringify(v));
    }
    return root;
}
const ALL = {
    [`public/data/rise-history/${D}.json`]: { date: D, is_final: true, rankings: [] },
    'public/data/_telegram-posted.json': { last: D },
    [`public/marketing/${D}/digest.json`]: { date: D },
    [`.marketing-state/${D}-threads.json`]: { status: 'published', post_id: '1' },
    [`.marketing-state/${D}-blog-note.json`]: { status: 'sent' },
};

test('다 나간 날은 알림 없음', () => {
    const s = inspect(D, repo(ALL));
    assert.deepEqual(s, { built: true, closePosted: true, manuscript: true, threads: 'published', threadsError: '', blogNoted: true });
    assert.deepEqual(report(D, s, { autopublish: true }), []);
});

test('마감 빌드가 없으면 이유 한 줄 — 재실행·진행 중·업스트림 미확정·수동 필요', () => {
    const s = inspect(D, repo({ 'public/data/_telegram-posted.json': { last: '20261002' } }));
    assert.equal(s.built, false); assert.equal(s.closePosted, false);
    const r = o => report(D, s, { autopublish: true, ...o });
    assert.equal(r({ rebuilt: true }).length, 2);
    assert.match(r({ rebuilt: true })[0], /10\/6 저녁 발행 점검 — 아직 아무것도/);
    assert.match(r({ rebuilt: true })[1], /다시 걸었어요/);
    assert.match(r({ buildRunning: true })[1], /도는 중/);
    assert.match(r({ upstreamFinal: false })[1], /업스트림.*확정 전/);
    assert.match(r({ upstreamFinal: true })[1], /incremental 로 실행/);
});

test('쓰레드 실패·블로그 알림 누락은 짚고, 된 것은 ✅ 로 같이 보여 준다', () => {
    const files = { ...ALL, [`.marketing-state/${D}-threads.json`]: { status: 'failed', error: 'OAuthException 190' } };
    delete files[`.marketing-state/${D}-blog-note.json`];
    const lines = report(D, inspect(D, repo(files)), { autopublish: true });
    assert.match(lines[0], /빠진 게 있어요/);
    assert.ok(lines.includes('✅ 텔레그램 마감 정리'));
    assert.ok(lines.some(l => /쓰레드 발행 실패 — OAuthException 190/.test(l)));
    assert.ok(lines.includes('✅ 블로그 원고 준비'));
    assert.ok(lines.some(l => /알림이 안 나갔어요/.test(l)));
});

test('원고 단계가 도는 중이면 쓰레드·블로그는 대기로 보고, 마감 정리만 따진다', () => {
    const files = { ...ALL };
    delete files[`public/marketing/${D}/digest.json`]; delete files[`.marketing-state/${D}-threads.json`];
    const s = inspect(D, repo(files));
    assert.deepEqual(report(D, s, { autopublish: true, marketingRunning: true }), []);
    assert.equal(report(D, { ...s, closePosted: false }, { autopublish: true, marketingRunning: true }).length, 3);
});

test('쓰레드 자동 발행이 꺼져 있으면 그걸 알려 준다', () => {
    const lines = report(D, inspect(D, repo(ALL)), { autopublish: false });
    assert.ok(lines.some(l => /THREADS_AUTOPUBLISH/.test(l)));
});

test('운영자 DM chat id — 둘 중 하나만 있어도 가고, 공개 채널은 쓰지 않는다', () => {
    assert.equal(tg.operatorChat({ THREADS_ALERT_CHAT_ID: '1' }), '1');
    assert.equal(tg.operatorChat({ TELEGRAM_ADMIN_CHAT_ID: '2' }), '2');
    assert.equal(tg.operatorChat({ THREADS_ALERT_CHAT_ID: '1', TELEGRAM_ADMIN_CHAT_ID: '2' }), '1');
    assert.equal(tg.operatorChat({ THREADS_ALERT_CHAT_ID: '1', TELEGRAM_ADMIN_CHAT_ID: '2' }, 'admin'), '2');
    assert.equal(tg.operatorChat({ TELEGRAM_CHAT_ID: '-100' }), '');
});

test('운영 DM 은 전용 delivery_key 로 — 저녁 복기의 순번 키(워크플로:1)와 겹치지 않게', () => {
    const { dmKey } = require('./ops_check');
    assert.equal(dmKey(D, 0), 'ops-check:20261006:0');
    assert.notEqual(dmKey(D, 0), dmKey(D, 1));
    const src = fs.readFileSync(path.join(__dirname, 'ops_check.js'), 'utf8');
    assert.match(src, /sendMessage\([^)]*delivery_key: dmKey\(/);
});
