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
function dayUrl(date, campaign) { return tg.orgoLink('/day/' + date, campaign); }
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

function daily(date, leaders, market, refined, day, previous) {
    const stock = leaders.leader;
    const rows = activeRows(day).sort((a, b) => b.change_rate - a.change_rate);
    const c = comparison(day, previous);
    const head = stock
        ? '🏆 ' + md(date) + ' 마감 · 오늘의 대장은 ' + stock.name
        : '🏆 ' + md(date) + ' 마감 · 오늘은 대장 조건을 충족한 종목이 없어요';
    const lines = [b_(head)];
    if (stock) {
        lines.push(e_(stock.name + ipoMark(stock) + ' ' + tg.pct(stock.change_rate) + ' · 거래대금 ' + tg.fmtAmount(stock.trading_value)));
        const why = whyOf(refined, stock);
        if (why) lines.push('└ ' + e_(why));
    }
    lines.push('');
    const delta = c ? c.count - c.previousCount : null;
    lines.push(e_('📈 +' + core.RISE_CUTOFF + '% 이상 ' + rows.length + '종목' +
        (c ? ' (' + md(c.date) + ' 대비 ' + (delta ? (delta > 0 ? '+' : '') + delta : '동일') + ')' : '')));
    if (market) lines.push(e_('📊 코스피 ' + tg.pct(market.kospi.changePct) + ' · 코스닥 ' + tg.pct(market.kosdaq.changePct)));
    if (leaders.theme) lines.push(e_('🔥 테마 ' + leaders.theme.key + ' ' + leaders.theme.count + '종목 · 평균 ' + tg.pct(leaders.theme.avgRate)));
    const top = explainedFirst(rows.filter(r => !stock || r.ticker !== stock.ticker), refined, 3);
    if (top.length) { lines.push('', b_('함께 오른 종목')); lines.push(...stockLines(top, refined)); }
    return closing(lines, '오늘 오른 종목·이유 전체 보기', dayUrl(date, 'daily'), true);
}
function intraday(date, movers, refined) {
    const lines = [b_('🚀 ' + md(date) + ' 개장 30분 · 개별 주도주'), e_('돈이 가장 많이 몰린 상승 종목이에요.'), ''];
    lines.push(...stockLines(movers.slice(0, TOP_CAPTION_ROWS).map(m => ({ ...m, change_rate: m.rate, trading_value: m.vol })), refined, { volume: true }));
    return closing(lines, '실시간 오른 종목 전체', tg.orgoLink('/rise.html?date=' + date, 'intraday'), false);
}
function themes(date, groups, refined, rankings) {
    const realThemes = (groups.themes || []).filter(g => !isNewListing(g.key) && !/^거래(량|대금)$/.test(String(g.key || '')));
    const chosen = realThemes.length ? realThemes : groups.sectors;
    const lines = [b_('🗺 ' + md(date) + ' 오전 · 테마 확산 지도')];
    if (!chosen.length) lines.push(e_('아직 3종목 이상 함께 오른 테마는 없어요. 개별 종목 장세예요.'));
    chosen.slice(0, 2).forEach((g, i) => {
        lines.push(e_((i ? '' : '가장 뜨거운 테마 ') + g.key + ' ' + g.count + '종목 · 평균 ' + tg.pct(g.avgRate) + (g.top ? ' (최고 ' + g.top + ')' : '')));
        const r = g.top && refined ? (rankings || []).find(x => x && x.name === g.top) : null;
        const why = r ? whyOf(refined, r) : '';
        if (why) lines.push('   └ ' + e_(why));
    });
    lines.push('', e_('버블=테마 크기, 트리맵=종목 비중이에요.'));
    return closing(lines, '테마 지도 크게 보기', tg.orgoLink('/flowmap.html?view=bubble&date=' + date, 'movers'), false);
}
function evening(date, day, previous, refined) {
    const c = comparison(day, previous);
    const rows = activeRows(day).sort((a, b) => b.change_rate - a.change_rate);
    const known = rows.filter(r => refined?.[r.ticker]);
    const lines = [b_('🌙 ' + md(date) + ' 오늘 왜 올랐나')];
    lines.push(e_('+' + core.RISE_CUTOFF + '% 이상 ' + rows.length + '종목 중 이유가 확인된 ' + known.length + '종목을 정리했어요.'));
    lines.push('');
    lines.push(...stockLines(explainedFirst(rows, refined, 5), refined));
    if (c && c.continuing.length) {
        lines.push('', e_('🔁 이틀 연속 +' + core.RISE_CUTOFF + '%: ' + c.continuing.slice(0, 3).map(r => r.name).join(', ')));
    }
    lines.push('', e_('👀 내일 체크: 오늘 오른 테마에 상승 종목이 더 붙는지'));
    return closing(lines, '📋 ' + rows.length + '종목 이유 전체 보기', dayUrl(date, 'evening'), true);
}
function morningCheck(recap) {
    if (!recap) return '👀 오늘 볼 것: 첫 30분 주도주와 같은 테마로 상승이 번지는지';
    const name = recap.topTheme?.key || (recap.leader && !recap.leader.listing_day ? recap.leader.name : '');
    return name ? '👀 오늘 볼 것: 어제 주도한 ' + String(name).replace(/\([^)]*\)/g, '').trim() + ' 흐름이 이어지는지' : '👀 오늘 볼 것: 상승 종목 수가 어제보다 늘어나는지';
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
module.exports = {stockLines, explainedFirst, isDelisting, isNewListing, ipoMark, finalSnapshot, calendarLeaders, activeRows, comparison, previousSnapshot, countLine, daily, intraday, themes, evening, morningCheck, calendarObservation};
