'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { threadsLength, publishText, recordFailure, parseArgs, TEXT_LIMIT } = require('./threads_publish');
const { checkToken, fingerprint } = require('./threads_token');
const { buildDigest } = require('./marketing_digest');
const tg = require('./tg_common');

const DATE = '20260904';
const LINK = 'https://orgo.kr/rise.html?date=20260904&utm_source=threads&utm_medium=social&utm_campaign=daily';
const noSleep = async () => {};

function memLedger(initial = {}) {
    const store = { ...initial };
    return { store, async load(date, ch) { const k = date + '-' + ch; return { k, state: store[k] || {} }; }, async save(rec, state) { store[rec.k] = { ...state }; rec.state = store[rec.k]; } };
}
// 스크립트된 Threads API — 경로별 응답 큐. 함수면 호출, Error 면 throw
function fakeApi(script) {
    const calls = [];
    const api = async (url, token, method = 'GET', fields) => {
        const key = method === 'GET' ? 'status' : url.endsWith('/threads_publish') ? 'publish' : 'create';
        calls.push({ key, url, fields });
        const q = script[key] || [];
        const next = q.length > 1 ? q.shift() : q[0];
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next() : next;
    };
    return { api, calls };
}
const ambiguous = () => Object.assign(new Error('응답 없음(TimeoutError)'), { ambiguous: true });
const rejected = () => Object.assign(new Error('HTTP 400 Invalid parameter (code 100)'), { ambiguous: false });

test('Threads 글자 수: 이모지는 UTF-8 바이트, 한글은 1자', () => {
    assert.equal(threadsLength('가나다'), 3);
    assert.equal(threadsLength('📌가'), 5);
    assert.equal(threadsLength('🇰🇷'), 8);
    assert.equal(threadsLength('⚡'), 3);
    assert.equal(threadsLength('머큐리 +29.8% · 티엠씨'), 16);
});

test('원고: 링크는 본문에 없고 끝줄이 아래 링크 카드를 가리킨다', () => {
    // test_marketing.js 와 같은 최소 하루치(급등 1 + 같은 테마 동반 2)
    const row = { ticker: '005930', name: '삼성전자', theme_tag: '반도체', change_rate: 20, rise_reason: '장비 공급계약 체결', reason_source: 'llm', reason_confidence: 'mid', reason_evidence: [{ title: '삼성전자 장비 공급계약' }], news: [{ title: '삼성전자 장비 공급계약', date: '2026.09.04', link: 'https://example.com/a' }] };
    const day = { date: DATE, is_final: true, rankings: [row, { ticker: '111111', name: '동반A', theme_tag: '반도체', change_rate: 1 }, { ticker: '222222', name: '동반B', theme_tag: '반도체', change_rate: 2 }] };
    const text = buildDigest(day, null).posts.threads.text;
    assert.match(text, /아래 링크에서$/);
    assert.doesNotMatch(text, /댓글|https?:\/\//);
    assert.ok(threadsLength(text) <= TEXT_LIMIT);
});

test('성공: TEXT+link_attachment → 같은 creation_id 로 게시, 같은 날 재실행은 호출 없이 건너뜀', async () => {
    const l = memLedger(), { api, calls } = fakeApi({ create: [{ id: 'c1' }], status: [{ status: 'FINISHED' }], publish: [{ id: 'p1' }] });
    const r = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: l, api, sleep: noSleep });
    assert.equal(r.status, 'published'); assert.equal(r.post_id, 'p1');
    const create = calls.find(c => c.key === 'create'), publish = calls.find(c => c.key === 'publish');
    assert.match(create.url, /\/v1\.0\/me\/threads$/);
    assert.deepEqual(create.fields, { media_type: 'TEXT', text: '본문', link_attachment: LINK });
    assert.deepEqual(publish.fields, { creation_id: 'c1' });
    assert.equal(l.store[DATE + '-threads'].status, 'published');
    const n = calls.length;
    const again = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: l, api, sleep: noSleep });
    assert.equal(again.skipped, true); assert.equal(calls.length, n);
});

test('컨테이너 생성 실패는 1회 재시도', async () => {
    const l = memLedger(), { api, calls } = fakeApi({ create: [rejected(), { id: 'c2' }], status: [{ status: 'FINISHED' }], publish: [{ id: 'p2' }] });
    const r = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: l, api, sleep: noSleep });
    assert.equal(r.status, 'published');
    assert.equal(calls.filter(c => c.key === 'create').length, 2);
});

test('생성 2번 실패 → failed 기록, 다음 자동 실행은 건너뛰고 수동(--retry-failed)만 다시 시도', async () => {
    const l = memLedger(), { api, calls } = fakeApi({ create: [rejected()] });
    const r = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: l, api, sleep: noSleep });
    assert.equal(r.status, 'failed'); assert.equal(r.step, 'create'); assert.ok(!r.skipped);
    const auto = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: l, api, sleep: noSleep });
    assert.equal(auto.skipped, true); assert.equal(calls.length, 2);
    const ok = fakeApi({ create: [{ id: 'c3' }], status: [{ status: 'FINISHED' }], publish: [{ id: 'p3' }] });
    const manual = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: l, api: ok.api, sleep: noSleep, retryFailed: true });
    assert.equal(manual.status, 'published');
});

test('게시 응답이 흐려도 재시도 전 상태가 PUBLISHED 면 두 번 게시하지 않는다', async () => {
    const l = memLedger();
    const { api, calls } = fakeApi({ create: [{ id: 'c4' }], status: [{ status: 'FINISHED' }, { status: 'PUBLISHED' }], publish: [ambiguous()] });
    const r = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: l, api, sleep: noSleep });
    assert.equal(r.status, 'published');
    assert.equal(calls.filter(c => c.key === 'publish').length, 1);
});

test('게시 재시도도 같은 creation_id — 명시적 거절 2번이면 failed, 흐린 응답 + 상태 불명이면 uncertain', async () => {
    const a = fakeApi({ create: [{ id: 'c5' }], status: [{ status: 'FINISHED' }], publish: [rejected()] });
    const r1 = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: memLedger(), api: a.api, sleep: noSleep });
    assert.equal(r1.status, 'failed'); assert.equal(r1.step, 'publish');
    assert.deepEqual(a.calls.filter(c => c.key === 'publish').map(c => c.fields.creation_id), ['c5', 'c5']);

    const b = fakeApi({ create: [{ id: 'c6' }], status: [{ status: 'FINISHED' }, ambiguous()], publish: [ambiguous()] });
    const r2 = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: memLedger(), api: b.api, sleep: noSleep });
    assert.equal(r2.status, 'uncertain');
});

test('지난 실행이 uncertain 이면 컨테이너 상태로 이어간다 — FINISHED 는 같은 컨테이너로 게시, 상태 불명은 보류', async () => {
    const held = { [DATE + '-threads']: { status: 'uncertain', mode: 'text', container_id: 'c7' } };
    const a = fakeApi({ status: [{ status: 'FINISHED' }], publish: [{ id: 'p7' }] });
    const r = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: memLedger(held), api: a.api, sleep: noSleep });
    assert.equal(r.status, 'published');
    assert.equal(a.calls.filter(c => c.key === 'create').length, 0);
    assert.equal(a.calls.find(c => c.key === 'publish').fields.creation_id, 'c7');

    const b = fakeApi({ status: [ambiguous()] });
    const r2 = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: memLedger(held), api: b.api, sleep: noSleep });
    assert.equal(r2.hold, true); assert.equal(b.calls.filter(c => c.key !== 'status').length, 0);
});

test('이미지 경로(marketing_publish.js) 기록은 건드리지 않는다', async () => {
    const { api, calls } = fakeApi({});
    const r = await publishText({ date: DATE, text: '본문', link: LINK, token: 't', ledger: memLedger({ [DATE + '-threads']: { status: 'created', container_id: 'img' } }), api, sleep: noSleep });
    assert.equal(r.hold, true); assert.equal(calls.length, 0);
});

test('원고 단계 실패(500자 초과 등)는 하루 한 번만 기록·알림', async () => {
    const l = memLedger();
    const first = await recordFailure(l, DATE, '본문 520자');
    assert.equal(first.status, 'failed'); assert.ok(!first.skipped);
    const second = await recordFailure(l, DATE, '본문 520자');
    assert.equal(second.skipped, true);
});

test('인자: 날짜·--dry-run·--retry-failed, 모르는 인자는 거부', () => {
    assert.deepEqual(parseArgs(['20261006', '--dry-run']), { dryRun: true, retryFailed: false, date: '20261006' });
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
