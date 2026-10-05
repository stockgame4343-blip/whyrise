'use strict';
/**
 * 날짜별 '오늘의 흐름' 요약 → public/data/day-story/{date}.json
 *
 * 날짜별 SEO 페이지(prerender_days.py)가 쓰레드·블로그·텔레그램과 같은 흐름·제목을 보여주도록
 * market_story.js 결과를 날짜마다 JSON 으로 남긴다. 빌드 시각을 넣지 않아 데이터가 같으면 파일도 같다.
 *
 *   node scripts/build_day_stories.js            # 전체 날짜
 *   node scripts/build_day_stories.js 20261002   # 특정 날짜만
 */
const fs = require('fs');
const path = require('path');
const Story = require('./market_story');
const Copy = require('./marketing_copy');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const RISE_DIR = path.join(PUBLIC, 'data', 'rise-history');
const OUT_DIR = path.join(PUBLIC, 'data', 'day-story');

function brief(r) {
    return { ticker: r.ticker, name: r.name, rate: Math.round(r.rate * 100) / 100, vol: Math.round(r.vol),
        reason: r.reason || '', why: Story.whyOf(r), tag: Story.tagOf(r), limit: r.limit, ipo: r.ipo, streak: r.streak };
}

function dayStory(date, day, calendar, history) {
    const leader = calendar && calendar[date] ? calendar[date].stock : null;
    const m = Copy.material({ date, rows: day.rankings, leader, history, prevCloses: day._prevCloses, altRates: day._altRates });
    const s = m.story;
    return {
        date, headline: s.headline, title: Copy.pageTitle(m), description: Copy.pageDesc(m), hook: Copy.threadsHook(s),
        hot: s.hot.length, prev_hot: s.prevHot, limit_ups: s.limitUps.map(brief), explained: s.explained, total: s.rows.length,
        // 날짜별 페이지 표에 실을 종목(검증을 통과한 종목)과 그 등락률 — {티커: 등락률}
        rates: Object.fromEntries(s.rows.map(r => [r.ticker, Math.round(r.rate * 100) / 100])), ipo_tickers: s.ipos.map(r => r.ticker),
        // 같은 날 근거로 확인된 '왜' — 날짜별 페이지 표도 쓰레드·블로그와 같은 이유만 이유 자리에 싣는다
        whys: Object.fromEntries(s.rows.filter(r => Story.whyOf(r)).map(r => [r.ticker, Story.whyOf(r)])),
        flows: s.flows.map(f => ({ label: f.label, word: Copy.flowWord(f), kind: f.kind, headliner: !!f.headliner, catalyst: f.catalyst, streak: f.streak,
            limit_ups: f.limitUps, vol: Math.round(f.vol), members: f.members.map(brief) })),
        solos: s.solos.map(brief), ipos: s.ipos.map(brief), money: s.money.map(brief),
        continuing: s.continuing.filter(r => !r.ipo).map(brief), high52: s.high52.map(brief), abnormal: s.abnormal,
    };
}

function writeIfChanged(file, text) {
    try { if (fs.readFileSync(file, 'utf8') === text) return false; } catch (_) { /* 새 파일 */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return true;
}

function main(only) {
    let calendar = {};
    try { calendar = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'leaders-calendar.json'), 'utf8')).days || {}; } catch (_) { /* 캘린더 없음 */ }
    const dates = fs.readdirSync(RISE_DIR).filter(f => /^\d{8}\.json$/.test(f)).map(f => f.slice(0, 8)).sort();
    let written = 0, same = 0;
    for (const date of dates) {
        if (only && date !== only) continue;
        let day;
        try { day = JSON.parse(fs.readFileSync(path.join(RISE_DIR, date + '.json'), 'utf8')); } catch (_) { continue; }
        if (!day || day.date !== date || !Array.isArray(day.rankings)) continue;
        const story = dayStory(date, Story.withSnapshot(PUBLIC, day), calendar, Story.loadHistory(PUBLIC, date, 10));
        if (writeIfChanged(path.join(OUT_DIR, date + '.json'), JSON.stringify(story) + '\n')) written++; else same++;
    }
    console.log(`  [day-story] ${written} 갱신, ${same} 동일`);
}

if (require.main === module) {
    const arg = process.argv[2] || '';
    if (arg && !/^\d{8}$/.test(arg)) { console.error('usage: build_day_stories.js [YYYYMMDD]'); process.exit(1); }
    main(arg);
}
module.exports = { dayStory };
