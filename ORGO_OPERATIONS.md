# ORGO 운영 개선 — 2026-09-05

## 현재 상태

- 사이트: 기사 날짜(당일~3일 전), 원래 기사 인덱스, 종목명, 중복 근거를 검증한다. 근거가 없는 LLM 교체를 차단하고 배치를 최대 3개 병렬 처리한다.
- 9월 4일 운영 로그에서 Anthropic 잔액 부족 오류를 확인했다. 결제·충전은 수행하지 않았다. 실패 시 종목명이 포함된 최근 기사 제목을 `관련 보도:`로 제공한다. 관련 보도는 인과관계를 확정하는 설명이 아니다.
- 이유 원본은 `reason_previous`, 인용 원문은 `reason_evidence`에 보관한다. 관리자 수정은 자동 정제 대상에서 제외한다.
- 최신 50종목 중 관련 보도 13종목. 나머지 37종목의 직접 상승 촉매는 미확인이다. 근거를 만들어 완성률을 부풀리지 않는다.
- 발행실: `/marketing.html`. Threads, Instagram, 카카오톡, 토스, 텔레그램 짧은 원고와 원본 시각화·대장 캘린더 JPEG를 제공한다.

## 자동 일정

`ORGO daily marketing`은 거래일 KST 16:37, 17:37 및 인덱스 빌드 완료 후 실행된다. 빌드 완료 트리거는 16:20~22:00에만 생성한다. 오늘 날짜의 마감 확정 데이터가 없으면 게시하지 않는다. 과거 날짜 수동 실행은 원고와 카드 생성만 가능하다.

마케팅 생성은 추가 LLM 비용이 없다. 텔레그램 기존 일정은 유지한다. 장중 주도주는 09:30~11:00, 마감 대장은 15:40 이후로 제한한다. 빌드 안에서 별도로 발송하지 않고 전용 발송 작업이 빌드 완료 이벤트를 받으므로 크론과 같은 중복 방지 경로를 쓴다.

## 계정 연결

현재 확인된 저장소 시크릿은 `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`다. 토큰은 채팅/소스에 넣지 않고 GitHub 저장소 Settings → Secrets and variables → Actions에 입력한다.

| 채널 | 연결 설정 | 현재 동작 |
|---|---|---|
| Telegram | 기존 시크릿 재사용 | 기존 채널 일정 유지, 발송 기록 보강 |
| Threads | secret `THREADS_ACCESS_TOKEN`, variable `THREADS_USER_ID` | 원고 준비; 연결 후 공식 API 게시 가능 |
| Instagram | secret `INSTAGRAM_ACCESS_TOKEN`, variables `INSTAGRAM_USER_ID`, `INSTAGRAM_API_VERSION` | 원고·가로형 원본 시각화/캘린더 준비; 프로 계정/게시 권한 필요 |
| Kakao | 카카오톡 채널 또는 오픈채팅 대상과 실제 발송 경로 필요 | 원고 준비, 직접 자동 발송 미연결 |
| Toss | 운영 계정과 허용된 게시 경로 필요 | 시황·관련 종목 게시판용 짧은 원고 준비, 직접 자동 게시 미연결 |

연결된 Meta 채널만 variable `MARKETING_ENABLED_CHANNELS`에 `threads,instagram`처럼 지정한다. 미설정이면 게시하지 않는다. Instagram 버전은 앱에서 현재 지원되는 `v숫자.숫자` 형식으로 설정한다. 이미지와 해시 목록을 먼저 배포한 뒤 공개 이미지 바이트를 검증한다. 배포/미디어 처리 대기는 10초 간격으로 최대 18회 확인하며, 초과하면 실패로 표시한다. 백업 일정은 이미 생성한 컨테이너를 재사용한다.

Kakao 일반 메시지 API의 나에게/친구에게 보내기는 채널 구독자나 오픈채팅 자동 방송 기능과 다르다. 일반 API를 채널 방송 기능으로 표시하지 않는다. Toss 커뮤니티 공식 게시 API는 이번 확인에서 확보하지 못했다. 두 채널의 미연결 상태를 완료로 표시하지 않는다.

## 발송 중복과 실패 처리

마케팅 및 텔레그램 발송은 `.marketing-state/`의 GitHub 기록에 발송 의도를 먼저 저장한다. Telegram은 작업명·KST 날짜·메시지 순번을 키로 사용한다. 반복 시장 감시는 점심/서킷 단계/사이드카 사건 키를 사용해 후속 경보 충돌을 방지한다. 전송 성공 기록이 있으면 기존 응답을 재사용하고 다시 보내지 않는다. Telegram이 명시적으로 반환한 429 `retry_after`만 최대 2회 기다려 재시도한다.

`sending`, `creating`, `publishing`, `uncertain`에서 끝나면 자동 재발송을 막는다. 운영자는 해당 플랫폼에서 실제 게시 여부를 확인한 뒤 기록을 조정해야 한다. `--force`로도 이 기록을 무시하지 않는다. 성공이면 `published`와 게시 ID를 기록하고, 확실한 미발송이면 해당 기록을 별도 커밋으로 초기화한다. 성공 여부를 확인하지 않은 채 기록을 지우지 않는다.

LLM 실패는 기본 데이터 생성과 관련 보도 대체 경로를 유지하면서 실패 건수를 기록한다. 원래 수집 사유의 배지는 ‘검증’에서 ‘수집’으로 수정했다. 키워드 수집과 인과관계 검증을 구분한다.

Telegram이 명시적으로 거절한 4xx 응답은 `retryable`로 기록해 다음 실행에서 다시 시도할 수 있다. 타임아웃 등 전송 결과가 불명확한 경우와 구분한다.

## 배포 검증

`https://orgo.kr/marketing.html` 및 생성 JSON 200, 잘못된 종목 요청 400, 이유 API 200(실측 약 2.44초)을 확인했다. GitHub `ORGO regression checks`, `ORGO daily marketing`의 과거 날짜 생성, 텔레그램 저녁 복기 dry-run이 모두 성공했다. 외부 채널에 테스트 게시물을 보내지는 않았다. 마케팅 작업은 active이며 실제 게시 채널 설정은 비어 있다.

## 검증과 실행

```sh
python scripts/test_reason_quality.py
python scripts/test_build_history.py
node --test scripts/test_marketing.js
node scripts/test_api_overrides.js
node scripts/marketing_digest.js 20260904
node scripts/marketing_render.js 20260904
```

카드 렌더만 Playwright가 필요하다. Actions가 설치한다. 원고는 로컬 JSON으로 생성한다. 파일이 없거나 마감 미확정이면 오류를 반환한다. 자동 생성물은 `public/marketing/YYYYMMDD/`, 발행 상태는 `public/marketing/status.json`, 다운로드 백업은 Actions artifact에 보관한다.

## 공식 API 자료

- [Meta Threads API](https://www.postman.com/meta/threads/overview)
- [Meta Instagram 게시 API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
- [Kakao 메시지 API](https://developers.kakao.com/docs/ko/kakaotalk-message/rest-api)
- [Telegram Bot API](https://core.telegram.org/bots/api)

## 시각화 중심 발행실 재설계

사용자 참고처럼 기존 시각화를 그대로 쓰고 관찰 문장은 1~2문장으로 제한한다. 긴 이유 카드, 50종목 나열, 반복 홍보 문장은 제거했다. `/marketing.html`에서 주제·채널 선택, 원고 편집/복사, 이미지 1~2장 다운로드를 제공한다. 화면 편집은 수동 공유에 적용되며 자동 원문을 저장하거나 바로 발송하지 않는다.

- 테마: 원래 핫테마 버블맵 + 시장 트리맵. 표시 가능한 3종목 이상 그룹이 있을 때만 선택한다.
- 시장: 시총 버블맵 + 트리맵. 캡션 통계는 전체 시장이 아닌 해당 ORGO 스냅샷 수집 종목 기준이다. 원본 버블맵은 시총 상위 100종목을 표시한다.
- 캘린더: 선택일까지의 월간 대장 기록. 미래 데이터와 검증되지 않은 이유 문구를 이미지에서 제외한다.
- 오늘의 대장: 기존 Telegram 대장 이미지. 대장이 없는 날도 조건 미충족 사실을 짧게 기록한다.
- 자동 주제: 일반 거래일 테마 → 시장 → 캘린더 대체. 월중 8거래일 이상 누적된 금요일이나 28일 이후에는 캘린더를 우선한다.

`marketing_render.js`는 원본 페이지의 저장 함수를 쓰되 모든 시세/API 요청을 해당 날짜 로컬 데이터로 고정한다. 크기 변경 후 SVG 좌표를 동기화해 버블과 글자가 어긋나지 않게 한다. 원본 비율을 보존한 1440px JPEG와 콘텐츠 해시가 포함된 변경 불가 파일명을 만든다. 원본 순위·시장 스냅샷 전체 해시로 시각화 입력 수정도 감지한다. 동일 내용 재실행은 검증된 파일을 재사용한다. 렌더 실패 시 새 데이터/부분 이미지를 배포하지 않는다.

Threads/Instagram 연결 시 이미지 1장이면 IMAGE, 2장이면 CAROUSEL로 게시한다. 각각의 자식·부모 컨테이너 생성과 실제 게시 직전에 의도를 기록하고, 결과가 불명확하면 자동 재전송하지 않는다. 아직 연결 정보가 없어 실제 Meta 발송 검증은 수행하지 않았다.

추가 사이트 검토로 기사 URL/종목 관련성/원문 인덱스 검증과 기존 구체 이유 보존을 보강했다. 프런트 5종 자료를 동시에 요청하고 동일 요청을 합치며 정적 요청은 6초 이내에 종료한다. Telegram은 로컬 동일 날짜 이유를 먼저 읽으며 본문·이미지에 동일 검증을 적용한다.

추가 검증: Python 이유 17 + history 40, Node 마케팅/Telegram 21, API 동시성/지연/재시도, 홈 6시나리오. 정상일 20260904와 무테마일 20260813의 실제 이미지 저장을 확인했고, 발행실 모든 주제/5채널/다운로드/편집/모바일 가로 넘침을 검증했다. `node scripts/test_marketing_ui.js`는 이미지 생성 후 CI에서도 실행한다.

공식 형식 확인: [Threads 캐러셀](https://www.postman.com/meta/threads/folder/34203612-c0bbd675-45cc-4a8e-b5b7-0d4d5d8600fe), [Instagram 캐러셀 생성](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-ab559ffb-8e2c-4b0a-b43a-5737b6d2f672).
