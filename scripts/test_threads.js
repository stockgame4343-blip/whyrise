'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { threadsLength, publishPost, publishWithReply, recordFailure, parseArgs, TEXT_LIMIT } = require('./threads_publish');
const { checkToken, fingerprint } = require('./threads_token');
const { buildDigest } = require('./marketing_digest');
const tg = require('./tg_common');

const DATE = '20260904';
const REPLY = '📋 9월 4일 오른 종목과 이유 전체 👉 https://orgo.kr/rise.html?date=20260904&utm_source=threads';
const noSleep = async () => {};

function memLedger(initial = {}) {
    const store = { ...initial };
    return { store, async load(date, ch) { const k = date + '-' + ch; return { k, state: store[k] || {} }; }, async save(rec, state) { store[rec.k] = { ...state }; rec.state = store[rec.k]; } };
}
// 스크립트된 Threads API — 종류별 응답 큐(마지막 값 반복). Error 면 throw
function fakeApi(script) {
    const calls = [];
    const api = async (url, token, method = 'GET', fields) => {
        const key = method === 'GET' ? (url.includes('/me/threads?') ? 'list' : 'status')
            : url.endsWith('/threads_publish') ? 'publish' : fields.reply_to_id ? 'reply' : 'create';
        calls.push({ key, url, fields });
        const q = script[key] || [];
        const next = q.length > 1 ? q.shift() : q[0];
        if (next instanceof Error) throw next;
        return next;
    };
    return { api, calls };
}
const ambiguous = () => Object.assign(new Error('응답 없음(TimeoutError)'), { ambiguous: true });
const rejected = () => Object.assign(new Error('HTTP 400 Invalid parameter (code 100)'), { ambiguous: false });
const post = o => publishPost({ date: DATE, channel: 'threads', fields: { media_type: 'TEXT', text: '본문' }, token: 't', sleep: noSleep, ...o });
const withReply = o => publishWithReply({ date: DATE, text: '본문', reply: REPLY, token: 't', sleep: noSleep, ...o });

test('Threads 글자 수: 이모지는 UTF-8 바이트, 한글은 1자', () => {
    assert.equal(threadsLength('가나다'), 3);
    assert.equal(threadsLength('📌가'), 5);
    assert.equal(threadsLength('🇰🇷'), 8);
    assert.equal(threadsLength('⚡'), 3);
    assert.equal(threadsLength('머큐리 +29.8% · 티엠씨'), 16);
});

test('원고: 본문엔 링크 없이 끝줄이 댓글을 가리키고, 댓글엔 사이트 본 화면(rise.html) 링크', () => {
    // test_marketing.js 와 같은 최소 하루치(급등 1 + 같은 테마 동반 2)
    const row = { ticker: '005930', name: '삼성전자', theme_tag: '반도체', change_rate: 20, rise_reason: '장비 공급계약 체결', reason_source: 'llm', reason_confidence: 'mid', reason_evidence: [{ title: '삼성전자 장비 공급계약' }], news: [{ title: '삼성전자 장비 공급계약', date: '2026.09.04', link: 'https://example.com/a' }] };
    const day = { date: DATE, is_final: true, rankings: [row, { ticker: '111111', name: '동반A', theme_tag: '반도체', change_rate: 1 }, { ticker: '222222', name: '동반B', theme_tag: '반도체', change_rate: 2 }] };
    const th = buildDigest(day, null).posts.threads;
    assert.match(th.text, /댓글 링크에서$/);
    assert.doesNotMatch(th.text, /https?:\/\//);
    assert.match(th.reply, /orgo\.kr\/rise\.html\?date=20260904/);
    assert.doesNotMatch(th.reply, /\/day\//);
    assert.ok(threadsLength(th.text) <= TEXT_LIMIT && threadsLength(th.reply) <= TEXT_LIMIT);
});

test('성공: 본문(링크 없음) → 첫 댓글(reply_to_id=본문 ID), 같은 날 재실행은 호출 없이 건너뜀', async () => {
    const l = memLedger(), { api, calls } = fakeApi({ create: [{ id: 'c1' }], reply: [{ id: 'rc1' }], status: [{ status: 'FINISHED' }], publish: [{ id: 'p1' }, { id: 'r1' }] });
    const r = await withReply({ ledger: l, api });
    assert.equal(r.post.status, 'published'); assert.equal(r.post.post_id, 'p1');
    assert.equal(r.reply.status, 'published'); assert.equal(r.reply.post_id, 'r1');
    const create = calls.find(c => c.key === 'create'), reply = calls.find(c => c.key === 'reply');
    assert.match(create.url, /\/v1\.0\/me\/threads$/);
    assert.deepEqual(create.fields, { media_type: 'TEXT', text: '본문' });
    assert.deepEqual(reply.fields, { media_type: 'TEXT', text: REPLY, reply_to_id: 'p1' });
    assert.deepEqual(calls.filter(c => c.key === 'publish').map(c => c.fields.creation_id), ['c1', 'rc1']);
    assert.equal(l.store[DATE + '-threads'].status, 'published'); assert.equal(l.store[DATE + '-threads-reply'].status, 'published');
    const n = calls.length;
    const again = await withReply({ ledger: l, api });
    assert.equal(again.post.skipped, true); assert.equal(again.reply.skipped, true); assert.equal(calls.length, n);
});

test('본문 게시가 실패하면 댓글을 달지 않는다', async () => {
    const { api, calls } = fakeApi({ create: [rejected()] });
    const r = await withReply({ ledger: memLedger(), api });
    assert.equal(r.post.status, 'failed'); assert.equal(r.reply, null);
    assert.equal(calls.filter(c => c.key === 'reply').length, 0);
});

test('본문은 됐는데 댓글만 실패 → 다음 자동 실행은 둘 다 건너뜀, --retry-failed 는 댓글만 다시', async () => {
    const l = memLedger();
    const a = fakeApi({ create: [{ id: 'c2' }], reply: [rejected()], status: [{ status: 'FINISHED' }], publish: [{ id: 'p2' }] });
    const r = await withReply({ ledger: l, api: a.api });
    assert.equal(r.post.status, 'published'); assert.equal(r.reply.status, 'failed'); assert.equal(r.reply.step, 'create');
    const b = fakeApi({});
    const auto = await withReply({ ledger: l, api: b.api });
    assert.equal(auto.reply.skipped, true); assert.equal(b.calls.length, 0);
    const c = fakeApi({ reply: [{ id: 'rc2' }], status: [{ status: 'FINISHED' }], publish: [{ id: 'r2' }] });
    const manual = await withReply({ ledger: l, api: c.api, retryFailed: true });
    assert.equal(manual.reply.status, 'published');
    assert.equal(c.calls.filter(x => x.key === 'create').length, 0);
    assert.equal(c.calls.find(x => x.key === 'reply').fields.reply_to_id, 'p2');
});

test('본문 ID 를 놓쳐도(상태로만 게시 확인) 최근 게시물에서 같은 본문을 찾아 댓글을 단다', async () => {
    const { api, calls } = fakeApi({ create: [{ id: 'c3' }], reply: [{ id: 'rc3' }], status: [{ status: 'FINISHED' }, { status: 'PUBLISHED' }, { status: 'FINISHED' }],
        publish: [ambiguous(), { id: 'r3' }], list: [{ data: [{ id: 'other', text: '다른 글' }, { id: 'p3', text: '본문' }] }] });
    const r = await withReply({ ledger: memLedger(), api });
    assert.equal(r.post.status, 'published'); assert.equal(r.post.post_id, 'p3');
    assert.equal(calls.find(c => c.key === 'reply').fields.reply_to_id, 'p3');
    assert.equal(r.reply.status, 'published');
});

test('컨테이너 생성 실패는 1회 재시도', async () => {
    const { api, calls } = fakeApi({ create: [rejected(), { id: 'c4' }], status: [{ status: 'FINISHED' }], publish: [{ id: 'p4' }] });
    const r = await post({ ledger: memLedger(), api });
    assert.equal(r.status, 'published');
    assert.equal(calls.filter(c => c.key === 'create').length, 2);
});

test('생성 2번 실패 → failed 기록, 다음 자동 실행은 건너뛰고 수동(--retry-failed)만 다시 시도', async () => {
    const l = memLedger(), { api, calls } = fakeApi({ create: [rejected()] });
    const r = await post({ ledger: l, api });
    assert.equal(r.status, 'failed'); assert.equal(r.step, 'create'); assert.ok(!r.skipped);
    const auto = await post({ ledger: l, api });
    assert.equal(auto.skipped, true); assert.equal(calls.length, 2);
    const ok = fakeApi({ create: [{ id: 'c5' }], status: [{ status: 'FINISHED' }], publish: [{ id: 'p5' }] });
    assert.equal((await post({ ledger: l, api: ok.api, retryFailed: true })).status, 'published');
});

test('게시 응답이 흐려도 재시도 전 상태가 PUBLISHED 면 두 번 게시하지 않는다', async () => {
    const { api, calls } = fakeApi({ create: [{ id: 'c6' }], status: [{ status: 'FINISHED' }, { status: 'PUBLISHED' }], publish: [ambiguous()], list: [{ data: [] }] });
    const r = await post({ ledger: memLedger(), api });
    assert.equal(r.status, 'published');
    assert.equal(calls.filter(c => c.key === 'publish').length, 1);
});

test('게시 재시도도 같은 creation_id — 명시적 거절 2번이면 failed, 흐린 응답 + 상태 불명이면 uncertain', async () => {
    const a = fakeApi({ create: [{ id: 'c7' }], status: [{ status: 'FINISHED' }], publish: [rejected()] });
    const r1 = await post({ ledger: memLedger(), api: a.api });
    assert.equal(r1.status, 'failed'); assert.equal(r1.step, 'publish');
    assert.deepEqual(a.calls.filter(c => c.key === 'publish').map(c => c.fields.creation_id), ['c7', 'c7']);

    const b = fakeApi({ create: [{ id: 'c8' }], status: [{ status: 'FINISHED' }, ambiguous()], publish: [ambiguous()] });
    assert.equal((await post({ ledger: memLedger(), api: b.api })).status, 'uncertain');
});

test('지난 실행이 uncertain 이면 컨테이너 상태로 이어간다 — FINISHED 는 같은 컨테이너로 게시, 상태 불명은 보류', async () => {
    const held = { [DATE + '-threads']: { status: 'uncertain', mode: 'text', container_id: 'c9' } };
    const a = fakeApi({ status: [{ status: 'FINISHED' }], publish: [{ id: 'p9' }] });
    const r = await post({ ledger: memLedger(held), api: a.api });
    assert.equal(r.status, 'published');
    assert.equal(a.calls.filter(c => c.key === 'create').length, 0);
    assert.equal(a.calls.find(c => c.key === 'publish').fields.creation_id, 'c9');

    const b = fakeApi({ status: [ambiguous()] });
    const r2 = await post({ ledger: memLedger(held), api: b.api });
    assert.equal(r2.hold, true); assert.equal(b.calls.filter(c => c.key !== 'status').length, 0);
});

test('이미지 경로(marketing_publish.js) 기록은 건드리지 않는다', async () => {
    const { api, calls } = fakeApi({});
    const r = await post({ ledger: memLedger({ [DATE + '-threads']: { status: 'created', container_id: 'img' } }), api });
    assert.equal(r.hold, true); assert.equal(calls.length, 0);
});

test('게시 전 단계 실패(500자 초과 등)는 하루 한 번만 기록·알림', async () => {
    const l = memLedger();
    const first = await recordFailure(l, DATE, 'threads', '본문 520자');
    assert.equal(first.status, 'failed'); assert.ok(!first.skipped);
    assert.equal((await recordFailure(l, DATE, 'threads', '본문 520자')).skipped, true);
});

test('인자: 날짜·--dry-run·--retry-failed·--preview-dm, 모르는 인자는 거부', () => {
    assert.deepEqual(parseArgs(['20261006', '--dry-run']), { dryRun: true, retryFailed: false, previewDm: false, date: '20261006' });
    assert.equal(parseArgs(['--preview-dm']).dryRun, true);
    assert.equal(parseArgs([]).date, tg.ymdKst());
    assert.throws(() => parseArgs(['--publish']));
});

// ── 토큰 만료 관리 ──
const NOW = Date.UTC(2026, 9, 6, 7, 30);
const SEC = ms => Math.floor(ms / 1000);
const DAY = 86400000;
const tokenEnv = extra => ({ THREADS_ACCESS_TOKEN: 'old-token', THREADS_SECRET_PAT: 'pat', GITHUB_REPOSITORY: 'o/r', ...extra });
const valid = days => async () => ({ is_valid: true, expires_at: SEC(NOW + days * DAY), issued_at: SEC(NOW - 30 * DAY) });

test('토큰: 10일 넘게 남으면 갱신 안 함, 바뀐 게 없으면 기록도 안 함', async () => {
    let refreshed = 0;
    const l = memLedger({ 'threads-token': { fingerprint: fingerprint('old-token'), expires_at: SEC(NOW + 40 * DAY), issued_at: SEC(NOW - 30 * DAY) } });
    let saves = 0; const save = l.save; l.save = async (...a) => { saves++; return save(...a); };
    const r = await checkToken({ env: tokenEnv(), ledger: l, nowMs: NOW, debugToken: valid(40), refreshToken: async () => { refreshed++; } });
    assert.equal(r.status, 'ok'); assert.equal(r.days_left, 40); assert.equal(refreshed, 0); assert.equal(saves, 0);
});

test('토큰: 10일 이하면 갱신 → 새 토큰을 시크릿에 저장하고 새 만료일 기록(토큰 값은 기록 안 함)', async () => {
    const l = memLedger(), saved = [];
    const r = await checkToken({ env: tokenEnv(), ledger: l, nowMs: NOW, debugToken: valid(9),
        refreshToken: async () => ({ access_token: 'new-token', expires_in: 60 * 86400 }), saveSecret: v => saved.push(v) });
    assert.equal(r.status, 'refreshed'); assert.equal(r.days_left, 60);
    assert.deepEqual(saved, ['new-token']);
    const st = l.store['threads-token'];
    assert.equal(st.fingerprint, fingerprint('new-token')); assert.equal(st.expires_at, SEC(NOW) + 60 * 86400);
    assert.doesNotMatch(JSON.stringify(st), /new-token|old-token/);
    // 갱신 직후 옛 토큰을 든 실행은 다시 갱신하지 않는다
    const again = await checkToken({ env: tokenEnv(), ledger: l, nowMs: NOW + 60000, debugToken: valid(9), refreshToken: async () => { throw Error('should not refresh'); } });
    assert.equal(again.note, 'refreshed_recently');
});

test('토큰: PAT 없음·갱신 실패·무효 토큰은 알림, 같은 종류는 하루 한 번', async () => {
    const l = memLedger();
    const noPat = await checkToken({ env: tokenEnv({ THREADS_SECRET_PAT: '' }), ledger: l, nowMs: NOW, debugToken: valid(5) });
    assert.equal(noPat.kind, 'no_pat'); assert.ok(noPat.alert);
    const repeat = await checkToken({ env: tokenEnv({ THREADS_SECRET_PAT: '' }), ledger: l, nowMs: NOW, debugToken: valid(5) });
    assert.equal(repeat.kind, 'no_pat'); assert.equal(repeat.alert, null);

    const fail = await checkToken({ env: tokenEnv(), ledger: memLedger(), nowMs: NOW, debugToken: valid(5), refreshToken: async () => { throw Error('HTTP 400'); } });
    assert.equal(fail.kind, 'refresh_failed'); assert.ok(fail.alert);

    const invalid = await checkToken({ env: tokenEnv(), ledger: memLedger(), nowMs: NOW, debugToken: async () => ({ is_valid: false, expires_at: 0, issued_at: 0 }) });
    assert.equal(invalid.kind, 'invalid');

    const saveFail = await checkToken({ env: tokenEnv(), ledger: memLedger(), nowMs: NOW, debugToken: valid(5),
        refreshToken: async () => ({ access_token: 'n', expires_in: 100 }), saveSecret: () => { throw Error('gh 403'); } });
    assert.equal(saveFail.kind, 'save_failed');
});

test('토큰: 없으면 아무것도 하지 않는다, 단기 토큰(1시간)은 갱신 시도 없이 교환 필요 알림', async () => {
    assert.equal((await checkToken({ env: {}, ledger: memLedger() })).status, 'no_token');
    const r = await checkToken({ env: tokenEnv(), ledger: memLedger(), nowMs: NOW,
        debugToken: async () => ({ is_valid: true, expires_at: SEC(NOW + 3000000), issued_at: SEC(NOW - 600000) }),
        refreshToken: async () => { throw Error('should not refresh'); } });
    assert.equal(r.kind, 'short_lived'); assert.ok(r.alert);
});
