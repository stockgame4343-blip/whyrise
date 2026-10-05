'use strict';
/**
 * 외부 채널 원고 — 쓰레드(짧은 글 + 링크 댓글) · 네이버 블로그(시황 정리).
 *
 * 원칙
 * - 재료는 market_story.js 하나: 숫자는 데이터 그대로, 이유는 같은 날 기사 근거로 확인된 것만.
 * - 제목·첫 줄은 사람들이 실제로 검색하는 말로: "○○ 상한가 이유", "오늘 ○○주가 오른 이유".
 *   단, 이유를 실제로 싣는 종목만 '이유' 제목에 쓴다(낚시 금지).
 * - 투자 권유·전망 표현 금지(매수/매도/추천/목표가/관심 가져야 할 등). 채워넣기 문장 없이 데이터가 있는 줄만.
 */
const path = require('path');
const Story = require(path.resolve(__dirname, 'market_story.js'));

const SITE = 'https://orgo.kr';
const CHANNEL = 'https://t.me/whyorgo';
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const FORBIDDEN = Story.FORBIDDEN;
const { pct, rateOf, amount, clip } = Story;

function md(ymd) { return (+ymd.slice(4, 6)) + '/' + (+ymd.slice(6, 8)); }
function mdKo(ymd) { return (+ymd.slice(4, 6)) + '월 ' + (+ymd.slice(6, 8)) + '일'; }
function weekday(ymd) { return WD[new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay()]; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function len(s) { return Array.from(String(s || '')).length; }
function pick(list, ymd, salt = 0) { let h = salt; for (const c of ymd) h = (h * 31 + c.charCodeAt(0)) >>> 0; return list[h % list.length]; }
const josa = Story.josa;   // 받침·영문 발음에 맞는 조사 — "티엠씨가", "형지I&C가", "삼천당제약이"
// "광통신" → "광통신주", "면역항암제" → "면역항암제 테마", "핸드셋 업종" 그대로
const JU = { '반도체': '반도체주', '2차전지': '2차전지주', '로봇': '로봇주', '우주항공': '우주항공주', '원전': '원전주',
    '전력설비': '전력주', '광통신': '광통신주', '조선': '조선주', '방산': '방산주', '양자': '양자주', '자동차·부품': '자동차주',
    '스마트폰 부품': '스마트폰 부품주', '철강': '철강주', '건설': '건설주', '바이오': '바이오주', '화장품': '화장품주', '증권': '증권주' };
function flowWord(f) { return f.kind === 'sector' ? f.label : (JU[f.label] || f.label + ' 테마'); }
// 이전 버전과 같은 이름 — 흐름 이름만
function flowName(text) {
    const g = Story.parseGroup(text);
    return g && g.name ? Story.familyOf(g.name) : String(text || '').split(' — ')[0].trim();
}

/** 하루 데이터 → 원고 공통 재료 */
function material({ date, rows, leader, breadth, market, history, extraRows, prevCloses, altRates }) {
    const story = Story.build({ date, rankings: rows || [], _prevCloses: prevCloses || null, _altRates: altRates || null }, { leader, history: history || [], extraRows });
    const item = r => ({ row: r.row, r, d: { text: r.reason || Story.whyOf(r), unknown: !r.reason } });
    return {
        date, story, leader: story.leader, breadth, market: market || null,
        // 하위 호환(발행실·테스트): 개별 이유 종목 / 이유 미확인 종목
        solo: story.solos.map(item), unknown: story.rest.map(item),
        active: story.rows, hot: story.hot, limit: story.limitUps, flows: story.flows,
        flowNames: story.flows.filter(f => f.headliner).slice(0, 2).map(f => f.label),
    };
}

// '이유' 제목을 걸 종목 — 이유(개별·흐름 배경)가 실제로 실리는 종목만, 상한가 → 상승 에너지 순
function hookStocks(s, n = 2) {
    const why = r => !r.ipo && Story.whyOf(r);
    const lead = s.flows.find(f => f.headliner) || null;
    const byEnergy = (a, b) => b.energy - a.energy || b.rate - a.rate;
    let list = s.limitUps.filter(why).sort((a, b) => (b.flow === lead) - (a.flow === lead) || byEnergy(a, b));
    if (list.length) {
        // 같은 흐름 종목끼리 묶어 제목이 한 이야기가 되게
        const f = list[0].flow;
        list = list.filter(r => r.flow === f || !f).slice(0, n);
        return { rows: list, limit: true };
    }
    list = s.rows.filter(why).sort(byEnergy).slice(0, 1);
    return { rows: list, limit: false };
}
function names(rows) { return rows.map(r => r.name).join('·'); }

// ── 쓰레드 ───────────────────────────────────────────────
function threadsHook(s) {
    const h = hookStocks(s);
    const lead = s.flows.find(f => f.headliner);
    if (h.rows.length && h.limit) return '오늘 ' + josa(names(h.rows), '이', '가') + ' 상한가 간 이유';
    if (lead && (lead.catalyst || lead.members.some(r => r.reason))) return '오늘 ' + josa(flowWord(lead), '이', '가') + ' 오른 이유';
    if (h.rows.length) return josa(h.rows[0].name, '이', '가') + ' ' + rateOf(h.rows[0]) + ' 오른 이유';
    if (lead) return '오늘 상한가·급등주: ' + flowWord(lead) + ' 강세';
    return '';
}
function memberText(r, withWhy) {
    return r.name + ' ' + rateOf(r) + (withWhy && r.reason ? '(' + clip(r.reason, 22) + ')' : '');
}
function threads(m) {
    const s = m.story;
    const reply = `${md(m.date)} 오른 종목 전체와 근거 기사 👉 ${SITE}/day/${m.date}?utm_source=threads&utm_medium=social&utm_campaign=daily\n` +
        `장전·장중·마감 정리는 텔레그램에서 👉 ${CHANNEL}`;
    if (!s.rows.length) return { text: '', reply };
    const stat = `${md(m.date)}(${weekday(m.date)}) 상한가 ${s.limitUps.length} · +15% 이상 ${s.hot.length}종목`;
    const hook = hookStocks(s), hooked = new Set(hook.rows);
    const first = list => list.slice().sort((a, b) => hooked.has(b) - hooked.has(a));   // 첫 줄에 건 종목은 본문에 꼭 나오게
    const blocks = [];
    const flows = s.flows.filter(f => f.headliner).slice(0, 2);
    for (const f of flows) {
        const head = `${f.label} ${f.members.length}종목` + (f.streak >= 2 ? ` · ${f.streak}거래일 연속` : '') + (f.catalyst ? ` — ${clip(f.catalyst, 26)}` : '');
        const shown = first(f.members).slice(0, 3).sort((a, b) => b.rate - a.rate);
        blocks.push({ prio: 1, lines: [head, shown.map(r => memberText(r, !f.catalyst)).join(' · ')] });
    }
    const solos = first(s.solos.slice().sort((a, b) => b.rate - a.rate)).slice(0, Math.max(3 - flows.length, 1));
    for (const r of solos) blocks.push({ prio: hooked.has(r) ? 0 : 2, lines: [`${r.name} ${rateOf(r)} — ${clip(r.reason, 30)}`] });
    for (const r of s.ipos.slice(0, 1)) blocks.push({ prio: 3, lines: [`신규상장 ${r.name}` + (r.vol ? ` · 거래대금 ${amount(r.vol)}` : '')] });
    if (!blocks.length) {
        // 이유가 확인된 종목이 없는 날 — 많이 오른 종목만 사실대로
        blocks.push({ prio: 2, lines: [s.rows.filter(r => !r.ipo).slice(0, 3).map(r => r.name + ' ' + rateOf(r)).join(' · ')] });
    }
    // 첫 줄에 건 종목이 본문에 없으면(3번째 흐름 소속 등) 그 종목 줄을 맨 앞에 붙인다
    const shownText = () => blocks.map(b => b.lines.join('\n')).join('\n');
    for (const r of hook.rows) if (!shownText().includes(r.name)) blocks.unshift({ prio: 0, lines: [`${r.name} ${rateOf(r)} — ${clip(Story.whyOf(r), 34)}`] });
    const tail = '종목별 이유와 근거 기사는 댓글 링크에.';
    const compose = bs => [threadsHook(s), stat, ''].filter((x, i) => x || i === 2).concat(...bs.map(b => b.lines.concat(''))).concat([tail]).join('\n')
        .replace(/^\n+/, '');
    let text = compose(blocks);
    // 500자 제한 — 우선순위 낮은 줄(신규상장 → 개별 이슈 → 흐름)부터 뺀다
    while (len(text) > 480 && blocks.some(b => b.prio > 0)) {
        let w = -1; blocks.forEach((b, i) => { if (b.prio > 0 && (w < 0 || b.prio >= blocks[w].prio)) w = i; });
        blocks.splice(w, 1); text = compose(blocks);
    }
    if (len(text) > 480) text = clip(text, 480);
    return { text, reply };
}

// ── 네이버 블로그 ─────────────────────────────────────────
function blogTitle(m) {
    const s = m.story, d = mdKo(m.date);
    const lead = s.flows.filter(f => f.headliner);
    const fw = lead.slice(0, 2).map(flowWord);
    const h = hookStocks(s);
    const both = h.rows.map(r => r.name), one = both.slice(0, 1);
    const cands = [];
    const variant = pick([0, 1, 2], m.date);
    if (h.limit && both.length) {
        // "○○ 상한가 이유" — 실제 검색어를 제목 앞에. 흐름 이름은 그 종목이 속한 흐름일 때만 한 문장으로 붙인다
        const own = h.rows[0].flow && h.rows[0].flow.headliner ? flowWord(h.rows[0].flow) : '';
        for (const ns of [both, one]) for (const f of [own, '']) {
            const n = ns.join('·');
            if (variant === 0) cands.push(`${n} 상한가 이유 | ${f ? f + ' 급등, ' : ''}${d} 급등주`);
            if (variant === 1) cands.push(`${n} 상한가 이유는? ${f ? f + ' 강세 ' : ''}(${d})`);
            if (variant === 2) cands.push(`오늘 ${josa(n, '이', '가')} 상한가 간 이유 | ${f ? f + ' · ' : ''}${d}`);
        }
    } else if (lead[0] && (lead[0].catalyst || lead[0].members.some(r => r.reason))) {
        // 상한가가 없으면 흐름으로: "반도체주 급등 이유"
        // 제목에 이름을 거는 종목은 이유가 실린 종목부터 (흐름에 기사 배경이 있으면 거래대금 큰 종목)
        const why = lead[0].members.filter(r => r.reason), pool = lead[0].catalyst ? lead[0].members : why;
        const top = pool.slice().sort((a, b) => (!!b.reason - !!a.reason) || b.energy - a.energy).slice(0, 2).map(r => r.name);
        const n = lead[0].members.length;
        cands.push(`${fw[0]} 급등 이유 | ${top.join('·')} 등 ${n}종목 (${d})`, `${fw[0]} 급등 이유 | ${top[0]} 등 ${n}종목 (${d})`,
            `오늘 ${josa(fw[0], '이', '가')} 오른 이유 (${d})`);
    } else if (one.length) {
        cands.push(`${one[0]} 급등 이유 | ${d} 급등주 정리`);
    }
    if (fw.length) cands.push(`${d} 상한가·급등주 | ${fw.join('·')} 강세`, `${d} 상한가·급등주 | ${fw[0]} 강세`);
    cands.push(`${d} 상한가·급등주 정리`);
    return cands.find(t => len(t) <= 40) || cands[cands.length - 1];
}
// 날짜별 페이지(orgo.kr/day/…) 제목 — 날짜 검색어를 앞에, 매일 같은 틀(검색 결과에서 일관되게)
function pageTitle(m) {
    const s = m.story, d = mdKo(m.date);
    const fw = s.flows.filter(f => f.headliner).slice(0, 2).map(flowWord);
    const h = hookStocks(s);
    const why = h.rows.length ? `${h.rows.map(r => r.name).join('·')} ${h.limit ? '상한가' : '급등'} 이유` : '';
    const one = h.rows.length ? `${h.rows[0].name} ${h.limit ? '상한가' : '급등'} 이유` : '';
    const head = `${d} 상한가·급등주`;
    const c = [[head, why, fw.length && fw.join('·') + ' 강세'], [head, why, fw[0] && fw[0] + ' 강세'], [head, one, fw[0] && fw[0] + ' 강세'],
        [head, one], [head, fw[0] && fw[0] + ' 강세'], [head + ' 정리']].map(a => a.filter(Boolean).join(' | '));
    return c.find(t => len(t) <= 46) || c[c.length - 1];
}
// 검색 결과 설명(155자) — 숫자와 흐름만
function pageDesc(m) {
    const s = m.story, d = mdKo(m.date);
    const parts = [`${d} 상한가 ${s.limitUps.length}종목, +15% 이상 ${s.hot.length}종목.`];
    const lead = s.flows.filter(f => f.headliner).slice(0, 2);
    if (lead.length) parts.push(lead.map(f => {
        const lu = f.members.filter(r => r.limit).slice(0, 2).map(r => r.name);
        return `${f.label} ${f.members.length}종목` + (lu.length ? `(${lu.join('·')} 상한가)` : '') + (f.catalyst ? ` — ${f.catalyst}` : '');
    }).join(', ') + '.');
    parts.push('종목별 상승 이유와 근거 기사를 정리했습니다.');
    return clip(parts.join(' '), 155);
}

function intro(m) {
    const s = m.story, d = mdKo(m.date), out = [];
    const mk = m.market;
    if (mk && Number.isFinite(mk.kospi) && Number.isFinite(mk.kosdaq)) {
        const a = v => Math.abs(v).toFixed(1);
        const mid = v => Math.abs(v) < 0.05 ? '보합이었고' : `${a(v)}% ${v > 0 ? '올랐고' : '내렸고'}`;
        const end = v => Math.abs(v) < 0.05 ? '보합으로 마감했습니다' : `${a(v)}% ${v > 0 ? '올랐습니다' : '내렸습니다'}`;
        out.push(`${d} 코스피는 ${mid(mk.kospi)}, 코스닥은 ${end(mk.kosdaq)}.`);
    }
    const prev = s.prevHot != null ? `(전 거래일 ${s.prevHot}개)` : '';
    out.push(`${out.length ? '' : d + ' '}+15% 이상 오른 종목은 ${s.hot.length}개${prev}${s.limitUps.length ? `, 상한가는 ${s.limitUps.length}종목` : ''}입니다.`);
    const lead = s.flows.filter(f => f.headliner).slice(0, 2);
    if (lead.length) {
        const both = lead.length > 1 ? josa(lead[0].label, '과', '와') + ' ' + lead[1].label : lead[0].label;
        const lu = lead[0].members.filter(r => r.limit);
        out.push(pick([`상승 종목은 ${both} 쪽에 몰렸습니다.`, `오늘은 ${both} 쪽으로 상승이 몰렸습니다.`], m.date, 5) +
            (lu.length ? ` ${lead[0].label}에서는 ${josa(names(lu.slice(0, 3)), '이', '가')} 상한가를 기록했습니다.` : ''));
    } else if (s.rows.length) out.push('뚜렷한 테마 없이 개별 재료로 오른 종목이 많았습니다.');
    return out.join(' ');
}

function blogHtml(m, images) {
    const s = m.story;
    const P = x => `<p>${x}</p>`;
    const H = x => `<p><b>■ ${esc(x)}</b></p>`;
    const UL = items => '<ul>' + items.map(x => `<li>${x}</li>`).join('') + '</ul>';
    const out = [P(esc(intro(m)))];
    if (images[0]) out.push(`<p><img src="${esc(images[0].url)}" alt="${esc(images[0].alt)}"></p>`);

    // 오늘의 주도 흐름 — 기사 배경이 있는 흐름 먼저, 테마로만 묶인 흐름은 뒤에, 업종 묶음은 흐름이 부족할 때만
    let flows = s.flows.filter(f => f.headliner).concat(s.flows.filter(f => !f.headliner && f.kind !== 'sector')).slice(0, 4);
    if (flows.length < 2) flows = flows.concat(s.flows.filter(f => f.kind === 'sector').slice(0, 2 - flows.length));
    if (flows.length) {
        out.push(H('오늘의 주도 흐름'));
        flows.forEach((f, i) => {
            const meta = [`${f.members.length}종목`];
            if (f.limitUps) meta.push(`상한가 ${f.limitUps}`);
            if (f.streak >= 2) meta.push(`${f.streak}거래일 연속`);
            const note = f.catalyst ? `<br>배경: ${esc(f.catalyst)}` : !f.members.some(r => r.reason) ? '<br>같은 테마로 함께 오른 종목 (근거 기사 미확인)' : '';
            out.push(P(`<b>${i + 1}. ${esc(flowWord(f))}</b> · ${esc(meta.join(' · '))}` + note));
            const shown = f.members.slice(0, 6);
            out.push(UL(shown.map(r => `${esc(r.name)} ${esc(rateOf(r))}${r.reason ? ' — ' + esc(r.reason) : ''}`)));
            if (f.members.length > shown.length) out.push(P(esc(`외 ${f.members.length - shown.length}종목: ` + f.members.slice(6, 14).map(r => r.name).join(', ') + (f.members.length > 14 ? ' 등' : ''))));
        });
    }
    // 이유가 없으면 이유 자리에 아무 말도 넣지 않고, 분류만 '· ○○ 테마'로
    const line = r => { const w = Story.whyOf(r), t = Story.tagOf(r); return w ? ' — ' + esc(w) : t ? ' · ' + esc(t) + ' 테마' : ''; };
    if (s.limitUps.length) {
        out.push(H(`상한가 ${s.limitUps.length}종목`));
        out.push(UL(s.limitUps.map(r => `<b>${esc(r.name)}</b> ${esc(rateOf(r))}${line(r)}`)));
    }
    const solos = s.solos.filter(r => !r.limit).slice(0, 10);
    if (solos.length) {
        out.push(H('개별 재료로 오른 종목'));
        out.push(UL(solos.map(r => `<b>${esc(r.name)}</b> ${esc(rateOf(r))} — ${esc(r.reason)}`)));
    }
    if (s.ipos.length) {
        // 신규상장주의 등락률은 공모가 기준이 아니어서 숫자를 싣지 않는다
        out.push(H('신규상장주'));
        out.push(UL(s.ipos.map(r => `<b>${esc(r.name)}</b>` + (r.vol ? ` · 거래대금 ${esc(amount(r.vol))}` : ''))));
    }
    if (s.money.length >= 3) {
        out.push(H('거래대금이 가장 많이 몰린 급등주'));
        out.push(UL(s.money.map(r => `${esc(r.name)} ${esc(amount(r.vol))} · ${esc(rateOf(r))}`)));
    }
    const extra = [];
    if (s.continuing.length) extra.push(s.continuing.slice(0, 6).map(r => `${r.name}(${r.streak}거래일)`).join(', ') + ' — 연속 +10% 이상');
    if (s.high52.length) extra.push(s.high52.slice(0, 6).map(r => r.name).join(', ') + ' — 52주 신고가');
    if (extra.length) { out.push(H('연속 상승 · 신고가')); out.push(UL(extra.map(esc))); }
    const shownSet = new Set([...flows.flatMap(f => f.members.slice(0, 14)), ...s.limitUps, ...solos, ...s.ipos]);
    const rest = s.rows.filter(r => !shownSet.has(r));
    if (rest.length) {
        const tag = r => { const t = Story.tagOf(r); return t ? `(${t})` : ''; };
        out.push(P(esc('그 밖에 +10% 이상 오른 종목: ' + rest.slice(0, 12).map(r => `${r.name} ${rateOf(r)}${tag(r)}`).join(', ') +
            (rest.length > 12 ? ` 외 ${rest.length - 12}종목` : ''))));
    }
    if (images[1]) out.push(`<p><img src="${esc(images[1].url)}" alt="${esc(images[1].alt)}"></p>`);
    const link = `${SITE}/day/${m.date}?utm_source=naver_blog&utm_medium=blog&utm_campaign=daily`;
    out.push(P(`종목별 근거 기사와 오른 종목 전체 목록은 ORGO 날짜별 페이지에 정리돼 있습니다.<br><a href="${link}">${SITE.replace('https://', '')}/day/${m.date}</a>`));
    out.push(P(`장전 브리핑·장중 주도주·마감 정리는 텔레그램에서 매일 받아볼 수 있습니다: <a href="${CHANNEL}">${CHANNEL.replace('https://', '')}</a>`));
    const notes = [];
    if (s.abnormal.length) {
        const who = s.abnormal.slice(0, 3).map(a => a.name).join('·') + (s.abnormal.length > 3 ? ` 등 ${s.abnormal.length}종목` : '');
        notes.push(`${josa(who, '은', '는')} 등락률이 가격제한폭(30%)을 벗어나(거래 재개·기준가 변경 등) 집계에서 뺐습니다.`);
    }
    notes.push('공개된 시세와 기사 제목을 자동으로 모은 기록입니다. 기사 인용은 상승 원인을 확정하지 않으며 투자 권유가 아닙니다.');
    out.push(P(`<span style="color:#888888">${notes.map(n => '※ ' + esc(n)).join('<br>')}</span>`));
    return out.join('\n');
}

function blogTags(m) {
    const s = m.story, mm = +m.date.slice(4, 6), dd = +m.date.slice(6);
    const clean = t => String(t || '').replace(/[^가-힣A-Za-z0-9]/g, '');
    const base = ['급등주', '상한가', '상한가종목', '오늘의급등주', '주식시황', '국내증시', '코스닥', `${mm}월${dd}일상한가`, `${mm}월${dd}일급등주`];
    const flows = s.flows.filter(f => f.headliner).slice(0, 4).map(f => clean(flowWord(f).replace(/ 테마$/, '관련주')));
    const h = hookStocks(s).rows.map(r => clean(r.name) + (r.limit ? '상한가' : '급등'));
    const stocks = [...s.limitUps, ...s.flows.slice(0, 2).flatMap(f => f.members.slice(0, 3)), ...s.solos.slice(0, 4)].map(r => clean(r.name));
    return [...new Set(base.concat(flows, h, stocks))].filter(t => len(t) >= 2).slice(0, 30);
}

function naverBlog(m, images) {
    const title = blogTitle(m);
    const html = blogHtml(m, images || []);
    const text = html.replace(/<br>/g, '\n').replace(/<\/(p|li|ul)>/g, '\n').replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
    return { title, html, text, tags: blogTags(m), images: images || [] };
}

function assertSafe(s) {
    const t = String(s || '').replace(/투자 권유가 아닙니다/g, '');
    if (FORBIDDEN.test(t)) throw new Error('Forbidden advisory wording in marketing copy: ' + (t.match(FORBIDDEN) || [])[0]);
    return s;
}

module.exports = { josa, flowName, flowWord, material, threads, threadsHook, hookStocks, naverBlog, blogTitle, pageTitle, pageDesc, blogTags, intro, assertSafe, md, mdKo };
