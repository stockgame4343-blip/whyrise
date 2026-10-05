'use strict';
/**
 * Threads 장기 토큰(60일) 만료 관리
 *
 *   node scripts/threads_token.js [--dry-run]
 *
 * 매 실행 debug_token 으로 만료일을 보고, 10일 이하로 남으면 refresh_access_token 으로 갱신해
 * GitHub Secret(THREADS_ACCESS_TOKEN)을 덮어쓴다. 시크릿 쓰기는 THREADS_SECRET_PAT(저장소 한정 PAT)로만.
 * 기록: .marketing-state/threads-token.json — 만료일·토큰 지문(해시 앞 12자)만, 토큰 값은 남기지 않는다.
 * 같은 종류의 알림은 하루 한 번만 보낸다.
 */
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const tg = require('./tg_common');
const { Ledger } = require('./delivery_ledger');

const API_ROOT = 'https://graph.threads.net';
const SECRET_NAME = 'THREADS_ACCESS_TOKEN';
const REFRESH_BEFORE_DAYS = 10;
const MIN_REFRESH_AGE_HOURS = 24;     // Threads: 발급 24시간이 지난 토큰만 갱신 가능
const SHORT_LIVED_MAX_HOURS = 24;     // 수명이 이보다 짧으면 단기 토큰(실제 1시간)
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_WAIT_MS = 5000;
const GH_CLI_TIMEOUT_MS = 30000;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
// Ledger 경로가 {date}-{channel}.json 이라 'threads','token' → .marketing-state/threads-token.json
const STATE_KEY = ['threads', 'token'];

const wait = ms => new Promise(r => setTimeout(r, ms));
const fingerprint = token => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);

// 토큰이 URL 에 실리는 호출이라(refresh 는 쿼리 파라미터만 받음) 오류 메시지에 URL 을 넣지 않는다
async function getJson(url, token) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await wait(RETRY_WAIT_MS);
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: token ? { Authorization: 'Bearer ' + token } : {} });
            let body = null;
            try { body = await res.json(); } catch (e) { body = null; }
            if (res.ok && body && !body.error) return body;
            const detail = body && body.error ? ` ${body.error.message || ''} (code ${body.error.code || '?'})` : '';
            lastError = new Error(`HTTP ${res.status}${detail}`);
            if (res.status < 500) break;
        } catch (e) {
            lastError = new Error('응답 없음(' + (e.name || 'network') + ')');
        }
    }
    throw lastError;
}

async function debugToken(token) {
    const r = await getJson(`${API_ROOT}/v1.0/debug_token?input_token=${encodeURIComponent(token)}`, token);
    const d = r.data || {};
    return { is_valid: d.is_valid === true, expires_at: Number(d.expires_at) || 0, issued_at: Number(d.issued_at) || 0 };
}

async function refreshToken(token) {
    const r = await getJson(`${API_ROOT}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`);
    if (!r.access_token || !Number(r.expires_in)) throw new Error('갱신 응답에 토큰·만료 없음');
    return { access_token: r.access_token, expires_in: Number(r.expires_in) };
}

function saveSecretWithGh(repo, pat, value) {
    const r = spawnSync('gh', ['secret', 'set', SECRET_NAME, '--repo', repo], {
        input: value, encoding: 'utf8', timeout: GH_CLI_TIMEOUT_MS, env: { ...process.env, GH_TOKEN: pat },
    });
    if (r.status !== 0) throw new Error('gh secret set 실패: ' + String(r.stderr || r.error || '').trim().slice(0, 200));
}

const kstDate = ms => new Date(ms + 9 * HOUR_MS).toISOString().slice(0, 10);
const kstTime = ms => new Date(ms + 9 * HOUR_MS).toISOString().slice(0, 16).replace('T', ' ') + ' KST';

/**
 * 결과: { status, days_left?, alert?: {kind, lines} }
 *   ok · refreshed · no_token · alert(invalid | debug_failed | no_pat | refresh_failed | save_failed)
 */
async function checkToken(o) {
    const { env, ledger } = o;
    const debug = o.debugToken || debugToken;
    const refresh = o.refreshToken || refreshToken;
    const saveSecret = o.saveSecret || (value => saveSecretWithGh(env.GITHUB_REPOSITORY, env.THREADS_SECRET_PAT, value));
    const nowMs = o.nowMs || Date.now();
    const dryRun = !!o.dryRun;
    const token = env.THREADS_ACCESS_TOKEN;
    if (!token) return { status: 'no_token' };

    const rec = await ledger.load(...STATE_KEY);
    const prev = rec.state || {};
    const fp = fingerprint(token);
    const today = tg.ymdKst();
    // 갱신 직후 이미 시작된 실행은 옛 토큰을 들고 있다 — 다시 갱신하지 않는다(새 시크릿은 다음 실행부터)
    if (prev.refreshed_at && prev.fingerprint !== fp && nowMs - Date.parse(prev.refreshed_at) < DAY_MS) return { status: 'ok', note: 'refreshed_recently' };
    let next = { ...prev, fingerprint: fp };
    const save = async () => {
        if (dryRun) return;
        if (JSON.stringify(next) !== JSON.stringify(prev)) await ledger.save(rec, next);
    };
    // 같은 알림은 하루 한 번 — 다음 실행부터는 결과만 돌려준다
    const alert = async (kind, lines) => {
        const repeated = prev.alerted_on === today && prev.alert_kind === kind;
        next = { ...next, alerted_on: today, alert_kind: kind };
        await save();
        return { status: 'alert', kind, alert: repeated ? null : { kind, lines } };
    };

    let info;
    try {
        info = await debug(token);
    } catch (e) {
        if (prev.fingerprint === fp && prev.expires_at) info = { is_valid: true, expires_at: prev.expires_at, issued_at: prev.issued_at || 0 };
        else return alert('debug_failed', ['⚠️ 쓰레드 토큰 만료일 조회 실패', `오류: ${e.message}`, '토큰 권한(threads_basic)·앱 테스터 등록을 확인해 주세요.']);
    }
    if (!info.is_valid) return alert('invalid', ['❌ 쓰레드 토큰이 유효하지 않습니다(만료·권한 해제)', '새 장기 토큰을 발급해 THREADS_ACCESS_TOKEN 시크릿에 넣어 주세요. 그 전까지 쓰레드 게시는 실패합니다.']);

    // 바뀐 게 없으면 기록하지 않는다(매 실행 커밋 → 매번 Vercel 배포가 되지 않게)
    next = { ...next, expires_at: info.expires_at, issued_at: info.issued_at };
    // expires_at 0 = 만료 없음
    if (!info.expires_at) { await save(); return { status: 'ok', days_left: null }; }
    // 단기 토큰(1시간)은 갱신 API 대상이 아니다 — 앱 시크릿으로 장기 토큰 교환이 먼저
    if (info.issued_at && (info.expires_at - info.issued_at) * 1000 < SHORT_LIVED_MAX_HOURS * HOUR_MS) return alert('short_lived', [
        `❌ 쓰레드 토큰이 단기 토큰입니다 (만료 ${kstTime(info.expires_at * 1000)})`,
        '장기 토큰(60일)으로 교환해 THREADS_ACCESS_TOKEN 시크릿에 넣어 주세요. 그 전까지 쓰레드 게시는 만료 후 실패합니다.',
    ]);
    const daysLeft = Math.floor((info.expires_at * 1000 - nowMs) / DAY_MS);
    if (daysLeft > REFRESH_BEFORE_DAYS) { await save(); return { status: 'ok', days_left: daysLeft }; }
    if (info.issued_at && nowMs - info.issued_at * 1000 < MIN_REFRESH_AGE_HOURS * HOUR_MS) { await save(); return { status: 'ok', days_left: daysLeft, note: 'too_new' }; }
    if (dryRun) return { status: 'would_refresh', days_left: daysLeft };
    if (!env.THREADS_SECRET_PAT) return alert('no_pat', [
        `⚠️ 쓰레드 토큰 만료 D-${daysLeft} (${kstDate(info.expires_at * 1000)})`,
        '갱신한 토큰을 저장할 THREADS_SECRET_PAT 시크릿이 없어 자동 갱신을 못 합니다.',
    ]);

    let fresh;
    try {
        fresh = await refresh(token);
    } catch (e) {
        return alert('refresh_failed', [`❌ 쓰레드 토큰 갱신 실패 (만료 D-${daysLeft}, ${kstDate(info.expires_at * 1000)})`, `오류: ${e.message}`, '내일 실행에서 다시 시도합니다.']);
    }
    // 이후 로그에 새 토큰이 찍혀도 가려지게
    if (env.GITHUB_ACTIONS === 'true') console.log('::add-mask::' + fresh.access_token);
    try {
        saveSecret(fresh.access_token);
    } catch (e) {
        return alert('save_failed', [`❌ 쓰레드 토큰은 갱신됐지만 시크릿 저장 실패 (기존 토큰 만료 D-${daysLeft})`, `오류: ${e.message}`, 'THREADS_SECRET_PAT 권한(Secrets 쓰기)을 확인해 주세요. 내일 다시 시도합니다.']);
    }
    const expiresAt = Math.floor(nowMs / 1000) + fresh.expires_in;
    next = { fingerprint: fingerprint(fresh.access_token), expires_at: expiresAt, issued_at: Math.floor(nowMs / 1000), refreshed_at: new Date(nowMs).toISOString() };
    await save();
    return { status: 'refreshed', days_left: Math.floor(fresh.expires_in * 1000 / DAY_MS), expires_on: kstDate(expiresAt * 1000) };
}

// 로컬 dry-run 용 — 기록을 GitHub 에 남기지 않는다
function memoryLedger() {
    return { async load() { return { state: {} }; }, async save() {} };
}

async function main(argv = process.argv.slice(2), env = process.env) {
    const dryRun = argv.includes('--dry-run');
    const ledger = env.GH_TOKEN && env.GITHUB_REPOSITORY ? new Ledger(env.GITHUB_REPOSITORY, env.GH_TOKEN) : null;
    if (!ledger && !dryRun) throw new Error('토큰 기록에 GH_TOKEN·GITHUB_REPOSITORY 필요');
    const r = await checkToken({ env, ledger: ledger || memoryLedger(), dryRun });
    console.log(JSON.stringify({ status: r.status, kind: r.kind || null, days_left: r.days_left ?? null, expires_on: r.expires_on || null, note: r.note || null }));
    if (r.alert) {
        if (env.TELEGRAM_BOT_TOKEN && env.THREADS_ALERT_CHAT_ID) {
            try { await tg.sendMessage(env.TELEGRAM_BOT_TOKEN, env.THREADS_ALERT_CHAT_ID, r.alert.lines.join('\n')); }
            catch (e) { console.log('::warning::운영자 알림 실패: ' + e.message); }
        } else console.log('::warning::운영자 알림 미설정(THREADS_ALERT_CHAT_ID) — ' + r.alert.lines[0]);
    }
    if (r.status === 'alert') process.exitCode = 1;
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { checkToken, fingerprint, REFRESH_BEFORE_DAYS };
