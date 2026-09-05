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
    return {leader:stock ? {ticker:stock.ticker,name:stock.name,change_rate:stock.rate,trading_value:stock.vol,theme:stock.theme,sector:stock.sector,market:stock.market} : null,sector:group(entry.sector),theme:group(entry.theme)};
}

function activeRows(day) {
    const rows = new Map();
    for (const r of day?.rankings || []) if (r?.ticker && r.name && core.isActive(r, core.RISE_CUTOFF)) rows.set(r.ticker, r);
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
function finish(lines, label, pathname, campaign, date) {
    const join = pathname.includes('?') ? '&' : '?';
    return tg.escHtml(lines.filter(x => x !== null && x !== undefined).join('\n')) + '\n\n' + tg.htmlLink(label, tg.orgoLink(pathname + (date ? join + 'date=' + date : ''), campaign));
}
function daily(date, leaders, market, refined, day, previous) {
    const lines = ['마감 · ' + tg.dateLabel(date), '', countLine(day, previous)];
    if (market) lines.push('코스피 ' + tg.pct(market.kospi.changePct) + ' · 코스닥 ' + tg.pct(market.kosdaq.changePct));
    const stock = leaders.leader;
    lines.push('', stock ? '오늘의 대장 ' + stock.name + ' ' + tg.pct(stock.change_rate) + ' · 거래 ' + tg.fmtAmount(stock.trading_value) : '오늘은 대장 조건을 충족한 종목이 없어요.');
    const reason = stock && refined?.[stock.ticker];
    if (reason) lines.push(tg.clip(reason, 70));
    if (leaders.theme) lines.push('+' + core.RISE_CUTOFF + '% 테마 집계: ' + leaders.theme.key + ' ' + leaders.theme.count + '종목 · 평균 ' + tg.pct(leaders.theme.avgRate));
    lines.push('버블 지도는 전체 수집 종목, 위 통계는 +15% 이상 기준이에요.');
    lines.push('', '다음 장 확인: 오늘의 대장이 이어지는지, 다른 테마로 바뀌는지.');
    return finish(lines, '대장 캘린더', '/sample2.html', 'daily', date);
}
function intraday(date, movers, refined) {
    const lines = ['장중 · 개별 주도주 / ' + tg.dateLabel(date), '', '거래대금×상승률(최대 30% 반영) 기준 상위 종목이에요.'];
    movers.slice(0, TOP_CAPTION_ROWS).forEach((m, i) => lines.push((i + 1) + '. ' + m.name + ' ' + tg.pct(m.rate) + ' · ' + tg.fmtAmount(m.vol)));
    const reason = movers[0] && refined?.[movers[0].ticker];
    if (reason) lines.push(tg.clip(reason, 70));
    lines.push('', '다음 확인: 한 종목의 상승이 같은 테마로 확산되는지.');
    return finish(lines, '주도주 전체', '/rise.html', 'intraday', date);
}
function themes(date, groups) {
    const lines = ['장중 · 테마 확산 / ' + tg.dateLabel(date), '', 'ORGO 수집 종목 중 +' + core.RISE_CUTOFF + '% 이상 기준'];
    const chosen = groups.themes.length ? groups.themes : groups.sectors;
    chosen.slice(0, 2).forEach(g => lines.push(g.key + ' ' + g.count + '종목 · 평균 ' + tg.pct(g.avgRate)));
    lines.push('지도는 전체 수집 종목, 위 통계는 +15% 이상 기준이에요.');
    lines.push('', '버블로 테마를, 트리맵으로 구성 종목을 볼 수 있어요.', '다음 확인: 상승 종목 수가 늘어나는지, 한두 종목에 그치는지.');
    return finish(lines, '테마 지도', '/flowmap.html?view=bubble', 'movers', date);
}
function evening(date, day, previous, refined) {
    const c = comparison(day, previous);
    const lines = ['저녁 복기 · ' + tg.dateLabel(date), '', countLine(day, previous)];
    if (c) {
        lines.push(tg.mdLabel(c.date) + '에도 +' + core.RISE_CUTOFF + '%였던 종목 ' + c.continuing.length + '개 · 비교일 대비 새로 기준에 든 종목 ' + c.newCount + '개.');
        if (c.continuing.length) lines.push('이어진 종목: ' + c.continuing.slice(0, TOP_CAPTION_ROWS).map(r => r.name + ' ' + tg.pct(r.change_rate)).join(', '));
    }
    const supported = activeRows(day).filter(r => refined?.[r.ticker]).sort((a, b) => b.change_rate - a.change_rate).slice(0, 2);
    if (supported.length) {
        lines.push('', '확인된 설명·관련 보도');
        supported.forEach(r => lines.push(r.name + ' — ' + tg.clip(refined[r.ticker], 65)));
    }
    lines.push('', '다음 장 확인: 새로 들어온 종목이 남는지, 오늘 주도 테마가 이어지는지.');
    return finish(lines, '날짜별 리포트', '/report.html', 'evening', date);
}
function morningCheck(recap) {
    if (!recap) return '개장 후 확인: 첫 주도주와 테마에 상승 종목이 함께 모이는지.';
    const name = recap.topTheme?.key || recap.leader?.name;
    return name ? '개장 후 확인: ' + tg.mdLabel(recap.ymd) + ' 주도 흐름인 ' + name + '에 오늘도 상승 종목이 모이는지.' : '개장 후 확인: 전 거래일과 비교해 상승 종목 수가 늘어나는지.';
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
module.exports = {finalSnapshot, calendarLeaders, activeRows, comparison, previousSnapshot, countLine, daily, intraday, themes, evening, morningCheck, calendarObservation};
