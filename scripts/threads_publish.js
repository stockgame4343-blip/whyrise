'use strict';
/**
 * 발행실 오늘자 쓰레드 원고 → Threads 텍스트 게시 (하루 1회)
 *
 *   node scripts/threads_publish.js [YYYYMMDD] [--dry-run] [--retry-failed]
 *
 * 원고: public/marketing/{date}/digest.json 의 posts.threads.text — 발행실이 보여주는 그 원고
 * 링크: 링크 카드(link_attachment)로 사이트 본 화면 rise.html?date= — Threads 는 텍스트 게시물에만 링크 카드를 붙인다
 * 기록: .marketing-state/{date}-threads.json — 기존 이미지 게시 경로(marketing_publish.js)와 같은 키라 어느 경로든 하루 1번
 * 알림: 실패·확인 필요 시 THREADS_ALERT_CHAT_ID(운영자 개인 채팅)로만 — 공개 채널(TELEGRAM_CHAT_ID)로는 보내지 않는다
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tg = require('./tg_common');
const { siteLink } = require('./marketing_copy');
const { Ledger } = require('./delivery_ledger');

const ROOT = path.resolve(__dirname, '..');
const API_BASE = 'https://graph.threads.net/v1.0';
const TEXT_LIMIT = 500;
const PUBLISH_NOT_BEFORE = '16:30';    // KST — 마감 집계가 끝난 뒤
const CONTAINER_WAIT_MS = 5000;
const CONTAINER_MAX_POLLS = 6;         // 5초 × 6 = 30초 — Meta 권장 평균 대기
const RETRY_WAIT_MS = 10000;
const REQUEST_TIMEOUT_MS = 20000;
const LEDGER_CHANNEL = 'threads';
const HOLD_STATUSES = ['publishing', 'uncertain'];
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

const wait = ms => new Promise(r => setTimeout(r, ms));

// Threads 는 이모지를 UTF-8 바이트 수로 센다(🇰🇷=8, ⚡=3). 그 외 글자는 1자
function threadsLength(text) {
    let n = 0;
    for (const { segment } of new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(String(text || ''))) {
        n += EMOJI_RE.test(segment) ? Buffer.byteLength(segment, 'utf8') : Array.from(segment).length;
    }
    return n;
}

function apiError(message, ambiguous) {
    const e = new Error(message);
    e.ambiguous = ambiguous;
    return e;
}

// 응답을 못 받았거나(타임아웃·네트워크) 5xx 면 ambiguous — 상대편에서 처리됐을 수도 있다
async function threadsApi(url, token, method = 'GET', fields) {
    let res;
    try {
        res = await fetch(url, {
            method,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { Authorization: 'Bearer ' + token, ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
            body: fields ? new URLSearchParams(fields) : undefined,
        });
    } catch (e) {
        throw apiError('응답 없음(' + (e.name || 'network') + ')', true);
    }
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok || !body || body.error) {
        const detail = body && body.error ? ` ${body.error.message || ''} (code ${body.error.code || '?'})` : '';
        throw apiError(`HTTP ${res.status}${detail}`, res.status >= 500 || (res.ok && !body));
    }
    return body;
}

async function createContainer(api, token, text, link) {
    const r = await api(`${API_BASE}/me/threads`, token, 'POST', { media_type: 'TEXT', text, link_attachment: link });
    if (!r.id) throw apiError('컨테이너 ID 없음', false);
    return r.id;
}

async function containerStatus(api, token, id) {
    try {
        const r = await api(`${API_BASE}/${id}?fields=status,error_message`, token);
        return r.status || '';
    } catch (e) {
        return '';
    }
}

async function waitUntilReady(api, token, id, sleep) {
    for (let i = 0; i < CONTAINER_MAX_POLLS; i++) {
        await sleep(CONTAINER_WAIT_MS);
        const st = await containerStatus(api, token, id);
        if (st !== 'IN_PROGRESS') return st;
    }
    return 'IN_PROGRESS';
}

/**
 * 컨테이너 생성 → 대기 → 게시. 단계마다 실패 시 1회 재시도.
 * 생성 재시도는 안전(미게시 컨테이너는 노출되지 않음). 게시 재시도는 같은 creation_id 로만 —
 * 컨테이너는 한 번만 게시되므로 첫 시도가 실제로 됐어도 중복 게시가 생기지 않는다.
 */
async function publishText(o) {
    const { date, text, link, token, ledger, retryFailed = false } = o;
    const api = o.api || threadsApi;
    const sleep = o.sleep || wait;
    const now = o.now || (() => new Date().toISOString());
    const rec = await ledger.load(date, LEDGER_CHANNEL);
    let state = rec.state || {};

    if (state.status === 'published') return { ...state, skipped: true };
    // 이미지 경로(marketing_publish.js)가 남긴 기록은 건드리지 않는다
    if (state.status && state.mode !== 'text') return { ...state, skipped: true, hold: true };
    if (state.status === 'failed' && !retryFailed) return { ...state, skipped: true };

    const published = async postId => {
        state = { ...state, status: 'published', post_id: postId, published_at: now() };
        delete state.error;
        await ledger.save(rec, state);
        return state;
    };

    if (HOLD_STATUSES.includes(state.status)) {
        // 지난 실행에서 결과가 흐렸던 게시 — 컨테이너 상태로 판정해 이어간다
        const st = await containerStatus(api, token, state.container_id);
        if (st === 'PUBLISHED') return published(null);
        if (st === 'ERROR' || st === 'EXPIRED') state = {};
        else if (st !== 'FINISHED') return { ...state, skipped: true, hold: true, container_status: st || 'unknown' };
    } else if (state.status === 'failed') {
        state = {};
    }

    if (!state.container_id) {
        state = { date, channel: LEDGER_CHANNEL, mode: 'text', link, content_hash: crypto.createHash('sha256').update(text + '\n' + link).digest('hex') };
        try {
            try {
                state.container_id = await createContainer(api, token, text, link);
            } catch (e) {
                await sleep(RETRY_WAIT_MS);
                state.container_id = await createContainer(api, token, text, link);
            }
        } catch (e) {
            state = { ...state, status: 'failed', step: 'create', error: e.message, failed_at: now() };
            await ledger.save(rec, state);
            return state;
        }
        await waitUntilReady(api, token, state.container_id, sleep);
    }

    // 게시 직전 의도 기록 — 이후 결과가 흐려지면 다음 실행이 컨테이너 상태로 판정한다
    state = { ...state, status: 'publishing' };
    await ledger.save(rec, state);

    const errors = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) {
            await sleep(RETRY_WAIT_MS);
            const st = await containerStatus(api, token, state.container_id);
            if (st === 'PUBLISHED') return published(null);
            if (st === 'ERROR' || st === 'EXPIRED') { errors.push(apiError('컨테이너 ' + st, false)); break; }
        }
        try {
            const r = await api(`${API_BASE}/me/threads_publish`, token, 'POST', { creation_id: state.container_id });
            if (!r.id) throw apiError('게시 ID 없음', true);
            return published(r.id);
        } catch (e) {
            errors.push(e);
        }
    }
    const final = await containerStatus(api, token, state.container_id);
    if (final === 'PUBLISHED') return published(null);
    const notPublished = final === 'FINISHED' || final === 'ERROR' || final === 'EXPIRED' || final === 'IN_PROGRESS' || !errors.some(e => e.ambiguous);
    state = { ...state, status: notPublished ? 'failed' : 'uncertain', step: 'publish', error: errors[errors.length - 1].message, failed_at: now() };
    await ledger.save(rec, state);
    return state;
}

// 실패를 하루 한 번만 알리기 위해 원고 단계 실패도 같은 기록에 남긴다
async function recordFailure(ledger, date, reason) {
    const rec = await ledger.load(date, LEDGER_CHANNEL);
    if (rec.state.status) return { ...rec.state, skipped: true };
    const state = { date, channel: LEDGER_CHANNEL, mode: 'text', status: 'failed', step: 'precheck', error: reason, failed_at: new Date().toISOString() };
    await ledger.save(rec, state);
    return state;
}

function loadManuscript(date) {
    const p = path.join(ROOT, 'public/marketing', date, 'digest.json');
    if (!fs.existsSync(p)) return null;
    const digest = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { digest, text: String((digest.posts && digest.posts.threads && digest.posts.threads.text) || '').trim() };
}

// 게시하면 안 되는 날·시각이면 사유를 돌려준다(조용히 종료)
function skipReason(date, digest) {
    if (date !== tg.ymdKst()) return `오늘(${tg.ymdKst()})이 아닌 날짜`;
    if (digest.date !== date) return '원고 날짜 불일치';
    if (digest.is_final !== true) return '마감 확정 전 데이터';
    const block = tg.krPublishBlock(date, false);
    if (block) return block;
    if (tg.hmKst() < PUBLISH_NOT_BEFORE) return `${PUBLISH_NOT_BEFORE} KST 이전`;
    return '';
}

async function notifyOperator(env, lines) {
    if (!env.TELEGRAM_BOT_TOKEN || !env.THREADS_ALERT_CHAT_ID) {
        console.log('::warning::운영자 알림 미설정(THREADS_ALERT_CHAT_ID) — ' + lines[0]);
        return false;
    }
    try {
        await tg.sendMessage(env.TELEGRAM_BOT_TOKEN, env.THREADS_ALERT_CHAT_ID, lines.join('\n'));
        return true;
    } catch (e) {
        console.log('::warning::운영자 알림 실패: ' + e.message);
        return false;
    }
}

function failureLines(date, result) {
    const md = `${+date.slice(4, 6)}/${+date.slice(6)}`;
    if (result.status === 'uncertain') return [
        `⚠️ ${md} 쓰레드 게시 결과 확인 필요`,
        `오류: ${result.error}`,
        '게시됐는지 Threads 앱에서 확인해 주세요. 다음 실행이 컨테이너 상태를 보고 자동으로 이어가거나 멈춥니다(중복 게시 없음).',
    ];
    return [
        `❌ ${md} 쓰레드 게시 실패 (${result.step || '-'})`,
        `오류: ${result.error}`,
        '오늘은 자동으로 다시 시도하지 않습니다. 다시 올리려면: gh workflow run marketing-daily.yml -f publish=true -R stockgame4343-blip/whyrise',
    ];
}

function parseArgs(argv) {
    const args = { dryRun: false, retryFailed: false, previewDm: false, date: '' };
    for (const a of argv) {
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--retry-failed') args.retryFailed = true;
        else if (a === '--preview-dm') args.previewDm = args.dryRun = true;   // 미리보기는 게시하지 않는다
        else if (/^\d{8}$/.test(a)) args.date = a;
        else throw new Error('알 수 없는 인자: ' + a);
    }
    args.date = args.date || tg.ymdKst();
    return args;
}

async function main(argv = process.argv.slice(2), env = process.env) {
    const args = parseArgs(argv);
    const date = args.date;
    const m = loadManuscript(date);
    if (!m || !m.text) { console.log(`${date} 쓰레드 원고 없음 — 게시하지 않음`); return; }

    const link = siteLink(date, 'threads', 'social');
    const length = threadsLength(m.text);
    const skip = skipReason(date, m.digest);

    if (args.dryRun) {
        console.log(`── 쓰레드 원고 ${date} (dry-run, 게시 안 함) ──\n${m.text}\n──\n링크 카드: ${link}\n글자 수(Threads 기준): ${length}/${TEXT_LIMIT}`);
        if (skip) console.log(`실게시였다면 건너뜀: ${skip}`);
        if (length > TEXT_LIMIT) { console.log(`::error::${TEXT_LIMIT}자 초과 — 실게시는 막힘`); process.exitCode = 1; }
        if (args.previewDm) await notifyOperator(env, [`🧪 쓰레드 미리보기 ${+date.slice(4, 6)}/${+date.slice(6)} (게시 안 함)`, '', m.text, '', `🔗 링크 카드: ${link}`, `글자 수(Threads 기준): ${length}/${TEXT_LIMIT}`]);
        return;
    }
    if (skip) { console.log(`건너뜀: ${skip}`); return; }
    if (!env.GH_TOKEN || !env.GITHUB_REPOSITORY) throw new Error('게시 기록에 GH_TOKEN·GITHUB_REPOSITORY 필요');
    const ledger = new Ledger(env.GITHUB_REPOSITORY, env.GH_TOKEN);

    const precheck = length > TEXT_LIMIT ? `본문 ${length}자 — ${TEXT_LIMIT}자 초과(Threads 기준, 이모지=바이트)`
        : !env.THREADS_ACCESS_TOKEN ? 'THREADS_ACCESS_TOKEN 시크릿 없음' : '';
    const result = precheck ? await recordFailure(ledger, date, precheck)
        : await publishText({ date, text: m.text, link, token: env.THREADS_ACCESS_TOKEN, ledger, retryFailed: args.retryFailed });

    console.log(JSON.stringify({ date, status: result.status, skipped: !!result.skipped, post_id: result.post_id || null, error: result.error || null }));
    if (result.status === 'published') return;
    if (!result.skipped) await notifyOperator(env, failureLines(date, result));
    if (!result.skipped || result.hold) process.exitCode = 1;
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { threadsLength, publishText, recordFailure, skipReason, parseArgs, failureLines, TEXT_LIMIT };
