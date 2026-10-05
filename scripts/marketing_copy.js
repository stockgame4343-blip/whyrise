'use strict';
/**
 * 외부 채널 원고 — 쓰레드(짧은 글 + 링크 댓글) · 네이버 블로그(시황 정리).
 *
 * 원칙
 * - 재료는 market_story.js 하나: 숫자는 데이터 그대로, 이유는 같은 날 기사 근거로 확인된 것만.
 * - 쓰레드는 텔레그램 마감 메시지처럼 간결하게: 한 줄 요약 → 흐름마다 '왜' 한 줄 → 개별 재료.
 * - 블로그는 종목 나열이 아니라 '오늘 무슨 일이 있었나'를 설명하는 글: 흐름마다 배경·주도 종목·돈의 쏠림을 문장으로.
 *   제목은 검색어("○○ 상한가 이유")를 앞에 두되, 그 이유를 첫 문단에서 바로 답한다.
 * - 투자 권유·전망 표현 금지(매수/매도/추천/목표가/관심 가져야 할 등). 채워넣기 문장 없이 데이터가 있는 줄만.
 */
const path = require('path');
const Story = require(path.resolve(__dirname, 'market_story.js'));
const Talk = require(path.resolve(__dirname, 'market_commentary.js'));   // 해석 문장(오늘은 어떤 날이었나·볼 부분)
const Persona = require(path.resolve(__dirname, 'persona.js'));          // 캐릭터 말투 — 쓰레드 전부, 블로그 시작·마무리 멘트만

const SITE = 'https://orgo.kr';
const CHANNEL = 'https://t.me/whyorgo';
// 외부 채널 링크는 사이트 본 화면(오른 종목, 그날 날짜)으로 — 검색용 날짜별 정적 페이지로 보내지 않는다
function siteLink(date, source, medium) {
    return `${SITE}/rise.html?date=${date}&utm_source=${source}&utm_medium=${medium}&utm_campaign=daily`;
}
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const FORBIDDEN = Story.FORBIDDEN;
const { pct, rateOf, amount, clip } = Story;

function md(ymd) { return (+ymd.slice(4, 6)) + '/' + (+ymd.slice(6, 8)); }
function mdKo(ymd) { return (+ymd.slice(4, 6)) + '월 ' + (+ymd.slice(6, 8)) + '일'; }
function weekday(ymd) { return WD[new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay()]; }
function dayKo(ymd) { return `${mdKo(ymd)}(${weekday(ymd)})`; }   // "10월 2일(금)" — 텔레그램과 같은 표기
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function len(s) { return Array.from(String(s || '')).length; }
// Threads 가 세는 길이 — 이모지는 UTF-8 바이트(🇰🇷=8, ⚡=3), 나머지는 1자 (threads_publish.js 와 같은 규칙, 500 넘으면 게시 실패)
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
function threadsLen(text) {
    let n = 0;
    for (const { segment } of new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(String(text || '')))
        n += EMOJI_RE.test(segment) ? Buffer.byteLength(segment, 'utf8') : Array.from(segment).length;
    return n;
}
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
function material({ date, rows, leader, breadth, market, history, extraRows, prevCloses, altRates, holiday, calendar, profileOf, since }) {
    const story = Story.build({ date, rankings: rows || [], _prevCloses: prevCloses || null, _altRates: altRates || null }, { leader, history: history || [], extraRows });
    const item = r => ({ row: r.row, r, d: { text: r.reason || Story.whyOf(r), unknown: !r.reason } });
    return {
        date, story, leader: story.leader, breadth, market: market || null, holiday: holiday || null,
        calendar: calendar || null, profileOf: profileOf || null, since: since || '',   // 해석용: 이번 달 대장 기록, 종목 급등 이력
        // 하위 호환(발행실·테스트): 개별 이유 종목 / 이유 미확인 종목
        solo: story.solos.map(item), unknown: story.rest.map(item),
        active: story.rows, hot: story.hot, limit: story.limitUps, flows: story.flows,
        flowNames: story.flows.filter(f => f.headliner).slice(0, 2).map(f => f.label),
    };
}

// '이유' 제목을 걸 종목 — 이유(개별·흐름 배경)가 실제로 실리는 종목만, 상한가 → 상승 에너지 순
function hookStocks(s, n = 2) {
    const why = r => !r.ipo && Story.whyOf(r);
    const lead = s.lead[0] || null;
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

// ── 쓰레드 — 텔레그램 마감 메시지와 같은 틀 ───────────────────
// 머리 한 줄: "광통신주 급등, 머큐리 상한가" / "광통신·우주항공 강세"
function headPhrase(s) {
    const lead = s.lead[0];
    const lu = lead ? lead.members.filter(r => r.limit) : [];
    if (lead && lu.length) return flowWord(lead) + ' 급등, ' + lu.slice(0, 2).map(r => r.name).join('·') + ' 상한가';
    // 흐름이 없는 날 — 이유가 확인된 상한가 종목을 앞에
    const solo = !lead ? s.limitUps.filter(r => r.reason).slice(0, 2) : [];
    if (solo.length) return solo.map(r => r.name).join('·') + ' 상한가, 개별 재료 장세';
    return s.headline || '';
}
// 이전 이름 호환 — 첫 줄
// 휴장 안내 한 줄 — 날짜를 그대로 써서(내일·모레 없이) 나중에 읽어도 맞게
function holidayLine(h) {
    if (!h) return '';
    if (h.kr) return '🇰🇷 국내 증시 휴장: ' + h.kr + (h.next ? ' → 다음 거래일 ' + h.next : '');
    return h.foreign || '';
}
// 블로그는 문장으로 — '국내 증시는 10월 5일(월) 개천절 대체공휴일 휴장, 다음 거래일은 10월 6일(화)입니다.'
function holidaySentence(h) {
    if (!h) return '';
    if (h.kr) return '국내 증시는 ' + h.kr + (/휴장$/.test(h.kr) ? '' : ' 휴장') + (h.next ? ', 다음 거래일은 ' + h.next + '입니다.' : '입니다.');
    return h.foreignPlain || '';
}
function threadsHook(s) { return s.date ? dayKo(s.date) + ' 마감 | ' + headPhrase(s) : headPhrase(s); }
// 쓰레드 — 캐릭터 말투로 전부(사용자 결정 2026-10-06). 숫자·종목 줄은 그대로, 말하는 줄만 캐릭터 말투
function threads(m) {
    const s = m.story;
    const reply = `📋 ${mdKo(m.date)} 오른 종목과 이유 전체 👉 ${siteLink(m.date, 'threads', 'social')}\n` +
        `📲 장전·장중·마감 정리는 텔레그램에서 👉 ${CHANNEL}`;
    if (!s.rows.length) return { text: '', reply };
    // 첫 줄은 인사, 둘째 줄은 오늘이 어떤 날이었는지 — 피드에 보이는 두 줄이 글의 요지
    const head = [Persona.threadsOpen(dayKo(m.date), m.date)];
    const talk = Persona.verdictTalk(s);
    if (talk) head.push(talk);
    const nums = [];
    if (m.market && Number.isFinite(m.market.kospi) && Number.isFinite(m.market.kosdaq)) nums.push(`📊 코스피 ${pct(m.market.kospi)} · 코스닥 ${pct(m.market.kosdaq)}`);
    nums.push(`🔺 상한가 ${s.limitUps.length} · +15% 이상 ${s.hot.length}종목`);
    const blocks = [{ prio: 0, lines: head }, { prio: 0, lines: nums }];
    const fixed = blocks.length;
    // 흐름마다: 이유가 있으면 이유, 없으면 상한가 수만 (근거 없는 말은 붙이지 않는다) + 대표 종목
    const flows = s.lead.slice(0, 2);
    flows.forEach((f, i) => {
        const why = Story.flowReason(f, 30), lu = f.members.filter(r => r.limit).length;
        blocks.push({ prio: 1 + i, lines: [`${i ? '⚡' : '🔥'} ${f.label} ${f.members.length}종목` + (why ? ` — ${why}` : lu ? ` · 상한가 ${lu}` : ''),
            f.members.slice(0, 3).map(r => `${r.name} ${r.limit ? '상한가' : rateOf(r)}`).join(' · ')] });
    });
    const solos = s.solos.slice().sort((a, b) => b.rate - a.rate).slice(0, flows.length >= 2 ? 2 : 3);
    if (solos.length) blocks.push({ prio: 3, lines: ['💡 혼자 튄 종목'].concat(solos.map(r => `🔺 ${r.name} ${r.limit ? '상한가' : rateOf(r)} — ${Story.clipWords(r.reason, 32)}`)) });
    if (blocks.length === fixed) blocks.push({ prio: 3, lines: [s.rows.filter(r => !r.ipo).slice(0, 3).map(r => r.name + ' ' + rateOf(r)).join(' · ')] });
    // 휴장 안내 — 국내 휴장(대체공휴일 포함)이 먼저, 없으면 다음 거래일 해외 휴장. 글자 수가 넘쳐도 빼지 않는다
    const hol = Persona.holidayTalk(m.holiday);
    if (hol) blocks.push({ prio: 0, lines: [hol] });
    const tail = Persona.threadsTail(m.date);
    const compose = bs => bs.map(b => b.lines.join('\n')).join('\n\n') + '\n\n' + tail;
    let text = compose(blocks);
    while (threadsLen(text) > 480 && blocks.some(b => b.prio > 0)) {
        let w = -1; blocks.forEach((b, i) => { if (b.prio > 0 && (w < 0 || b.prio >= blocks[w].prio)) w = i; });
        blocks.splice(w, 1); text = compose(blocks);
    }
    while (threadsLen(text) > 490) text = clip(text, Array.from(text).length - 10);   // 그래도 넘으면 끝을 자른다(드묾)
    return { text, reply };
}

// ── 네이버 블로그 ─────────────────────────────────────────
// 제목이 무엇을 약속하는지 — 종목('○○ 상한가 이유')인지 흐름('○○주 급등 이유')인지. 첫 문단이 같은 것에 답한다
function titlePlan(s) {
    const h = hookStocks(s);
    const lead = s.lead;
    if (h.limit && h.rows.length) return { kind: 'stock', rows: h.rows };
    if (lead[0] && (lead[0].catalyst || lead[0].members.some(r => r.reason))) return { kind: 'flow', flow: lead[0] };
    if (h.rows.length) return { kind: 'stock', rows: h.rows.slice(0, 1) };
    return { kind: 'plain' };
}
function blogTitle(m) {
    // 날짜를 맨 앞에: "10월 2일 머큐리 상한가 이유는? 광통신주 강세"
    const s = m.story, d = mdKo(m.date);
    const lead = s.lead;
    const fw = lead.slice(0, 2).map(flowWord);
    const h = hookStocks(s);
    const both = h.rows.map(r => r.name), one = both.slice(0, 1);
    const cands = [];
    const variant = pick([0, 1, 2], m.date);
    if (h.limit && both.length) {
        // "○○ 상한가 이유" — 흐름 이름은 그 종목이 속한 흐름일 때만 한 문장으로 붙인다
        const own = h.rows[0].flow && h.rows[0].flow.headliner ? flowWord(h.rows[0].flow) : '';
        for (const ns of [both, one]) for (const f of [own, '']) {
            const n = ns.join('·');
            if (variant === 0) cands.push(`${d} ${n} 상한가 이유` + (f ? ` | ${f} 급등` : ''));
            if (variant === 1) cands.push(`${d} ${n} 상한가 이유는?` + (f ? ` ${f} 강세` : ''));
            if (variant === 2) cands.push(`${d} ${josa(n, '이', '가')} 상한가 간 이유` + (f ? ` | ${f}` : ''));
        }
    } else if (lead[0] && (lead[0].catalyst || lead[0].members.some(r => r.reason))) {
        // 상한가가 없으면 흐름으로: "10월 1일 반도체주 급등 이유"
        const why = lead[0].members.filter(r => r.reason), pool = lead[0].catalyst ? lead[0].members : why;
        const top = pool.slice().sort((a, b) => (!!b.reason - !!a.reason) || b.energy - a.energy).slice(0, 2).map(r => r.name);
        const n = lead[0].members.length;
        cands.push(`${d} ${fw[0]} 급등 이유 | ${top.join('·')} 등 ${n}종목`, `${d} ${fw[0]} 급등 이유 | ${top[0]} 등 ${n}종목`, `${d} ${fw[0]} 급등 이유`);
    } else if (one.length) {
        cands.push(`${d} ${one[0]} 급등 이유 | 급등주 정리`, `${d} ${one[0]} 급등 이유`);
    }
    if (fw.length) cands.push(`${d} 상한가·급등주 | ${fw.join('·')} 강세`, `${d} 상한가·급등주 | ${fw[0]} 강세`);
    cands.push(`${d} 상한가·급등주 정리`);
    return cands.find(t => len(t) <= 40) || cands[cands.length - 1];
}
// 날짜별 페이지(orgo.kr/day/…) 제목 — 날짜 검색어를 앞에, 매일 같은 틀(검색 결과에서 일관되게)
function pageTitle(m) {
    const s = m.story, d = mdKo(m.date);
    const fw = s.lead.slice(0, 2).map(flowWord);
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
    const lead = s.lead.slice(0, 2);
    if (lead.length) parts.push(lead.map(f => {
        const lu = f.members.filter(r => r.limit).slice(0, 2).map(r => r.name);
        return `${f.label} ${f.members.length}종목` + (lu.length ? `(${lu.join('·')} 상한가)` : '') + (f.catalyst ? ` — ${f.catalyst}` : '');
    }).join(', ') + '.');
    parts.push('종목별 상승 이유와 근거 기사를 정리했습니다.');
    return clip(parts.join(' '), 155);
}

// ── 블로그 문장 재료 ──
// "머큐리(+29.8%)가" — 조사는 종목명 기준
function rl(r) { return `${r.name}(${rateOf(r)})`; }
function rlJ(list, a, b) {
    const last = list[list.length - 1];
    return list.map(rl).join('·') + josa(last.name, a, b).slice(last.name.length);
}
// 종목 한 줄 설명 문장 — 이유를 실제로 말하는 문장 (제목에 건 종목은 여기서 답한다)
function whySentence(r) {
    const did = r.limit ? '상한가를 기록했습니다' : `${rateOf(r)} 올랐습니다`;
    if (r.reason) return `${josa(r.name, '은', '는')} '${r.reason}' 기사와 함께 ${did}.`;
    if (r.flow && r.flow.catalyst) return `${josa(r.name, '은', '는')} ${flowWord(r.flow)} 동반 강세 속에 ${did}. 같은 날 '${r.flow.catalyst}' 관련 기사가 나왔습니다.`;
    // (위 두 경우만 '이유'가 있다 — 제목에 거는 종목은 hookStocks 에서 이미 이 조건을 통과한 종목)
    return '';
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
    // 제목이 약속한 것에 첫 문단에서 바로 답한다
    const plan = titlePlan(s);
    if (plan.kind === 'stock') for (const r of plan.rows) { const w = whySentence(r); if (w) out.push(w); }
    if (plan.kind === 'flow') {
        const f = plan.flow, told = f.members.filter(r => r.reason).sort((a, b) => b.energy - a.energy)[0];
        out.push(`${flowWord(f)} ${f.members.length}종목이 함께 올랐고, ` + (f.catalyst ? `같은 날 '${f.catalyst}' 관련 기사가 나왔습니다.` : `${josa(told.name, '은', '는')} '${told.reason}' 기사가 나왔습니다.`));
    }
    // 그래서 오늘은 어떤 날이었나 — 나열 전에 해석 한 마디
    const v = Talk.verdict(s, flowWord).text;
    if (v) out.push(v);
    else if (!out.length) out.push(`${d} +10% 이상 오른 종목은 ${s.rows.length}개였습니다.`);
    let text = out.join(' ');
    // 첫 문장에 날짜(검색어)를 — '오늘은' 으로 시작하면 '10월 2일은'
    if (!/^\d+월 \d+일/.test(text)) text = /^오늘은 /.test(text) ? text.replace(/^오늘은 /, `${d}은 `) : out[0] === v ? `${d}은 ${text}` : `${d} ${text}`;
    return text;
}
// 흐름 한 단락 — 몇 종목이 왜 올랐고, 누가 앞장섰고, 돈은 어디로 갔나
function flowParagraph(f, hooked, introduced, headed) {
    // 소제목에 종목 수가 있거나 첫 문단에서 이미 소개한 흐름이면 '몇 종목이 올랐다'는 문장은 반복하지 않는다
    const out = introduced || headed ? [] : [`${flowWord(f)} ${f.members.length}종목이 함께 올랐습니다.`];
    if (f.catalyst && !introduced) out.push(`같은 날 '${f.catalyst}' 관련 기사가 나왔습니다.`);
    const lu = f.members.filter(r => r.limit);
    const rest = f.members.filter(r => !r.limit).slice(0, lu.length ? 2 : 3);
    if (lu.length) out.push(`${rlJ(lu.slice(0, 3), '이', '가')} 상한가를 기록했고` + (rest.length ? `, ${rest.map(rl).join('·')}도 크게 올랐습니다.` : '.'));
    else if (rest.length) out.push(`${rest.map(rl).join('·')} 순으로 많이 올랐습니다.`);
    // 개별 기사가 확인된 종목 — 제목에 건 종목은 위에서 답했다, 최대 2개
    const told = f.members.filter(r => r.reason && !hooked.has(r)).sort((a, b) => b.energy - a.energy).slice(0, 2);
    for (const r of told) out.push(`${r.name} 관련 '${r.reason}' 기사도 나왔습니다.`);
    const top = f.members.slice().sort((a, b) => b.vol - a.vol)[0];
    if (top && top.vol >= 3e10) out.push(`거래대금은 ${josa(top.name, '이', '가')} ${josa(amount(top.vol), '으로', '로')} 가장 컸습니다.`);
    return out.join(' ').replace('기록했고.', '기록했습니다.');
}

// 이유가 확인되지 않은 큰 흐름 — 규모·상한가·앞장선 종목·돈, 그리고 '근거 기사 미확인'을 분명히
function quietParagraph(f, date, n = 0) {
    const out = [];
    const lu = f.members.filter(r => r.limit), rest = f.members.filter(r => !r.limit).slice(0, lu.length ? 2 : 3);
    if (lu.length) out.push(`이 중 ${lu.length}종목이 상한가였고, ${rlJ(lu.slice(0, 3), '이', '가')} 앞장섰습니다.`);
    else if (rest.length) out.push(`${rest.map(rl).join('·')} 순으로 많이 올랐습니다.`);
    const top = f.members.slice().sort((a, b) => b.vol - a.vol)[0];
    if (top && top.vol >= 3e10) out.push(`거래대금은 ${josa(top.name, '이', '가')} ${josa(amount(top.vol), '으로', '로')} 가장 컸습니다.`);
    out.push(Talk.noArticle(date, n));
    return out.join(' ');
}

// 네이버 블로그 본문 — 붙여넣기 그대로 쓰도록: 꼭지는 이모지(■·점 목록 없음), 문장마다 줄바꿈, 꼭지 사이 빈 줄.
// 목록(<ul><li>)은 스마트에디터에 붙이면 글머리표 서식이 따라와 고치기 어려워 쓰지 않는다.
const FLOW_EMOJI = ['🔥', '⚡', '📌'];
function sentences(t) { return String(t || '').split(/(?<=[다\)]\.)\s+/).map(x => x.trim()).filter(Boolean); }
function blogHtml(m, images) {
    const s = m.story;
    const P = x => `<p>${x}</p>`;
    const LINES = arr => P(arr.join('<br>'));                          // 한 꼭지 = 한 단락, 줄마다 <br>
    const SAY = text => LINES(sentences(text).map(esc));              // 문장마다 줄바꿈
    const H = (emoji, x) => `<p><b>${emoji} ${esc(x)}</b></p>`;
    const GAP = '<p><br></p>';                                         // 꼭지 사이 빈 줄
    const plan = titlePlan(s), hooked = new Set(plan.kind === 'stock' ? plan.rows : []);
    const ctx = { date: m.date, calendar: m.calendar, profileOf: m.profileOf, since: m.since, holiday: m.holiday, story: s };
    // 이미지 — id 로 자리를 정한다. 썸네일(제목 카드)이 맨 위 → 대표 이미지
    const byId = {}, d = mdKo(m.date);
    (images || []).forEach((im, i) => { byId[im.id || (i === 0 ? 'lead-visual' : 'calendar')] = im; });
    const CAP = { leader: `📸 ${d} 오늘의 대장 — 대장주·대장 섹터·대장 테마`, 'theme-bubble': `📸 ${d} 테마별 급등주 지도`,
        'market-tree': `📸 ${d} 시장 전체 등락 트리맵 (ORGO 수집 종목 기준)`, calendar: `📸 ${+m.date.slice(4, 6)}월 대장주 캘린더 (${d}까지)`,
        top5: `📸 ${d} 오늘의 주도주 TOP5 — 상승률×거래대금 기준(마감)`, 'theme-tree': `📸 ${d} 테마별 급등주 트리맵`,
        'market-bubble': `📸 ${d} 시장 전체 등락 버블맵 (ORGO 수집 종목 기준)` };
    const IMG = id => { const im = byId[id]; return im ? [`<p><img src="${esc(im.url)}" alt="${esc(im.alt)}"></p>`].concat(CAP[id] ? [P(esc(CAP[id]))] : []) : []; };

    // ⓪ 캐릭터 시작 멘트(블로그는 멘트만 캐릭터 말투, 본문은 담백하게)
    // ① 첫 문단 — 제목의 답 + 오늘은 어떤 날이었나
    const out = [...IMG('title'), SAY(Persona.blogOpening(m, plan, flowWord)), SAY(intro(m))];
    // ② 오늘의 대장 — 누가, 왜 대장인지
    out.push(GAP, H('🏆', '오늘의 대장'), SAY(Talk.leaderPara(s, m.calendar, m.date, flowWord)), ...IMG('leader'), ...IMG('top5'));

    // ③ 제목 종목 깊게 — 업종·테마, 같은 날 기사, 지난 급등 이력, 같은 테마 동반 여부
    if (plan.kind === 'stock') {
        const flowsTold = new Set();
        for (const r of plan.rows.slice(0, 2)) {
            const t = Talk.stockProfile(r, ctx, flowWord, { flowTold: r.flow && flowsTold.has(r.flow) });
            if (r.flow) flowsTold.add(r.flow);
            if (t) out.push(GAP, H('🔍', `${r.name}, 어떤 종목이길래`), SAY(t));
        }
    }

    // ④ 오늘의 큰 흐름 — 테마 지도 다음에. 이유가 확인된 흐름은 배경·앞장선 종목·돈, 직접 다룬 기사를 못 찾은 큰 흐름은 규모와 그 사실을
    out.push(...IMG('theme-bubble'), ...IMG('theme-tree'), ...IMG('lead-visual'));
    const told = s.lead.slice(0, 3);
    const extra = s.flows.find(f => !told.includes(f) && f.kind !== 'sector' && Story.flowReason(f));
    if (extra) told.push(extra);
    let noArt = 0;   // '기사를 찾지 못했다'를 한 글에서 몇 번 했는지 — 표현을 바꿔 되풀이를 피한다
    told.forEach((f, i) => {
        const known = !!Story.flowReason(f), headed = !f.catalyst;
        out.push(GAP, H(FLOW_EMOJI[i] || '📌', f.catalyst ? `${flowWord(f)} — ${Story.clipWords(f.catalyst, 32)}` : `${flowWord(f)} ${f.members.length}종목 동반 ${known ? '상승' : '급등'}`));
        out.push(SAY(known ? flowParagraph(f, hooked, plan.kind === 'flow' && plan.flow === f, headed) : quietParagraph(f, m.date, noArt++)));
    });

    // ⑤ 그 밖의 동반 상승 — 한 단락으로
    const quiet = s.flows.filter(f => !told.includes(f) && !Story.flowReason(f)).slice(0, 3);
    if (quiet.length) {
        const parts = quiet.map(f => `${flowWord(f)} ${f.members.length}종목(${f.members.slice(0, 2).map(r => `${r.name} ${rateOf(r)}`).join(', ')} 등)`);
        const lu = quiet.flatMap(f => f.members.filter(r => r.limit));
        const luText = !lu.length ? '' : lu.length <= 3 ? ` 이 중 ${josa(lu.map(r => r.name).join('·'), '은', '는')} 상한가였습니다.` : ` 이 중 ${lu.length}종목은 상한가였습니다.`;
        out.push(GAP, H('🤔', '그 밖에 함께 오른 테마'), SAY(`${parts.join(', ')}도 함께 올랐습니다.${luText} ${Talk.noArticle(m.date, noArt++)}`));
    }
    const shown = told.concat(quiet);

    // ⑥ 개별 재료 — 이유가 분명한 종목만 몇 개
    const solos = s.solos.slice().sort((a, b) => b.rate - a.rate).filter(r => !hooked.has(r)).slice(0, 4);
    if (solos.length) {
        out.push(GAP, H('💡', '개별 재료로 오른 종목'));
        out.push(LINES(solos.map(r => `🔺 <b>${esc(r.name)}</b> ${esc(rateOf(r))}${r.limit ? ' (상한가)' : ''} — ${esc(r.reason)}`)));
    }

    // ⑦ 숫자로 본 오늘 — 열기 비교 한 문장 + 꼭 필요한 숫자만
    const nums = [];
    if (s.limitUps.length) nums.push(`🔒 상한가 ${s.limitUps.length}종목: ${s.limitUps.slice(0, 8).map(r => r.name).join(', ')}${s.limitUps.length > 8 ? ` 외 ${s.limitUps.length - 8}종목` : ''}`);
    if (s.money[0]) nums.push(`💰 +10% 이상 종목 중 거래대금 1위: ${s.money[0].name} ${amount(s.money[0].vol)} (${rateOf(s.money[0])})`);
    if (s.continuing.length) nums.push(`🔁 연속 +10% 이상: ${s.continuing.slice(0, 4).map(r => `${r.name}(${r.streak}거래일)`).join(', ')}`);
    if (s.high52.length) nums.push(`🏔️ 52주 신고가: ${s.high52.slice(0, 5).map(r => r.name).join(', ')}`);
    if (s.ipos.length) nums.push(`🆕 신규상장: ${s.ipos.map(r => r.name + (r.vol ? ` (거래대금 ${amount(r.vol)})` : '')).join(', ')}`);
    out.push(GAP, H('📊', '숫자로 본 오늘'), SAY(Talk.heat(s)));
    if (nums.length) out.push(LINES(nums.map(esc)));
    out.push(...IMG('market-tree'), ...IMG('market-bubble'));

    // ⑧ ORGO의 시선 — 본문에 나온 흐름만 놓고 종합, 이어짐, 다음 거래일에 볼 부분 (원인 단정·전망·권유 없이)
    const view = Talk.view(s, ctx, flowWord, shown);
    if (view) out.push(GAP, H('💬', 'ORGO의 시선'), SAY(view));
    out.push(...IMG('calendar'));

    const hol = holidaySentence(m.holiday);
    if (hol) out.push(GAP, H('🗓', '휴장 안내'), SAY(hol));
    // 링크는 주소를 그대로 보이게 — 텍스트로 붙여넣어도 주소가 남는다. 날짜별 정적 페이지(/day/)로는 보내지 않는다
    const link = siteLink(m.date, 'naver_blog', 'blog');
    // 캐릭터 마무리 멘트(그림은 운영자가 직접 넣는다)
    out.push(GAP, SAY(Persona.blogClosing(m)));
    // 마지막 — 웹과 텔레그램 소개(무엇을 볼 수 있는지, 언제 오는지)
    out.push(GAP, H('🧭', 'ORGO에서 더 보기'));
    out.push(LINES([`🌐 <b>웹 orgo.kr</b>`, '매일 오른 종목과 그 이유를 근거 기사와 함께 날짜별로 정리합니다.',
        '대장 캘린더, 테마 지도, 종목별 1년 급등 이력도 볼 수 있습니다.',
        `👉 ${esc(mdKo(m.date))} 오른 종목 전체: <a href="${esc(link)}">${esc(link)}</a>`]));
    out.push(LINES([`📲 <b>텔레그램 채널</b>`, '평일 아침부터 저녁까지 장 흐름을 받아볼 수 있습니다.',
        '장전 브리핑(08:30), 장중 주도주(09:30), 오전 테마(10:00), 장 마감 정리(마감 후), 저녁 \'오늘 왜 올랐나\'(19:00).',
        '휴장일과 해외 증시 휴장 안내도 함께 보내드립니다.',
        `👉 <a href="${CHANNEL}">${CHANNEL}</a>`]));
    const notes = [];
    if (s.abnormal.length) {
        const who = s.abnormal.slice(0, 3).map(a => a.name).join('·') + (s.abnormal.length > 3 ? ` 등 ${s.abnormal.length}종목` : '');
        notes.push(`${josa(who, '은', '는')} 등락률이 가격제한폭(30%)을 벗어나(거래 재개·기준가 변경 등) 집계에서 뺐습니다.`);
    }
    notes.push('공개된 시세와 기사 제목을 자동으로 모은 기록입니다. 기사 인용은 상승 원인을 확정하지 않으며 투자 권유가 아닙니다.');
    out.push(GAP, P(`<span style="color:#888888">${notes.map(n => '※ ' + sentences(n).map(esc).join('<br>')).join('<br>')}</span>`));
    return out.join('\n');
}

// 썸네일(제목 카드) 재료 — 검색 결과에 뜨는 대표 이미지. 제목을 큰 글씨로
function blogCard(m, title) {
    const s = m.story, body = title.replace(/^\d+월 \d+일 /, '');
    let main = body, sub = '';
    if (body.includes('? ')) { const k = body.indexOf('? '); main = body.slice(0, k + 1); sub = body.slice(k + 2); }
    else if (body.includes(' | ')) { const k = body.indexOf(' | '); main = body.slice(0, k); sub = body.slice(k + 3); }
    const chips = [s.limitUps.length ? `상한가 ${s.limitUps.length}` : '', `+15% 이상 ${s.hot.length}종목`, s.leader ? `대장 ${s.leader.name}` : ''].filter(Boolean);
    return { kicker: `${dayKo(m.date)} 마감`, main, sub, chips };
}

function blogTags(m) {
    // 태그는 많다고 좋지 않다 — 제목 종목·날짜·흐름 위주로 12개 이내
    const s = m.story, mm = +m.date.slice(4, 6), dd = +m.date.slice(6);
    const clean = t => String(t || '').replace(/[^가-힣A-Za-z0-9]/g, '');
    const h = hookStocks(s).rows.map(r => clean(r.name) + (r.limit ? '상한가' : '급등'));
    const flows = s.lead.slice(0, 3).map(f => clean(flowWord(f).replace(/ 테마$/, '관련주')));
    const stocks = [...s.limitUps, ...s.solos.slice(0, 2)].map(r => clean(r.name));
    const base = [`${mm}월${dd}일상한가`, `${mm}월${dd}일급등주`, '상한가', '급등주', '주식시황'];
    return [...new Set(h.concat(base.slice(0, 2), flows, base.slice(2), stocks))].filter(t => len(t) >= 2).slice(0, 12);
}

function naverBlog(m, images) {
    const title = blogTitle(m);
    const html = blogHtml(m, images || []);
    // 텍스트 복사본: 꼭지 제목 바로 아래에 본문, 단락 사이 빈 줄 한 줄
    // 이미지 설명(📸) 줄은 이미지가 없는 텍스트 복사본에선 뺀다
    const text = html.replace(/<p>📸[^<]*<\/p>\n?/g, '').replace(/<p><br><\/p>\n?/g, '').replace(/(<p><b>[^<]*<\/b><\/p>)\n/g, '$1').replace(/<br>/g, '\n').replace(/<\/(p|li|ul)>/g, '\n').replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
    return { title, html, text, tags: blogTags(m), images: images || [], card: blogCard(m, title) };
}

function assertSafe(s) {
    const t = String(s || '').replace(/투자 권유가 아닙니다/g, '');
    if (FORBIDDEN.test(t)) throw new Error('Forbidden advisory wording in marketing copy: ' + (t.match(FORBIDDEN) || [])[0]);
    return s;
}

module.exports = { threadsLen, blogCard, holidayLine, holidaySentence, josa, flowName, flowWord, material, threads, threadsHook, headPhrase, hookStocks, siteLink, naverBlog, blogTitle, pageTitle, pageDesc, blogTags, intro, assertSafe, md, mdKo };
