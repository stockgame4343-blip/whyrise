'use strict';
/**
 * 외부 채널 원고 — 쓰레드(짧은 훅) · 네이버 블로그(장문 시황 정리).
 *
 * 원칙
 * - 사실만: 등락률·종목 수·지수는 데이터 그대로, '이유'는 같은 날 기사 근거(reason.js 규칙)만 싣는다.
 * - 투자 권유·전망 표현 금지(매수/매도/추천/목표가/급등 예상 등).
 * - 매일 같은 틀이 반복되면 블로그 저품질 위험 → 도입부·소제목 문구를 날짜별로 바꿔 쓴다(결정적 선택).
 */
const path = require('path');
const Reason = require(path.resolve(__dirname, '..', 'public', 'js', 'reason.js'));

const SITE = 'https://orgo.kr';
const CHANNEL = 'https://t.me/whyorgo';
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const FORBIDDEN = /매수|매도|추천|목표가|사세요|팔아|급등\s*예상|오를\s*종목|수익\s*보장/;

function pct(v) { const n = Number(v) || 0; return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
function md(ymd) { return (+ymd.slice(4, 6)) + '/' + (+ymd.slice(6, 8)); }
function mdKo(ymd) { return (+ymd.slice(4, 6)) + '월 ' + (+ymd.slice(6, 8)) + '일'; }
function weekday(ymd) { return WD[new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay()]; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function clip(s, n) { const a = Array.from(String(s || '')); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); }
function pick(list, ymd, salt = 0) { let h = salt; for (const c of ymd) h = (h * 31 + c.charCodeAt(0)) >>> 0; return list[h % list.length]; }
function themeShort(t) { return String(t || '').replace(/\([^)]*\)/g, '').split('/')[0].trim(); }
// 받침에 맞는 조사 — "브릴스가", "디아이가", "삼천당제약이"
function josa(word, withBatchim, without) {
    const c = String(word || '').trim().slice(-1).charCodeAt(0);
    if (c >= 0xAC00 && c <= 0xD7A3) return word + ((c - 0xAC00) % 28 ? withBatchim : without);
    return word + withBatchim + '(' + without + ')';
}
function amount(won) { const v = Number(won) || 0; return v >= 1e12 ? (v / 1e12).toFixed(1) + '조' : v >= 1e8 ? Math.round(v / 1e8).toLocaleString('ko-KR') + '억' : ''; }

// "원전주 동반 강세 — …" → "원전", "면역항암제 테마 6종목 동반 상승" → "면역항암제"
function flowName(text) {
    return String(text || '').split(/\s*(?:동반 강세|테마\s*\d+종목)/)[0].replace(/\s*(?:관련주|주)$/, '').trim();
}

/** 하루 데이터 → 원고 공통 재료 */
function material({ date, rows, leader, breadth, market }) {
    const active = (rows || []).filter(r => r && r.ticker && Number(r.change_rate) >= 10 && !/^정리매매/.test(r.rise_reason || ''))
        .sort((a, b) => b.change_rate - a.change_rate);
    const hot = active.filter(r => r.change_rate >= 15);
    const limit = active.filter(r => r.change_rate >= 29.5);
    // 외부 채널엔 증권사 목표가·매수/매도 표현이 들어간 사유를 싣지 않는다(투자 권유 오해 방지)
    const items = active.map(r => {
        const d = Reason.display(r);
        if (!d.unknown && (FORBIDDEN.test(d.text) || r.reason_kind === 'analyst')) return { row: r, d: { ...d, text: Reason.UNKNOWN, unknown: true } };
        return { row: r, d };
    });
    // 업종·테마 동반 상승 묶음 — 같은 이유 문장끼리
    const groups = new Map();
    for (const it of items) {
        if (it.d.unknown || !['sector', 'theme'].includes(it.row.reason_kind)) continue;
        const key = it.d.text;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it.row);
    }
    const flows = [...groups.entries()].map(([text, members]) => ({ text, members }))
        .sort((a, b) => b.members.length - a.members.length || b.members[0].change_rate - a.members[0].change_rate);
    // '관련 보도:'(종목명은 나오지만 오른 원인으로 보기 어려운 기사)는 외부 원고에서 이유로 쓰지 않는다
    const weak = it => it.row.reason_kind === 'related' || /^관련 보도:/.test(it.d.text);
    const solo = items.filter(it => !it.d.unknown && !['sector', 'theme'].includes(it.row.reason_kind) && !weak(it));
    const unknown = items.filter(it => it.d.unknown || weak(it));
    const flowNames = flows.slice(0, 2).map(f => flowName(f.text)).filter(Boolean);
    return { date, active, hot, limit, items, flows, solo, unknown, leader, breadth, market, flowNames };
}

// ── 쓰레드 ───────────────────────────────────────────────
function threads(m) {
    // 1위 — 신규상장 대장(rise-history 에 없을 수 있음)까지 포함해 등락률 최고 종목
    const ld = m.leader && m.leader.name ? { ticker: m.leader.ticker, name: m.leader.name,
        change_rate: Number(m.leader.rate ?? m.leader.change_rate) || 0, listing_day: !!m.leader.listing_day } : null;
    const top = [m.active[0], ld].filter(Boolean).sort((a, b) => b.change_rate - a.change_rate)[0];
    const ipo = r => r && (r.reason_kind === 'ipo' || r.listing_day || (ld && ld.ticker === r.ticker && ld.listing_day));
    const hook = top ? `+15% 이상 ${m.hot.length}종목, 1위는 ${top.name} ${pct(top.change_rate)}${ipo(top) ? ' (상장 첫날)' : ''}` : '';
    const lines = [`${md(m.date)}(${weekday(m.date)}) 오늘 왜 올랐나 📈`].concat(hook ? [hook] : [], ['']);
    const picks = [];
    for (const f of m.flows.slice(0, 2)) {
        const top = f.members[0];
        picks.push(`• ${clip(f.text, 46)}\n  ${f.members.slice(0, 3).map(r => r.name + ' ' + pct(r.change_rate)).join(', ')}`);
    }
    for (const it of m.solo.slice(0, 3 - picks.length)) picks.push(`• ${it.row.name} ${pct(it.row.change_rate)}\n  ${clip(it.d.text.replace(/^관련 보도:\s*/, ''), 46)}`);
    if (!picks.length) return { text: '', reply: `오른 종목 기록 👉 ${SITE}/day/?utm_source=threads&utm_medium=social&utm_campaign=daily\n매일 받아보기 👉 ${CHANNEL}` };
    lines.push(...picks);
    lines.push('', `나머지 ${Math.max(m.active.length - picks.length, 0)}종목 이유와 근거 기사는 댓글 링크에 정리해 뒀어요.`);
    let text = lines.join('\n');
    if (Array.from(text).length > 480) text = clip(text, 480);
    const reply = `종목별 오른 이유 전체 👉 ${SITE}/day/${m.date}?utm_source=threads&utm_medium=social&utm_campaign=daily\n매일 받아보기 👉 ${CHANNEL}`;
    return { text, reply };
}

// ── 네이버 블로그 ─────────────────────────────────────────
function blogTitle(m) {
    // 제목 종목은 '이유가 확인된' 상위 종목만 (이유 없는 종목을 '오른 이유' 제목에 넣지 않는다)
    const known = m.items.filter(it => !it.d.unknown).sort((a, b) => b.row.change_rate - a.row.change_rate);
    const names = (known.length ? known.map(it => it.row) : m.hot).slice(0, 2).map(r => r.name);
    const flow = m.flowNames.length ? m.flowNames.join('·') + ' 강세' : `+15% ${m.hot.length}종목`;
    const t = pick([
        `${mdKo(m.date)} 급등주 정리 | ${flow}, ${names.join('·')} 오른 이유`,
        `${mdKo(m.date)} 상한가·급등주 이유 | ${flow} (${names.join('·')})`,
        `오늘의 급등주 ${mdKo(m.date)} | ${names.join('·')} 왜 올랐나, ${flow}`,
    ], m.date);
    return clip(t, 70);
}

function intro(m) {
    const flow = m.flowNames.length ? m.flowNames.join('·') : '';
    const ld = m.leader && m.leader.name ? `${m.leader.name}(${pct(m.leader.rate ?? m.leader.change_rate)})` : '';
    const variants = [
        `${mdKo(m.date)} 장 마감 기준으로 많이 오른 종목과 그 이유를 정리했어요.${flow ? ` 오늘은 ${flow} 쪽으로 상승 종목이 몰렸습니다.` : ''}`,
        `오늘(${md(m.date)}) 국내 증시에서 +15% 이상 오른 종목은 ${m.hot.length}개였어요.${flow ? ` ${flow} 흐름이 두드러졌고,` : ''} 종목별로 왜 올랐는지 같은 날 기사를 근거로 정리했습니다.`,
        `${mdKo(m.date)} 급등주 복기입니다.${ld ? ` 거래대금과 상승률을 함께 본 오늘의 대장은 ${ld}였어요.` : ''}${flow ? ` 업종·테마로는 ${flow} 쪽이 강했습니다.` : ''}`,
    ];
    return pick(variants, m.date, 7);
}

function blogHtml(m, images) {
    const P = s => `<p>${s}</p>`;
    const H = s => `<p><b>■ ${esc(s)}</b></p>`;
    const out = [];
    out.push(P(esc(intro(m))));
    const mk = [];
    if (m.market) mk.push(`코스피 ${pct(m.market.kospi)} · 코스닥 ${pct(m.market.kosdaq)}`);
    if (m.breadth) mk.push(`주요 ${m.breadth.total.toLocaleString('ko-KR')}종목 중 상승 ${m.breadth.up.toLocaleString('ko-KR')} · 하락 ${m.breadth.down.toLocaleString('ko-KR')}`);
    mk.push(`+15% 이상 ${m.hot.length}종목${m.limit.length ? ` · 상한가 근접(+29.5%↑) ${m.limit.length}종목` : ''}`);
    out.push(H(pick(['오늘 시장 한눈에', '숫자로 본 오늘', '오늘 장 요약'], m.date, 1)));
    out.push('<ul>' + mk.map(s => `<li>${esc(s)}</li>`).join('') + '</ul>');
    if (images[0]) out.push(`<p><img src="${esc(images[0].url)}" alt="${esc(images[0].alt)}"></p>`);

    if (m.leader && m.leader.name) {
        const lrow = m.active.find(r => r.ticker === m.leader.ticker) || {};
        const d = Reason.display({ ...lrow, ...{ rise_reason: lrow.rise_reason } });
        out.push(H('오늘의 대장'));
        out.push(P(`<b>${esc(m.leader.name)}</b> ${esc(pct(m.leader.rate ?? m.leader.change_rate))}` +
            (m.leader.vol ? ` · 거래대금 ${esc(amount(m.leader.vol))}` : '') + (m.leader.listing_day ? ' (상장 첫날)' : '') +
            (!d.unknown ? `<br>└ ${esc(d.text)}` : '')));
    }
    if (m.flows.length) {
        out.push(H(pick(['오늘 시장을 끈 흐름', '함께 오른 업종·테마', '돈이 몰린 곳'], m.date, 2)));
        out.push('<ul>' + m.flows.slice(0, 4).map(f =>
            `<li><b>${esc(f.text)}</b><br>${esc(f.members.slice(0, 5).map(r => r.name + ' ' + pct(r.change_rate)).join(', '))}${f.members.length > 5 ? ` 외 ${f.members.length - 5}종목` : ''}</li>`).join('') + '</ul>');
    }
    if (m.solo.length) {
        out.push(H(pick(['개별 이슈로 오른 종목', '종목별 오른 이유', '뉴스가 있었던 종목'], m.date, 3)));
        out.push('<ul>' + m.solo.slice(0, 12).map(it =>
            `<li><b>${esc(it.row.name)}</b> ${esc(pct(it.row.change_rate))} — ${esc(it.d.text)}</li>`).join('') + '</ul>');
    }
    if (m.unknown.length) {
        out.push(P(`그 밖에 ${esc(m.unknown.slice(0, 10).map(r => r.row.name + ' ' + pct(r.row.change_rate)).join(', '))}${m.unknown.length > 10 ? ` 등 ${m.unknown.length}종목` : ''}은 오른 이유가 같은 날 기사로 분명하게 확인되지 않았어요.`));
    }
    if (images[1]) out.push(`<p><img src="${esc(images[1].url)}" alt="${esc(images[1].alt)}"></p>`);
    out.push(H('내일 체크 포인트'));
    const checks = [];
    if (m.flows[0]) checks.push(`${m.flows[0].text.split(' — ')[0]} 흐름에 상승 종목이 더 붙는지`);
    if (m.leader && m.leader.name && !m.leader.listing_day) checks.push(`오늘의 대장 ${josa(m.leader.name, '이', '가')} 이틀 연속 거래대금 상위에 남는지`);
    checks.push('개장 30분 거래대금 상위 종목이 오늘과 같은 테마인지');
    out.push('<ul>' + checks.slice(0, 3).map(c => `<li>${esc(c)}</li>`).join('') + '</ul>');
    const link = `${SITE}/day/${m.date}?utm_source=naver_blog&utm_medium=blog&utm_campaign=daily`;
    out.push(P(`📋 종목별 근거 기사와 오른 종목 전체 목록은 ORGO에서 볼 수 있어요.<br><a href="${link}">${SITE.replace('https://', '')}/day/${m.date}</a>`));
    out.push(P(`📲 매일 장전·장중·마감 정리를 텔레그램으로 받아보세요: <a href="${CHANNEL}">${CHANNEL.replace('https://', '')}</a>`));
    out.push(P('<span style="color:#888888">※ 공개된 시세와 기사 제목을 자동 집계한 기록이며 투자 권유가 아닙니다. 기사 인용은 상승 원인을 확정하지 않으며, 투자 판단과 손익은 본인 책임입니다.</span>'));
    return out.join('\n');
}

function blogTags(m) {
    const base = ['급등주', '상한가', '주식시황', '오늘의급등주', '국내증시', '코스닥', '주식공부', `${+m.date.slice(4, 6)}월${+m.date.slice(6)}일급등주`];
    const themes = m.flows.map(f => flowName(f.text)).concat((m.active || []).map(r => themeShort(r.theme_tag)))
        .map(t => t.replace(/[^가-힣A-Za-z0-9]/g, '')).filter(t => t.length >= 2 && !/신규상장|거래량/.test(t));
    const names = m.hot.slice(0, 8).map(r => r.name.replace(/[^가-힣A-Za-z0-9]/g, ''));
    return [...new Set(base.concat(themes.map(t => t + '관련주').slice(0, 6), names))].slice(0, 30);
}

function naverBlog(m, images) {
    const title = blogTitle(m);
    const html = blogHtml(m, images);
    const text = html.replace(/<br>/g, '\n').replace(/<\/(p|li|ul)>/g, '\n').replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
    return { title, html, text, tags: blogTags(m), images };
}

function assertSafe(s) {
    const t = String(s || '').replace(/투자 권유가 아닙니다/g, '');
    if (FORBIDDEN.test(t)) throw new Error('Forbidden advisory wording in marketing copy: ' + (t.match(FORBIDDEN) || [])[0]);
    return s;
}

module.exports = { josa, flowName, material, threads, naverBlog, blogTitle, blogTags, assertSafe, md, mdKo };
