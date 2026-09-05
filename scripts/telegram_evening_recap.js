/**
 * 저녁 마감 복기 → 텔레그램 자동 게시 (평일 저녁, 텍스트 전용 — 이미지 없음)
 *   (워크플로: telegram-evening.yml — 샘플 승인 후 연결 예정)
 *
 *   node scripts/telegram_evening_recap.js            # 실제 게시 (시크릿 필요)
 *   node scripts/telegram_evening_recap.js --dry-run  # 전송 안 함, 캡션만 산출(검증용)
 *   node scripts/telegram_evening_recap.js --date=YYYYMMDD  # 과거일 샘플
 *
 * 구성: 확정 수집 종목 수 변화 + 비교일의 재등장/신규 종목 + 검증 이유 + 다음 장 확인점.
 * 유료 AI 호출 없이 동일 데이터에서 같은 관찰 문장을 만든다.
 *
 * 필요한 환경변수(=GitHub Secrets): TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 */
'use strict';
const path = require('path');
const tg = require('./tg_common.js');
const editorial = require('./tg_editorial.js');
const market = require('./tg_market.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DATE_ARG = ((process.argv.find(function (a) { return a.indexOf('--date=') === 0; }) || '').split('=')[1] || '').trim();
const PUBLIC = path.resolve(__dirname, '..', 'public');
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-evening.json');

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }

    var today = DATE_ARG || tg.ymdKst();
    if (!DATE_ARG && !FORCE) {
        // 휴장일 2중 가드 — 캘린더(공휴일) + 네이버 실측(임시휴장, 2026-07-17 사고 방어)
        if (!tg.isKrTradingDay(today)) { console.log('휴장일(' + today + ', 캘린더) — 스킵'); return; }
        var traded = await market.isKrTradedToday(today);
        if (!traded.ok) { console.log('휴장일(실측 거래일=' + traded.tradedYmd + ') — 스킵'); return; }
    }
    if (!DRY && !FORCE) {
        var mk = tg.loadMarker(MARKER);
        if (mk && mk.last === today) { console.log('이미 오늘(' + today + ') 저녁 복기 게시함 — 스킵'); return; }
    }

    var day = editorial.finalSnapshot(PUBLIC, today);
    var prevDay = editorial.previousSnapshot(PUBLIC, day);
    var refined = await tg.fetchRefinedReasons(today);   // 날짜·근거 검증 사유만 사용
    var caption = editorial.evening(today, day, prevDay, refined);
    console.log('----- 캡션 -----\n' + caption + '\n----------------');

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendMessage(BOT_TOKEN, CHAT_ID, caption, { parse_mode: 'HTML' });
    console.log('게시 완료 — message_id', r.result && r.result.message_id);
    tg.saveMarker(MARKER, { last: today, message_id: r.result && r.result.message_id, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
