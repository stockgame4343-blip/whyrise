/**
 * public/js/api.js override 캐시 회귀 테스트 —
 * 5분 캐시 · invalidateOverrides · applyLocalOverride(낙관 반영) · getRankings 머지 ·
 * 404=확정 빈 셋 vs 일시 실패(미캐시·fail-open) · stock.js applyOverrideToEvent replace 시맨틱.
 * 운영 코드를 vm 으로 그대로 실행 (fetch 만 스텁).
 *
 *   node scripts/test_api_overrides.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

const fetchLog = [];
const responses = {};   // url 부분문자열 → JSON 데이터 | {__status:N} | {__badjson:true} | '__network__'
let nowMs = Date.now();
class FakeDate extends Date {
    static now() { return nowMs; }
}

function fetchStub(url) {
    const u = String(url);
    fetchLog.push(u);
    const key = Object.keys(responses).find((k) => u.indexOf(k) >= 0);
    if (!key) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    const r = responses[key];
    if (r === '__network__') return Promise.reject(new TypeError('network failure'));
    if (r && r.__promise) return r.__promise;
    if (r && r.__status) {
        return Promise.resolve({ ok: false, status: r.__status, json: () => Promise.resolve({}) });
    }
    if (r && r.__badjson) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('bad json')) });
    }
    return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(JSON.parse(JSON.stringify(r))),
    });
}

const context = { fetch: fetchStub, console: console, Date: FakeDate };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'api.js'), 'utf8'), context);
const WhyAPI = context.WhyAPI;

assert.ok(typeof WhyAPI.getOverrides === 'function', 'getOverrides 노출');
assert.ok(typeof WhyAPI.invalidateOverrides === 'function', 'invalidateOverrides 노출');
assert.ok(typeof WhyAPI.applyLocalOverride === 'function', 'applyLocalOverride 노출');

(async function main() {
    // 1) override fetch + 5분 캐시
    responses['/data/overrides/20260701.json'] = {
        '005930': { rise_reason: '서버 사유', theme_tag: '반도체' },
    };
    const ov1 = await WhyAPI.getOverrides('20260701');
    assert.strictEqual(ov1['005930'].rise_reason, '서버 사유');
    const nAfterFirst = fetchLog.length;
    await WhyAPI.getOverrides('20260701');
    assert.strictEqual(fetchLog.length, nAfterFirst, 'TTL 내 재요청 없어야 함');

    // 2) 낙관 반영 — 같은 날짜 다른 종목 override 보존 + 대상만 갱신 (재요청 없음)
    await WhyAPI.applyLocalOverride('20260701', '000001', { rise_reason: '수동 저장' });
    const ov2 = await WhyAPI.getOverrides('20260701');
    assert.strictEqual(ov2['000001'].rise_reason, '수동 저장');
    assert.strictEqual(ov2['005930'].rise_reason, '서버 사유', '기존 override 보존');
    assert.strictEqual(fetchLog.length, nAfterFirst, '캐시 시드 후 재요청 없어야 함');

    // 3) 삭제 낙관 반영
    await WhyAPI.applyLocalOverride('20260701', '000001', null);
    const ov3 = await WhyAPI.getOverrides('20260701');
    assert.ok(!ov3['000001'], '삭제 즉시 캐시에서 제거');

    // 4) 명시적 무효화 → 재요청
    WhyAPI.invalidateOverrides('20260701');
    await WhyAPI.getOverrides('20260701');
    assert.ok(fetchLog.length > nAfterFirst, 'invalidate 후 재요청 발생');

    // 5) getRankings 가 override 를 머지하는지 (일별 화면 경로)
    responses['stock-rise/master/public/data/20260701.json'] = {
        rankings: [{
            ticker: '005930', name: '삼성전자', market: 'KOSPI',
            change_rate: 11.0, trading_value: 1e12,
            rise_reason: '빌드 원본 사유', theme_tag: '',
        }],
        collected_at: '2026-07-01T16:00:00', is_final: true, mode: 'closing',
    };
    const day = await WhyAPI.getRankings('20260701', 'ALL');
    const row = day.rankings.find((r) => r.ticker === '005930');
    assert.strictEqual(row.rise_reason, '서버 사유', 'override rise_reason 머지');
    assert.strictEqual(row.theme_tag, '반도체', 'override theme_tag 머지');
    assert.strictEqual(row._edited, true);

    // 6) 저장 직후 시나리오: applyLocalOverride → 캐시 무효화 없이도 새 값이 랭킹에 반영
    await WhyAPI.applyLocalOverride('20260701', '005930', { rise_reason: '방금 저장한 사유' });
    const day2 = await WhyAPI.getRankings('20260701', 'ALL');
    const row2 = day2.rankings.find((r) => r.ticker === '005930');
    assert.strictEqual(row2.rise_reason, '방금 저장한 사유', '저장 직후 stale 아님');

    // 7) 404 = 확정 빈 override 셋 — {} 로 캐시 (TTL 내 재요청 없음)
    const beforeMiss = fetchLog.length;
    const ovMiss = await WhyAPI.getOverrides('20260702');
    // WhyAPI 는 vm realm 안에서 실행되므로 host realm 의 {} 와 prototype 이 다르다.
    assert.strictEqual(Object.keys(ovMiss).length, 0, '404 → 빈 객체');
    await WhyAPI.getOverrides('20260702');
    assert.strictEqual(fetchLog.length, beforeMiss + 1, '404 는 유효한 빈 셋으로 캐시');

    // 8) HTTP 500 → reject, 캐시 안 됨 — 복구되면 다음 호출이 실제 값을 가져온다
    responses['/data/overrides/20260703.json'] = { __status: 500 };
    await assert.rejects(WhyAPI.getOverrides('20260703'), /HTTP 500/, '500 은 reject');
    responses['/data/overrides/20260703.json'] = { '005930': { rise_reason: '복구 후 사유' } };
    const ovRecovered = await WhyAPI.getOverrides('20260703');
    assert.strictEqual(ovRecovered['005930'].rise_reason, '복구 후 사유',
        '일시 실패가 확정 빈 셋으로 오캐시되지 않음');

    // 9) JSON 파싱 실패도 reject + 미캐시
    responses['/data/overrides/20260706.json'] = { __badjson: true };
    await assert.rejects(WhyAPI.getOverrides('20260706'), SyntaxError, '깨진 JSON 은 reject');
    responses['/data/overrides/20260706.json'] = { '005930': { rise_reason: 'json 복구' } };
    const ovJsonOk = await WhyAPI.getOverrides('20260706');
    assert.strictEqual(ovJsonOk['005930'].rise_reason, 'json 복구');

    // 10) 네트워크 실패 → getOverrides 는 reject, getRankings 는 base 로 fail-open
    responses['stock-rise/master/public/data/20260704.json'] = {
        rankings: [{
            ticker: '005930', name: '삼성전자', market: 'KOSPI',
            change_rate: 12.0, trading_value: 1e12,
            rise_reason: '빌드 원본 사유', theme_tag: '원본테마',
        }],
        collected_at: '2026-07-04T16:00:00', is_final: true, mode: 'closing',
    };
    responses['/data/overrides/20260704.json'] = '__network__';
    await assert.rejects(WhyAPI.getOverrides('20260704'), /network/, '네트워크 실패는 reject');
    const dayFail = await WhyAPI.getRankings('20260704', 'ALL');
    const rowFail = dayFail.rankings.find((r) => r.ticker === '005930');
    assert.strictEqual(rowFail.rise_reason, '빌드 원본 사유', 'override 일시 실패 → base fail-open');
    assert.ok(!rowFail._edited, 'fail-open 이 admin 편집으로 오인되지 않음');
    // 실패가 캐시되지 않았으므로 override 복구 즉시 랭킹에 반영
    responses['/data/overrides/20260704.json'] = { '005930': { rise_reason: '복구 사유' } };
    const dayOk = await WhyAPI.getRankings('20260704', 'ALL');
    assert.strictEqual(dayOk.rankings.find((r) => r.ticker === '005930').rise_reason, '복구 사유',
        '실패 미캐시 → 복구 즉시 머지');

    // 11) 지움(replace) 시맨틱 — 명시적 빈 theme_tag/note 는 base 값을 지우지 않는다
    responses['stock-rise/master/public/data/20260705.json'] = {
        rankings: [{
            ticker: '005930', name: '삼성전자', market: 'KOSPI',
            change_rate: 10.5, trading_value: 1e12,
            rise_reason: '원본 사유', theme_tag: '원본테마',
        }],
        collected_at: '2026-07-05T16:00:00', is_final: true, mode: 'closing',
    };
    await WhyAPI.applyLocalOverride('20260705', '005930',
        { rise_reason: '수정 사유', theme_tag: '', note: '' });
    const day5 = await WhyAPI.getRankings('20260705', 'ALL');
    const row5 = day5.rankings.find((r) => r.ticker === '005930');
    assert.strictEqual(row5.rise_reason, '수정 사유');
    assert.strictEqual(row5.theme_tag, '원본테마', '지운 테마는 base 테마 유지(빈 값으로 안 덮음)');
    assert.strictEqual(row5._edited, true);

    // 12) stock.js — 방문자 전원 override fan-out(최대 24 날짜 fetch) 제거 확인
    const stockSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'stock.js'), 'utf8');
    assert.ok(stockSrc.indexOf('OVERRIDE_MERGE_MAX_DATES') < 0, '날짜별 fan-out 상수 제거');
    assert.ok(stockSrc.indexOf('mergeOverridesIntoEvents') < 0, '런타임 override 머지 제거');
    assert.ok(stockSrc.indexOf('WhyAPI.getOverrides') < 0, 'stock.js 의 override fetch 호출 없음');

    // 13) stock.js applyOverrideToEvent — replace 시맨틱 (override-pure 영역 추출 실행)
    const rs = stockSrc.indexOf('//#region override-pure');
    const re = stockSrc.indexOf('//#endregion override-pure');
    assert.ok(rs >= 0 && re > rs, 'override-pure 영역 존재');
    const ovCtx = {};
    vm.createContext(ovCtx);
    vm.runInContext(stockSrc.slice(rs, re), ovCtx);
    const applyOverrideToEvent = ovCtx.applyOverrideToEvent;
    assert.ok(typeof applyOverrideToEvent === 'function');

    const ev = {
        date: '20260701', rise_reason: '원본 사유', reason_confidence: 'mid',
        reason_source: 'news', reason_status: 'filled', theme_tag: '원본테마',
    };
    // 1차 저장 — theme+note 포함
    applyOverrideToEvent(ev, { rise_reason: '1차 사유', theme_tag: '새테마', note: '메모1' });
    assert.strictEqual(ev.rise_reason, '1차 사유');
    assert.strictEqual(ev.theme_tag, '새테마');
    assert.strictEqual(ev.note, '메모1');
    assert.strictEqual(ev.pre_override.rise_reason, '원본 사유', '최초 원본 백업');
    // 2차 저장 — theme/note 지움 → 이전 admin 값이 아니라 원본 값/부재 복원 (replace)
    applyOverrideToEvent(ev, { rise_reason: '2차 사유', theme_tag: '', note: '' });
    assert.strictEqual(ev.rise_reason, '2차 사유');
    assert.strictEqual(ev.theme_tag, '원본테마', '지운 테마 → 원본 테마 복원');
    assert.ok(!('note' in ev), '지운 note → 부재 복원');
    assert.strictEqual(ev.pre_override.rise_reason, '원본 사유', '재저장이 백업을 오염시키지 않음');
    assert.strictEqual(ev.pre_override.theme_tag, '원본테마');
    // 삭제 — 전체 원복 + 백업 제거
    applyOverrideToEvent(ev, null);
    assert.strictEqual(ev.rise_reason, '원본 사유');
    assert.strictEqual(ev.reason_source, 'news');
    assert.strictEqual(ev.reason_status, 'filled');
    assert.strictEqual(ev.theme_tag, '원본테마');
    assert.ok(!ev.pre_override, '삭제 후 백업 제거');

    // 14) 저장 전에 시작된 stale fetch 가 늦게 끝나도 낙관 캐시를 덮지 못한다.
    let resolveStale;
    responses['/data/overrides/20260707.json'] = {
        __promise: new Promise(function (resolve) { resolveStale = resolve; }),
    };
    const stalePending = WhyAPI.getOverrides('20260707');
    await Promise.resolve();   // fetchStub 호출까지 진행
    await WhyAPI.applyLocalOverride('20260707', '005930', { rise_reason: '최신 관리자 값' });
    resolveStale({
        ok: true, status: 200,
        json: function () {
            return Promise.resolve({ '005930': { rise_reason: '늦게 온 stale 값' },
                '000001': { rise_reason: '다른 종목 값' } });
        },
    });
    const staleReturn = await stalePending;
    await new Promise(function (resolve) { setImmediate(resolve); });
    assert.strictEqual(staleReturn['005930'].rise_reason, '최신 관리자 값',
        '늦은 이전 fetch 의 호출자 반환값도 최신 낙관 값');
    const raceResult = await WhyAPI.getOverrides('20260707');
    assert.strictEqual(raceResult['005930'].rise_reason, '최신 관리자 값',
        '늦은 이전 fetch 가 낙관 값을 덮지 않음');
    assert.strictEqual(raceResult['000001'].rise_reason, '다른 종목 값',
        '백그라운드 최신화가 다른 ticker 값은 보존');

    // 15) hydration 전 연속 편집 A/B — 모든 로컬 패치와 서버의 다른 ticker 를 합친다.
    let resolveA;
    let resolveB;
    responses['/data/overrides/20260708.json'] = {
        __promise: new Promise(function (resolve) { resolveA = resolve; }),
    };
    await WhyAPI.applyLocalOverride('20260708', '005930', { rise_reason: '편집 A' });
    responses['/data/overrides/20260708.json'] = {
        __promise: new Promise(function (resolve) { resolveB = resolve; }),
    };
    await WhyAPI.applyLocalOverride('20260708', '000001', { rise_reason: '편집 B' });
    const serverResponse = {
        ok: true, status: 200,
        json: function () {
            return Promise.resolve({ '123456': { rise_reason: '서버의 다른 종목' } });
        },
    };
    resolveA(serverResponse);
    resolveB(serverResponse);
    await new Promise(function (resolve) { setImmediate(resolve); });
    const consecutive = await WhyAPI.getOverrides('20260708');
    assert.strictEqual(consecutive['005930'].rise_reason, '편집 A');
    assert.strictEqual(consecutive['000001'].rise_reason, '편집 B');
    assert.strictEqual(consecutive['123456'].rise_reason, '서버의 다른 종목',
        '연속 편집 중 background hydration 결과도 보존');

    // 16) 서버 ack 시 patch 해제 — 이후 다른 세션 수정이 현재 탭에서 가려지지 않는다.
    responses['/data/overrides/20260709.json'] = {
        '005930': { rise_reason: '내 저장값' },
    };
    await WhyAPI.applyLocalOverride('20260709', '005930', { rise_reason: '내 저장값' });
    await new Promise(function (resolve) { setImmediate(resolve); });
    responses['/data/overrides/20260709.json'] = {
        '005930': { rise_reason: '다른 관리자 후속값' },
    };
    nowMs += 6 * 60 * 1000;   // override cache TTL(5분) 경과
    const afterAck = await WhyAPI.getOverrides('20260709');
    assert.strictEqual(afterAck['005930'].rise_reason, '다른 관리자 후속값',
        '서버 ack 뒤에는 다른 세션 변경을 가리지 않음');

    // 17) 서버 ack가 없어도 patch는 15분 안전 상한 뒤 만료된다.
    responses['/data/overrides/20260710.json'] = {
        '005930': { rise_reason: '배포 전 서버값' },
    };
    await WhyAPI.applyLocalOverride('20260710', '005930', { rise_reason: '로컬 임시값' });
    await new Promise(function (resolve) { setImmediate(resolve); });
    responses['/data/overrides/20260710.json'] = {
        '005930': { rise_reason: '서버 최종값' },
    };
    nowMs += 16 * 60 * 1000;
    const afterExpiry = await WhyAPI.getOverrides('20260710');
    assert.strictEqual(afterExpiry['005930'].rise_reason, '서버 최종값',
        '미확인 로컬 patch도 상한 뒤 서버 진실에 양보');

    // 18) 과거 rise-history bake도 pre_override로 삭제/replace 원본을 즉시 복원한다.
    responses['/data/rise-history/20260301.json'] = {
        rankings: [{
            ticker: '005930', name: '삼성전자', market: 'KOSPI', change_rate: 12,
            rise_reason: 'bake된 admin 사유', reason_source: 'admin',
            reason_status: 'edited', theme_tag: 'admin테마', note: 'admin메모',
            pre_override: {
                rise_reason: '과거 원본 사유', reason_source: 'news',
                reason_status: 'filled', theme_tag: '원본테마',
            },
        }],
        collected_at: '', is_final: true, mode: 'backfill', pullbacks: [],
    };
    const oldDay = await WhyAPI.getRankings('20260301', 'ALL');
    const oldRow = oldDay.rankings[0];
    assert.strictEqual(oldRow.rise_reason, '과거 원본 사유');
    assert.strictEqual(oldRow.theme_tag, '원본테마');
    assert.strictEqual(oldRow.reason_source, 'news');
    assert.ok(!oldRow.pre_override, '클라이언트 결과에는 내부 백업 미노출');
    await WhyAPI.applyLocalOverride('20260301', '005930', {
        rise_reason: '과거 최신 수정', theme_tag: '', note: '',
    });
    const oldDayEdited = await WhyAPI.getRankings('20260301', 'ALL');
    assert.strictEqual(oldDayEdited.rankings[0].rise_reason, '과거 최신 수정');
    assert.strictEqual(oldDayEdited.rankings[0].theme_tag, '원본테마',
        '과거 재저장 theme 지움도 원본 복원 후 적용');

    console.log('test_api_overrides: OK (fetch ' + fetchLog.length + '회)');
})().catch(function (err) {
    console.error(err);
    process.exit(1);
});
