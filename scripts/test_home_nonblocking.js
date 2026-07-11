/**
 * public/js/home.js 비차단 렌더 + 라이브 단일 비행 회귀 테스트 —
 * ① 공식 rankings 도착 즉시 렌더 (/api/marketmap 이 영영 안 와도 로딩 상태 금지)
 *    + 선조회 미정착 동안 visibilitychange 가 두 번째 라이브 호출을 시작하지 못함 (단일 비행)
 * ② marketmap 실패해도 초기 화면 유지 + 즉시 재호출 없이 LIVE_RETRY_MS 예약
 *    (getLiveMarketmap 이 내부에서 이미 1회 재시도하므로)
 * ③ 라이브 도착(같은 거래일) 시 overlay 재렌더 + LIVE_POLL_MS 폴링 예약
 * ④ 장초반 갭 뷰 정책 보존 (live.date > build date → '오늘 집계 준비 중')
 *    + 섹터맵 진행 중 fetch 공유 — 선적재·갭 뷰가 중복 요청하지 않음
 * ⑤ 07:59 요청이 08~09시 NXT 리드인 중 도착 → 응답 폐기 + 리드인 재확인만 예약
 * ⑥ rankings 미도착 상태에선 visibilitychange 가 라이브를 시작/렌더하지 않음
 * 운영 코드를 vm 으로 그대로 실행 (DOM·WhyAPI·시계·타이머 스텁).
 * 타이머는 수동 발화, 시계는 주입 Date — 실제 대기 없음(플레이크 없는 결정적 실행).
 *
 *   node scripts/test_home_nonblocking.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const CORE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'report-core.js'), 'utf8');
const HOME_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'home.js'), 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'public', 'data', 'rise-history', '20260629.json'), 'utf8'));

// home.js 의 상수와 일치해야 함 — 예약 지연 검증용
const LIVE_POLL_MS = 15 * 1000;
const LIVE_RETRY_MS = 30 * 1000;
const NXT_LEADIN_RECHECK_MS = 60 * 1000;

// 평일 장중(2026-06-30 화 10:00 KST) 고정 — NXT 리드인/주말 분기 플레이크 방지
const FIXED_NOW = Date.UTC(2026, 5, 30, 1, 0, 0);

let unhandled = null;
process.on('unhandledRejection', function (err) { unhandled = err; });

function makeEl(id) {
    const classes = new Set();
    return {
        id: id, innerHTML: '', textContent: '', style: {}, href: '', hidden: false,
        classList: {
            add: function () { for (var i = 0; i < arguments.length; i++) classes.add(arguments[i]); },
            remove: function () { for (var i = 0; i < arguments.length; i++) classes.delete(arguments[i]); },
        },
        _classes: classes,
        setAttribute: function () {}, getAttribute: function () { return null; },
        addEventListener: function () {},
    };
}

const RENDER_IDS = ['home2MarketStatus', 'home2Date', 'home2UpdatedAt', 'home2StatStocks',
    'home2StatLimit', 'home2HeroLeader', 'home2SectorFeature', 'home2ThemeFeature',
    'home2SectorAction', 'home2ThemeAction', 'home6WhyList'];

// 수동 발화 가짜 타이머 — 콜백을 등록만 하고 실행하지 않는다. fire(delay)로 결정적 발화.
function makeTimers() {
    const pending = new Map();   // id → { fn, delay }
    let seq = 1;
    return {
        set: function (fn, delay) {
            const id = seq++;
            pending.set(id, { fn: fn, delay: Number(delay) || 0 });
            return id;
        },
        clear: function (id) { pending.delete(id); },
        delays: function () {
            return Array.from(pending.values()).map(function (t) { return t.delay; });
        },
        size: function () { return pending.size; },
        // 해당 지연의 가장 오래된 타이머 1개를 발화. 없으면 false.
        fire: function (delay) {
            for (const entry of pending) {
                if (entry[1].delay === delay) {
                    pending.delete(entry[0]);
                    entry[1].fn();
                    return true;
                }
            }
            return false;
        },
    };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
    return { promise: promise, resolve: resolve, reject: reject };
}

// opts: { nowUtc: 시계 시작값(UTC ms), fetch: 정적 fetch 스텁 }
function makeEnv(whyApi, opts) {
    opts = opts || {};
    const els = {};
    RENDER_IDS.forEach(function (id) { els[id] = makeEl(id); });
    const clock = { now: opts.nowUtc || FIXED_NOW };
    class EnvDate extends Date {
        constructor(...args) {
            if (args.length === 0) super(clock.now);
            else super(...args);
        }
        static now() { return clock.now; }
    }
    const timers = makeTimers();
    const listeners = {};
    const documentStub = {
        addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        getElementById: function (id) { return els[id] || null; },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        visibilityState: 'visible',
        documentElement: {
            getAttribute: function () { return null; },
            setAttribute: function () {}, removeAttribute: function () {},
            classList: { add: function () {}, remove: function () {} },
        },
    };
    const context = {
        document: documentStub,
        window: { addEventListener: function () {}, setInterval: function () { return 0; }, location: {} },
        fetch: opts.fetch || function () { return Promise.reject(new Error('static fetch 미사용')); },
        setTimeout: timers.set,
        clearTimeout: timers.clear,
        setInterval: function () { return 0; },
        clearInterval: function () {},
        Date: EnvDate,
        console: console,
        WhyAPI: whyApi,
    };
    vm.createContext(context);
    vm.runInContext(CORE_JS, context);
    vm.runInContext(HOME_JS, context);
    (listeners.DOMContentLoaded || []).forEach(function (fn) { fn(); });
    return {
        els: els,
        timers: timers,
        clock: clock,
        setVisibility: function (value) {
            documentStub.visibilityState = value;
            (listeners.visibilitychange || []).forEach(function (fn) { fn(); });
        },
    };
}

function settle(rounds) {
    let p = Promise.resolve();
    for (let i = 0; i < (rounds || 8); i++) {
        p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
    }
    return p;
}

function baseRankingsResponse() {
    return {
        rankings: FIXTURE.rankings,
        pullbacks: [], collected_at: '2026-06-29T16:00:00',
        is_final: true, mode: 'closing',
    };
}

function baseApi(overrides) {
    return Object.assign({
        getDates: function () { return Promise.resolve(['20260629']); },
        getRankings: function () { return Promise.resolve(baseRankingsResponse()); },
        getLiveMarketmap: function () { return new Promise(function () {}); },   // 영영 pending
    }, overrides || {});
}

function assertRendered(els, label) {
    assert.notStrictEqual(els.home2Date.textContent, '데이터 연결 지연', label + ': 실패 화면 아님');
    assert.ok(/2026년 6월 29일/.test(els.home2Date.textContent), label + ': 날짜 렌더 — ' + els.home2Date.textContent);
    assert.ok(/^\d+개$/.test(els.home2StatStocks.textContent), label + ': 급등 종목 수 렌더 — "' + els.home2StatStocks.textContent + '"');
    assert.ok(els.home2HeroLeader.innerHTML.length > 0, label + ': 대장 카드 렌더');
    assert.ok(els.home6WhyList.innerHTML.length > 0, label + ': WHY 리스트 렌더');
    assert.ok(!els.home2MarketStatus._classes.has('is-delayed'), label + ': is-delayed 아님');
}

function liveMapFromFixture(n) {
    const map = {};
    FIXTURE.rankings.slice(0, n || 20).forEach(function (r) {
        map[r.ticker] = {
            name: r.name, market: r.market,
            change_rate: (Number(r.change_rate) || 0) + 1.0,
            close_price: r.close_price, trading_value: r.trading_value,
            market_cap: Math.round((Number(r.market_cap) || 0) / 1e8),
        };
    });
    return map;
}

(async function main() {
    // ① marketmap 영영 pending — rankings 만으로 즉시 렌더 + 선조회 단일 비행
    {
        let liveCalls = 0;
        const env = makeEnv(baseApi({
            getLiveMarketmap: function () { liveCalls++; return new Promise(function () {}); },
        }));
        await settle();
        assertRendered(env.els, '시나리오1(라이브 pending)');
        assert.strictEqual(liveCalls, 1, '시나리오1: 선조회 1회 시작');
        // 선조회 A 가 미정착인 동안 탭 전환 — 두 번째 호출 B 를 시작하면 안 된다
        env.setVisibility('hidden');
        env.setVisibility('visible');
        await settle();
        assert.strictEqual(liveCalls, 1,
            '시나리오1: 선조회 pending 중 visibilitychange 가 라이브 호출을 중복하지 않음');
        assert.strictEqual(env.timers.size(), 0, '시나리오1: 선조회 정착 전 타이머 미등록');
    }

    // ② marketmap 실패(즉시 reject) — 초기 화면 유지 + 즉시 재호출 금지 + LIVE_RETRY_MS 예약
    {
        let liveCalls = 0;
        const env = makeEnv(baseApi({
            getLiveMarketmap: function () {
                liveCalls++;
                return Promise.reject(new Error('marketmap down'));
            },
        }));
        await settle();
        assertRendered(env.els, '시나리오2(라이브 실패)');
        assert.strictEqual(liveCalls, 1,
            '시나리오2: 실패 직후 즉시 재호출 없음(헬퍼가 내부 재시도 전담)');
        assert.deepStrictEqual(env.timers.delays(), [LIVE_RETRY_MS],
            '시나리오2: LIVE_RETRY_MS 재시도 예약 — ' + JSON.stringify(env.timers.delays()));
        // 예약된 재시도 발화 → 그때 비로소 2번째 호출, 재실패 시 다시 예약
        assert.ok(env.timers.fire(LIVE_RETRY_MS), '시나리오2: 재시도 타이머 발화');
        await settle();
        assert.strictEqual(liveCalls, 2, '시나리오2: 재시도 타이머 발화 후에만 재호출');
        assert.deepStrictEqual(env.timers.delays(), [LIVE_RETRY_MS], '시나리오2: 재실패 → 재예약');
        assertRendered(env.els, '시나리오2(재실패 후에도 초기 화면 유지)');
    }

    // ③ 라이브 도착(같은 거래일) — overlay 재렌더 + 폴링 예약
    {
        let liveCalls = 0;
        const env = makeEnv(baseApi({
            getLiveMarketmap: function () {
                liveCalls++;
                return Promise.resolve({
                    map: liveMapFromFixture(), date: '20260629',
                    updated_at: '2026-06-29T14:33:00', market_status: 'CLOSE', count: 20,
                });
            },
        }));
        await settle();
        assertRendered(env.els, '시나리오3(라이브 overlay)');
        assert.ok(/14:33/.test(env.els.home2UpdatedAt.textContent),
            '시나리오3: 라이브 updated_at 반영 — ' + env.els.home2UpdatedAt.textContent);
        assert.strictEqual(liveCalls, 1, '시나리오3: 선조회 1회로 충분');
        assert.deepStrictEqual(env.timers.delays(), [LIVE_POLL_MS],
            '시나리오3: overlay 후 LIVE_POLL_MS 폴링 예약');
    }

    // ④ 장초반 갭(live.date > 빌드 최신일, 오늘 빌드 404) — 잠정 뷰 + 섹터맵 fetch 단일화
    {
        let sectorFetchCalls = 0;
        const sectorFetch = deferred();
        let todayBuildCalls = 0;
        const env = makeEnv(baseApi({
            getRankings: function (date) {
                if (date === '20260630') {
                    todayBuildCalls++;
                    return Promise.reject(new Error('HTTP 404'));   // 오늘 빌드 미도착
                }
                return Promise.resolve(baseRankingsResponse());
            },
            getLiveMarketmap: function () {
                return Promise.resolve({
                    map: liveMapFromFixture(), date: '20260630',
                    updated_at: '2026-06-30T09:20:00', market_status: 'OPEN', count: 20,
                });
            },
        }), {
            fetch: function () { sectorFetchCalls++; return sectorFetch.promise; },
        });
        await settle(16);
        // 선적재(loadMarket)와 갭 뷰(renderGapView)가 진행 중 fetch 프라미스를 공유해야 한다
        assert.strictEqual(sectorFetchCalls, 1,
            '시나리오4: 섹터맵 fetch 1회(진행 중 프라미스 메모) — 실제 ' + sectorFetchCalls + '회');
        // 섹터맵 도착 → 갭 뷰 렌더
        sectorFetch.resolve({
            ok: true,
            json: function () { return Promise.resolve({ date: '20260629', items: [] }); },
        });
        await settle(16);
        assert.ok(/오늘 집계 준비 중/.test(env.els.home2UpdatedAt.textContent),
            '시나리오4: 갭 뷰(오늘 집계 준비 중) — ' + env.els.home2UpdatedAt.textContent);
        assert.ok(/2026년 6월 30일/.test(env.els.home2Date.textContent),
            '시나리오4: 라이브 거래일 라벨 — ' + env.els.home2Date.textContent);
        assert.strictEqual(sectorFetchCalls, 1, '시나리오4: 갭 렌더 후에도 섹터맵 fetch 1회');
        assert.ok(todayBuildCalls >= 1, '시나리오4: 오늘 빌드 감시(adoptTodayBuild) 동작');
        assert.deepStrictEqual(env.timers.delays(), [LIVE_POLL_MS], '시나리오4: 갭 뷰 후 폴링 예약');
    }

    // ⑤ NXT 리드인 전환 — 07:50 시작한 요청이 08:10(리드인 중) 도착하면 응답 폐기 + 재확인 예약
    {
        let liveCalls = 0;
        let todayBuildCalls = 0;
        const livePending = deferred();
        const env = makeEnv(baseApi({
            getRankings: function (date) {
                if (date === '20260630') todayBuildCalls++;
                return Promise.resolve(baseRankingsResponse());
            },
            getLiveMarketmap: function () { liveCalls++; return livePending.promise; },
        }), { nowUtc: Date.UTC(2026, 5, 29, 22, 50) });   // 2026-06-30 07:50 KST — 리드인 직전
        await settle();
        assertRendered(env.els, '시나리오5(리드인 전 로드)');
        assert.strictEqual(liveCalls, 1, '시나리오5: 07:50 로드 → 선조회 시작');
        // 응답 도착 전에 08:10 KST(NXT 리드인)로 진입
        env.clock.now = Date.UTC(2026, 5, 29, 23, 10);
        livePending.resolve({
            map: liveMapFromFixture(), date: '20260630',
            updated_at: '2026-06-30T08:09:00', market_status: 'OPEN', count: 20,
        });
        await settle();
        assert.ok(!/오늘 집계 준비 중/.test(env.els.home2UpdatedAt.textContent),
            '시나리오5: 리드인 중 도착한 응답으로 갭 뷰를 그리지 않음');
        assert.ok(!/08:09/.test(env.els.home2UpdatedAt.textContent),
            '시나리오5: 리드인 중 도착한 응답의 updated_at 미반영');
        assert.ok(/2026년 6월 29일/.test(env.els.home2Date.textContent),
            '시나리오5: 빌드 화면 유지 — ' + env.els.home2Date.textContent);
        assert.strictEqual(todayBuildCalls, 0, '시나리오5: adoptTodayBuild 미발동');
        assert.deepStrictEqual(env.timers.delays(), [NXT_LEADIN_RECHECK_MS],
            '시나리오5: 리드인 종료 후 재확인 예약');
        assert.strictEqual(liveCalls, 1, '시나리오5: 리드인 중 추가 호출 없음');
    }

    // ⑥ rankings 미도착(response 미준비) — visibilitychange 가 라이브를 시작/렌더하지 않음
    {
        let liveCalls = 0;
        const rankingsPending = deferred();
        const env = makeEnv(baseApi({
            getRankings: function () { return rankingsPending.promise; },
            getLiveMarketmap: function () {
                liveCalls++;
                return Promise.reject(new Error('marketmap down'));
            },
        }));
        await settle();
        assert.strictEqual(liveCalls, 1, '시나리오6: 선조회 1회(즉시 실패로 정착)');
        assert.strictEqual(env.els.home2Date.textContent, '', '시나리오6: rankings 도착 전 미렌더');
        // 선조회는 정착됐지만 rankings 미도착 — 라이브 갱신을 시작하면 빈 랭킹 위에 렌더될 수 있다
        env.setVisibility('hidden');
        env.setVisibility('visible');
        await settle();
        assert.strictEqual(liveCalls, 1,
            '시나리오6: rankings 미준비 상태에서 visibilitychange 가 라이브를 시작하지 않음');
        assert.strictEqual(env.els.home2Date.textContent, '', '시나리오6: 여전히 미렌더');
        // rankings 도착 → 기본 렌더 + (정착된 null 선조회는) 재시도 예약만
        rankingsPending.resolve(baseRankingsResponse());
        await settle();
        assertRendered(env.els, '시나리오6(rankings 도착 후)');
        assert.strictEqual(liveCalls, 1, '시나리오6: rankings 도착이 즉시 재호출을 유발하지 않음');
        assert.deepStrictEqual(env.timers.delays(), [LIVE_RETRY_MS],
            '시나리오6: 실패한 선조회의 재시도 예약');
    }

    if (unhandled) throw unhandled;
    console.log('test_home_nonblocking: OK (6 시나리오)');
})().catch(function (err) {
    console.error(err);
    process.exit(1);
});
