"""백테스트용 데이터 수집 (GitHub Actions 전용).

1) KRX 상장 보통주(코스피·코스닥, 스팩·우선주·코넥스 제외) 5분봉 — 야후 60일 (약 3개월)
   저장 대상: 기간 중 하루라도 거래대금 50억원 이상인 종목
   (백테스트는 '전일 거래대금 50억 이상'일 때만 진입하므로, 이 조건은 거래 가능 종목의 상위집합 — 미래정보 편향 없음)
2) 비트코인 15분봉 2018-03 ~ 2021-12 (바이낸스 BTCUSDT) — 원본 규칙의 %를 변동성 단위로 옮기는 기준
3) 코스피·코스닥 지수 5분봉 (시장 맥락)
"""
from __future__ import annotations

import json
import os
import random
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import numpy as np
import requests

OUT = 'lab/out'
os.makedirs(OUT, exist_ok=True)
H = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'}
KST = timezone(timedelta(hours=9))
S = requests.Session()
S.headers.update(H)


def yahoo(sym: str, interval: str = '5m', rng: str = '60d', tries: int = 5):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval={interval}&range={rng}'
    for k in range(tries):
        try:
            r = S.get(url, timeout=20)
            if r.status_code == 429:
                time.sleep(5 * (k + 1) + random.random() * 3)
                continue
            if r.status_code == 404:
                return None
            j = r.json()['chart']
            res = (j.get('result') or [None])[0]
            if not res or not res.get('timestamp'):
                return None
            q = res['indicators']['quote'][0]
            return res['timestamp'], q
        except Exception:
            time.sleep(2 * (k + 1))
    return None


def grid_slots():
    # 09:00 ~ 15:00, 5분 간격 → 73칸 (야후는 15:00 이후 봉을 주지 않는다)
    return [(9 + m // 60) * 100 + m % 60 for m in range(0, 361, 5)]


SLOTS = grid_slots()
SLOT_IX = {s: i for i, s in enumerate(SLOTS)}


def to_grid(ts, q, days_ix):
    n_days, n_slots = len(days_ix), len(SLOTS)
    arr = np.zeros((n_days, n_slots, 5), dtype=np.int64)
    o, h, l, c, v = (q.get(k) or [] for k in ('open', 'high', 'low', 'close', 'volume'))
    for i, t in enumerate(ts):
        dt = datetime.fromtimestamp(t, KST)
        d = dt.strftime('%Y%m%d')
        s = dt.hour * 100 + dt.minute
        if d not in days_ix or s not in SLOT_IX:
            continue
        vals = (o[i], h[i], l[i], c[i], v[i])
        if any(x is None for x in vals[:4]):
            continue
        arr[days_ix[d], SLOT_IX[s]] = [round(vals[0]), round(vals[1]), round(vals[2]), round(vals[3]), int(vals[4] or 0)]
    return arr


def main():
    t0 = time.time()
    import FinanceDataReader as fdr
    lst = fdr.StockListing('KRX')
    lst = lst[lst['Market'].isin(['KOSPI', 'KOSDAQ', 'KOSDAQ GLOBAL'])]
    lst = lst[lst['Code'].str.match(r'^\d{5}0$')]               # 보통주만 (우선주 코드 제외)
    lst = lst[~lst['Name'].str.contains('스팩|리츠|인프라')]
    tickers = [(r.Code, r.Name, 'KOSPI' if r.Market == 'KOSPI' else 'KOSDAQ') for r in lst.itertuples()]
    print('universe', len(tickers))

    # 날짜 축: 삼성전자 5분봉의 거래일
    ref = yahoo('005930.KS')
    days = sorted({datetime.fromtimestamp(t, KST).strftime('%Y%m%d') for t in ref[0]})
    days_ix = {d: i for i, d in enumerate(days)}
    print('days', days[0], '~', days[-1], len(days))

    def job(t):
        code, name, mkt = t
        suf = '.KS' if mkt == 'KOSPI' else '.KQ'
        time.sleep(random.random() * 0.3)
        got = yahoo(code + suf)
        if not got:
            return t, None
        return t, to_grid(got[0], got[1], days_ix)

    keep, meta, fails = [], [], []
    with ThreadPoolExecutor(max_workers=6) as ex:
        for k, (t, arr) in enumerate(ex.map(job, tickers)):
            if k % 200 == 0:
                print(f'  {k}/{len(tickers)} kept={len(keep)} fails={len(fails)} {time.time() - t0:.0f}s', flush=True)
            if arr is None:
                fails.append(t[0])
                continue
            value = (arr[:, :, 3] * arr[:, :, 4]).sum(axis=1)    # 일 거래대금(원) 근사
            if value.max() < 5e9:
                continue
            keep.append(arr)
            meta.append(t)
    data = np.stack(keep).astype(np.int64)
    # 가격 int32, 거래량 int64 → 분리 저장
    np.savez_compressed(f'{OUT}/kr5m.npz', px=data[..., :4].astype(np.int32), vol=data[..., 4].astype(np.int64),
                        codes=np.array([m[0] for m in meta]), names=np.array([m[1] for m in meta]),
                        markets=np.array([m[2] for m in meta]), days=np.array(days), slots=np.array(SLOTS))
    for sym, nm in (('^KS11', 'kospi'), ('^KQ11', 'kosdaq')):
        got = yahoo(sym)
        if got:
            g = to_grid(got[0], got[1], days_ix)
            np.save(f'{OUT}/idx_{nm}.npy', g[..., :4].astype(np.int64))
    json.dump({'universe': len(tickers), 'kept': len(meta), 'fails': len(fails), 'days': [days[0], days[-1], len(days)],
               'sec': round(time.time() - t0)}, open(f'{OUT}/kr5m_meta.json', 'w'), ensure_ascii=False)
    print('saved', data.shape, f'{time.time() - t0:.0f}s')

    # 비트코인 15분봉 2018-03-05 ~ 2021-12-24
    start = int(datetime(2018, 3, 5, tzinfo=timezone.utc).timestamp() * 1000)
    end = int(datetime(2021, 12, 25, tzinfo=timezone.utc).timestamp() * 1000)
    rows = []
    cur = start
    while cur < end:
        r = S.get('https://data-api.binance.vision/api/v3/klines',
                  params={'symbol': 'BTCUSDT', 'interval': '15m', 'startTime': cur, 'limit': 1000}, timeout=20)
        k = r.json()
        if not k:
            break
        rows += [(x[0] // 1000, float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[5])) for x in k]
        cur = k[-1][0] + 15 * 60 * 1000
    b = np.array(rows, dtype=np.float64)
    np.save(f'{OUT}/btc15m.npy', b)
    print('btc', b.shape, f'{time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
