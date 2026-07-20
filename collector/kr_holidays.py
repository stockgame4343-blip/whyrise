"""한국 거래소(KRX) 휴장일 캘린더.

토·일은 별도 처리, 본 모듈은 평일 공휴일·임시휴장일만 다룬다.
날짜 목록은 kr_holidays.json 이 단일 소스 — JS(scripts/tg_common.js)와 공용이므로
갱신은 반드시 JSON 쪽에서 한다. 연도별 갱신 필요 — KRX 공식 캘린더 참고:
  https://open.krx.co.kr/contents/MKD/01/0110/01100305/MKD01100305.jsp

사용법:
    from kr_holidays import is_kr_holiday
    if is_kr_holiday("20260501"):
        skip()
"""
import json
from datetime import date
from pathlib import Path

# YYYYMMDD 문자열 set — kr_holidays.json(단일 소스)에서 로드.
# 로드 실패 시 빈 set(공휴일 미반영)으로 동작하되 경고를 남긴다 — 조용한 오차단 방지.
try:
    KR_HOLIDAYS = set(json.loads(
        Path(__file__).with_name('kr_holidays.json').read_text(encoding='utf-8')
    )['holidays'].keys())
except Exception as _e:  # noqa: N816
    print(f'[kr_holidays] kr_holidays.json 로드 실패({_e}) — 공휴일 미반영으로 동작')
    KR_HOLIDAYS = set()


def is_kr_holiday(date_input):
    """주어진 날짜가 KRX 휴장 공휴일인지.

    Args:
        date_input: "YYYYMMDD" 문자열 또는 datetime.date / datetime.datetime

    Returns:
        bool — 한국 공휴일이면 True (토·일은 별도 검사 필요)
    """
    if hasattr(date_input, "strftime"):
        key = date_input.strftime("%Y%m%d")
    else:
        key = str(date_input).replace("-", "")
    return key in KR_HOLIDAYS


def is_kr_business_day(date_input):
    """주어진 날짜가 한국 거래소 영업일인지 (토·일·공휴일 제외)."""
    if hasattr(date_input, "weekday"):
        d = date_input
    else:
        s = str(date_input).replace("-", "")
        d = date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    if d.weekday() >= 5:
        return False
    return not is_kr_holiday(d)


if __name__ == "__main__":
    import sys
    arg = sys.argv[1] if len(sys.argv) > 1 else date.today().strftime("%Y%m%d")
    if is_kr_business_day(arg):
        print(f"{arg} business_day")
        sys.exit(0)
    else:
        print(f"{arg} holiday_or_weekend")
        sys.exit(1)
