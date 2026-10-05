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
    assert.match(b.html, /뚜렷한 테마 없이/);
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
