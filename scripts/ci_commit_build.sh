#!/usr/bin/env bash
# build-history.yml 빌드 산출물 커밋 & push — 마감 빌드는 종목 데이터 / marketmap 두 번 호출한다.
#   사용: scripts/ci_commit_build.sh "<커밋 메시지>"
#   push 하면 $GITHUB_OUTPUT 에 pushed=true. 바뀐 파일은 $RUNNER_TEMP/orgo-changed.txt 에 누적(IndexNow 핑 대상).
set -u
MSG="$1"
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
# 빌드 산출물 stage — sitemap·종목 프리렌더도 빌드 산출물
# (git add 가 아래 checkout/clean 보다 먼저라 stage 분은 보존됨)
git add public/data/ public/sitemap.xml public/rss.xml public/stock/ public/day/
# IndexNow 핑 대상(바뀐 종목·날짜 페이지) — 커밋 전에 기록
git diff --staged --name-only >> "$RUNNER_TEMP/orgo-changed.txt" || true
# 추가 unstaged 변경 (예: pip cache·기타) 도 stage 또는 버림
git checkout -- . || true   # 추적 중인 다른 파일 변경 복원
git clean -fd -e 'public/data/_cache' || true  # 추적 안 되는 파일 제거 (cache 디렉토리는 보존)
git diff --staged --quiet && echo "변경 없음" && exit 0
git commit -m "$MSG"
# 트리거한 브랜치로 커밋·푸시 — 스케줄(master)이든 수동 dispatch(feature 브랜치)든
# 자기 브랜치에 rebase 후 push. master 하드코딩 시 feature 브랜치 백필이 add/add 충돌로 실패함.
BRANCH="${GITHUB_REF_NAME}"
echo "push 대상 브랜치: $BRANCH"
for attempt in 1 2 3; do
  git fetch origin "$BRANCH"
  REBASE_OK=false
  if git -c rebase.autoStash=true rebase "origin/$BRANCH"; then
    REBASE_OK=true
  else
    # override-sync 는 종목 파일 1개만 최신 원격에서 재생성해 push한다.
    # 전역 빌드와 그 파일만 충돌하면 원격(override 반영본)을 보존하고,
    # 그 외 충돌은 자동 판단하지 않고 기존 재시도/실패 경로로 넘긴다.
    CONFLICTS=$(git diff --name-only --diff-filter=U)
    BAD=$(printf '%s\n' "$CONFLICTS" | grep -Ev '^public/data/stock-history/[0-9A-Z]{6}\.json$' || true)
    if [ -n "$CONFLICTS" ] && [ -z "$BAD" ]; then
      echo "override-sync 종목 파일 충돌 - 최신 원격본 보존"
      while IFS= read -r file; do
        [ -z "$file" ] && continue
        # rebase 중 --ours = 새 upstream(origin/$BRANCH).
        git checkout --ours -- "$file"
        git add "$file"
      done <<< "$CONFLICTS"
      if GIT_EDITOR=true git rebase --continue; then
        REBASE_OK=true
      fi
    fi
  fi
  if [ "$REBASE_OK" = "true" ]; then
    if git push origin "HEAD:$BRANCH"; then
      echo "push 성공 (시도 $attempt, branch=$BRANCH)"
      echo "pushed=true" >> "$GITHUB_OUTPUT"
      exit 0
    fi
  else
    echo "rebase 충돌 - abort 후 재시도"
    git rebase --abort || true
  fi
  sleep 5
done
echo "::error::push 3회 실패"
exit 1
