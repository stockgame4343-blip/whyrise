'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { test } = require('node:test');
const tg = require('./tg_common');
const source = fs.readFileSync(path.join(__dirname, 'telegram_market_watch.js'), 'utf8');
// Run the actual caption, gate, marker and send functions; replace external dependencies.
const constants = source.slice(source.indexOf('const LUNCH_START_MIN'), source.indexOf('const BOT_TOKEN'));
const functions = source.slice(source.indexOf('function idxNum'), source.indexOf('\nmain().catch'));

function harness({ dry = true, demo = '' } = {}) {
    const messages = [], logs = [];
    let marker = {}, markerWrites = 0, aiCalls = 0;
    const M = { tradedYmd: '20260904', kospi: { price: 2500, changePct: -8.3 },
        kosdaq: { price: 700, changePct: -6 }, upCount: 150, downCount: 1900, tradingValueWon: 1e12 };
    const ev = { market: '코스피', direction: '매도', title: '[속보] 코스피 <매도> 사이드카 발동', signature: '사이드카|코스피' };
    const context = {
        DRY: dry, DEMO: demo, FORCE: false, BOT_TOKEN: 'test', CHAT_ID: 'test', MARKER: '/unused',
        console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
        tg: Object.assign({}, tg, {
            ymdKst: () => '20260904', hmKst: () => '12:30', isKrTradingDay: () => true,
            loadMarker: () => JSON.parse(JSON.stringify(marker)),
            saveMarker: (_, value) => { marker = JSON.parse(JSON.stringify(value)); markerWrites++; },
            aiHook: () => { aiCalls++; throw Error('paid API must not run'); },
            sendMessage: async (_, __, caption, opts) => {
                messages.push({ caption, opts }); return { result: { message_id: messages.length } };
            },
        }),
        market: { fetchKrMarketSummary: async () => M, fetchSidecarEvents: async () => [ev] },
        core: {
            RAW: 'fixture:', RISE_CUTOFF: 15,
            fetchJson: async url => url.endsWith('/dates.json') ? ['20260904'] : { rankings: [{ change_rate: 20 }] },
            isActive: r => r.change_rate >= 15,
            buildGroups: () => [{ key: '로봇', avgRate: 20 }],
        },
    };
    vm.createContext(context);
    vm.runInContext(constants + functions, context);
    return { run: context.main, context, messages, logs, M,
        marker: () => marker, markerWrites: () => markerWrites, aiCalls: () => aiCalls };
}

test('market watch dry-run uses facts and no LLM, sends or marker writes', async () => {
    const h = harness();
    await h.run();
    const captions = h.logs.join('\n');
    assert.match(captions, /ORGO 수집 종목 중 \+15% 이상 1종목/);
    assert.match(captions, /기준 도달/);
    assert.match(captions, /실제 거래소 발동 여부는 별도 확인/);
    assert.match(captions, /사이드카 발동 보도/);
    assert.match(captions, /감지 보도: \[속보\] 코스피 &lt;매도&gt; 사이드카 발동/);
    assert.equal(h.aiCalls(), 0);
    assert.equal(h.messages.length, 0);
    assert.equal(h.markerWrites(), 0);
});

test('all preview branches avoid LLM and external writes', async () => {
    for (const demo of ['lunch', 'alert', 'sidecar']) {
        const h = harness({ dry: false, demo });
        await h.run();
        assert.equal(h.aiCalls(), 0, demo);
        assert.equal(h.messages.length, 0, demo);
        assert.equal(h.markerWrites(), 0, demo);
        assert.ok(h.logs.some(line => line.includes('캡션')), demo);
    }
});

test('mock delivery retains event keys, duplicate markers and stage escalation', async () => {
    const h = harness({ dry: false });
    await h.run();
    assert.deepEqual(h.messages.map(m => m.opts.delivery_key), ['lunch', 'cb:8', 'sidecar:사이드카|코스피']);
    assert.equal(h.marker().lunchPosted, true);
    assert.equal(h.marker().cbStage, 8);
    assert.deepEqual(h.marker().sidecarKeys, ['사이드카|코스피']);
    await h.run();
    assert.equal(h.messages.length, 3, 'same event is not resent');
    assert.equal(h.markerWrites(), 1, 'unchanged state does not write a marker');
    h.M.kospi.changePct = -15.2;
    await h.run();
    assert.equal(h.messages.length, 4);
    assert.equal(h.messages[3].opts.delivery_key, 'cb:15');
    assert.equal(h.aiCalls(), 0);
});
