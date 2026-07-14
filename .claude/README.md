# 멀티모델 위임 구조 (Claude 리드 + Opus/Codex 수하)

이 디렉토리는 Claude Code 세션이 리드가 되어 Opus와 Codex에게 작업을 배분하고
서로 교차검증시키는 구조를 정의한다.

## 구성

```
.claude/
├── agents/
│   ├── opus-worker.md     # Opus 구현 담당 (복잡한 작업)
│   ├── opus-reviewer.md   # Opus 적대적 리뷰어 (codex 결과물 검증)
│   └── codex-worker.md    # Codex CLI 브리지 (단순·대량 작업 + Claude 결과물 2차 소견)
├── skills/
│   └── delegate/SKILL.md  # /delegate — 분해→라우팅→병렬실행→교차검증→중재 파이프라인
└── README.md
```

## 동작 원리

- **리드**: 메인 Claude Code 세션. 작업 분해·라우팅·중재·최종 통합만 담당.
- **Opus 수하**: Claude Code 내장 서브에이전트 기능. `model: opus` frontmatter로 지정됨.
- **Codex 수하**: 외부 CLI라 브리지 에이전트가 Bash로 `codex exec`를 호출.
- **교차검증**: 구현한 모델과 *다른 계열* 모델이 리뷰. 같은 모델의 맹점을 서로 잡아줌.

## 사전 준비 (Codex 쪽)

```bash
npm install -g @openai/codex
codex login          # 또는 export OPENAI_API_KEY=...
```

- 로컬 머신에서는 위만 하면 됨.
- Claude Code on the web(원격 환경)에서는 환경 설정의 setup script에 설치 명령을 넣고,
  네트워크 정책이 `api.openai.com` / `chatgpt.com`을 허용해야 함.
- codex가 없는 환경에서도 파이프라인은 동작함 — 교차검증이 opus-reviewer로 대체될 뿐.

## 사용법

```
/delegate 리포트 빌드 스크립트를 리팩터링하고 텔레그램 발송 로직에 재시도를 추가해줘
```

또는 그냥 "이 작업을 위임 파이프라인으로 처리해줘"라고 말하면 된다.

### Codex를 MCP로 붙이는 대안

Bash 브리지 대신 MCP 서버로 붙이면 리드가 Codex를 도구처럼 직접 호출할 수 있다:

```bash
claude mcp add codex -- codex mcp
```

브리지 방식이 더 단순하고 결과 검수 단계가 내장돼 있어 기본값으로는 브리지를 권장.
