/**
 * 저녁 마감 복기 → 텔레그램 자동 게시 (평일 저녁, 텍스트 전용 — 이미지 없음)
 *   (워크플로: telegram-evening.yml — 샘플 승인 후 연결 예정)
 *
 *   node scripts/telegram_evening_recap.js            # 실제 게시 (시크릿 필요)
 *   node scripts/telegram_evening_recap.js --dry-run  # 전송 안 함, 캡션만 산출(검증용)
 *   node scripts/telegram_evening_recap.js --date=YYYYMMDD  # 과거일 샘플
 *
 * 구성(사실 복기만 — 추천·전망 표현 금지, 유사투자자문 가드):
 *   ① 오늘 요약 — 급등 종목수·상한가 수
 *   ② 상한가 복기 — 종목별 '이름(딥링크) +% — 이유(LLM 정제 우선)'
 *      (상한가 없으면 +20%↑ 상위로 대체)
 *   ③ 2일 연속 급등 — 어제·오늘 모두 +10%↑ 종목
 *   ④ 1년 급등 단골 — 오늘 급등 중 1년 누적 +10% 횟수 상위 (stock-history stats)
 *   ⑤ AI 한 줄(담백 규칙, 특이사항 없으면 생략) + 리포트 딥링크
 *
 * 필요한 환경변수(=GitHub Secrets): TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / ANTHROPIC_API_KEY(선택)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./build_leaders_calendar.js');
const tg = require('./tg_common.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DATE_ARG = ((process.argv.find(function (a) { return a.indexOf('--date=') === 0; }) || '').split('=')[1] || '').trim();
const PUBLIC = path.resolve(__dirname, '..', 'public');
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-evening.json');
const STOCK_HISTORY_DIR = path.resolve(PUBLIC, 'data', 'stock-history');
const RAW = core.RAW;

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-sonnet-5').trim();

const LIMIT_UP_CUTOFF = 29.5;   // 상한가 간주(%) — report-core 관행과 동일
const BIG_CUTOFF = 20;          // 상한가 없을 때 대체 섹션 기준(%)
const RECAP_MAX = 5;            // 상한가/급등 복기 최대 종목 수
const STREAK_MAX = 5;           // 2일 연속 급등 최대 표시 수
const REGULAR_MIN_COUNT = 5;    // '급등 단골' 최저 1년 누적 횟수
const REGULAR_MAX = 3;          // 급등 단골 최대 표시 수
const REGULAR_SCAN = 10;        // 단골 후보로 살펴볼 오늘 상승률 상위 종목 수
const REASON_CLIP = 30;         // 이유 표시 상한(자) — LLM 정제 사유 상한과 동일

function reasonOf(row, refined) {
    return String((refined && refined[row.ticker]) || row.rise_reason || '').trim();
}

// 로컬 stock-history 에서 1년 +10% 누적 횟수 — 파일 없으면 null (섹션에서 제외)
function count10Of(ticker) {
    try {
        var h = JSON.parse(fs.readFileSync(path.join(STOCK_HISTORY_DIR, ticker + '.json'), 'utf8'));
        var c = h && h.stats && h.stats.count_10;
        return (typeof c === 'number' && c > 0) ? c : null;
    } catch (e) { return null; }
}

// ── 섹션 데이터 ──
function buildSections(day, prevDay) {
    var rows = day.rankings || [];
    var active = rows.filter(function (r) { return core.isActive(r, core.RISE_CUTOFF); });
    var byRate = active.slice().sort(function (a, b) { return core.num(b.change_rate) - core.num(a.change_rate); });

    var limitUps = byRate.filter(function (r) { return core.num(r.change_rate) >= LIMIT_UP_CUTOFF; });
    var recap = limitUps.length ? { title: '⛔ 상한가 복기', rows: limitUps.slice(0, RECAP_MAX) }
        : { title: '🚀 오늘 급등 상위', rows: byRate.filter(function (r) { return core.num(r.change_rate) >= BIG_CUTOFF; }).slice(0, Math.min(RECAP_MAX, 3)) };

    var prevActive = {};
    ((prevDay && prevDay.rankings) || []).forEach(function (r) {
        if (r && r.ticker && core.isActive(r, core.RISE_CUTOFF)) prevActive[r.ticker] = core.num(r.change_rate);
    });
    var streaks = byRate.filter(function (r) { return prevActive[r.ticker] != null; })
        .slice(0, STREAK_MAX)
        .map(function (r) { return { name: r.name, prev: prevActive[r.ticker], cur: core.num(r.change_rate) }; });

    var regulars = [];
    byRate.slice(0, REGULAR_SCAN).forEach(function (r) {
        if (regulars.length >= REGULAR_MAX) return;
        var c = count10Of(r.ticker);
        if (c != null && c >= REGULAR_MIN_COUNT) regulars.push({ name: r.name, ticker: r.ticker, count: c });
    });

    return { riseCount: active.length, limitUpCount: limitUps.length, recap: recap, streaks: streaks, regulars: regulars };
}

// ── 캡션 (parse_mode:'HTML' — 상한가 복기 종목명만 딥링크) ──
function buildCaption(ymd, S, refined, comment) {
    var parts = [];
    function plain(s) { parts.push(tg.escHtml(s)); }

    plain('🌙 마감 복기 (' + tg.dateLabel(ymd) + ')');
    plain('');
    plain('급등(+' + core.RISE_CUTOFF + '%↑) ' + S.riseCount + '종목 · 상한가 ' + S.limitUpCount + '종목');
    plain('');
    if (S.recap.rows.length) {
        plain(S.recap.title);
        S.recap.rows.forEach(function (r) {
            var reason = reasonOf(r, refined);
            parts.push(tg.htmlLink(r.name, tg.orgoLink('/stock/' + r.ticker, 'evening')) +
                tg.escHtml(' ' + tg.pct(r.change_rate) + (reason ? ' — ' + tg.clip(reason, REASON_CLIP) : '')));
        });
        plain('');
    }
    if (S.streaks.length) {
        plain('📈 2일 연속 급등');
        S.streaks.forEach(function (s) {
            plain(s.name + ' (어제 ' + tg.pct(s.prev) + ' → 오늘 ' + tg.pct(s.cur) + ')');
        });
        plain('');
    }
    if (S.regulars.length) {
        plain('🔁 1년 급등 단골');
        S.regulars.forEach(function (r) {
            plain(r.name + ' — 최근 1년 +10% 급등 ' + r.count + '회');
        });
        plain('');
    }
    if (comment) { plain(comment); plain(''); }   // 특이사항 없으면 멘트 줄 자체를 생략
    parts.push(tg.htmlLink('👉 오늘 리포트 전체 보기', tg.orgoLink('/report.html', 'evening')));
    return parts.join('\n');
}

async function aiLine(ymd, S) {
    var summary = {
        날짜: tg.dateLabel(ymd) + ' 마감 복기(저녁)',
        급등: S.riseCount + '종목, 상한가 ' + S.limitUpCount + '종목',
        상한가: S.recap.rows.slice(0, 3).map(function (r) { return r.name + ' ' + tg.pct(r.change_rate); }).join(', '),
        연속: S.streaks.map(function (s) { return s.name; }).join(', '),
    };
    return tg.aiHook('마감 복기(저녁, 오늘 급등 사실 정리)', summary, ANTHROPIC_KEY, MODEL, '');
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }

    var today = DATE_ARG || tg.ymdKst();
    var dates = await core.fetchJson(RAW + '/dates.json');
    var sorted = Array.isArray(dates) ? dates.slice().sort() : [];
    if (!DATE_ARG) {
        var latest = sorted.length ? sorted[sorted.length - 1] : '';
        if (latest !== today) { console.log('오늘(' + today + ') 마감 데이터 없음(최신=' + latest + ') — 스킵'); return; }
    }
    if (!DRY && !FORCE) {
        var mk = tg.loadMarker(MARKER);
        if (mk && mk.last === today) { console.log('이미 오늘(' + today + ') 저녁 복기 게시함 — 스킵'); return; }
    }

    var prevYmd = sorted.filter(function (d) { return d < today; }).slice(-1)[0] || '';
    var day = await core.fetchJson(RAW + '/' + today + '.json');
    var prevDay = null;
    if (prevYmd) {
        try { prevDay = await core.fetchJson(RAW + '/' + prevYmd + '.json'); }
        catch (e) { console.error('전일 데이터 실패(연속 섹션 생략):', e.message); }
    }

    var S = buildSections(day, prevDay);
    if (!S.recap.rows.length && !S.streaks.length && !S.regulars.length) {
        console.log('복기할 급등 내용 없음 — 스킵(조용한 날은 안 보냄)');
        return;
    }

    var refined = await tg.fetchRefinedReasons(today);   // LLM 정제 사유 우선(없으면 raw 폴백)
    var comment = await aiLine(today, S);
    var caption = buildCaption(today, S, refined, comment);
    console.log('----- 캡션 -----\n' + caption + '\n----------------');

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendMessage(BOT_TOKEN, CHAT_ID, caption, { parse_mode: 'HTML' });
    console.log('게시 완료 — message_id', r.result && r.result.message_id);
    tg.saveMarker(MARKER, { last: today, message_id: r.result && r.result.message_id, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
