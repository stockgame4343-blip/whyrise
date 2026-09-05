'use strict';
// Execute the production loaders with controllable responses, without network or DOM writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extract(source, name) {
    const start = source.indexOf('    function ' + name + '(');
    assert.ok(start >= 0, 'missing function ' + name);
    const end = source.indexOf('\n    }', start);
    return source.slice(start, end + 6);
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
function harness(file) {
    const snapshots = ['bubbles2', 'treemap'].includes(file);
    const requests = [];
    const elements = Object.fromEntries(['loading', 'reportContent', 'message'].map(k => [k, { style: {}, textContent: '' }]));
    const state = { dateIndex: 1, availableDates: ['20260904', '20260903', '20260902'], sectorMap: {}, rankings: [], snapshotItems: [] };
    let renders = 0;
    const request = () => { const d = deferred(); requests.push(d); return d.promise; };
    const context = {
        state, Promise, fetch: request, WhyAPI: { getRankings: request },
        $loading: elements.loading, $message: elements.message,
        $: id => elements[id],
        normalizeRanking: r => r, updateDateNav() {}, updateLastUpdated() {},
        setUpdatedAt(value) { state.updatedAt = value; },
        showMessage(value) { elements.message.textContent = value; },
        render() { renders++; }, applyDay() { renders++; }, isWaitingLive() { return false; },
        setLiveState() {}, isMarketOpen() { return false; }, updateBackBtn() {},
    };
    vm.createContext(context);
    const source = fs.readFileSync(path.join(__dirname, '../public/js', file + '.js'), 'utf8');
    const fn = snapshots ? 'fetchSnapshot' : 'loadDate';
    vm.runInContext(extract(source, fn), context);
    if (snapshots) vm.runInContext(extract(source, 'gotoDateIndex'), context);
    function respond(index, date) {
        const data = { date, collected_at: date, updated_at: date, rankings: [{ ticker: date }], items: [{ ticker: date, sector: date }] };
        requests[index].resolve(snapshots ? { ok: true, json: () => Promise.resolve(data) } : data);
    }
    return { state, elements, requests, respond, run: context[fn], context, snapshots, renders: () => renders };
}

async function check(file) {
    const h = harness(file);
    const old = h.run('20260903');
    const current = h.run('20260902');
    h.respond(1, '20260902');
    await current;
    h.respond(0, '20260903');
    await old;
    assert.equal(h.renders(), 1, file + ': older success must not redraw');
    assert.equal((h.snapshots ? h.state.snapshotItems : (h.state.day || h.state).rankings)[0].ticker, '20260902');
    if (h.snapshots) assert.equal(h.state.sectorMap['20260903'], undefined, 'stale sector metadata ignored');

    h.elements.loading.style.display = '';
    const failingOld = h.run('20260903');
    const loadingCurrent = h.run('20260902');
    h.requests[2].reject(new Error('old failure'));
    await failingOld;
    assert.notEqual(h.elements.loading.style.display, 'none', file + ': stale failure must not stop current loading');
    assert.ok(!h.elements.message.textContent.includes('old failure'));
    h.respond(3, '20260902');
    await loadingCurrent;

    if (h.snapshots) {
        h.context.gotoDateIndex(2);
        h.requests[4].reject(new Error('current failure'));
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assert.ok(h.elements.message.textContent.includes('current failure'), file + ': selected date failure is shown');
        assert.equal(h.elements.loading.style.display, 'none');
        const beforeEmpty = h.renders();
        const empty = h.run('20260901');
        h.requests[5].resolve({ ok: true, json: () => Promise.resolve({ date: '20260901', items: [] }) });
        await empty;
        assert.equal(h.renders(), beforeEmpty + 1, file + ': empty snapshot clears previous chart');
        assert.equal(h.state.snapshotItems.length, 0);
    }
}

(async () => {
    for (const file of ['flowmap', 'bubbles2', 'treemap', 'report']) await check(file);
    console.log('test_date_navigation: OK (4 screens; stale success, stale failure, current failure)');
})().catch(err => { console.error(err); process.exitCode = 1; });
