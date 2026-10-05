/**
 * 장전 브리핑 → 텔레그램 자동 게시 (평일 아침, 텍스트 전용 — 이미지 없음)
 *
 *   node scripts/telegram_morning_brief.js            # 실제 게시
 *   node scripts/telegram_morning_brief.js --dry-run  # 전송 안 함, 캡션만 산출(검증용)
 *
 * 구성: ① 간밤 미국 마감(S&P·나스닥·다우·SOX·VIX) + 원/달러 — Yahoo chart API
 *       ② 전 거래일 국내 복기 — stock-rise raw(급등 종목수·상한가·대장주·핫테마, 캘린더 로직 재사용)
 *       ③ 전일 흐름을 기준으로 개장 후 확인점
 *
 * 필요한 환경변수(=GitHub Secrets): TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 */
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./build_leaders_calendar.js');
const tg = require('./tg_common.js');
const editorial = require('./tg_editorial.js');
const market = require('./tg_market.js');
const Story = require('./market_story.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const PUBLIC = path.resolve(__dirname, '..', 'public');
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-morning.json');   // 중복 게시 방지(크론 이중 발동)
const LIMIT_UP_CUTOFF = 29.5;   // 상한가 간주 기준(%) — report-core 와 동일 관행

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

// 소수 지수 표기 — 지수는 소수 2자리, 환율은 1자리
function idx(n) { return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fx(n) { return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function arrow(p) { return p > 0 ? '🔺' : p < 0 ? '🔻' : '⏸'; }

// ── 전 거래일 국내 복기 — 자체 확정 스냅샷, 없으면(빌드 지연) 상류 stock-rise 확정본 ──
function prevTradingDay(today) {
    var d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6, 8)));
    for (var i = 0; i < 10; i++) {
        d.setUTCDate(d.getUTCDate() - 1);
        var ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
        if (tg.isKrTradingDay(ymd)) return ymd;
    }
    return '';
}
async function fetchYesterdayRecap(today) {
    var want = prevTradingDay(today);
    var day = null;
    try {
        var own = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'rise-history', want + '.json'), 'utf8'));
        if (own.date === want && own.is_final === true) day = own;
    } catch (_) { /* 자체 스냅샷 없음 */ }
    if (!day && want) {
        try {
            var up = await core.fetchJson(core.RAW + '/' + want + '.json');
            if (up && Array.isArray(up.rankings)) day = { date: want, is_final: true, rankings: up.rankings };
        } catch (e) { console.error('상류 전일 데이터 실패:', e.message); }
    }
    if (!day) day = editorial.previousSnapshot(PUBLIC, { date: today, is_final: true, rankings: [] });
    if (!day) return null;
    var last = day.date;
    var leader = null;
    try { leader = editorial.calendarLeaders(PUBLIC, last, day).leader; } catch (_) { /* 캘린더 미반영 */ }
    // 어제 흐름 — 마감·저녁과 같은 규칙(market_story), 연속일은 그 전 거래일들 기준
    return Story.build(Story.withSnapshot(PUBLIC, day), {
        leader: leader ? { ticker: leader.ticker, name: leader.name, rate: leader.change_rate, vol: leader.trading_value, listing_day: leader.listing_day } : null,
        history: Story.loadHistory(PUBLIC, last, 10),
    });
}

// ── 캡션 ── 해외는 한 줄 요약, 핵심은 '어제 왜 올랐나'
function buildCaption(todayYmd, quotes, fxQuote, recap, comment) {
    var e = tg.escHtml;
    var lines = ['<b>' + e('🌅 ' + tg.dateKo(todayYmd) + ' 장전 브리핑') + '</b>', ''];
    var by = {};
    quotes.forEach(function (q) { by[q.label] = q; });
    // 간밤 미국 정규장이 쉬었으면 시세는 그 전 거래일 값이다 — 등락률 대신 휴장이라고 쓴다
    var usClosed = editorial.usOvernightClosure(todayYmd);
    var us = ['S&P 500', '나스닥', '반도체(SOX)'].filter(function (k) { return by[k]; })
        .map(function (k) { return k.replace(' 500', '') + ' ' + tg.pct(by[k].changePct); });
    if (usClosed) lines.push(e('🇺🇸 간밤 미국 증시 휴장(' + usClosed.name + ')'));
    else if (us.length) lines.push(e('🇺🇸 간밤 ' + us.join(' · ')));
    var extra = [];
    if (by.VIX && !usClosed) extra.push('VIX ' + idx(by.VIX.price));
    if (fxQuote) extra.push('원/달러 ' + fx(fxQuote.price) + '원');
    if (extra.length) lines.push(e('   ' + extra.join(' · ')));
    // 휴장 안내 — 오늘 해외 휴장·단축장, 일주일 안의 국내 휴장(대체공휴일 포함)
    var hol = editorial.holidayMorningLines(todayYmd);
    if (hol.length) { lines.push(''); hol.forEach(function (h) { lines.push(e(h)); }); }
    if (recap) {
        lines.push('');
        lines.push.apply(lines, editorial.morningBlock(recap));
    }
    if (comment) { lines.push(''); lines.push(e(comment)); }
    var link = recap ? tg.htmlLink(tg.dateKo(recap.date, false) + ' 오른 종목·이유 전체', tg.orgoLink('/rise.html?date=' + recap.date, 'morning'))
        : tg.htmlLink('대장 캘린더', tg.orgoLink('/sample2.html', 'morning'));
    return lines.join('\n') + '\n\n' + link;
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }
    var today = tg.ymdKst();
    // 주말+공휴일 캘린더 가드 — 장전(07:30)엔 네이버 실측 거래일 확인이 불가능(항상 전 거래일이
    // 나옴)해서 캘린더(kr_holidays.json)가 유일한 가드다. 임시휴장은 공지 즉시 JSON에 추가할 것.
    // 달력 범위 밖(다음 해 휴장일 미등록)이면 확정할 수 없으므로 게시하지 않고 워크플로를 실패로 남긴다.
    tg.logHolidayWarnings(today);
    if (!DRY && !FORCE) {
        var block = tg.krPublishBlock(today, false);
        if (block) {
            console.log(block + ' — 게시 스킵');
            if (!tg.krCalendarCovers(today)) process.exitCode = 1;
            return;
        }
    }
    if (!DRY && !FORCE) {
        var mk = tg.loadMarker(MARKER);
        if (mk.last === today) { console.log('이미 오늘(' + today + ') 게시함 — 스킵'); return; }
    }

    // ① 해외 시세 — 부분 실패는 성공분만, 전부 실패면 게시 자체를 중단(빈 브리핑 방지)
    var quotes = await market.fetchGlobalQuotes(market.GLOBAL_SYMBOLS);
    var fxQuote = null;
    try { fxQuote = await market.fetchGlobalQuote(market.FX_SYMBOL); }
    catch (e) { console.error('환율 실패:', e.message); }
    if (!quotes.length && !fxQuote) throw new Error('해외 시세 전체 실패 — 게시 중단');

    // ② 전 거래일 복기 — 실패해도 브리핑은 발송(블록 생략)
    var recap = null;
    try { recap = await fetchYesterdayRecap(today); }
    catch (e) { console.error('국내 복기 실패(블록 생략):', e.message); }

    var comment = '';   // 일반론 '오늘 볼 것' 문구는 쓰지 않는다 — 연속 흐름은 morningBlock 이 데이터로 싣는다

    var caption = buildCaption(today, quotes, fxQuote, recap, comment);
    console.log('----- 캡션 -----\n' + caption + '\n----------------');

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendMessage(BOT_TOKEN, CHAT_ID, caption, { parse_mode: 'HTML' });
    console.log('게시 완료 — message_id', r.result && r.result.message_id);
    tg.saveMarker(MARKER, { last: today, message_id: r.result && r.result.message_id, at: new Date().toISOString().slice(0, 19) });
}

if (require.main === module) main().catch(function (e) { console.error(e); process.exit(1); });
module.exports = { buildCaption: buildCaption };
