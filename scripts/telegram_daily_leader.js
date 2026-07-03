/**
 * 오늘의 대장 → 텔레그램 자동 게시 (매일 마감후)
 *
 *   node scripts/telegram_daily_leader.js            # 실제 게시
 *   node scripts/telegram_daily_leader.js --dry-run  # 전송 안 함, 이미지+캡션만 산출(검증용)
 *
 * 동작: ① stock-rise 최신일 랭킹으로 대장 3종 계산(캘린더 빌드와 동일 로직 재사용)
 *       ② 정사각 이미지 렌더(홈 리포트 카드 캡쳐 방식, headless Chromium)
 *       ③ 캡션 생성 + 마지막 한 줄 멘트는 Claude API 로 매일 새로 작성(실패 시 템플릿 폴백)
 *       ④ Telegram Bot API sendPhoto 로 채널 게시
 *
 * 필요한 환경변수(=GitHub Secrets):
 *   TELEGRAM_BOT_TOKEN   BotFather 봇 토큰
 *   TELEGRAM_CHAT_ID     채널 chat_id (또는 @publicchannel)
 *   ANTHROPIC_API_KEY    (선택) AI 멘트용. 없으면 템플릿 멘트.
 *   TELEGRAM_MODEL       (선택) 기본 claude-haiku-4-5-20251001
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const core = require('./build_leaders_calendar.js');
const tg = require('./tg_common.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DATE_ARG = ((process.argv.find(function (a) { return a.indexOf('--date=') === 0; }) || '').split('=')[1] || '').trim();  // 샘플용 과거 날짜
const PUBLIC = path.resolve(__dirname, '..', 'public');
const OUT_IMG = path.resolve(__dirname, '..', 'telegram-daily.png');            // 1번: 대장 카드
const IMG_TB = path.resolve(__dirname, '..', 'telegram-daily-theme-bubble.png'); // 2번: 장마감 핫테마 버블
const IMG_TT = path.resolve(__dirname, '..', 'telegram-daily-theme-tree.png');   // 3번: 장마감 핫테마 트리
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-posted.json');  // 중복 게시 방지(크론 이중 발동)
const RAW = core.RAW;

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-sonnet-5').trim();

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

// 원 → "1.5조" / "3,164억" (report.js fmtAmount 와 동일 톤)
function fmtAmount(won) {
    won = num(won);
    if (won >= 1e12) return (Math.round(won / 1e11) / 10).toLocaleString('ko-KR') + '조';
    if (won >= 1e8) return Math.round(won / 1e8).toLocaleString('ko-KR') + '억';
    if (won > 0) return Math.round(won / 1e4).toLocaleString('ko-KR') + '만';
    return '-';
}
function pct(v) { var n = num(v); return (n >= 0 ? '+' : '') + (Math.round(n * 10) / 10).toFixed(1) + '%'; }
function ymdKst() {
    var k = new Date(Date.now() + 9 * 3600000);
    return k.getUTCFullYear() + ('0' + (k.getUTCMonth() + 1)).slice(-2) + ('0' + k.getUTCDate()).slice(-2);
}
function dateLabel(ymd) {
    var y = ymd.slice(0, 4), m = ymd.slice(4, 6), d = ymd.slice(6, 8);
    var dow = WEEKDAY[new Date(+y, +m - 1, +d).getDay()];
    return y + '.' + m + '.' + d + ' ' + dow;
}
function marketLabel(m) {
    m = String(m || '').toUpperCase();
    if (m.indexOf('KOSDAQ') >= 0) return 'KOSDAQ';
    if (m.indexOf('KOSPI') >= 0 || m.indexOf('KRX') >= 0) return 'KOSPI';
    return m || '';
}

// ── 대장 3종 계산 (캘린더 빌드와 동일) + 캡션용 리치 필드 ──
function computeLeaders(rankings) {
    var leader = core.pickLeader(rankings);
    var active = (rankings || []).filter(function (r) { return core.isActive(r, core.RISE_CUTOFF); });
    var sectors = core.buildGroups(active, 'sector');
    var themes = core.buildGroups(active, 'theme');
    return { leader: leader, sector: sectors[0] || null, theme: themes[0] || null };
}

function detailTag(leader) {
    return core.themeOf(leader) || String(leader.sector || '').trim() || '대장';
}

// ── 캡션(구조 텍스트) ──
function buildCaption(ymd, L, comment) {
    var lines = [];
    lines.push('🔥 오늘의 대장 (' + dateLabel(ymd) + ')');
    lines.push('');
    if (L.leader) {
        var mk = marketLabel(L.leader.market);
        lines.push('🥇 대장주');
        lines.push(L.leader.name + (mk ? '(' + mk + ')' : ''));
        lines.push(pct(L.leader.change_rate) + ' · 거래대금 ' + fmtAmount(L.leader.trading_value));
        var reason = String(L.leader.rise_reason || '').trim();
        lines.push('[' + detailTag(L.leader) + ']' + (reason ? ' ' + reason : ''));
        lines.push('');
    } else {
        lines.push('🥇 대장주');
        lines.push('해당 없음 — 오늘은 대장주 조건에 맞는 종목이 없었어요');
        lines.push('');
    }
    if (L.sector) {
        lines.push('🏢 대장섹터');
        lines.push(L.sector.key + ' ' + L.sector.count + '종목');
        lines.push('평균 ' + pct(L.sector.avgRate) + ' · 거래 ' + fmtAmount(L.sector.totalVolume));
        lines.push('1위 ' + L.sector.top + ' ' + pct(L.sector.topRate));
        lines.push('');
    }
    if (L.theme) {
        lines.push('🏷️ 대장테마');
        lines.push(L.theme.key + ' ' + L.theme.count + '종목');
        lines.push('평균 ' + pct(L.theme.avgRate) + ' · 거래 ' + fmtAmount(L.theme.totalVolume));
        lines.push('1위 ' + L.theme.top + ' ' + pct(L.theme.topRate));
        lines.push('');
    }
    lines.push(comment);
    lines.push('');
    // 바로가기 — HTML 텍스트 링크(긴 URL 미노출, utm 으로 효과 측정).
    // 본문은 통째로 이스케이프 후 링크 줄만 붙인다 (parse_mode:'HTML').
    var links = [];
    if (L.leader && L.leader.ticker) {
        links.push(tg.htmlLink('👉 ' + L.leader.name + ' 이유·1년 이력 보러가기', tg.orgoLink('/stock/' + L.leader.ticker, 'daily')));
    }
    links.push(tg.htmlLink('👉 오늘 오른 종목 전부 보기', tg.orgoLink('/rise.html', 'daily')));
    return tg.escHtml(lines.join('\n')) + '\n' + links.join('\n');
}

// 템플릿 멘트(폴백) — AI 없을 때
function templateComment(L) {
    var subj = (L.theme && L.theme.key) || (L.sector && L.sector.key) || (L.leader && L.leader.name);
    if (!subj) return '오늘도 시장 잘 살펴보세요 👀';
    // 조사 문제 회피 — '쪽'은 받침 유무와 무관하게 자연스러움
    return '오늘은 ' + subj + ' 쪽 상승이 많았어요';
}

// ── AI 멘트 (Claude) ──
async function aiComment(ymd, L) {
    if (!ANTHROPIC_KEY) return templateComment(L);
    var summary = {
        date: dateLabel(ymd),
        대장주: L.leader ? (L.leader.name + ' ' + pct(L.leader.change_rate) + ' / ' + detailTag(L.leader) + ' / ' + (L.leader.rise_reason || '')) : '없음',
        대장섹터: L.sector ? (L.sector.key + ' 평균 ' + pct(L.sector.avgRate)) : '없음',
        대장테마: L.theme ? (L.theme.key + ' 평균 ' + pct(L.theme.avgRate)) : '없음',
    };
    var prompt = '아래는 한국 주식시장 그날의 "오늘의 대장" 요약이야. 텔레그램 채널 구독자에게 ' +
        '오늘 장 마감을 담백하게 한 줄로 정리해줘. 한 문장 45자 내외, 이모지 0~1개. ' +
        '사실 서술만 — 호들갑·감탄·드라마화 금지, 평범한 날이면 평범하게. ' +
        '숫자 나열 금지, 과장·투자권유·목표가 금지. 따옴표 없이 문장만.\n\n' +
        JSON.stringify(summary, null, 2);
    try {
        var res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ model: MODEL, max_tokens: 200, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!res.ok) throw new Error('anthropic HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
        var j = await res.json();
        var text = (j.content || []).map(function (b) { return b.text || ''; }).join('').trim();
        text = text.replace(/^["'\s]+|["'\s]+$/g, '').split('\n')[0].trim();
        return text || templateComment(L);
    } catch (e) {
        console.error('AI 멘트 실패 → 템플릿 폴백:', e.message);
        return templateComment(L);
    }
}

// ── 정사각 이미지 렌더 (홈 리포트 카드 캡쳐 방식) ──
function servePublic() {
    return new Promise(function (resolve) {
        var srv = http.createServer(function (req, res) {
            var p = decodeURIComponent(req.url.split('?')[0]);
            if (p === '/') p = '/index.html';
            var fp = path.join(PUBLIC, p);
            if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
                res.statusCode = 404; return res.end('nf');
            }
            var ext = path.extname(fp).toLowerCase();
            var ct = ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css'
                : ext === '.json' ? 'application/json' : ext === '.html' ? 'text/html' : 'application/octet-stream';
            res.setHeader('Content-Type', ct);
            fs.createReadStream(fp).pipe(res);
        });
        srv.listen(0, '127.0.0.1', function () { resolve(srv); });
    });
}

async function renderImage(ymd, L) {
    function grp(g) { return g ? { name: g.key, count: g.count, avgRate: g.avgRate, top: g.top, topRate: g.topRate, vol: g.totalVolume } : null; }
    function ld(x) { return x ? { name: x.name, market: x.market, rate: x.change_rate, vol: x.trading_value, tag: detailTag(x), reason: String(x.rise_reason || '').trim() } : null; }
    var html = tg.leaderCardHtml({
        dateRange: dateLabel(ymd),
        leader: ld(L.leader),
        sector: grp(L.sector),
        theme: grp(L.theme),
    });
    var browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try { await tg.captureHtml(browser, html, { outPath: OUT_IMG }); }
    finally { await browser.close(); }
    return OUT_IMG;
}

// ── Telegram sendPhoto (multipart) ──
async function sendPhoto(imgPath, caption) {
    var boundary = '----wr' + Date.now();
    var parts = [];
    function field(name, value) {
        parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
    }
    field('chat_id', CHAT_ID);
    field('caption', caption);
    field('parse_mode', 'HTML');   // 캡션의 <a> 텍스트 링크 렌더
    var img = fs.readFileSync(imgPath);
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="photo"; filename="leader.png"\r\nContent-Type: image/png\r\n\r\n'));
    parts.push(img);
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    var bodyBuf = Buffer.concat(parts);
    var res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendPhoto', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body: bodyBuf,
    });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok || !j.ok) throw new Error('telegram HTTP ' + res.status + ' ' + JSON.stringify(j).slice(0, 300));
    return j;
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;   // 시크릿 없으면 워크플로 실패(빨간 X) 대신 조용히 no-op
    }

    var today = DATE_ARG || ymdKst();
    if (!DATE_ARG) {   // 샘플(--date) 이 아니면 오늘 거래일 데이터 있어야 함
        var dates = await core.fetchJson(RAW + '/dates.json');
        var latest = Array.isArray(dates) && dates.length ? dates.slice().sort().slice(-1)[0] : '';
        if (latest !== today) {
            console.log('오늘(' + today + ') 거래일 데이터 없음(최신=' + latest + ') — 게시 스킵');
            return;
        }
    }
    // 장 마감(종가 확정) 전 트리거 차단 — 마감 전엔 대장이 장중값으로 나가 마커를 선점(→진짜 15:45 종가 대장 스킵)하는 사고 방지.
    // 실발송에만 적용: --dry-run(검증)/--force/--date(샘플) 는 예외.
    if (!DRY && !DATE_ARG && !FORCE) {
        var hm = tg.hmKst();                      // "HH:MM" (KST)
        var nowMin = (+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5));
        var CLOSE_GATE_MIN = 15 * 60 + 40;        // 15:40 KST — 종가 수집 여유 후에만 대장 확정 발송
        if (nowMin < CLOSE_GATE_MIN) {
            console.log('장 마감 전(' + hm + ' KST) — 종가 대장 확정 전이라 게시 스킵(15:40 이후 발송)');
            return;
        }
    }
    if (!DRY && !FORCE) {
        try {
            var mk = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
            if (mk && mk.last === today) { console.log('이미 오늘(' + today + ') 게시함 — 스킵'); return; }
        } catch (e) { /* 마커 없음 → 첫 게시 */ }
    }

    var day = await core.fetchJson(RAW + '/' + today + '.json');
    var L = computeLeaders(day.rankings || []);
    console.log('대장주:', L.leader ? (L.leader.name + ' ' + pct(L.leader.change_rate)) : '없음',
        '| 섹터:', L.sector && L.sector.key, '| 테마:', L.theme && L.theme.key);

    var comment = await aiComment(today, L);
    var caption = buildCaption(today, L, comment);
    console.log('\n----- 캡션 -----\n' + caption + '\n----------------\n');

    await renderImage(today, L);
    console.log('대장 카드:', OUT_IMG);

    // 장마감 핫테마(종가) 버블·트리 — 대장 카드 뒤에 붙여 "장마감 핫테마 정리" 앨범 구성
    var themeImgs = await tg.captureFlowmaps(PUBLIC, [
        { mode: 'theme', view: 'bubble', out: IMG_TB },
        { mode: 'theme', view: 'tree', out: IMG_TT },
    ]);
    console.log('핫테마 이미지:', themeImgs.join(', ') || '(실패 → 대장 카드만 발송)');

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var album = [OUT_IMG].concat(themeImgs);   // 1 대장카드 + 2 버블 + 3 트리 (실패 시 대장카드만)
    var r = album.length > 1
        ? await tg.sendMediaGroup(BOT_TOKEN, CHAT_ID, album, caption, { parse_mode: 'HTML' })
        : await sendPhoto(OUT_IMG, caption);
    var mid = Array.isArray(r.result) ? (r.result[0] && r.result[0].message_id) : (r.result && r.result.message_id);
    console.log('게시 완료 — message_id', mid);
    // 중복 방지 마커 기록(워크플로가 커밋) — 같은 날 재실행 시 스킵됨
    fs.writeFileSync(MARKER, JSON.stringify({ last: today, message_id: mid, at: new Date().toISOString().slice(0, 19) }) + '\n', 'utf8');
}

main().catch(function (e) { console.error(e); process.exit(1); });
