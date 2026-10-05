'use strict';
/**
 * 원고의 '해석' — 블로그 🏆 오늘의 대장·🔍 제목 종목·💬 ORGO의 시선, 쓰레드 💬 한 줄.
 *
 * 나열 대신 "그래서 오늘은 어떤 날이었나"를 말하되, 데이터로 확인되는 것만 말한다.
 *  - 돈이 어디로 몰렸나: +10% 이상 오른 종목들의 거래대금 가운데 주도 흐름의 몫(신규상장 제외)
 *  - 열기: +15% 이상 종목 수를 전 거래일과 비교
 *  - 재료: 같은 날 기사로 확인되는 흐름과, 직접 다룬 기사를 찾지 못한 흐름 ('이유 없음'이라고 단정하지 않는다)
 *  - 대장: 거래대금×상승률 기준 대장이 왜 대장인지(목록 밖 대형주·신규상장 포함)
 *  - 제목 종목: 업종·테마, 같은 날 기사, ORGO 기록상 지난 급등 이력, 같은 테마 동반 여부
 * 본문에 나온 흐름만 결론에서 다시 말한다. 원인 단정·전망·매매 권유는 쓰지 않는다
 * (Story.FORBIDDEN + 권유형 기사 제목 거르기). 같은 문장이 매일 반복되지 않게 날짜별로 표현을 바꾼다. 유료 LLM 호출 없음.
 */
const Story = require('./market_story');
const { josa, pct, amount } = Story;

const WD = ['일', '월', '화', '수', '목', '금', '토'];
function mdKo(ymd) { return (+ymd.slice(4, 6)) + '월 ' + (+ymd.slice(6, 8)) + '일'; }
function dayKo(ymd) { return `${mdKo(ymd)}(${WD[new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay()]})`; }
function addDays(ymd, n) { const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10).replace(/-/g, ''); }
// 날짜마다 다른 표현 — 같은 날은 항상 같은 결과
function pick(list, date, salt = 0) { let h = salt; for (const c of String(date)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return list[h % list.length]; }
function names(list, n = 2) { return list.slice(0, n).join('·'); }
// 기사 제목·배경 중 권유·전망형 문구 — 인용하지 않는다
const ADVICE = /찾아야|줍줍|담아야|사야\s|사야$|노려|주목해야|수혜주\s*된|팔아라|추천|목표가/;

// 주도 흐름이 +10% 이상 오른 종목들(신규상장 제외)의 거래대금에서 차지한 몫
function moneyShare(s, f) {
    const listed = s.rows.filter(r => !r.ipo);
    const total = listed.reduce((a, r) => a + r.vol, 0);
    const mine = f.members.filter(r => !r.ipo).reduce((a, r) => a + r.vol, 0);
    return total > 0 ? mine / total : 0;
}
// '기사를 찾지 못했다'는 사실만 — 이유가 없다고 단정하지 않는다
// n: 한 글에서 몇 번째로 하는 말인지 — 같은 문장을 되풀이하지 않게
function noArticle(date, n = 0) {
    if (n === 0) return pick(['같은 날 이 종목들을 직접 다룬 기사는 찾지 못했습니다.', '같은 날 이 흐름을 직접 다룬 기사는 찾지 못했습니다.'], date, 3);
    return pick(['이쪽도 직접 다룬 기사는 찾지 못했습니다.', '여기도 같은 날 기사로는 이유가 확인되지 않았습니다.'], date, 3 + n);
}

/** 오늘은 어떤 날이었나 — { text, short } */
function verdict(s, fw) {
    const lead = s.lead, date = s.date || '';
    if (!lead.length) {
        if (!s.rows.length) return { text: '', short: '' };
        return {
            text: pick(['뚜렷한 주도 테마 없이 종목마다 제각각의 소식에 반응한 하루였습니다.', '큰 줄기 없이 개별 종목의 소식이 주가를 움직인 하루였습니다.'], date),
            short: '주도 테마 없이 개별 소식에 반응한 날',
        };
    }
    const f = lead[0], p = Math.round(moneyShare(s, f) * 100), w = fw(f);
    const base = '+10% 이상 오른 종목들의 거래대금' + (s.ipos && s.ipos.length ? '(신규상장 제외)' : '');
    if (p >= 50) return {
        text: `${w} 쪽으로 돈이 확실히 몰린 하루였습니다. ${base} 가운데 ${p}%가 ${w}에서 나왔습니다.`,
        short: `${josa(f.label, '으로', '로')} 돈이 몰린 날 — 급등주 거래대금의 ${p}%`,
    };
    if (p >= 30) return {
        text: `돈이 가장 많이 실린 곳은 ${josa(w, '이었습니다', '였습니다')}. ${base} 가운데 ${p}%가 ${w}에서 나왔습니다.`,
        short: `${f.label}에 돈이 가장 많이 실린 날 — 급등주 거래대금의 ${p}%`,
    };
    if (lead.length >= 2) return {
        text: `${josa(w, '과', '와')} ${fw(lead[1])} 등 여러 테마가 함께 움직인 하루였습니다. 비중이 가장 큰 ${w}조차 ${base} 가운데 ${p}%에 그쳐, 돈이 한쪽으로 쏠리지는 않았습니다.`,
        short: `${f.label}·${lead[1].label}로 돈이 나뉜 날`,
    };
    return { text: `${josa(w, '이', '가')} 앞장섰지만, ${base} 가운데 ${w} 비중은 ${p}%에 그쳐 쏠림은 약했습니다.`, short: `${josa(f.label, '이', '가')} 앞장선 날` };
}

/** 급등주 열기 — 전 거래일과 비교 */
function heat(s) {
    const h = s.hot.length, p = s.prevHot, date = s.date || '';
    if (p == null) return `+15% 이상 오른 종목은 ${h}개였습니다.`;
    const head = `+15% 이상 오른 종목은 ${h}개로 전 거래일(${p}개)`;
    if (h - p >= Math.max(5, p * 0.3)) return `${head}보다 크게 늘어, 급등주 열기가 ${pick(['달아올랐습니다', '뜨거워졌습니다'], date)}.`;
    if (h - p >= Math.max(3, p * 0.15)) return `${head}보다 다소 늘었습니다.`;
    if (p - h >= Math.max(5, p * 0.3)) return `${head}보다 크게 줄어, 급등주 열기가 ${pick(['식었습니다', '가라앉았습니다'], date)}.`;
    if (p - h >= Math.max(3, p * 0.15)) return `${head}보다 다소 줄었습니다.`;
    return `${head}과 비슷했습니다.`;
}

/** 🏆 오늘의 대장 — 누가, 왜 대장인지(목록 밖 대형주·신규상장 설명 포함) */
function leaderPara(s, calendar, date, fw) {
    const L = s.leader;
    if (!L) {
        const f = s.lead[0], focused = f && moneyShare(s, f) >= 0.4;
        return '오늘은 대장주 기준(거래대금×상승률)을 넘는 종목이 없었습니다. ' + (focused && fw
            ? `${josa(fw(f), '으로', '로')} 돈은 몰렸지만, 한 종목이 독주하지는 않았습니다.` : '큰돈이 한 종목에 몰리지 않은 날입니다.');
    }
    const amt = L.vol ? amount(L.vol) : '';
    let t = `오늘의 대장은 ${L.name}입니다.`;
    if (L.ipo) t += ` 신규상장 첫날로${amt ? ` 거래대금 ${josa(amt, '이', '가')} 실렸습니다` : ' 거래가 몰렸습니다'}. 첫날 등락률은 공모가 기준이라, 대장을 고를 때는 상승률을 30%로 쳐서 다른 종목과 비교했습니다.`;
    else if (L.resumed) t += ` 거래가 재개된 날로${amt ? `, 거래대금 ${josa(amt, '이', '가')} 실렸습니다` : ' 거래가 몰렸습니다'}.`;
    else if (!L.row) t += ` ${pct(L.rate)} 올라 급등주 목록(+10% 이상)에는 들지 않지만, 거래대금 ${josa(amt, '이', '가')} 실려 상승 에너지(거래대금×상승률)가 가장 컸습니다.`;
    else t += ` ${pct(L.rate)} 오르며 거래대금 ${josa(amt, '이', '가')} 실려, 상승 에너지(거래대금×상승률)가 가장 컸습니다.`;
    const month = Object.entries(calendar || {}).filter(([d, v]) => d.slice(0, 6) === date.slice(0, 6) && d <= date && v && v.stock && v.stock.ticker === L.ticker).length;
    if (month >= 2) t += ` 이번 달에만 ${month}번째 대장입니다.`;
    return t;
}

/** 🔍 제목 종목 — 업종·테마, 같은 날 기사, 지난 급등 이력, 같은 테마 동반 여부 */
function stockProfile(r, ctx, fw, opts = {}) {
    const date = ctx.date, out = [], s = ctx.story;
    const theme = String(r.theme || '').trim(), sector = String(r.sector || '').trim().replace(/\s*,\s*/g, '·');
    if (sector || theme) out.push(`${josa(r.name, '은', '는')} ${[sector && `${sector} 업종`, theme && `${theme} 테마`].filter(Boolean).join(', ')}로 분류되는 종목입니다.`);
    // 같은 날 기사 — 이유의 근거 기사 먼저, 그 밖의 기사는 제목에 종목 이름이 있을 때만(시황 묶음 기사 제외)
    const row = r.row || {};
    const ev = [].concat(row.reason_evidence || [], (row.news || []).filter(n => n && String(n.title || '').includes(r.name)))
        .filter(n => n && n.title && String(n.date || '').replace(/\D/g, '').slice(0, 8) === date && !/공모가/.test(n.title) &&
            (r.limit || !/상한가|上/.test(n.title)));   // 장중 상한가 기사는 종가가 상한가가 아니면 뺀다(오해 방지)
    const seen = new Set(), titles = [];
    for (const n of ev) {
        const t = Story.clip(String(n.title).replace(/^\s*\[[^\]]{1,12}\]\s*/, '').replace(/·{2,}|\.{3,}/g, '…').replace(/\s+/g, ' ').trim(), 44);
        if (!t || seen.has(t) || Story.FORBIDDEN.test(t) || ADVICE.test(t)) continue;
        seen.add(t); titles.push(`「${t}」` + (n.source ? `(${n.source})` : ''));
        if (titles.length >= 2) break;
    }
    if (titles.length) out.push(`같은 날 나온 기사: ${titles.join(', ')}.`);
    // 지난 급등 이력 — ORGO 기록(급등주 목록, +10% 이상) 기준
    const events = (ctx.profileOf && ctx.profileOf(r.ticker)) || null;
    if (events) {
        const start = ctx.since && ctx.since > addDays(date, -365) ? ctx.since : addDays(date, -365);
        const label = start === ctx.since ? `ORGO 기록이 시작된 ${+start.slice(0, 4)}년 ${+start.slice(4, 6)}월 이후` : '최근 1년 동안';
        const past = events.filter(e => e && /^\d{8}$/.test(e.date) && e.date < date && e.date >= start && Number(e.change_rate) >= 10)
            .sort((a, b) => b.date.localeCompare(a.date));
        if (!past.length) out.push(`${label} +10% 이상 오른 적이 없던 종목이라, 오랜만의 급등입니다.`);
        else {
            const last = past[0], why = pastReason(last);
            const when = (last.date.slice(0, 4) !== date.slice(0, 4) ? `${+last.date.slice(0, 4)}년 ` : '') + mdKo(last.date);
            out.push(`${label} +10% 이상 오른 날이 이번 말고도 ${past.length}번 있었습니다. 직전은 ${when}(${pct(last.change_rate)})` +
                (why ? `로, '${why}' 기사가 나온 날이었습니다.` : '이었습니다.'));
            if (past.length >= 8) out.push(pick(['급등이 잦은 편인 종목입니다.', '크게 오른 날이 많은 종목입니다.'], date, 7));
        }
    }
    // 같은 테마가 함께 올랐는지 — 흐름 안이면 그 흐름, 흐름 밖인데 같은 계열 흐름이 있으면 그 사실도
    const f = r.flow;
    const sameFamily = !f && s ? s.flows.find(x => x.key === r.family && x.members.length >= 3) : null;
    if (f && f.members.length >= 3) { if (!opts.flowTold) out.push(`혼자가 아니라 ${fw(f)} ${f.members.length}종목이 같이 오른 날이었습니다.`); }
    else if (sameFamily) out.push(`같은 ${fw(sameFamily)} ${sameFamily.members.length}종목도 함께 올랐지만, ${josa(r.name, '은', '는')} 회사 자체 소식을 다룬 기사가 따로 나왔습니다.`);
    else if (r.reason) out.push(pick(['같은 테마에서 함께 크게 오른 종목은 없었습니다. 회사 자체 소식에 반응한 것으로 보입니다.',
        '같은 테마 종목들은 크게 움직이지 않아, 회사 자체 소식에 반응한 상승으로 보입니다.',
        '테마 동반 상승은 없었고, 이 회사만의 소식이 주가를 움직인 것으로 보입니다.'], date, r.ticker.charCodeAt(5)));
    return out.join(' ');
}
function pastReason(e) {
    const src = String(e.reason_source || ''), t = Story.cleanReason(String(e.rise_reason || ''));
    if (!/^(news_extract|news_headline|admin)$/.test(src) && !/^(news|toss)$/.test(String(e.reason_origin || ''))) return '';
    if (e.reason_kind === 'analyst' || e.reason_kind === 'related' || e.reason_kind === 'sector') return '';
    if (Story.parseGroup(t) || !Story.goodReason(t) || Story.FORBIDDEN.test(t) || ADVICE.test(t)) return '';
    return Story.clipWords(t, 30);
}

/** 💬 ORGO의 시선 — 본문에 나온 흐름(shown)만 놓고 오늘을 종합 + 이어짐 + 다음 거래일에 볼 부분 */
function view(s, ctx, fw, shown) {
    const date = ctx.date, out = [];
    const flows = (shown || s.lead).filter(Boolean);
    const known = flows.filter(f => Story.flowReason(f)), quiet = flows.filter(f => !Story.flowReason(f));
    const f1 = s.lead[0];
    // ① 종합 — 돈이 몰린 곳과 재료가 확인되는 곳이 같은가
    if (!s.lead.length) {
        if (s.rows.length) out.push(pick(['테마보다 종목 하나하나의 소식이 주가를 움직인 날이었습니다.', '큰 흐름보다 개별 소식이 앞선 날이었습니다.'], date, 11));
    } else if (!known.length) {
        out.push(pick(['크게 움직인 흐름 가운데 같은 날 직접 다룬 기사를 찾은 곳이 없었습니다. 상승 이유를 단정하기 어려운 종목이 많았던 날입니다.',
            '오늘 큰 흐름들은 같은 날 기사로 이유가 확인되지 않았습니다. 기사로 설명되지 않는 상승이 많았던 날입니다.',
            '주요 흐름 어디에서도 같은 날 직접 다룬 기사를 찾지 못했습니다. 이유를 단정하기 어려운 날입니다.'], date, 13));
    } else if (known.includes(f1)) {
        out.push(moneyShare(s, f1) >= 0.3
            ? `기사로 확인되는 재료가 있는 ${fw(f1)}에 돈이 실린, 비교적 이야기가 분명한 날이었습니다.`
            : `${names(known.map(fw))}처럼 재료가 확인되는 흐름이 앞에 섰지만, 돈은 여러 곳에 나뉘었습니다.`);
    } else {
        out.push(`가장 크게 움직인 ${josa(fw(f1), '은', '는')} 같은 날 직접 다룬 기사를 찾지 못했고, 기사로 확인되는 쪽은 ${josa(names(known.map(fw)), '이었습니다', '였습니다')}.`);
    }
    // ② 눈에 띄는 점 — 기사를 찾지 못했는데 상한가가 여럿 나온 흐름
    const loud = quiet.slice().sort((a, b) => b.limitUps - a.limitUps)[0];
    if (loud && loud.limitUps >= 3) out.push(`특히 ${josa(fw(loud), '은', '는')} 직접 다룬 기사를 찾지 못했는데도 상한가가 ${loud.limitUps}개 나왔습니다.`);
    // ③ 이어짐 — 본문에 나온 흐름 중 가장 오래 이어진 것
    const long = flows.filter(f => f.streak >= 2).sort((a, b) => b.streak - a.streak)[0];
    if (long) out.push(long.streak >= 3 ? `${josa(fw(long), '은', '는')} ${long.streak}거래일째 이어지고 있어, 짧지 않은 흐름이 됐습니다.` : `${josa(fw(long), '은', '는')} 전 거래일에 이어 이틀째 올랐습니다.`);
    // ④ 다음 거래일에 볼 부분 — 전망이 아니라 확인할 것
    const w = watch(ctx, fw, known, quiet);
    if (w) out.push(w);
    const text = out.join(' ');
    if (Story.FORBIDDEN.test(text)) throw new Error('Advisory wording in commentary: ' + text.match(Story.FORBIDDEN)[0]);
    return text;
}
function watch(ctx, fw, known, quiet) {
    const pts = [], date = ctx.date;
    const f = known[0];
    if (f) pts.push(f.streak >= 2 ? `${fw(f)} 강세가 ${f.streak + 1}거래일째로 이어지는지` : `${fw(f)} 강세가 하루로 끝나지 않는지`);
    const q = quiet.find(x => x.members.length >= 4);
    if (q) pts.push(`${josa(fw(q), '을', '를')} 직접 다룬 기사가 나오는지`);
    const h = ctx.holiday;
    if (h && h.kr) pts.push('휴장 사이에 나온 소식이 다음 장에 어떻게 반영되는지');
    if (!pts.length) return '';
    const when = h && h.next ? `다음 거래일인 ${h.next}` : '다음 거래일';
    const verb = pick(['지켜볼 부분입니다', '확인할 부분입니다'], date, 5);
    if (pts.length === 1) return `${when}에는 ${pts[0]}가 ${verb}.`;
    return `${when}에는 ${pts.slice(0, -1).join(', ')}, 그리고 ${pts[pts.length - 1]}가 ${verb}.`;
}

module.exports = { verdict, heat, leaderPara, stockProfile, view, watch, moneyShare, pastReason, noArticle, dayKo, mdKo, pick, ADVICE };
