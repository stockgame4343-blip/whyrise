'use strict';
/**
 * ORGO 캐릭터 말투 — 파란 정장·안경의 애널리스트 캐릭터(public/img/orgo-mascot.png).
 *
 * 쓰는 곳 (사용자 결정 2026-10-06)
 *  - 쓰레드: 글 전체를 캐릭터 말투로
 *  - 네이버 블로그: 시작·마무리 멘트만 캐릭터 말투, 본문은 지금처럼 담백하게
 *  - 텔레그램: 쓰지 않는다
 *
 * 말투 규칙: 해요체, 밝고 똑 부러지게. 이모지는 줄마다 하나 이하.
 * '떡상'·'꼭 담으세요'·'오를 거예요' 같은 과장·권유·전망은 쓰지 않는다(Story.FORBIDDEN + HYPE 로 한 번 더 막는다).
 * 같은 날은 항상 같은 문장, 날짜마다 표현을 바꿔 매일 똑같지 않게.
 */
const Story = require('./market_story');
const Talk = require('./market_commentary');
const { josa } = Story;

const HYPE = /떡상|떡락|가즈아|무조건|꼭\s*담|담아\s*두|사\s*두|오를\s*거|오를\s*것|대박|폭등\s*예상|수익\s*보장/;
function pick(list, date, salt) { return Talk.pick(list, date, salt); }
function safe(text) {
    const t = String(text || '');
    if (Story.FORBIDDEN.test(t) || HYPE.test(t)) throw new Error('Persona wording not allowed: ' + t);
    return t;
}

// ── 쓰레드 ──
function threadsOpen(dayKo, date) {
    return safe(`📌 ${dayKo} ` + pick(['마감 정리 왔어요!', '장 마감 정리해 왔어요!', '오늘 장 마감 정리예요!'], date, 21));
}
/** 오늘은 어떤 날이었나 — 캐릭터 말투 한두 문장 */
function verdictTalk(s) {
    const lead = s.lead, date = s.date || '';
    if (!s.rows.length) return '';
    if (!lead.length) return safe(pick(['오늘은 큰 테마 없이 종목마다 각자 소식에 움직였어요.', '오늘은 뚜렷한 주도 테마 없이 개별 종목 장이었어요.'], date, 22));
    const f = lead[0], p = Math.round(Talk.moneyShare(s, f) * 100), L = f.label;
    if (p >= 50) return safe(`오늘은 ${josa(L, '으로', '로')} 돈이 확 몰렸어요. 급등주 거래대금의 ${p}%가 ${L} 쪽이었거든요 👀`);
    if (p >= 30) return safe(`오늘 돈이 가장 많이 실린 곳은 ${L}! 급등주 거래대금의 ${p}%였어요.`);
    if (lead.length >= 2) return safe(`오늘은 ${L}·${lead[1].label} 등 여러 테마가 골고루 움직였어요. 한쪽으로 쏠리진 않았고요.`);
    return safe(`${josa(L, '이', '가')} 앞장섰는데, 쏠림은 크지 않았어요.`);
}
function holidayTalk(h) {
    if (!h) return '';
    if (h.kr) return safe(`🗓 ${h.kr}, 국내 증시는 쉬어요.` + (h.next ? ` 다음 장은 ${h.next}!` : ''));
    if (h.foreignPlain) return safe(`🌏 참고로 ${h.foreignPlain}`);
    return '';
}
function threadsTail(date) {
    return safe(pick(['종목별 이유는 댓글 링크에 정리해 뒀어요 👇', '종목마다 왜 올랐는지는 댓글 링크에 있어요 👇'], date, 23));
}

// ── 블로그 멘트(시작·마무리만) ──
function blogOpening(m, plan, flowWord) {
    const date = m.date;
    const greet = pick(['안녕하세요! 오늘도 장 마감 정리 들고 왔어요 😊', '안녕하세요, 오늘 장도 같이 정리해 볼게요!', '오늘 장 마감 정리, 바로 시작할게요!'], date, 24);
    let hook = '오늘 장 흐름부터 차근차근 볼게요.';
    if (plan.kind === 'stock' && plan.rows.length) hook = `${plan.rows.map(r => r.name).join('·')} ${plan.rows[0].limit ? '상한가' : '급등'} 이유부터 볼게요.`;
    else if (plan.kind === 'flow') hook = `${flowWord(plan.flow)} 급등 이유부터 볼게요.`;
    return safe(`${greet} ${hook}`);
}
function blogClosing(m) {
    const date = m.date, h = m.holiday;
    const end = pick(['오늘 정리는 여기까지예요!', '오늘 마감 정리는 여기까지예요!'], date, 25);
    const next = h && h.next ? `다음 장인 ${h.next}에도 정리해서 올릴게요.` : '다음 장에도 정리해서 올릴게요.';
    const ask = pick(['궁금한 종목은 댓글로 남겨 주세요 🙌', '같이 보고 싶은 종목이 있으면 댓글로 알려 주세요 🙌'], date, 26);
    return safe(`${end} ${next} ${ask}`);
}

const MASCOT_URL = 'https://orgo.kr/img/orgo-mascot-sm.png';
module.exports = { threadsOpen, verdictTalk, holidayTalk, threadsTail, blogOpening, blogClosing, safe, HYPE, MASCOT_URL };
