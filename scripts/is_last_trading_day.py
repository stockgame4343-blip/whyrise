"""오늘이 이번 달의 '마지막 거래일'이면 exit 0, 아니면 exit 1. (KST 기준, KRX 공휴일 반영)

월간 리포트 워크플로 게이트용. 오늘이 거래일이고, 이번 달 남은 날이 전부 주말/공휴일이면 마지막 거래일.
워크플로 env TZ=Asia/Seoul 이라 date.today() 가 KST.
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


today = datetime.date.today()
if not is_trading(today):
    print('오늘은 거래일 아님:', today)
    sys.exit(1)

d = today + datetime.timedelta(days=1)
while d.month == today.month:
    if is_trading(d):
        print('이번 달 이후 거래일 존재:', d, '→ 마지막 거래일 아님')
        sys.exit(1)
    d += datetime.timedelta(days=1)

print('이번 달 마지막 거래일:', today)
sys.exit(0)
