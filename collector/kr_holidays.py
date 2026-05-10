"""한국 거래소(KRX) 휴장일 캘린더.

토·일은 별도 처리, 본 모듈은 평일 공휴일·임시휴장일만 다룬다.
연도별 갱신 필요 — KRX 공식 캘린더 참고:
  https://open.krx.co.kr/contents/MKD/01/0110/01100305/MKD01100305.jsp

사용법:
    from kr_holidays import is_kr_holiday
    if is_kr_holiday("20260501"):
        skip()
"""
from datetime import date

# YYYYMMDD 문자열 set
KR_HOLIDAYS = {
    # 2026
    "20260101",  # 신정
    "20260216",  # 설날 연휴
    "20260217",  # 설날
    "20260218",  # 설날 연휴
    "20260302",  # 삼일절 대체(3/1 일)
    "20260501",  # 근로자의 날
    "20260505",  # 어린이날
    "20260525",  # 부처님오신날 대체(5/24 일)
    "20260817",  # 광복절 대체(8/15 토)
    "20260924",  # 추석 연휴
    "20260925",  # 추석
    "20260928",  # 추석 대체(9/26 토)
    "20261005",  # 개천절 대체(10/3 토)
    "20261009",  # 한글날
    "20261225",  # 성탄절
    "20261231",  # 연말 휴장
    # 2027 (필요 시 추가)
    "20270101",  # 신정
}


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
