"""LLM(Claude) 기반 상승 이유 정제 — build-history.py --llm-refine / --llm-backfill 전담.

목표: 백필·추정 경로가 남긴 제네릭 사유("시장 관심 증가", "{테마} 강세")를
그날 뉴스 제목 근거의 구체적 한 줄(≤30자)로 교체한다. 사이트는 LLM 에 의존하지
않는다 — 어떤 실패(키 없음/타임아웃/스키마 오류)도 기존 사유를 그대로 둔다.

정렬 규칙 (build-history.py 의 reason 체계와 합의):
  - reason_source == 'admin' / reason_status == 'edited' 는 불가침 (수집 자체를 안 함)
  - stock-rise 의 구체 사유(제네릭 아님)는 교체 금지 — 의미반전 flag 만 허용
  - 교체 시 reason_source='llm', reason_status='filled', confidence 는 근거 수로 캡
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

API_URL = 'https://api.anthropic.com/v1/messages'
API_VERSION = '2023-06-01'
MODEL = os.environ.get('LLM_REASONS_MODEL', 'claude-sonnet-5').strip()
MAX_TOKENS = 8000
REQUEST_TIMEOUT_S = 180
RETRIES = 2                    # 429/5xx/네트워크 — SDK 기본과 동일한 2회
BATCH_SIZE = 20                # 종목 수/요청
MAX_ITEMS_PER_RUN = 400        # 비용 폭주 가드 (일간 ~170 대비 여유)
MIN_RATE = 15.0                # 정제 대상 최저 등락률
NEWS_PER_ITEM = 10             # 종목당 뉴스 제목 입력 상한
REASON_MAX_LEN = 30

# 제네릭 판정 — estimate_reasons/enrich 가 만드는 비구체 라벨들
GENERIC_RE = re.compile(r'^(시장 관심 증가|상한가 — 사유 미수집|.{0,24}(테마 )?(강세|상한가))$')
# 투자조언성 표현 — 응답에 섞이면 해당 건 폐기 (유사투자자문 리스크 차단)
FORBIDDEN_RE = re.compile(r'매수|매도|추천|목표가|손절|익절|사세요|팔')

SYSTEM_PROMPT = (
    '당신은 한국 주식 급등 사유 데이터 검수원입니다. 각 종목에 대해 제공된 뉴스 제목만 '
    '근거로 판단하세요. 제목에 없는 사실을 지어내지 마세요.\n\n'
    '규칙:\n'
    '1. reason: 급등을 설명하는 구체적 사건을 30자 이내 한국어 명사구로. '
    '예: "1,883억 반도체 장비 공급계약", "리보세라닙 FDA 승인 기대". '
    '금지: 투자 조언·전망·매수/매도/추천/목표가 표현 (사실 서술만).\n'
    '2. 제목이 급등 이유를 설명하지 못하면 action="no_evidence", reason 은 빈 문자열.\n'
    '3. current_reason 이 이미 구체적이고 뉴스와 부합하면 action="keep".\n'
    '4. current_reason 이 제네릭("~테마 강세", "시장 관심 증가")인데 뉴스에 구체 사건이 '
    '있으면 action="replace" 로 더 나은 사유 제시.\n'
    '5. 의미반전 주의: "공급 중단"·"계약 해지"·"임상 실패" 같은 악재 제목은 해당 테마의 '
    '호재 근거가 아닙니다. current_reason 이 그런 반전 위에 서 있으면 action="flag_reversal".\n'
    '6. evidence: 판단 근거가 된 뉴스의 i 인덱스 배열. replace 면 반드시 1개 이상.\n'
    '7. confidence: 종목명이 포함된 근거 2건 이상이면 high, 1건이면 mid, 정황뿐이면 low.'
)

OUTPUT_SCHEMA = {
    'type': 'object',
    'properties': {
        'results': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'ticker': {'type': 'string'},
                    'action': {'type': 'string',
                               'enum': ['keep', 'replace', 'flag_reversal', 'no_evidence']},
                    'reason': {'type': 'string'},
                    'confidence': {'type': 'string', 'enum': ['high', 'mid', 'low']},
                    'evidence': {'type': 'array', 'items': {'type': 'integer'}},
                },
                'required': ['ticker', 'action', 'reason', 'confidence', 'evidence'],
                'additionalProperties': False,
            },
        },
    },
    'required': ['results'],
    'additionalProperties': False,
}


def is_generic(reason: str) -> bool:
    r = (reason or '').strip()
    return (not r) or bool(GENERIC_RE.match(r))


# ── 대상 수집 ─────────────────────────────────────────────

def _target_from_event(ticker: str, name: str, ev: dict) -> dict | None:
    if ev.get('reason_source') == 'admin' or ev.get('reason_status') == 'edited':
        return None
    news = [n for n in (ev.get('news') or []) if (n.get('title') or '').strip()]
    reason = str(ev.get('rise_reason') or '').strip()
    return {
        'ticker': ticker,
        'name': name,
        'date': ev.get('date') or '',
        'change_rate': ev.get('change_rate'),
        'theme_tag': ev.get('theme_tag') or '',
        'sector': ev.get('sector') or '',
        'rise_reason': reason,
        'reason_source': ev.get('reason_source') or '',
        # stock-rise 구체 사유는 검증만(교체 금지) — 확정 데이터 보호
        'verify_only': ev.get('reason_source') == 'stockrise' and not is_generic(reason),
        'news': [{'i': i, 'title': n.get('title') or '', 'date': n.get('date') or ''}
                 for i, n in enumerate(news[:NEWS_PER_ITEM])],
    }


def collect_day_targets(day_path: Path, min_rate: float = MIN_RATE) -> list[dict]:
    """rise-history/{date}.json 의 당일 랭킹 → 정제 대상 목록."""
    data = json.loads(day_path.read_text(encoding='utf-8'))
    out = []
    for r in data.get('rankings') or []:
        if (r.get('change_rate') or 0) < min_rate or not r.get('ticker'):
            continue
        t = _target_from_event(r['ticker'], r.get('name') or r['ticker'], r)
        if t:
            out.append(t)
    return out


def collect_backfill_targets(stock_history_dir: Path, limit: int) -> list[dict]:
    """뉴스가 저장돼 있는 저신뢰·제네릭 과거 이벤트 — 오래된 것부터 limit 건."""
    out = []
    for f in sorted(stock_history_dir.glob('*.json')):
        if f.name == 'index.json':
            continue
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        ticker = h.get('ticker') or f.stem
        name = h.get('name') or ticker
        for ev in h.get('events') or []:
            if ev.get('reason_source') not in ('theme', 'estimated', 'pattern', 'naver'):
                continue
            if not is_generic(ev.get('rise_reason') or ''):
                continue
            if len([n for n in (ev.get('news') or []) if (n.get('title') or '').strip()]) < 2:
                continue
            t = _target_from_event(ticker, name, ev)
            if t:
                out.append(t)
        if len(out) >= limit * 2:   # 정렬 전 여유 수집
            break
    out.sort(key=lambda t: t['date'])
    return out[:limit]


# ── Claude API 호출 (표준 라이브러리만) ────────────────────

def _post(payload: dict, api_key: str) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    last_err = None
    for attempt in range(RETRIES + 1):
        req = urllib.request.Request(API_URL, data=body, method='POST', headers={
            'x-api-key': api_key,
            'anthropic-version': API_VERSION,
            'content-type': 'application/json',
        })
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = e.read().decode('utf-8')[:300]
            except Exception:
                pass
            # 4xx(429 제외)는 요청 자체가 잘못 — 재시도 무의미
            if e.code != 429 and e.code < 500:
                raise RuntimeError(f'API {e.code}: {detail}') from e
            last_err = RuntimeError(f'API {e.code}: {detail}')
            wait = 2 ** attempt * 5
            try:
                wait = max(wait, int(e.headers.get('retry-after') or 0))
            except (ValueError, TypeError):
                pass
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
            wait = 2 ** attempt * 5
        if attempt < RETRIES:
            time.sleep(wait)
    raise RuntimeError(f'API 재시도 소진: {last_err}')


def _call_batch(items: list[dict], api_key: str) -> list[dict]:
    payload = {
        'model': MODEL,
        'max_tokens': MAX_TOKENS,
        'thinking': {'type': 'disabled'},   # JSON 추출엔 불필요 — tg_common.js 와 동일 방침
        'system': SYSTEM_PROMPT,
        'output_config': {'format': {'type': 'json_schema', 'schema': OUTPUT_SCHEMA}},
        'messages': [{'role': 'user', 'content': json.dumps(items, ensure_ascii=False)}],
    }
    data = _post(payload, api_key)
    stop = data.get('stop_reason')
    if stop not in ('end_turn', 'stop_sequence'):
        raise RuntimeError(f'stop_reason={stop} — 배치 폐기')
    text = next((b.get('text') for b in data.get('content') or [] if b.get('type') == 'text'), '')
    return (json.loads(text) or {}).get('results') or []


def _validate(res: dict, target: dict) -> dict | None:
    action = res.get('action')
    reason = str(res.get('reason') or '').strip()
    confidence = res.get('confidence') if res.get('confidence') in ('high', 'mid', 'low') else 'low'
    evidence = [i for i in (res.get('evidence') or [])
                if isinstance(i, int) and 0 <= i < len(target['news'])]
    if not evidence and confidence == 'high':
        confidence = 'mid'   # 근거 없는 high 금지
    if action == 'replace':
        if target.get('verify_only'):
            return {'action': 'keep', 'note': 'verify_only'}
        if (not reason or len(reason) > REASON_MAX_LEN or FORBIDDEN_RE.search(reason)
                or reason == target['rise_reason']):
            return {'action': 'keep', 'note': 'invalid_reason'}
        return {'action': 'replace', 'reason': reason, 'confidence': confidence,
                'evidence': evidence}
    if action == 'flag_reversal':
        return {'action': 'flag_reversal', 'confidence': 'low', 'evidence': evidence}
    if action in ('keep', 'no_evidence'):
        return {'action': action}
    return None


def refine(targets: list[dict], api_key: str) -> tuple[dict, dict]:
    """대상 목록 → {(ticker, date): verdict}. 배치 단위 실패는 건너뛰고 계속."""
    verdicts: dict = {}
    stats = {'sent': 0, 'skipped_no_news': 0, 'batch_errors': 0}
    sendable = []
    for t in targets[:MAX_ITEMS_PER_RUN]:
        if not t['news']:
            verdicts[(t['ticker'], t['date'])] = {'action': 'no_evidence'}
            stats['skipped_no_news'] += 1
        else:
            sendable.append(t)
    for i in range(0, len(sendable), BATCH_SIZE):
        batch = sendable[i:i + BATCH_SIZE]
        by_ticker = {t['ticker']: t for t in batch}
        payload_items = [{k: t[k] for k in
                          ('ticker', 'name', 'date', 'change_rate', 'theme_tag', 'sector', 'news')}
                         | {'current_reason': t['rise_reason'],
                            'current_source': t['reason_source']}
                         for t in batch]
        try:
            results = _call_batch(payload_items, api_key)
        except Exception as e:
            print(f'  llm batch {i // BATCH_SIZE + 1} 실패: {e}')
            stats['batch_errors'] += 1
            continue
        stats['sent'] += len(batch)
        for res in results:
            t = by_ticker.get(res.get('ticker'))
            if not t:
                continue
            v = _validate(res, t)
            if v:
                verdicts[(t['ticker'], t['date'])] = v
    return verdicts, stats


# ── 반영 ─────────────────────────────────────────────────

def _reversal_fallback(ev: dict) -> str:
    theme = (ev.get('theme_tag') or '').strip()
    sector = (ev.get('sector') or '').strip()
    if theme:
        return f'{theme} 테마 강세'
    if sector:
        return f'{sector} 강세'
    return '시장 관심 증가'


def apply_to_stock_history(stock_history_dir: Path, verdicts: dict) -> dict:
    """verdict 를 stock-history/{ticker}.json 이벤트에 반영. 반환: 액션별 카운트."""
    from datetime import datetime
    counts = {'replaced': 0, 'flagged': 0, 'kept': 0, 'no_evidence': 0}
    by_ticker: dict[str, list] = {}
    for (ticker, date), v in verdicts.items():
        by_ticker.setdefault(ticker, []).append((date, v))
    for ticker, entries in by_ticker.items():
        f = stock_history_dir / f'{ticker}.json'
        if not f.exists():
            continue
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        changed = False
        ev_by_date = {e.get('date'): e for e in h.get('events') or []}
        for date, v in entries:
            ev = ev_by_date.get(date)
            if not ev or ev.get('reason_source') == 'admin' or ev.get('reason_status') == 'edited':
                continue
            if v['action'] == 'replace':
                ev['rise_reason'] = v['reason']
                ev['reason_confidence'] = v['confidence']
                ev['reason_source'] = 'llm'
                ev['reason_status'] = 'filled'
                _reorder_news(ev, v.get('evidence') or [])
                counts['replaced'] += 1
                changed = True
            elif v['action'] == 'flag_reversal':
                # 반전 감지 — stock-rise 확정 사유는 로그만, 추정 계열은 제네릭으로 강등
                if ev.get('reason_source') == 'stockrise':
                    print(f'  [reversal-flag] {ticker} {date}: "{ev.get("rise_reason")}" (확정 사유 — 검토 필요)')
                else:
                    ev['rise_reason'] = _reversal_fallback(ev)
                    ev['reason_confidence'] = 'low'
                    ev['reason_source'] = 'llm'
                    counts['flagged'] += 1
                    changed = True
            elif v['action'] == 'no_evidence':
                counts['no_evidence'] += 1
            else:
                counts['kept'] += 1
        if changed:
            h['built_at'] = datetime.now().isoformat(timespec='seconds')
            f.write_text(json.dumps(h, ensure_ascii=False, indent=2), encoding='utf-8')
    return counts


def _reorder_news(ev: dict, evidence: list[int]) -> None:
    """근거 기사(입력 인덱스 = news[:NEWS_PER_ITEM] 기준)를 앞으로 — 상세 카드가 먼저 집게."""
    news = ev.get('news') or []
    if not evidence or not news:
        return
    head = [news[i] for i in evidence if 0 <= i < min(len(news), NEWS_PER_ITEM)]
    rest = [n for n in news if n not in head]
    ev['news'] = head + rest


# ── 리포팅 ────────────────────────────────────────────────

def summary_table(targets: list[dict], verdicts: dict, limit: int = 0) -> str:
    lines = ['ticker | 종목 | 등락 | 기존 사유 | LLM 판정 | 새 사유 | conf | 근거#']
    lines.append('-' * 110)
    shown = 0
    for t in targets:
        v = verdicts.get((t['ticker'], t['date']))
        if not v:
            continue
        action = v['action'] + (f"({v['note']})" if v.get('note') else '')
        lines.append(' | '.join([
            t['ticker'], t['name'][:8], f"{t['change_rate']:+.1f}%",
            (t['rise_reason'] or '(없음)')[:22],
            action,
            (v.get('reason') or '')[:30],
            v.get('confidence') or '',
            ','.join(map(str, v.get('evidence') or [])),
        ]))
        shown += 1
        if limit and shown >= limit:
            lines.append(f'... (+{len(verdicts) - shown}건)')
            break
    return '\n'.join(lines)


def write_step_summary(title: str, counts: dict, table: str) -> None:
    """GitHub Actions job summary — 러닝 텔레메트리(있을 때만)."""
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if not path:
        return
    try:
        with open(path, 'a', encoding='utf-8') as fh:
            fh.write(f'## {title}\n\n')
            fh.write(' · '.join(f'{k}: {v}' for k, v in counts.items()) + '\n\n')
            fh.write('```\n' + table[:6000] + '\n```\n')
    except Exception:
        pass
