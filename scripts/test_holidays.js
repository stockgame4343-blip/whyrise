'use strict';
/**
 * 휴장일 달력·휴장 안내·게시 가드 회귀 테스트
 *   node --test scripts/test_holidays.js
 *
 * 핵심: 한국 휴장일(대체공휴일 포함)을 법 규칙으로 따로 계산해 kr_holidays.json 과 맞춰 본다.
 * 달력에 하루라도 빠지거나 더 들어가면 그날 텔레그램·쓰레드가 엉뚱하게 나가므로 실패시킨다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tg = require('./tg_common');
const ed = require('./tg_editorial');

const ROOT = path.resolve(__dirname, '..');
const KR = JSON.parse(fs.readFileSync(path.join(ROOT, 'collector', 'kr_holidays.json'), 'utf8'));
const GL = JSON.parse(fs.readFileSync(path.join(ROOT, 'collector', 'global_holidays.json'), 'utf8')).markets;

const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const at = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const add = (s, n) => { const d = at(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const dow = s => at(s).getUTCDay();
const weekend = s => dow(s) === 0 || dow(s) === 6;

// ── 법 규칙으로 한 해의 KRX 평일 휴장일 계산 ──
// 「관공서의 공휴일에 관한 규정」 + 대체공휴일 규정 + KRX 연말 휴장
//  · 설·추석 연휴: 일요일 또는 다른 공휴일과 겹칠 때만 대체(토요일은 대체 없음)
//  · 국경일(삼일절·제헌절·광복절·개천절·한글날)·어린이날·부처님오신날·성탄절·노동절: 토·일과 겹치면 대체
//  · 신정·현충일: 대체 없음
function krxClosures(year, lunar, extra) {
    const y = String(year);
    const named = new Map();   // 날짜 → 이름(공휴일 전체, 주말 포함)
    const put = (d, n) => named.set(d, named.has(d) ? named.get(d) + '+' + n : n);
    put(y + '0101', '신정');
    lunar.seol.forEach(d => put(d, '설'));
    lunar.chuseok.forEach(d => put(d, '추석'));
    const satSun = { [y + '0301']: '삼일절', [y + '0501']: '노동절', [y + '0505']: '어린이날', [lunar.buddha]: '부처님오신날',
        [y + '0717']: '제헌절', [y + '0815']: '광복절', [y + '1003']: '개천절', [y + '1009']: '한글날', [y + '1225']: '성탄절' };
    Object.entries(satSun).forEach(([d, n]) => put(d, n));
    put(y + '0606', '현충일');
    const subs = [];
    const nextFree = d => { let x = add(d, 1); while (weekend(x) || named.has(x) || subs.includes(x)) x = add(x, 1); return x; };
    // 설·추석: 연휴(3일) 중 일요일이거나 다른 공휴일과 겹친 날 수만큼, 연휴 다음 첫 비공휴일
    for (const run of [lunar.seol, lunar.chuseok]) {
        const hits = run.filter(d => dow(d) === 0 || named.get(d).includes('+')).length;
        let last = run[run.length - 1];
        for (let i = 0; i < hits; i++) { last = nextFree(last); subs.push(last); }
    }
    // 토·일 대체 대상
    Object.keys(satSun).forEach(d => { if (weekend(d) || named.get(d).includes('+')) subs.push(nextFree(d)); });
    const out = new Set();
    for (const d of named.keys()) if (d.startsWith(y) && !weekend(d)) out.add(d);
    subs.forEach(d => out.add(d));
    (extra || []).forEach(d => out.add(d));
    out.add(y + '1231');   // KRX 연말 휴장(주말이면 그대로 주말)
    return [...out].filter(d => d.startsWith(y) && !weekend(d)).sort();
}

test('2027 한국 휴장일 — 법 규칙으로 계산한 값과 달력이 정확히 같다(대체공휴일 포함)', () => {
    const want = krxClosures(2027, {
        seol: ['20270206', '20270207', '20270208'],      // 한국 기준 설날 2/7(일) — 중국 춘절(2/6)과 다름
        buddha: '20270513',
        chuseok: ['20270914', '20270915', '20270916'],
    });
    const have = Object.keys(KR.holidays).filter(d => d.startsWith('2027')).sort();
    assert.deepEqual(have, want);
    // 대체공휴일 개별 확인 — 하나라도 빠지면 그날 '정상 발행' 사고
    for (const d of ['20270209', '20270503', '20270719', '20270816', '20271004', '20271011', '20271227']) assert.ok(KR.holidays[d], d + ' 대체공휴일 누락');
    // 현충일(6/6 일)·신정은 대체 없음
    assert.ok(!KR.holidays['20270607']);
});

test('2026 한국 휴장일 — 규칙 계산 + 선거일·임시휴장과 같고, 추석 토요일은 대체 없음(9/28 정상 거래)', () => {
    const want = krxClosures(2026, {
        seol: ['20260216', '20260217', '20260218'], buddha: '20260524', chuseok: ['20260924', '20260925', '20260926'],
    }, ['20260603']);
    const have = Object.keys(KR.holidays).filter(d => d.startsWith('2026')).sort();
    assert.deepEqual(have, want);
    assert.equal(tg.isKrTradingDay('20260928'), true);
    assert.equal(tg.isKrTradingDay('20261005'), false);   // 개천절(10/3 토) 대체
    assert.equal(tg.isKrTradingDay('20260603'), false);   // 지방선거
});

test('2026 실제 시세 파일과 달력이 어긋나지 않는다 — 휴장일엔 데이터 없음, 거래일엔 데이터 있음', () => {
    const dir = path.join(ROOT, 'public', 'data', 'rise-history');
    if (!fs.existsSync(dir)) return;
    const files = new Set(fs.readdirSync(dir).filter(f => /^2026\d{4}\.json$/.test(f)).map(f => f.slice(0, 8)));
    if (!files.size) return;
    const last = [...files].sort().pop();
    for (let d = '20260102'; d <= last; d = add(d, 1)) {
        if (weekend(d)) continue;
        assert.equal(files.has(d), tg.isKrTradingDay(d), d + (files.has(d) ? ' 데이터가 있는데 달력은 휴장' : ' 데이터가 없는데 달력은 거래일'));
    }
});

test('달력 범위·메타 — 2027년까지 담고, 2027 KRX 공식 대조 전이면 운영 경고가 뜬다', () => {
    assert.equal(KR._covered_through, '20271231');
    assert.equal(tg.krCalendarCovers('20271231'), true);
    assert.equal(tg.krCalendarCovers('20280103'), false);
    assert.deepEqual(tg.holidayCalendarWarnings('20261005'), []);
    const dec = tg.holidayCalendarWarnings('20261201').join('\n');
    assert.match(dec, /2027/);              // KRX 2027 대조 요청
    assert.match(dec, /홍콩|중국|대만/);     // 2027 미발표 해외 달력 갱신 요청
});

test('게시 가드 — 휴장·대체공휴일·주말은 막고, 달력 밖 날짜는 캘린더만 믿는 게시물에서 막는다', () => {
    assert.match(tg.krPublishBlock('20261009'), /한글날/);
    assert.match(tg.krPublishBlock('20261005'), /개천절/);
    assert.match(tg.krPublishBlock('20270209'), /설날/);
    assert.match(tg.krPublishBlock('20261003'), /주말/);
    assert.equal(tg.krPublishBlock('20261006'), '');
    assert.equal(tg.krPublishBlock('20260928'), '');
    const log = console.log; console.log = () => {};
    try {
        assert.match(tg.krPublishBlock('20280103', false), /확정할 수 없음/);   // 장전 브리핑·마케팅
        assert.equal(tg.krPublishBlock('20280103', true), '');                  // 네이버 실측이 뒤따르는 게시물
        assert.match(tg.krPublishBlock('20280101', true), /주말/);                // 토요일은 달력과 무관하게 막음
    } finally { console.log = log; }
});

test('마감 안내 — 다음 거래일 전 국내 휴장(대체공휴일)과 다음 거래일의 해외 휴장', () => {
    assert.deepEqual(ed.holidayCloseLines('20261008'), [
        '🇰🇷 국내 증시 휴장: 내일 10월 9일(금) 한글날 → 다음 거래일 10월 12일(월)',
        '🌏 10월 12일(월) 해외 휴장: 🇯🇵 일본(스포츠의 날)',
    ]);
    assert.deepEqual(ed.holidayCloseLines('20261002'), [
        '🇰🇷 국내 증시 휴장: 10월 5일(월) 개천절 대체공휴일 → 다음 거래일 10월 6일(화)',
        '🌏 10월 6일(화) 해외 휴장: 🇨🇳 중국(국경절 연휴, ~10월 7일(수)까지)',
    ]);
    assert.deepEqual(ed.holidayCloseLines('20261230'), ['🇰🇷 국내 증시 휴장: 내일 12월 31일(목) 연말 휴장, 1월 1일(금) 신정 → 다음 거래일 1월 4일(월)']);
    assert.deepEqual(ed.holidayCloseLines('20270205'), ['🇰🇷 국내 증시 휴장: 2월 8일(월)~9일(화) 설 연휴(대체공휴일 포함) → 다음 거래일 2월 10일(수)']);
    assert.deepEqual(ed.holidayCloseLines('20260925'), []);       // 금요일 → 월요일(9/28) 정상
    assert.deepEqual(ed.holidayCloseLines('20261124'), []);
    assert.deepEqual(ed.holidayCloseLines('20261126'), ['🌏 11월 27일(금) 해외: 🇺🇸 미국 현지 13시 조기 폐장(추수감사절 다음날)']);
    assert.deepEqual(ed.holidayCloseLines('20261008', false), ['🇰🇷 국내 증시 휴장: 내일 10월 9일(금) 한글날 → 다음 거래일 10월 12일(월)']);
});

test('장전 안내 — 오늘 해외 휴장, 간밤 미국 휴장, 일주일 안 국내 휴장', () => {
    assert.deepEqual(ed.holidayMorningLines('20261012'), ['🌏 오늘 해외 휴장: 🇯🇵 일본(스포츠의 날)']);
    assert.deepEqual(ed.holidayMorningLines('20261008'), ['🇰🇷 국내 증시 휴장 예정: 내일 10월 9일(금) 한글날']);
    assert.deepEqual(ed.holidayMorningLines('20270910'), ['🇰🇷 국내 증시 휴장 예정: 9월 14일(화)~16일(목) 추석 연휴']);
    assert.deepEqual(ed.usOvernightClosure('20261127'), { date: '20261126', name: '추수감사절' });
    assert.deepEqual(ed.usOvernightClosure('20270329'), { date: '20270326', name: '성금요일' });   // 월요일 아침 ← 미국 금요일
    assert.equal(ed.usOvernightClosure('20261124'), null);
});

test('해외 달력 — 발표 범위 밖은 안내하지 않고, 잠정(tentative) 날짜는 쓰지 않는다', () => {
    assert.deepEqual(tg.foreignClosures('20270101', ['HK', 'CN', 'TW']), []);   // 2027 미발표
    assert.equal(tg.foreignClosures('20270101', ['US'])[0].name, '새해 첫날');
    for (const [code, m] of Object.entries(GL)) {
        for (const d of Object.keys(m.holidays || {})) {
            assert.ok(d <= m.covered_through, code + ' ' + d + ' 범위 밖');
            assert.ok(!weekend(d), code + ' ' + d + ' 주말이 휴장일로 들어감');
        }
        for (const d of Object.keys(m.tentative || {})) assert.equal(tg.foreignClosures(d, [code]).length, 0, code + ' 잠정 ' + d + ' 안내됨');
    }
});

test('달력 밖 다음 거래일은 단정하지 않는다', () => {
    const lines = ed.holidayCloseLines('20271230');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /내일 12월 31일\(금\) 연말 휴장/);
    assert.doesNotMatch(lines[0], /다음 거래일/);    // 2028-01-03 은 달력 밖
});

test('장전 브리핑 캡션 — 간밤 미국 휴장이면 전날 시세 대신 휴장, 휴장 안내 포함', () => {
    const mb = require('./telegram_morning_brief');
    const q = [{ label: 'S&P 500', changePct: 0.42 }, { label: '나스닥', changePct: -0.31 }, { label: 'VIX', price: 16.3 }];
    const tg27 = mb.buildCaption('20261127', q, { price: 1391.2 }, null, '');
    assert.match(tg27, /간밤 미국 증시 휴장\(추수감사절\)/);
    assert.doesNotMatch(tg27, /S&amp;P|VIX/);
    assert.match(tg27, /조기 폐장/);
    const tg08 = mb.buildCaption('20261008', q, { price: 1391.2 }, null, '');
    assert.match(tg08, /S&amp;P \+0\.4%/);
    assert.match(tg08, /국내 증시 휴장 예정: 내일 10월 9일\(금\) 한글날/);
});

test('쓰레드·블로그 한 줄 — 국내 휴장이 먼저, 없으면 다음 거래일 해외 휴장, 날짜는 그대로(내일 없이)', () => {
    const Copy = require('./marketing_copy');
    assert.equal(Copy.holidayLine(ed.holidayNotice('20261008')), '🇰🇷 국내 증시 휴장: 10월 9일(금) 한글날 → 다음 거래일 10월 12일(월)');
    assert.equal(Copy.holidaySentence(ed.holidayNotice('20261002')), '국내 증시는 10월 5일(월) 개천절 대체공휴일 휴장, 다음 거래일은 10월 6일(화)입니다.');
    assert.equal(Copy.holidaySentence(ed.holidayNotice('20271230')), '국내 증시는 12월 31일(금) 연말 휴장입니다.');   // 연말 휴장 휴장 X, 달력 밖 다음 거래일 X
    assert.equal(Copy.holidayLine(ed.holidayNotice('20261016')), '🌏 10월 19일(월) 해외 휴장: 🇭🇰 홍콩(중양절 대체휴일)');
    assert.equal(Copy.holidayLine(ed.holidayNotice('20261124')), '');
    // 원고에 실제로 붙는지 — 쓰레드는 글자 수가 넘쳐도 빠지지 않는다
    const row = (t, n, rate) => ({ ticker: t, name: n, change_rate: rate, close_price: 10000, trading_value: 5e10, trading_volume: 1e6, rise_reason: '' });
    const m = Copy.material({ date: '20261008', rows: [row('000001', '가나다', 12), row('000002', '라마바', 14)], holiday: ed.holidayNotice('20261008') });
    assert.match(Copy.threads(m).text, /🇰🇷 국내 증시 휴장: 10월 9일\(금\) 한글날 → 다음 거래일 10월 12일\(월\)\n\n👇/);
    assert.match(Copy.naverBlog(m).html, /<b>🗓 휴장 안내<\/b><\/p>\n<p>국내 증시는 10월 9일\(금\) 한글날 휴장, 다음 거래일은 10월 12일\(월\)입니다\./);
    const plain = Copy.material({ date: '20261124', rows: [row('000001', '가나다', 12)], holiday: ed.holidayNotice('20261124') });
    assert.doesNotMatch(Copy.threads(plain).text + Copy.naverBlog(plain).html, /휴장/);
});

test('사이트 대장 캘린더 데이터 — 휴장일이 달력(kr_holidays.json)과 같다', () => {
    const cal = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'leaders-calendar.json'), 'utf8'));
    // 다르면: node scripts/build_leaders_calendar.js --holidays-only
    assert.deepEqual(cal.holidays, tg.krHolidayLabels());
    assert.equal(cal.holidays_through, KR._covered_through);
    assert.equal(cal.holidays['20261005'], '개천절 대체공휴일');
    assert.equal(cal.holidays['20260928'], undefined);
    // 메인 목록(rise-history)에는 휴장일 날짜가 없다 — 휴장일은 캘린더 표시만
    for (const d of Object.keys(cal.holidays)) assert.ok(!cal.days[d], d + ' 휴장일에 대장 기록');
});
