"""1분봉 (최근 30일, 야후 7일 단위 4~5회) — 초단타형(번개·중거리) 정밀 검증용. kr5m.npz 와 같은 종목."""
import json, os, random, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import numpy as np
import requests
OUT = 'lab/out'
KST = timezone(timedelta(hours=9))
S = requests.Session()
S.headers.update({'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'})
SLOTS = [(9 + m // 60) * 100 + m % 60 for m in range(0, 361)]
SIX = {s: i for i, s in enumerate(SLOTS)}

def yahoo(sym, p1, p2, tries=5):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1m&period1={p1}&period2={p2}'
    for k in range(tries):
        try:
            r = S.get(url, timeout=20)
            if r.status_code == 429:
                time.sleep(5 * (k + 1) + random.random() * 3); continue
            if r.status_code in (404, 422):
                return None
            res = (r.json()['chart'].get('result') or [None])[0]
            if not res or not res.get('timestamp'):
                return None
            return res['timestamp'], res['indicators']['quote'][0]
        except Exception:
            time.sleep(2 * (k + 1))
    return None

def main():
    t0 = time.time()
    d5 = np.load(f'{OUT}/kr5m.npz')
    codes, markets = d5['codes'], d5['markets']
    now = int(time.time())
    wins = []
    end = now
    start_all = now - 29 * 86400
    while end > start_all:
        st = max(start_all, end - 7 * 86400 + 60)
        wins.append((st, end)); end = st - 60
    ref = []
    for p1, p2 in wins:
        g = yahoo('005930.KS', p1, p2)
        if g: ref += g[0]
    days = sorted({datetime.fromtimestamp(t, KST).strftime('%Y%m%d') for t in ref})
    dix = {d: i for i, d in enumerate(days)}
    print('days', days[0], days[-1], len(days), flush=True)
    def job(k):
        sym = codes[k] + ('.KS' if markets[k] == 'KOSPI' else '.KQ')
        arr = np.zeros((len(days), len(SLOTS), 5), dtype=np.int64)
        got_any = False
        for p1, p2 in wins:
            time.sleep(random.random() * 0.2)
            g = yahoo(sym, p1, p2)
            if not g: continue
            ts, q = g
            o, h, l, c, v = (q.get(x) or [] for x in ('open', 'high', 'low', 'close', 'volume'))
            for i, t in enumerate(ts):
                dt = datetime.fromtimestamp(t, KST); d = dt.strftime('%Y%m%d'); s = dt.hour * 100 + dt.minute
                if d not in dix or s not in SIX or o[i] is None or c[i] is None or h[i] is None or l[i] is None:
                    continue
                arr[dix[d], SIX[s]] = [round(o[i]), round(h[i]), round(l[i]), round(c[i]), int(v[i] or 0)]
                got_any = True
        return k, arr if got_any else None
    out = [None] * len(codes)
    with ThreadPoolExecutor(max_workers=6) as ex:
        for n, (k, arr) in enumerate(ex.map(job, range(len(codes)))):
            out[k] = arr
            if n % 100 == 0:
                print(f'  {n}/{len(codes)} {time.time() - t0:.0f}s', flush=True)
    ok = [k for k in range(len(codes)) if out[k] is not None]
    data = np.stack([out[k] for k in ok])
    for mk in ('KOSPI', 'KOSDAQ'):
        sel = [j for j, k in enumerate(ok) if markets[k] == mk]
        np.savez_compressed(f'{OUT}/kr1m_{mk.lower()}.npz', px=data[sel][..., :4].astype(np.int32),
                            vol=data[sel][..., 4].astype(np.int64), codes=codes[[ok[j] for j in sel]],
                            markets=markets[[ok[j] for j in sel]], days=np.array(days), slots=np.array(SLOTS))
    json.dump({'kept': len(ok), 'days': [days[0], days[-1], len(days)], 'sec': round(time.time() - t0)},
              open(f'{OUT}/kr1m_meta.json', 'w'))
    print('done', data.shape, f'{time.time() - t0:.0f}s')

if __name__ == '__main__':
    main()
