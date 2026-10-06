'use strict';
// '오늘의 흐름'(market_story) 회귀 테스트 — node --test scripts/test_market_story.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const S = require('./market_story');
const Copy = require('./marketing_copy');

let seq = 0;
const row = (name, rate, extra = {}) => ({ ticker: String(200000 + (++seq)), name, change_rate: rate, trading_value: 1e10, ...extra });
const news = (reason, kind = 'catalyst') => ({ rise_reason: reason, reason_source: 'news_extract', reason_kind: kind });
const day = rankings => ({ date: '20261002', is_final: true, rankings });

test('가격제한폭을 벗어난 종목은 1위·집계에서 빠지고 신규상장주는 숫자 없이 따로 표시된다', () => {
    const s = S.build(day([
        row('재개주', 900, { theme_tag: '키오스크' }),
        row('신규주', 59.5, { theme_tag: '2026 하반기 신규상장' }),
        row('보통주', 20, news('200억 공급계약 체결')),
    ]));
    assert.deepEqual(s.abnormal.map(a => a.name), ['재개주']);
    assert.ok(!s.rows.some(r => r.name === '재개주'));
    assert.deepEqual(s.ipos.map(r => r.name), ['신규주']);
    assert.equal(s.hot.length, 1);                       // 신규상장주는 '+15% 이상' 집계에서 뺀다
    const t = Copy.threads(Copy.material({ date: '20261002', rows: day([]).rankings.concat(s.rows.map(r => r.row)) })).text;
    assert.doesNotMatch(t, /900/);
});

test('그룹 종목 수는 실제로 묶인 종목만 센다 (상류 문장의 N종목을 쓰지 않는다)', () => {
    const s = S.build(day([
        row('부품A', 18, { ...news('자동차·부품주 3종목 동반 상승', 'theme'), theme_tag: '자동차부품' }),
        row('기타B', 12, { theme_tag: '화장품' }),
    ]));
    assert.equal(s.flows.length, 0);                     // 1종목은 흐름이 아니다
    const t = Copy.threads(Copy.material({ date: '20261002', rows: s.rows.map(r => r.row) })).text;
    assert.doesNotMatch(t, /3종목/);
});

test('같은 계열 테마를 묶고 기사 배경과 개별 이유를 함께 보존한다', () => {
    const s = S.build(day([
        row('위성A', 19, { ...news('메탄위성 교신 성공'), theme_tag: '우주항공산업(누리호/인공위성 등)' }),
        row('스페X', 18, { theme_tag: '스페이스X(SpaceX)' }),
        row('태양B', 12, { theme_tag: '우주태양광(페로브스카이트 등)' }),
        row('항공C', 11, { theme_tag: '우주항공산업(누리호/인공위성 등)' }),
        row('광A', 29.8, { ...news('광통신주 동반 강세 — 美 빅테크 투자 확대 소식', 'sector'), theme_tag: '광통신(광케이블/광섬유 등)', trading_value: 1e11 }),
        row('광B', 16, { ...news('광통신주 동반 강세 — 美 빅테크 투자 확대 소식', 'sector'), theme_tag: '통신장비' }),
        row('광C', 11, { ...news('AI 광통신 수혜'), theme_tag: '광통신(광케이블/광섬유 등)' }),
    ]));
    const sp = s.flows.find(f => f.key === '우주항공');
    assert.ok(sp && sp.members.length === 4, '우주항공 4종목');
    assert.equal(sp.members.find(r => r.name === '위성A').reason, '메탄위성 교신 성공');
    const op = s.flows.find(f => f.key === '광통신');
    assert.equal(op.catalyst, '美 빅테크 투자 확대');
    assert.deepEqual(op.members.map(r => r.name).sort(), ['광A', '광B', '광C']);
    assert.equal(s.flows[0].key, '광통신');              // 거래대금×상승률로 순위
    assert.equal(s.headline, '광통신·우주항공 강세');
});

test('이유 품질: 가격대·시장 서술·투자 의견·잘린 제목은 이유로 쓰지 않는다', () => {
    for (const bad of ['5만원선 돌파', '증시 혼조', '수주 대비 저평가 (하나)', '美 월가서 탈모치료제 주목? 찍은 이유 [주간', '급한불 끄는, 액면병합 추진', '피지컬 AI 부문 고평가'])
        assert.equal(S.goodReason(S.cleanReason(bad)), false, bad);
    for (const ok of ['20억원 규모 자사주 취득', '메탄위성 교신 성공', '코로나 재확산 우려', '230억 LG U+ 파주 1239 기계설비공사 수주'])
        assert.equal(S.goodReason(S.cleanReason(ok)), true, ok);
    assert.equal(S.cleanReason('5대 1 액면병합 마친, 거래 재개일'), '5대 1 액면병합 후 거래 재개');
    assert.equal(S.cleanReason('mRNA 암백신 3상 첫 성공 (IBK투자증권)'), 'mRNA 암백신 3상 첫 성공');
});

test('출처가 확인되지 않은 사유·관련 보도·리포트는 이유가 아니다', () => {
    const s = S.build(day([
        row('규칙주', 20, { rise_reason: '리튬 계약 체결', reason_source: 'stockrise', reason_origin: 'rule' }),
        row('보도주', 18, { rise_reason: '관련 보도: 대표 인터뷰', reason_source: 'news_extract', reason_kind: 'related' }),
        row('리포트주', 16, { rise_reason: '증권사 목표가 19만원 상향 (iM)', reason_source: 'news_extract', reason_kind: 'analyst' }),
        row('토스주', 15, { rise_reason: 'APR1400 수혜 부각', reason_source: 'stockrise', reason_origin: 'toss' }),
    ]));
    const by = Object.fromEntries(s.rows.map(r => [r.name, r.reason]));
    assert.equal(by['규칙주'], ''); assert.equal(by['보도주'], ''); assert.equal(by['리포트주'], '');
    assert.equal(by['토스주'], 'APR1400 수혜 부각');
});

test('혼자 남은 기사 배경 그룹은 그 배경을 개별 이유로 쓴다', () => {
    const s = S.build(day([row('원전A', 26.5, { ...news('원전주 동반 강세 — 1200억달러 투자해 美 대형 원전 8기 건설 소식', 'sector'), theme_tag: '원자력발전소 해체' })]));
    assert.equal(s.solos[0].reason, '1200억달러 투자해 美 대형 원전 8기 건설');
});

test('연속 상승·흐름 연속일은 과거 스냅샷에 같은 규칙을 적용해 센다', () => {
    const mk = (date, names) => ({ date, is_final: true, rankings: names.map(([n, t]) => ({ ticker: t, name: n, change_rate: 15, trading_value: 1e10, theme_tag: '광통신' })) });
    const today = mk('20261002', [['가', '000001'], ['나', '000002'], ['다', '000003']]);
    const hist = [mk('20261001', [['가', '000001'], ['나', '000002'], ['라', '000004']]), mk('20260930', [['가', '000001'], ['마', '000005'], ['바', '000006']])];
    const s = S.build(today, { history: hist });
    assert.equal(s.rows.find(r => r.name === '가').streak, 3);
    assert.equal(s.rows.find(r => r.name === '나').streak, 2);
    assert.equal(s.rows.find(r => r.name === '다').streak, 1);
    assert.equal(s.flows[0].streak, 3);
    assert.equal(s.prevHot, 3);
});

test('제목은 이유가 실린 종목만 "○○ 상한가 이유"로 걸고, 40자 안쪽이다', () => {
    const rows = [
        row('이유없는상한', 30, { theme_tag: '패션' }),
        row('머큐리', 29.8, { ...news('AI 데이터센터發 광통신 투자 확대'), theme_tag: '광통신(광케이블/광섬유 등)', trading_value: 3e10 }),
    ];
    const m = Copy.material({ date: '20261002', rows });
    const title = Copy.blogTitle(m);
    assert.match(title, /머큐리/);
    assert.doesNotMatch(title, /이유없는상한/);
    assert.ok(Array.from(title).length <= 40, title);
    assert.match(Copy.headPhrase(m.story), /머큐리 상한가/);
    assert.match(Copy.pageTitle(m), /^10월 2일 상한가·급등주 \| 머큐리 상한가 이유/);
});

test('조용한 날과 빈 날도 문장이 깨지지 않는다', () => {
    const quiet = Copy.material({ date: '20261002', rows: [row('혼자', 11, { theme_tag: '화장품' })] });
    const t = Copy.threads(quiet).text;
    assert.match(t, /혼자 \+11\.0%/);
    assert.doesNotMatch(t, /undefined|NaN|null/);
    const b = Copy.naverBlog(quiet, []);
    assert.doesNotMatch(b.html + b.title, /undefined|NaN|null/);
    assert.match(b.html, /10월 2일은 (뚜렷한 주도 테마 없이|큰 줄기 없이)/);
    const empty = Copy.material({ date: '20261002', rows: [] });
    assert.equal(Copy.threads(empty).text, '');
    assert.doesNotMatch(Copy.naverBlog(empty, []).html, /undefined|NaN/);
});

test('반올림은 사람이 읽는 방식(10진 기준)이다', () => {
    assert.equal(S.pct(11.35), '+11.4%');
    assert.equal(S.pct(16.25), '+16.3%');
    assert.equal(S.pct(-0.08), '-0.1%');
    assert.equal(require('./tg_common').pct(11.35), '+11.4%');
});

test('상한가는 호가단위로 계산한 상한가에 닿았을 때만 (+29.7%라도 4호가 모자라면 아님)', () => {
    assert.equal(S.limitPrice(14220), 18480);
    assert.equal(S.isLimitUp(18440, 29.68), false);          // 티엠씨 10/2: 종가 18,440 < 상한가 18,480
    assert.equal(S.isLimitUp(18480, 29.96), true);
    assert.equal(S.isLimitUp(5690, 30.5), true);             // 표기 등락률이 30%를 살짝 넘어도 종가가 상한가 이상이면 상한가
    assert.equal(S.isLimitUp(0, 29.8), true);                // 종가가 없으면 등락률 기준
    const s = S.build(day([row('사분', 29.68, { close_price: 18440, theme_tag: '광통신' }), row('상한', 29.96, { close_price: 18480, theme_tag: '광통신' })]));
    assert.deepEqual(s.limitUps.map(r => r.name), ['상한']);
});

test('시장 스냅샷 보충 종목은 전일 종가로 다시 계산해 맞을 때만 쓰고, 30% 초과 표기는 전일 종가로 바로잡는다', () => {
    const prev = new Map([['300001', 2945], ['300002', 4380]]);
    const s = S.build({ date: '20261002', rankings: [{ ticker: '300002', name: '바로잡기', change_rate: 30.5, close_price: 5690, trading_value: 1e10, theme_tag: '로봇' }], _prevCloses: prev });
    assert.equal(s.rows[0].rate, 29.91);
    assert.equal(s.limitUps.length, 1);
});

test('우선주는 같은 회사로 세어 같은 회사 주식끼리는 흐름이 되지 않는다', () => {
    const s = S.build(day([row('두산퓨얼셀', 20, { theme_tag: '고체산화물 연료전지' }), row('두산퓨얼셀1우', 18, { theme_tag: '고체산화물 연료전지' }),
        row('두산퓨얼셀2우B', 17, { theme_tag: '고체산화물 연료전지' })]));
    assert.equal(s.flows.length, 0);
    assert.equal(S.companyOf('DL이앤씨우', new Set(['DL이앤씨'])), 'DL이앤씨');
    assert.equal(S.companyOf('한우', new Set()), '한우');
});

test('스팩·거래 없던 종목은 빼고, 조사는 영문·숫자 발음도 맞춘다', () => {
    const s = S.build(day([row('한화플러스제5호스팩', 33), row('정지주', 25, { trading_value: 0, trading_volume: 0 }), row('정상주', 12)]));
    assert.deepEqual(s.rows.map(r => r.name), ['정상주']);
    assert.equal(S.josa('형지I&C', '이', '가'), '형지I&C가');
    assert.equal(S.josa('LG', '이', '가'), 'LG가');
    assert.equal(S.josa('루트K', '이', '가'), '루트K가');
    assert.equal(S.josa('일신석재', '은', '는'), '일신석재는');
    assert.equal(S.josa('코이즈', '은', '는'), '코이즈는');
    assert.equal(S.josa('삼천당제약', '이', '가'), '삼천당제약이');
});

test('기사 배경의 핵심어를 공유하는 개별 이유는 같은 흐름으로 묶는다 (하이스틸 → 철강)', () => {
    const g = n => row(n, 25, { ...news('철강주 동반 강세 — 알래스카 LNG 韓 투자 발표 가능성 소식', 'sector'), theme_tag: '철강 중소형' });
    const s = S.build(day([g('철A'), g('철B'), row('하이스틸', 23.5, { ...news('美알래스카 LNG 투자 기대'), theme_tag: '강관' })]));
    assert.ok(s.flows[0].members.some(r => r.name === '하이스틸'));
});

test('잘린 제목·물음형·증권사 전망은 이유가 아니다', () => {
    for (const bad of ['美 FDA 승인 표적약 다락손라십과', '수주 쌓였는데 적자 난 이유는', '중동 전쟁 끝나나', '키움증권 내년 흑자전환 전망 (IBK투자증권)', '美 반도체주 ·메모리 호황 전망에 반도체주', '고무줄 상여금에 실적 따로 주가 따로'])
        assert.equal(S.goodReason(S.cleanReason(bad)), false, bad);
    for (const ok of ['임상 결과 발표', '범LG家 구미현 인수 효과', '中 궈룬과 2년간 하이난성에 DeepCARS 독점 판매계약'])
        assert.equal(S.goodReason(S.cleanReason(ok)), true, ok);
});

test('대장 선정 — 신규상장(+30% 초과)도 +30%로 쳐서 거래대금과 곱한 에너지로 뽑는다(캘린더·사이트 공통)', () => {
    const core = require('./build_leaders_calendar');
    const vm = require('vm'), fs = require('fs'), path = require('path');
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'report-core.js'), 'utf8') + '\nthis.C = WhyReportCore;', ctx);
    const site = rows => ctx.C.pickLeader(rows, [], [], []);
    const row = (t, n, rate, tv, extra) => Object.assign({ ticker: t, name: n, change_rate: rate, trading_value: tv, sector: '기계', theme_tags: [] }, extra || {});
    const ipo = { theme_tags: ['2026 하반기 신규상장'] };
    // 10/1 실제 값: 브릴스(신규상장) +59.5%·6,958억 → 30×6,958억=20.9조 > 제주반도체 14.2%×3,183억=4.5조
    const oct1 = [row('468670', '브릴스', 59.49, 695.8e9, ipo), row('080220', '제주반도체', 14.18, 318.3e9)];
    assert.equal(core.pickLeader(oct1).name, '브릴스');
    assert.equal(site(oct1).name, '브릴스');
    assert.equal(core.leaderEnergy(oct1[0]), 695.8e9 * 30);
    // 캡이 실제로 걸리는지 — 원래 상승률(120%)이면 이기지만(24조) 30%로 치면 진다(2,000억×30=6조 < 5,000억×20=10조)
    const capped = [row('000001', '새내기', 120, 200e9, ipo), row('000002', '기존주', 20, 500e9)];
    assert.equal(core.pickLeader(capped).name, '기존주');
    assert.equal(site(capped).name, '기존주');
    // 표시용 상승률은 그대로(+59.5%) — 캘린더 기록
    assert.equal(core.leadersFromRows(oct1).stock.rate, 59.5);
});

test('해석 문장 — 돈의 쏠림·열기·이유의 무게·지난 급등 이력을 데이터로만 말한다', () => {
    const Talk = require('./market_commentary');
    const fw = f => f.label + '주';
    const news2 = (t) => ({ rise_reason: t, reason_source: 'news_extract', reason_kind: 'catalyst' });
    const rows = [
        row('머큐리', 30, { theme_tag: '광통신', trading_value: 6e11, close_price: 13000, ...news2('광통신 투자 확대') }),
        row('티엠씨', 20, { theme_tag: '광통신', trading_value: 2e11 }),
        row('다산네트웍스', 15, { theme_tag: '광통신', trading_value: 1e11 }),
        row('빛샘전자', 12, { theme_tag: '광통신', trading_value: 1e11 }),
        row('리튬포어스', 18, { theme_tag: '2차전지', trading_value: 5e10 }),
        row('하이드로리튬', 16, { theme_tag: '2차전지', trading_value: 5e10 }),
        row('파워넷', 12, { theme_tag: '2차전지', trading_value: 5e10 }),
    ];
    const s = S.build(day(rows));
    const v = Talk.verdict(s, fw);
    assert.match(v.text, /광통신주 쪽으로 돈이 확실히 몰린 하루/);
    assert.match(v.text, /가운데 87%가/);                                   // 1조 / 1조 1,500억
    assert.match(v.short, /^광통신으로 돈이 몰린 날 — 급등주 거래대금의 87%$/);
    // 열기 — 전 거래일 대비(작은 차이는 '다소', 큰 차이만 '크게')
    assert.match(Talk.heat({ hot: new Array(19), prevHot: 12 }), /크게 늘어, 급등주 열기가 (달아올랐|뜨거워졌)습니다/);
    assert.match(Talk.heat({ hot: new Array(19), prevHot: 16 }), /다소 늘었습니다/);
    assert.match(Talk.heat({ hot: new Array(8), prevHot: 16 }), /크게 줄어, 급등주 열기가 (식었|가라앉았)습니다/);
    assert.match(Talk.heat({ hot: new Array(17), prevHot: 16 }), /과 비슷했습니다/);
    // 지난 급등 이력 — 오늘 이전, 기록 시작일·1년 창 안, +10% 이상만 센다
    const r = s.rows.find(x => x.name === '머큐리');
    const events = [{ date: '20261002', change_rate: 30 }, { date: '20260910', change_rate: 14.1, rise_reason: '美 광통신주 호재', reason_source: 'news_extract', reason_kind: 'catalyst' },
        { date: '20260312', change_rate: 12.5 }, { date: '20250901', change_rate: 20 }];
    const p = Talk.stockProfile(r, { date: '20261002', profileOf: () => events, since: '20250523' }, fw);
    assert.match(p, /최근 1년 동안 \+10% 이상 오른 날이 이번 말고도 2번 있었습니다/);   // 2025-09-01 은 1년 밖
    assert.match(p, /직전은 9월 10일\(\+14\.1%\)로, '美 광통신주 호재' 기사가 나온 날이었습니다/);
    assert.match(p, /혼자가 아니라 광통신주 4종목이 같이 오른 날이었습니다/);
    const young = Talk.stockProfile(r, { date: '20260102', profileOf: () => [], since: '20250523' }, fw);
    assert.match(young, /ORGO 기록이 시작된 2025년 5월 이후 \+10% 이상 오른 적이 없던 종목/);
    // 💬 종합 — 본문에 나온 흐름만, '이유 없음' 단정 없이, 권유·전망 없이
    const view = Talk.view(s, { date: '20261002', calendar: {}, holiday: null }, fw, s.flows);
    assert.doesNotMatch(view, S.FORBIDDEN);
    assert.match(view, /기사로 확인되는 재료가 있는 광통신주에 돈이 실린, 비교적 이야기가 분명한 날이었습니다/);
    assert.match(view, /다음 거래일에는 광통신주 강세가 하루로 끝나지 않는지가 (지켜볼|확인할) 부분입니다/);
    assert.doesNotMatch(view, /테마 이름만|보는 게 맞|무게가 다릅/);
    // 대장 설명 — 목록 밖 대형주
    const big = { ...s, leader: { ticker: '005930', name: '삼성전자', rate: 6.1, vol: 3e12, row: null } };
    assert.match(Talk.leaderPara(big, {}, '20261002', fw), /오늘의 대장은 삼성전자입니다\. \+6\.1% 올라 급등주 목록\(\+10% 이상\)에는 들지 않지만, 거래대금 3조가 실려/);
});

test('블로그는 나열 대신 해석 — 💬 ORGO의 시선·🔍 제목 종목 꼭지·썸네일 카드', () => {
    const rows = [
        row('머큐리', 30, { theme_tag: '광통신', trading_value: 6e11, close_price: 13000, sector: '통신장비', rise_reason: '광통신 투자 확대', reason_source: 'news_extract', reason_kind: 'catalyst' }),
        row('티엠씨', 20, { theme_tag: '광통신', trading_value: 2e11 }), row('다산네트웍스', 15, { theme_tag: '광통신', trading_value: 1e11 }),
        row('빛샘전자', 12, { theme_tag: '광통신', trading_value: 1e11 }),
    ];
    const m = Copy.material({ date: '20261002', rows, calendar: {}, profileOf: () => [], since: '20250523' });
    const b = Copy.naverBlog(m, []);
    assert.match(b.html, /<p><b>💬 ORGO의 시선<\/b><\/p>/);
    assert.match(b.html, /<p><b>🔍 머큐리, 어떤 종목이길래<\/b><\/p>/);
    assert.match(b.text.split('\n\n')[0], /머큐리 상한가 이유부터 볼게요\.$/);                    // 캐릭터 시작 멘트(블로그는 멘트만)
    assert.match(b.text.split('\n\n')[1], /^10월 2일 머큐리는 '광통신 투자 확대' 기사와 함께 상한가를 기록했습니다\.\n/);
    assert.doesNotMatch(b.html, /📋 관련 종목/);                                 // 긴 종목 나열은 없다
    assert.ok(b.tags.length <= 12);
    assert.deepEqual(b.card, { kicker: '10월 2일(금) 마감', main: b.title.replace(/^10월 2일 /, '').split(/\? | \| /)[0] + (b.title.includes('? ') ? '?' : ''),
        sub: b.card.sub, chips: ['상한가 1', '+15% 이상 3종목'] });
    assert.match(Copy.threads(m).text, /\n오늘은 광통신으로 돈이 확 몰렸어요\. 급등주 거래대금의 100%가 광통신 쪽이었거든요 👀\n\n/);   // 쓰레드는 캐릭터 말투
});

test('같은 그룹 계열사 동반 상승은 테마가 제각각이어도 그룹주 흐름으로 묶고, 계열사 기사와 맞는 이유를 배경으로 쓴다', () => {
    const t = (title, date = '2026.10.02') => ({ news: [{ title, date }] });
    const s = S.build(day([
        row('GAO제약', 29.6, { theme_tag: '비만치료제', ...t('GAO그룹주 연일 강세…신약 FDA 허가 효과') }),
        row('GAO바이오텍', 29.4, { theme_tag: 'GAO그룹', ...news('간암 신약 제조시설 FDA 실사 종결'), news: [{ title: 'GAO, 간암 신약 제조시설 FDA 실사 종결', date: '2026.10.02' }] }),
        row('GAO생명', 25, { theme_tag: '줄기세포', ...t('GAO 간암 신약 FDA 재신청에 그룹주 동반 강세') }),
        row('GAO글로벌', 16, { theme_tag: '화장품', ...t('GAO그룹株 일제히 급등') }),
        row('남천제약', 17, { theme_tag: '바이오시밀러', ...news('기술이전 기대 재부각') }),
    ]));
    const g = s.flows.find(f => f.group);
    assert.ok(g, '그룹주 흐름이 있어야 한다');
    assert.equal(g.label, 'GAO그룹');
    assert.equal(g.members.length, 4);
    assert.equal(g.catalyst, '간암 신약 제조시설 FDA 실사 종결');
    assert.ok(!g.members.some(r => r.name === '남천제약'));            // 다른 회사 재료는 섞지 않는다
    assert.ok(s.solos.some(r => r.name === '남천제약'));
    assert.ok(!s.flows.some(f => f !== g && f.members.some(r => g.members.includes(r))));   // 한 종목은 한 흐름에만
    const th = Copy.threads(Copy.material({ date: '20261002', rows: s.rows.map(r => r.row) })).text;
    assert.match(th, /GAO그룹 4종목 — 간암 신약 제조시설 FDA 실사 종결/);
});

test('이름 앞머리만 같고 그룹 기사가 없거나 지난 기사뿐이면 그룹주로 묶지 않는다', () => {
    const old = { news: [{ title: 'NR그룹주 일제히 급등', date: '2026.09.01' }] };
    const s = S.build(day([
        row('NR전자', 20, { theme_tag: '반도체', ...old }),
        row('NR건설', 18, { theme_tag: '건설', ...old }),
        row('NR식품', 15, { theme_tag: '음식료' }),
    ]));
    assert.ok(!s.flows.some(f => f.group));
});

test('해킹 사고 날 보안주 — 정보보안·딥페이크 태그와 해킹 이유 종목이 한 흐름으로', () => {
    const s = S.build(day([
        row('시큐A', 30, { theme_tag: '딥페이크', ...news('AI 해킹 대응 부각') }),
        row('시큐B', 25, { theme_tag: '보안주(정보보안 등)', ...news('금융권 해킹') }),
        row('시큐C', 16, { theme_tag: '보안주(정보보안 등)' }),
        row('시큐D', 15, { theme_tag: '보안주(정보보안 등)' }),
        row('시큐E', 13, { theme_tag: '딥페이크' }),
    ]));
    const f = s.flows.find(x => x.label === '보안');
    assert.ok(f);
    assert.equal(f.members.length, 5);
    assert.equal(s.solos.length, 0);
});
