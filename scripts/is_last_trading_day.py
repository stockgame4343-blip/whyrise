"""오늘이 이번 '달'(기본) 또는 이번 '주'의 마지막 거래일이면 exit 0, 아니면 exit 1.

  python is_last_trading_day.py         # 이번 달 마지막 거래일?
  python is_last_trading_day.py week    # 이번 주(월~일) 마지막 거래일?

KST 기준(워크플로 env TZ=Asia/Seoul), KRX 공휴일 반영. 월간/주간 리포트 워크플로 게이트용.
오늘이 거래일이고, 이번 달/주 남은 날이 전부 주말·공휴일이면 마지막 거래일.
"""
import sys
import datetime

sys.path.insert(0, '.')
try:
    from collector.kr_holidays import is_kr_holiday
except Exception:
    def is_kr_holiday(_d):
        return False


def is_trading(d):
    return d.weekday() < 5 and not is_kr_holiday(d)


scope = (sys.argv[1] if len(sys.argv) > 1 else 'month').strip().lower()
today = datetime.date.today()

if not is_trading(today):
    print('오늘은 거래일 아님:', today)
    sys.exit(1)

d = today + datetime.timedelta(days=1)
if scope == 'week':
    # 다음 주 월요일(weekday 0) 전까지 = 이번 주 남은 날
    while d.weekday() != 0:
        if is_trading(d):
            print('이번 주 이후 거래일 존재:', d, '→ 주 마지막 거래일 아님')
            sys.exit(1)
        d += datetime.timedelta(days=1)
    print('이번 주 마지막 거래일:', today)
    sys.exit(0)
else:
    while d.month == today.month:
        if is_trading(d):
            print('이번 달 이후 거래일 존재:', d, '→ 달 마지막 거래일 아님')
            sys.exit(1)
        d += datetime.timedelta(days=1)
    print('이번 달 마지막 거래일:', today)
    sys.exit(0)
