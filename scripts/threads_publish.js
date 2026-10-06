'use strict';
/**
 * 발행실 오늘자 쓰레드 원고 → Threads 본문 게시 + 첫 댓글 링크 (하루 1회)
 *
 *   node scripts/threads_publish.js [YYYYMMDD] [--dry-run] [--retry-failed] [--preview-dm]
 *
 * 본문: public/marketing/{date}/digest.json 의 posts.threads.text — 발행실 원고 그대로, 링크 없음
 * 댓글: posts.threads.reply — 사이트 본 화면 rise.html?date= 링크. 본문 링크는 도달을 깎아서 첫 댓글로 단다
 * 기록: .marketing-state/{date}-threads.json · {date}-threads-reply.json
 *       기존 이미지 게시 경로(marketing_publish.js)와 같은 키라 어느 경로든 하루 1번
 * 알림: 게시 완료·실패·확인 필요 시 THREADS_ALERT_CHAT_ID(운영자 개인 채팅)로만 — 공개 채널(TELEGRAM_CHAT_ID)로는 보내지 않는다
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tg = require('./tg_common');
const { Ledger } = require('./delivery_ledger');

const ROOT = path.resolve(__dirname, '..');
const API_BASE = 'https://graph.threads.net/v1.0';
const TEXT_LIMIT = 500;
const PUBLISH_NOT_BEFORE = '16:30';    // KST — 마감 집계가 끝난 뒤
const CONTAINER_WAIT_MS = 5000;
const CONTAINER_MAX_POLLS = 6;         // 5초 × 6 = 30초 — Meta 권장 평균 대기
const RETRY_WAIT_MS = 10000;
const REQUEST_TIMEOUT_MS = 20000;
const RECENT_POSTS_LIMIT = 10;
const POST_CHANNEL = 'threads';
const REPLY_CHANNEL = 'threads-reply';
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

async function createContainer(api, token, fields) {
    const r = await api(`${API_BASE}/me/threads`, token, 'POST', fields);
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

// 게시 응답을 놓쳐 ID 를 모를 때 — 최근 게시물에서 같은 본문을 찾는다(댓글을 달 대상)
async function findPostId(api, token, text) {
    try {
        const r = await api(`${API_BASE}/me/threads?fields=id,text&limit=${RECENT_POSTS_LIMIT}`, token);
        const hit = (r.data || []).find(p => String(p.text || '').trim() === String(text).trim());
        return hit ? hit.id : null;
    } catch (e) {
        return null;
    }
}

/**
 * 컨테이너 생성 → 대기 → 게시(본문·댓글 공용). 단계마다 실패 시 1회 재시도.
 * 생성 재시도는 안전(미게시 컨테이너는 노출되지 않음). 게시 재시도는 같은 creation_id 로만 —
 * 컨테이너는 한 번만 게시되므로 첫 시도가 실제로 됐어도 중복 게시가 생기지 않는다.
 */
async function publishPost(o) {
    const { date, channel, fields, token, ledger, retryFailed = false } = o;
    const api = o.api || threadsApi;
    const sleep = o.sleep || wait;
    const now = o.now || (() => new Date().toISOString());
    const rec = await ledger.load(date, channel);
    let state = rec.state || {};

    if (state.status === 'published') return { ...state, skipped: true };
    // 이미지 경로(marketing_publish.js)가 남긴 기록은 건드리지 않는다
    if (state.status && state.mode !== 'text') return { ...state, skipped: true, hold: true };
    if (state.status === 'failed' && !retryFailed) return { ...state, skipped: true };

    const published = async postId => {
        state = { ...state, status: 'published', post_id: postId || await findPostId(api, token, fields.text), published_at: now() };
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
        state = { date, channel, mode: 'text', content_hash: crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
        try {
            try {
                state.container_id = await createContainer(api, token, fields);
            } catch (e) {
                await sleep(RETRY_WAIT_MS);
                state.container_id = await createContainer(api, token, fields);
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

// 실패를 하루 한 번만 알리기 위해 게시 전 단계 실패도 같은 기록에 남긴다
async function recordFailure(ledger, date, channel, reason) {
    const rec = await ledger.load(date, channel);
    if (rec.state.status) return { ...rec.state, skipped: true };
    const state = { date, channel, mode: 'text', status: 'failed', step: 'precheck', error: reason, failed_at: new Date().toISOString() };
    await ledger.save(rec, state);
    return state;
}

// 본문이 게시된 뒤에만 첫 댓글(링크)을 단다. 본문이 이미 게시된 날 다시 돌면 빠진 댓글만 채운다
async function publishWithReply(o) {
    const { date, text, reply, token, ledger } = o;
    const api = o.api || threadsApi;
    const post = await publishPost({ ...o, channel: POST_CHANNEL, fields: { media_type: 'TEXT', text } });
    if (post.status !== 'published' || !reply) return { post, reply: null };
    let postId = post.post_id;
    if (!postId) {
        postId = await findPostId(api, token, text);
        if (!postId) return { post, reply: await recordFailure(ledger, date, REPLY_CHANNEL, '본문 게시 ID를 찾지 못해 댓글을 달 수 없음') };
        const rec = await ledger.load(date, POST_CHANNEL);
        await ledger.save(rec, { ...rec.state, post_id: postId });
    }
    const replied = await publishPost({ ...o, channel: REPLY_CHANNEL, fields: { media_type: 'TEXT', text: reply, reply_to_id: postId } });
    return { post: { ...post, post_id: postId }, reply: replied };
}

function loadManuscript(date) {
    const p = path.join(ROOT, 'public/marketing', date, 'digest.json');
    if (!fs.existsSync(p)) return null;
    const digest = JSON.parse(fs.readFileSync(p, 'utf8'));
    const th = (digest.posts && digest.posts.threads) || {};
    return { digest, text: String(th.text || '').trim(), reply: String(th.reply || '').trim() };
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

function precheckReason(m, env) {
    const bodyLen = threadsLength(m.text), replyLen = threadsLength(m.reply);
    if (bodyLen > TEXT_LIMIT) return `본문 ${bodyLen}자 — ${TEXT_LIMIT}자 초과(Threads 기준, 이모지=바이트)`;
    if (replyLen > TEXT_LIMIT) return `댓글 ${replyLen}자 — ${TEXT_LIMIT}자 초과`;
    if (!env.THREADS_ACCESS_TOKEN) return 'THREADS_ACCESS_TOKEN 시크릿 없음';
    return '';
}

async function notifyOperator(env, lines) {
    const chat = tg.operatorChat(env);
    if (!env.TELEGRAM_BOT_TOKEN || !chat) {
        console.log('::warning::운영자 알림 미설정(THREADS_ALERT_CHAT_ID / TELEGRAM_ADMIN_CHAT_ID) — ' + lines[0]);
        return false;
    }
    try {
        await tg.sendMessage(env.TELEGRAM_BOT_TOKEN, chat, lines.join('\n'));
        return true;
    } catch (e) {
        console.log('::warning::운영자 알림 실패: ' + e.message);
        return false;
    }
}

function failureLines(date, result, label) {
    const md = `${+date.slice(4, 6)}/${+date.slice(6)}`;
    if (result.status === 'uncertain') return [
        `⚠️ ${md} ${label} 결과 확인 필요`,
        `오류: ${result.error}`,
        '게시됐는지 Threads 앱에서 확인해 주세요. 다음 실행이 컨테이너 상태를 보고 자동으로 이어가거나 멈춥니다(중복 게시 없음).',
    ];
    return [
        `❌ ${md} ${label} 실패 (${result.step || '-'})`,
        `오류: ${result.error}`,
        '오늘은 자동으로 다시 시도하지 않습니다. 다시 올리려면: gh workflow run marketing-daily.yml -f publish=true -R stockgame4343-blip/whyrise',
    ];
}

async function permalinkOf(api, token, id) {
    if (!id) return '';
    try { return (await api(`${API_BASE}/${id}?fields=permalink`, token)).permalink || ''; } catch (e) { return ''; }
}

// 이번 실행에서 새로 일어난 일만 DM 한다(이미 게시·이미 실패한 건 다시 알리지 않음). 알릴 게 없으면 null
function outcomeLines(date, { post, reply }, permalink) {
    const md = `${+date.slice(4, 6)}/${+date.slice(6)}`;
    const fresh = r => r && !r.skipped;
    if (fresh(post) && post.status === 'published') return [
        `✅ ${md} 쓰레드 게시 완료`,
        permalink || '(게시물 주소를 못 받았습니다 — Threads 앱에서 확인)',
        !reply ? '💬 첫 댓글 링크: 원고에 없음'
            : reply.status === 'published' ? '💬 첫 댓글 링크 달림'
            : `⚠️ 첫 댓글 링크 ${reply.status === 'uncertain' ? '확인 필요' : '실패'}: ${reply.error || reply.status}`,
    ];
    if (fresh(post)) return failureLines(date, post, '쓰레드 게시');
    if (fresh(reply)) return reply.status === 'published' ? [`✅ ${md} 쓰레드 첫 댓글 링크 달림`] : failureLines(date, reply, '쓰레드 댓글 링크');
    return null;
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

    const length = threadsLength(m.text);
    const skip = skipReason(date, m.digest);

    if (args.dryRun) {
        console.log(`── 쓰레드 원고 ${date} (dry-run, 게시 안 함) ──\n${m.text}\n── 첫 댓글 ──\n${m.reply || '(없음)'}\n──\n글자 수(Threads 기준): 본문 ${length}/${TEXT_LIMIT}, 댓글 ${threadsLength(m.reply)}/${TEXT_LIMIT}`);
        if (skip) console.log(`실게시였다면 건너뜀: ${skip}`);
        if (length > TEXT_LIMIT) { console.log(`::error::${TEXT_LIMIT}자 초과 — 실게시는 막힘`); process.exitCode = 1; }
        if (args.previewDm) await notifyOperator(env, [`🧪 쓰레드 미리보기 ${+date.slice(4, 6)}/${+date.slice(6)} (게시 안 함)`, '', m.text, '', '💬 첫 댓글로 달릴 링크', m.reply || '(없음)', '', `글자 수(Threads 기준): 본문 ${length}/${TEXT_LIMIT}`]);
        return;
    }
    if (skip) { console.log(`건너뜀: ${skip}`); return; }
    if (!env.GH_TOKEN || !env.GITHUB_REPOSITORY) throw new Error('게시 기록에 GH_TOKEN·GITHUB_REPOSITORY 필요');
    const ledger = new Ledger(env.GITHUB_REPOSITORY, env.GH_TOKEN);

    const precheck = precheckReason(m, env);
    const result = precheck ? { post: await recordFailure(ledger, date, POST_CHANNEL, precheck), reply: null }
        : await publishWithReply({ date, text: m.text, reply: m.reply, token: env.THREADS_ACCESS_TOKEN, ledger, retryFailed: args.retryFailed });

    const brief = r => r && { status: r.status, skipped: !!r.skipped, post_id: r.post_id || null, error: r.error || null };
    console.log(JSON.stringify({ date, post: brief(result.post), reply: brief(result.reply) }));
    const fresh = result.post && !result.post.skipped && result.post.status === 'published';
    const permalink = fresh ? await permalinkOf(threadsApi, env.THREADS_ACCESS_TOKEN, result.post.post_id) : '';
    const lines = outcomeLines(date, result, permalink);
    if (lines) await notifyOperator(env, lines);
    const bad = [result.post, result.reply].some(r => r && r.status !== 'published' && (!r.skipped || r.hold));
    if (bad) process.exitCode = 1;
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { threadsLength, publishPost, publishWithReply, recordFailure, skipReason, parseArgs, failureLines, outcomeLines, TEXT_LIMIT };
