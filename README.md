# 이거왜오름? (WhyRise)

종목 검색 기반 한국 주식 급등 백과사전.

- 메인: `___ 왜 오름?` 검색바 + 오늘 +15% 이상 오른 종목 + 이유
- 종목 페이지(`/stock/{ticker}`): 그 종목의 모든 급등일 타임라인 + 이유 + 뉴스
- 리포트: 섹터/테마 분석
- 관리자 모드: AI 추정 이유의 오류를 인라인 수정

## 데이터

stock-rise 의 raw GitHub JSON 을 재사용. 자체 cron 없음.

종목별 인덱스(`public/data/stock-history/{ticker}.json`)는 매일 18:00 KST GitHub Actions(`build-history.yml`) 가 stock-rise 데이터를 순회하여 빌드.

## 환경변수 (Vercel)

| 키 | 용도 |
|---|---|
| `GITHUB_TOKEN` | stock-rise repo 읽기 + whyrise overrides commit |
| `ADMIN_TOKEN` | 임시 관리자 인증(MVP). Phase 3 OAuth 도입 후 deprecate |
| `ADMIN_EMAIL` | 향후 OAuth 로그인 시 자동 관리자 권한 부여 (MVP 미사용) |

## 로컬 개발

```bash
npx vercel dev
# http://localhost:3000
```

## 인덱스 빌드

```bash
python scripts/build-history.py --days 365
```
