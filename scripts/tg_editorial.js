'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./build_leaders_calendar');
const tg = require('./tg_common');
const TOP_CAPTION_ROWS = 3;
function finalSnapshot(publicDir, date) {
    if (!/^\d{8}$/.test(date || '')) throw new Error('Invalid final snapshot date');
    const day = JSON.parse(fs.readFileSync(path.join(publicDir, 'data', 'rise-history', date + '.json'), 'utf8'));
    if (day.date !== date || day.is_final !== true || !Array.isArray(day.rankings)) throw new Error('Final matching ORGO snapshot required');
    return day;
}
function calendarLeaders(publicDir, date, day) {
    const entry = JSON.parse(fs.readFileSync(path.join(publicDir, 'data', 'leaders-calendar.json'), 'utf8')).days?.[date];
    if (!entry || !Object.hasOwn(entry, 'stock')) throw new Error('Dated ORGO calendar entry required');
    const stock = entry.stock;
    if (stock && (!stock.name || !Number.isFinite(stock.rate) || !Number.isFinite(stock.vol))) throw new Error('Invalid calendar leader');
    const group = g => g ? {key:g.name,count:g.count,avgRate:g.avgRate,top:g.top,topRate:day?.rankings?.find(r=>r.name===g.top)?.change_rate,totalVolume:g.vol} : null;
    return {leader:stock ? {ticker:stock.ticker,name:stock.name,change_rate:stock.rate,trading_value:stock.vol,theme:stock.theme,sector:stock.sector,market:stock.market,listing_day:!!stock.listing_day} : null,sector:group(entry.sector),theme:group(entry.theme)};
}

// 정리매매(상장폐지 절차) 종목의 등락은 급등 집계·설명 대상이 아니다.
function isDelisting(r) { return /^정리매매/.test(String(r?.rise_reason || '')); }
// 신규상장주는 상장 초기 가격제한폭(최대 4배)이 달라 '주도주'와 구분해 표기한다.
function isNewListing(theme) { return /신규상장/.test(String(theme || '')); }
// '신규상장' 태그는 반기 단위라 수개월 전 상장주도 붙는다 → 상장 첫날(±30% 밖)만 표기
function ipoMark(themeOrRow, rate) {
    if (themeOrRow && typeof themeOrRow === 'object') {
        const r = themeOrRow;
        const tags = [].concat(r.theme_tags || [], r.theme_tag || [], r.theme || []);
        const day1 = r.listing_day || (Number(r.change_rate ?? r.rate) > 30.5 && tags.some(isNewListing));
        return day1 ? ' (상장 첫날)' : '';
    }
    return Number(rate) > 30.5 && isNewListing(themeOrRow) ? ' (상장 첫날)' : '';
}
function activeRows(day) {
    const rows = new Map();
    for (const r of day?.rankings || []) if (r?.ticker && r.name && !isDelisting(r) && core.isActive(r, core.RISE_CUTOFF)) rows.set(r.ticker, r);
    return [...rows.values()];
}
function comparison(day, previous) {
    if (!/^\d{8}$/.test(day?.date || '') || !/^\d{8}$/.test(previous?.date || '') || previous.date >= day.date || day.is_final !== true || previous.is_final !== true) return null;
    if (!Array.isArray(day.rankings) || !Array.isArray(previous.rankings) || tg.isDuplicateDayData(day, previous)) return null;
    const now = activeRows(day), before = new Set(activeRows(previous).map(r => r.ticker));
    const continuing = now.filter(r => before.has(r.ticker));
    return { date: previous.date, count: now.length, previousCount: before.size, continuing, newCount: now.length - continuing.length };
}
function previousSnapshot(publicDir, day) {
    try {
        const dir = path.join(publicDir, 'data', 'rise-history');
        const dates = fs.readdirSync(dir).filter(f => /^\d{8}\.json$/.test(f) && f.slice(0, 8) < day.date).sort().reverse();
        for (const f of dates) {
            const date = f.slice(0, 8);
            if (!tg.isKrTradingDay(date)) continue;
            const previous = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (previous.date === date && previous.is_final === true && comparison(day, previous)) return previous;
        }
    } catch (_) { /* A missing comparison never becomes an invented change. */ }
    return null;
}
function countLine(day, previous) {
    const c = comparison(day, previous);
    if (!c) return 'ORGO 수집 종목 중 +' + core.RISE_CUTOFF + '% 이상 ' + activeRows(day).length + '개.';
    const delta = c.count - c.previousCount;
    return '수집 종목 중 +' + core.RISE_CUTOFF + '% 이상 ' + c.previousCount + '→' + c.count + '개 (' + tg.mdLabel(c.date) + ' 대비 ' + (delta ? Math.abs(delta) + '개 ' + (delta > 0 ? '증가' : '감소') : '동일') + ').';
}
// ── 문구 공통 ─────────────────────────────────────────────
// 원칙: ① 첫 줄 = 오늘의 한 줄 훅 ② 종목마다 '왜' 한 줄 ③ 링크 1개(+공유) ④ 방법론 문구는 채널 고정 공지로
const CHANNEL_URL = 'https://t.me/whyorgo';
const SHARE_URL = 'https://t.me/share/url?url=' + encodeURIComponent(CHANNEL_URL) +
    '&text=' + encodeURIComponent('오늘 오른 한국 주식, 왜 올랐는지 매일 정리해 주는 채널');
const e_ = s => tg.escHtml(s);
const md = ymd => (+String(ymd).slice(4, 6)) + '/' + (+String(ymd).slice(6, 8));
const b_ = s => '<b>' + tg.escHtml(s) + '</b>';
function isIpoRow(r) { return !!ipoMark(r); }
function whyOf(refined, r) {
    const t = r && refined ? refined[r.ticker] : '';
    return t ? tg.clip(String(t).replace(/^관련 보도:\s*/, '📰 '), 52) : '';
}
function stockLines(rows, refined, opts = {}) {
    const out = [];
    rows.forEach((r, i) => {
        const rate = r.change_rate ?? r.rate;
        const vol = r.trading_value ?? r.vol;
        out.push((opts.numbered === false ? '• ' : (i + 1) + '. ') + b_(r.name) + ' ' + e_(tg.pct(rate)) +
            (opts.volume && vol ? ' · ' + e_(tg.fmtAmount(vol)) : '') + (isIpoRow(r) ? e_(ipoMark(r)) : ''));
        const why = whyOf(refined, r);
        if (why) out.push('   └ ' + e_(why));
    });
    return out;
}
// 사이트 본 화면(오른 종목)의 그날 목록 — 검색용 날짜별 정적 페이지로 보내지 않는다
function dayUrl(date, campaign) { return tg.orgoLink('/rise.html?date=' + date, campaign); }
function closing(lines, label, url, share) {
    return lines.filter(x => x !== null && x !== undefined).join('\n') + '\n\n' +
        tg.htmlLink(label, url) + (share ? '  ·  ' + tg.htmlLink('📲 공유', SHARE_URL) : '');
}
// 오늘 흐름 한 줄 — 테마/업종 상위 2개 (사실만)
function flowLine(groups) {
    const top = (groups || []).filter(g => g && g.key && !isNewListing(g.key) && !/^거래(량|대금)$/.test(g.key)).slice(0, 2);
    if (!top.length) return '';
    return top.map(g => g.key.replace(/\([^)]*\)/g, '').trim() + ' ' + g.count + '종목').join(' · ');
}
// 이유가 확인된 종목 우선, 같은 조건이면 등락률 순
function explainedFirst(rows, refined, n) {
    // 같은 업종 문장이 줄줄이 반복되지 않게 — 이유가 다른 종목을 먼저, 그다음 나머지
    const seen = new Set(), first = [], later = [];
    rows.forEach(r => {
        const why = refined && refined[r.ticker];
        if (!why) return;
        (seen.has(why) ? later : first).push(r);
        seen.add(why);
    });
    const rest = rows.filter(r => !(refined && refined[r.ticker]));
    return first.concat(later, rest).slice(0, n);
}

// ── 오늘의 흐름(market_story) 기반 문구 ─────────────────────
const Story = require('./market_story');
const JU = { '반도체': '반도체주', '2차전지': '2차전지주', '로봇': '로봇주', '우주항공': '우주항공주', '원전': '원전주',
    '전력설비': '전력주', '광통신': '광통신주', '조선': '조선주', '방산': '방산주', '양자': '양자주', '자동차·부품': '자동차주',
    '스마트폰 부품': '스마트폰 부품주', '철강': '철강주', '건설': '건설주', '바이오': '바이오주', '화장품': '화장품주', '증권': '증권주' };
function flowWord(f) { return f.kind === 'sector' ? f.label : (JU[f.label] || f.label + ' 테마'); }
function storyOf(day, opts) { return Story.build(day || { date: '', rankings: [] }, opts || {}); }
const P = Story.pct;
// 머리 한 줄: "광통신주 급등, 머큐리·티엠씨 상한가" / "광통신·우주항공 강세"
function headPhrase(s) {
    const lead = s.lead[0];
    const lu = lead ? lead.members.filter(r => r.limit) : [];
    if (lead && lu.length) return flowWord(lead) + ' 급등, ' + lu.slice(0, 2).map(r => r.name).join('·') + ' 상한가';
    // 흐름이 없는 날 — 이유가 확인된 상한가 종목을 앞에
    const solo = !lead ? s.limitUps.filter(r => r.reason).slice(0, 2) : [];
    if (solo.length) return solo.map(r => r.name).join('·') + ' 상한가, 개별 재료 장세';
    return s.headline || '';
}
function memberLine(rows, n) { return rows.slice(0, n).map(r => r.name + ' ' + Story.rateOf(r)).join(' · '); }
function flowHead(f) {
    const why = Story.flowReason(f);   // 기사 배경, 없으면 이유가 확인된 대표 종목의 이유
    const lu = f.members.filter(r => r.limit).length;
    return b_(f.label) + ' ' + e_(f.members.length + '종목' + (!why && lu ? ' · 상한가 ' + lu : '') + (f.streak >= 2 ? ' · ' + f.streak + '거래일 연속' : '') +
        (why ? ' — ' + why : ''));
}
// 캡션 길이(HTML 포함) 제한 — 넘으면 우선순위 낮은 줄부터 뺀다 (잘린 태그로 파싱 실패 방지)
function fit(blocks, max, tailHtml) {
    const keep = blocks.slice();
    const join = () => keep.filter(b => b).map(b => b.lines.join('\n')).join('\n\n') + '\n\n' + tailHtml;
    let text = join();
    while (text.length > max) {
        let worst = -1;
        keep.forEach((b, i) => { if (b && b.prio > 0 && (worst < 0 || b.prio >= keep[worst].prio)) worst = i; });
        if (worst < 0) break;
        keep.splice(worst, 1); text = join();
    }
    return text;
}
function tail(label, url, share) { return tg.htmlLink(label, url) + (share ? '  ·  ' + tg.htmlLink('📲 공유', SHARE_URL) : ''); }

// ── 휴장 안내 ── 한국(대체공휴일 포함)은 kr_holidays.json, 해외는 global_holidays.json 의 거래소 발표분만
const holidayName = tg.krHolidayLabel;
function dateRangeKo(a, b) {
    if (a === b) return tg.dateKo(a);
    const tail = a.slice(0, 6) === b.slice(0, 6) ? tg.dateKo(b).replace(/^\d+월 /, '') : tg.dateKo(b);
    return tg.dateKo(a) + '~' + tail;
}
// 이어지는 국내 휴장 — 설·추석 연휴는 한 덩어리로, 나머지는 날짜마다
function krClosureText(kr) {
    const names = kr.map(k => holidayName(k.name));
    const root = names[0].split(' ')[0];
    if (kr.length > 1 && /^(설날|추석)$/.test(root) && names.every(n => n.split(' ')[0] === root))
        return dateRangeKo(kr[0].date, kr[kr.length - 1].date) + ' ' + (root === '설날' ? '설' : root) + ' 연휴' + (names.some(n => /대체/.test(n)) ? '(대체공휴일 포함)' : '');
    return kr.map(k => tg.dateKo(k.date) + ' ' + holidayName(k.name)).join(', ');
}
// 해외 휴장이 며칠 이어지는지 — 중국 국경절처럼 긴 연휴는 '~10월 7일(수)까지'
function foreignUntil(code, ymd, name) {
    let last = ymd, d = ymd;
    for (let i = 0; i < 12; i++) {
        d = shiftDay(d, 1);
        if (!isWeekday(d)) continue;
        const hit = tg.foreignClosures(d, [code]).filter(x => !x.early && x.name === name)[0];
        if (!hit) break;
        last = d;
    }
    return last;
}
function foreignItems(ymd, flags) {
    const fx = tg.foreignClosures(ymd);
    const onlyClosed = fx.every(x => !x.early);
    const items = fx.map(x => {
        const who = (flags === false ? '' : x.flag + ' ') + x.label;
        if (x.early) return who + ' ' + x.note + '(' + x.name + ')';
        const until = foreignUntil(x.code, ymd, x.name);
        return who + (onlyClosed ? '' : ' 휴장') + '(' + x.name + (until > ymd ? ', ~' + tg.dateKo(until) + '까지' : '') + ')';
    });
    return { items, onlyClosed };
}
function foreignLine(when, ymd, flags) {
    const f = foreignItems(ymd, flags);
    if (!f.items.length) return '';
    return (flags === false ? '' : '🌏 ') + when + ' 해외' + (f.onlyClosed ? ' 휴장' : '') + ': ' + f.items.join(' · ');
}
// 다음 거래일 전 국내 휴장과 다음 거래일 해외 휴장 — 텔레그램·쓰레드·블로그 공용 재료
//   kr: '10월 9일(금) 한글날' · tomorrow: 첫 휴장일이 바로 다음 날인지 · next: '10월 12일(월)'(달력 범위 안일 때만)
//   foreign / foreignPlain: 다음 거래일 해외 휴장·단축장 한 줄(국기 있음/없음)
function holidayNotice(date) {
    const next = tg.nextKrTradingDay(date), kr = tg.krClosuresBefore(date);
    if (!next) return { kr: '', tomorrow: false, next: '', foreign: '', foreignPlain: '' };
    const sure = tg.krCalendarCovers(next);   // 달력 범위 밖 날짜는 '다음 거래일'로 단정하지 않는다
    return {
        kr: kr.length ? krClosureText(kr) : '', tomorrow: !!kr.length && kr[0].date === shiftDay(date, 1),
        next: sure ? tg.dateKo(next) : '',
        foreign: sure ? foreignLine(tg.dateKo(next), next) : '', foreignPlain: sure ? foreignLine(tg.dateKo(next), next, false) : '',
    };
}
// 마감·저녁: 다음 거래일 전에 끼는 국내 휴장(대체공휴일 포함)과, 다음 거래일의 해외 휴장·단축장
function holidayCloseLines(date, withForeign) {
    const h = holidayNotice(date), out = [];
    if (h.kr) out.push('🇰🇷 국내 증시 휴장: ' + (h.tomorrow ? '내일 ' : '') + h.kr + (h.next ? ' → 다음 거래일 ' + h.next : ''));
    if (withForeign !== false && h.foreign) out.push(h.foreign);
    return out;
}
// 장전: 오늘 해외 휴장·단축장, 일주일 안의 국내 휴장 예고(이어지는 날은 한 덩어리로)
function holidayMorningLines(today) {
    const out = [], f = foreignLine('오늘', today);
    if (f) out.push(f);
    const runs = [];
    for (let i = 1; i <= 7; i++) {
        const d = shiftDay(today, i), n = tg.krHolidayName(d);
        if (!n || !isWeekday(d)) continue;
        const last = runs.length ? runs[runs.length - 1] : null;
        if (last && tg.nextKrTradingDay(last[last.length - 1].date) > d) last.push({ date: d, name: n });
        else runs.push([{ date: d, name: n }]);
    }
    if (runs.length) out.push('🇰🇷 국내 증시 휴장 예정: ' + (runs[0][0].date === shiftDay(today, 1) ? '내일 ' : '') + runs.map(krClosureText).join(', '));
    return out;
}
// 간밤 미국 정규장이 쉬었는지 — 장전 브리핑이 그 전 거래일 시세를 '간밤'으로 싣지 않게
function usOvernightClosure(today) {
    let d = shiftDay(today, -1);
    while (!isWeekday(d)) d = shiftDay(d, -1);
    const us = tg.foreignClosures(d, ['US']).filter(x => !x.early)[0];
    return us ? { date: d, name: us.name } : null;
}
function shiftDay(ymd, n) { const t = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10).replace(/-/g, ''); }
function isWeekday(ymd) { const w = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay(); return w > 0 && w < 6; }

/** 15:45 마감 — 이미지(대장 카드·테마 버블)와 함께 나가는 캡션 (1024자 이내) */
function daily(date, leaders, market, refined, day, previous, history) {
    const s = storyOf(day, { leader: leaders && leaders.leader ? { ...leaders.leader, rate: leaders.leader.change_rate, vol: leaders.leader.trading_value } : null,
        history: history || (previous ? [previous] : []) });
    const blocks = [];
    const head = [b_('📌 ' + tg.dateKo(date) + ' 마감' + (s.rows.length ? ' | ' + headPhrase(s) : ''))];
    if (market) head.push(e_('코스피 ' + tg.pct(market.kospi.changePct) + ' · 코스닥 ' + tg.pct(market.kosdaq.changePct)));
    head.push(e_('상한가 ' + s.limitUps.length + ' · +' + core.RISE_CUTOFF + '% 이상 ' + s.hot.length + '종목' + (s.prevHot != null ? ' (전일 ' + s.prevHot + ')' : '')));
    blocks.push({ prio: 0, lines: head });
    const L = s.leader;
    if (L) {
        const why = L.row && !L.ipo ? Story.whyOf(L.row) : '';
        // 신규상장주의 등락률은 공모가 기준이 아니어서 숫자 없이
        const rateText = L.resumed ? ' · 거래 재개(기준가 변경)' : L.ipo ? ' · 신규상장' : ' ' + (L.row ? Story.rateOf(L.row) : P(L.rate));
        blocks.push({ prio: 0, lines: [e_('🏆 오늘의 대장 ' + L.name + rateText + ' · 거래대금 ' + tg.fmtAmount(L.vol))].concat(why ? ['└ ' + e_(tg.clip(why, 48))] : []) });
    } else if (s.money[0]) {
        blocks.push({ prio: 0, lines: [e_('🏆 오늘의 대장 없음 · 거래대금 1위 ' + s.money[0].name + ' ' + tg.fmtAmount(s.money[0].vol) + ' (' + Story.rateOf(s.money[0]) + ')')] });
    }
    const flows = s.lead.slice(0, 3);
    flows.forEach((f, i) => blocks.push({ prio: 2 + i, lines: [flowHead(f), e_(memberLine(f.members, 3))] }));
    const solos = s.solos.slice().sort((a, b) => b.rate - a.rate).slice(0, 2);
    if (solos.length) blocks.push({ prio: 6, lines: solos.map(r => '• ' + b_(r.name) + ' ' + e_(Story.rateOf(r) + ' — ' + tg.clip(r.reason, 34))) });
    const hol = holidayCloseLines(date);   // 휴장 안내는 줄이지 않는다
    if (hol.length) blocks.push({ prio: 0, lines: hol.map(e_) });
    return fit(blocks, 1000, tail('오늘 오른 종목·이유 전체 보기', dayUrl(date, 'daily'), true));
}

/** 19:00 저녁 — 뉴스 보강 후 '왜 올랐나' 전체 (텍스트 4096자 이내) */
function evening(date, day, previous, refined, history) {
    const s = storyOf(day, { history: history || (previous ? [previous] : []) });
    const blocks = [{ prio: 0, lines: [b_('🌙 ' + tg.dateKo(date) + ' 오늘 왜 올랐나' + (s.headline && s.flows.length ? ' | ' + s.headline : '')),
        e_('+10% 이상 ' + s.rows.length + '종목 중 이유가 확인된 ' + s.explained + '종목' + (s.limitUps.length ? ' · 상한가 ' + s.limitUps.length : ''))] }];
    // 기사 배경·개별 이유가 있는 흐름은 자세히, 테마로만 묶인 흐름은 한 묶음으로
    const told = s.flows.filter(f => f.kind !== 'sector' && (f.catalyst || f.members.some(r => r.reason)));
    const tagged = s.flows.filter(f => !told.includes(f));
    told.slice(0, 5).forEach((f, i) => {
        const lines = [flowHead(f)];
        const withWhy = f.members.filter(r => r.reason), plain = f.members.filter(r => !r.reason);
        withWhy.slice(0, 4).forEach(r => lines.push('• ' + b_(r.name) + ' ' + e_(Story.rateOf(r) + ' — ' + tg.clip(r.reason, 40))));
        if (plain.length) lines.push('• ' + e_(memberLine(plain, 5) + (plain.length > 5 ? ' 외 ' + (plain.length - 5) : '')));
        blocks.push({ prio: 1 + i, lines });
    });
    if (tagged.length) blocks.push({ prio: 5, lines: [b_('같은 테마로 함께 오른 종목') + e_(' (근거 기사 미확인)')].concat(tagged.slice(0, 4).map(f =>
        '• ' + e_(f.label + ' ' + f.members.length + '종목: ' + memberLine(f.members, 4) + (f.members.length > 4 ? ' 외 ' + (f.members.length - 4) : '')))) });
    if (s.solos.length) blocks.push({ prio: 3, lines: [b_('개별 재료')].concat(s.solos.slice(0, 8).map(r => '• ' + b_(r.name) + ' ' + e_(Story.rateOf(r) + ' — ' + tg.clip(r.reason, 44)))) });
    if (s.ipos.length) blocks.push({ prio: 6, lines: [e_('🆕 신규상장 ' + s.ipos.map(r => r.name + (r.vol ? ' (거래대금 ' + tg.fmtAmount(r.vol) + ')' : '')).join(', '))] });
    if (s.continuing.length) blocks.push({ prio: 4, lines: [e_('🔁 연속 +10%: ' + s.continuing.slice(0, 5).map(r => r.name + '(' + r.streak + '거래일)').join(', '))] });
    if (!s.rows.length) blocks.push({ prio: 0, lines: [e_('오늘은 +10% 이상 오른 종목이 없어요.')] });
    const hol = holidayCloseLines(date, false);
    if (hol.length) blocks.push({ prio: 0, lines: hol.map(e_) });
    return fit(blocks, 3900, tail('📋 ' + s.rows.length + '종목 이유 전체 보기', dayUrl(date, 'evening'), true));
}

/** 장전 브리핑의 '어제 국내' 블록 (HTML 줄 배열) */
function morningBlock(s) {
    if (!s || !s.date) return [];
    const lines = [b_('📌 ' + tg.dateKo(s.date) + ' 국내 마감'),
        e_((s.flows.length ? s.headline + ' · ' : '') + '상한가 ' + s.limitUps.length + ' · +' + core.RISE_CUTOFF + '% 이상 ' + s.hot.length + '종목')];
    const items = [];
    for (const f of s.lead.slice(0, 2)) {
        const lu = f.members.filter(r => r.limit).slice(0, 2).map(r => r.name);
        const first = f.members.find(r => r.reason);
        const why = f.catalyst ? f.catalyst : first ? first.name + ' ' + first.reason : '';
        if (!why && !lu.length) continue;   // 이유도 상한가도 없는 흐름은 개별 재료 종목에 자리를 내준다
        items.push('• ' + b_(f.label) + ' ' + e_(f.members.length + '종목' + (why ? ' — ' + tg.clip(why, 34) : '') + (lu.length ? ' (' + lu.join('·') + ' 상한가)' : '')));
    }
    for (const r of s.solos.slice().sort((a, b) => b.rate - a.rate).slice(0, 3 - items.length)) items.push('• ' + b_(r.name) + ' ' + e_(Story.rateOf(r) + ' — ' + tg.clip(r.reason, 34)));
    lines.push(...items);
    const long = s.flows.filter(f => f.headliner && f.streak >= 3)[0];
    if (long) lines.push(e_('🔁 ' + long.label + ' ' + long.streak + '거래일 연속 급등주가 나왔어요'));
    else if (s.continuing.length) lines.push(e_('🔁 연속 +10%: ' + s.continuing.slice(0, 3).map(r => r.name + '(' + r.streak + '거래일)').join(', ')));
    return lines;
}
// 이전 버전 호환 — 일반론 문구는 더 이상 쓰지 않는다
function morningCheck() { return ''; }

function intraday(date, movers, refined) {
    const lines = [b_('🚀 ' + tg.dateKo(date) + ' 개장 30분 · 개별 주도주'), e_('거래대금이 실린 상승 종목 순서예요.'), ''];
    lines.push(...stockLines(movers.slice(0, TOP_CAPTION_ROWS).map(m => ({ ...m, change_rate: m.rate, trading_value: m.vol })), refined, { volume: true }));
    return closing(lines, '실시간 오른 종목 전체', tg.orgoLink('/rise.html?date=' + date, 'intraday'), false);
}
/** 10:00 오전 테마 — 장중 랭킹을 같은 흐름 규칙으로 묶는다 */
function themes(date, groups, refined, rankings) {
    const s = storyOf({ date, rankings: rankings || [] });
    const lines = [b_('🗺 ' + tg.dateKo(date) + ' 오전 · 테마 확산')];
    const flows = s.lead.concat(s.flows.filter(f => !f.headliner && f.kind !== 'sector')).slice(0, 3);
    if (flows.length) {
        flows.forEach(f => {
            const avg = f.members.reduce((a, r) => a + r.rate, 0) / f.members.length;
            lines.push(b_(f.label) + ' ' + e_(f.members.length + '종목 · 평균 ' + P(avg) + (f.catalyst ? ' — ' + tg.clip(f.catalyst, 30) : '')));
            lines.push('└ ' + e_(memberLine(f.members, 3)));
        });
    } else {
        // 장중 랭킹이 없거나 흐름이 없으면 기존 테마 집계로
        const real = ((groups && groups.themes) || []).filter(g => !isNewListing(g.key) && !/^거래(량|대금)$/.test(String(g.key || '')));
        if (!real.length) lines.push(e_('아직 3종목 이상 함께 오른 테마는 없어요. 개별 종목 장세예요.'));
        real.slice(0, 2).forEach(g => lines.push(e_(String(g.key).replace(/\([^)]*\)/g, '').trim() + ' ' + g.count + '종목 · 평균 ' + tg.pct(g.avgRate) + (g.top ? ' (최고 ' + g.top + ')' : ''))));
    }
    lines.push('', e_('버블=테마 크기, 트리맵=종목 비중이에요.'));
    return closing(lines, '테마 지도 크게 보기', tg.orgoLink('/flowmap.html?view=bubble&date=' + date, 'movers'), false);
}
/** 주간·월간 — 매일의 흐름을 모은 요약 줄 (평문) */
function periodLines(days, unit) {
    const p = Story.period(days || []);
    if (!p.tradingDays) return [];
    const out = [];
    const lead = p.flows.filter(f => f.days >= 2).slice(0, 3);   // 하루만 나온 흐름은 '주도'라 하지 않는다
    if (lead.length) out.push(unit + ' 주도: ' + lead.map(f => f.label + '(' + f.days + '일)').join(' · '));
    if (p.repeat.length) out.push('여러 번 오른 종목: ' + p.repeat.slice(0, 4).map(r => r.name + ' ' + r.days + '회').join(' · '));
    out.push('+' + core.RISE_CUTOFF + '% 이상 ' + p.hot + '건 · 상한가 ' + p.limit + '건 (' + p.tradingDays + '거래일)');
    return out;
}
function calendarObservation(days, start, end) {
    const entries = Object.entries(days || {}).filter(([d]) => d >= start && d <= end && tg.isKrTradingDay(d));
    if (!entries.length) return '해당 기간의 대장 기록이 아직 없어요.';
    const counts = new Map();let empty = 0;
    for (const [, day] of entries) {
        if (!day.stock) { empty++; continue; }
        const key = day.stock.ticker || day.stock.name;
        const item = counts.get(key) || {name:day.stock.name,count:0};item.count++;counts.set(key,item);
    }
    const top = [...counts.values()].sort((a, b) => b.count - a.count)[0];
    if (!top) return '기록된 ' + entries.length + '거래일 모두 대장 조건을 충족한 종목이 없었어요.';
    return '기록된 ' + entries.length + '거래일 · ' + top.name + ' 대장 ' + top.count + '일.' + (empty ? ' 대장 없는 날은 ' + empty + '일.' : '');
}
module.exports = {stockLines, explainedFirst, isDelisting, isNewListing, ipoMark, finalSnapshot, calendarLeaders, activeRows, comparison, previousSnapshot, countLine, daily, intraday, themes, evening, morningCheck, morningBlock, periodLines, headPhrase, storyOf, calendarObservation, holidayCloseLines, holidayMorningLines, usOvernightClosure, holidayNotice};
