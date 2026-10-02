"""코인 데이터 소스 탐색 — BTC·HYPE·ZEC·USELESS 무기한 1분봉·펀딩비를 어디서 얼마나 길게 받을 수 있나."""
import json
import os
import time

import requests

H = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'}
S = requests.Session()
S.headers.update(H)
COINS = ['BTC', 'HYPE', 'ZEC', 'USELESS']
out = {}


def get(url, method='GET', **kw):
    t = time.time()
    try:
        r = S.request(method, url, timeout=20, **kw)
        return r, round(time.time() - t, 2)
    except Exception as e:
        return e, round(time.time() - t, 2)


def ts(ms):
    return time.strftime('%Y-%m-%d %H:%M', time.gmtime(int(ms) / 1000))


def summarize(r, dt, rows_fn):
    if isinstance(r, Exception):
        return {'err': str(r)[:200], 'sec': dt}
    try:
        rows = rows_fn(r.json())
        return {'status': r.status_code, 'n': len(rows), 'first': ts(rows[0]) if rows else None,
                'last': ts(rows[-1]) if rows else None, 'sec': dt}
    except Exception as e:
        return {'status': r.status_code, 'parse': str(e)[:120], 'body': r.text[:200], 'sec': dt}


# 1) Binance 공개 덤프 (data.binance.vision) — 월별 1분봉 zip 존재 여부
months = [f'{y}-{m:02d}' for y in (2024, 2025, 2026) for m in range(1, 13) if f'{y}-{m:02d}' <= '2026-09']
for c in COINS:
    sym = f'{c}USDT'
    for kind, base in (('um', f'https://data.binance.vision/data/futures/um/monthly/klines/{sym}/1m/{sym}-1m-'),
                       ('spot', f'https://data.binance.vision/data/spot/monthly/klines/{sym}/1m/{sym}-1m-')):
        have = []
        for mo in months:
            r, _ = get(base + mo + '.zip', method='HEAD')
            if not isinstance(r, Exception) and r.status_code == 200:
                have.append(mo)
        out[f'binance-dump {kind} {sym}'] = {'months': len(have), 'first': have[0] if have else None,
                                             'last': have[-1] if have else None}
    r, _ = get(f'https://data.binance.vision/data/futures/um/monthly/fundingRate/{sym}/{sym}-fundingRate-2026-08.zip', method='HEAD')
    out[f'binance-dump fundingRate {sym} 2026-08'] = getattr(r, 'status_code', str(r)[:100])
    r, _ = get(f'https://data.binance.vision/data/futures/um/daily/klines/{sym}/1m/{sym}-1m-2026-09-30.zip', method='HEAD')
    out[f'binance-dump daily {sym} 2026-09-30'] = getattr(r, 'status_code', str(r)[:100])

# 2) Binance 선물 API (미국 IP 차단 여부)
for c in COINS:
    r, dt = get(f'https://fapi.binance.com/fapi/v1/klines?symbol={c}USDT&interval=1m&startTime=1704067200000&limit=5')
    out[f'binance fapi {c}'] = summarize(r, dt, lambda j: [x[0] for x in j])

# 3) Bybit v5 (linear)
for c in COINS:
    r, dt = get(f'https://api.bybit.com/v5/market/kline?category=linear&symbol={c}USDT&interval=1&start=1704067200000&limit=1000')
    out[f'bybit {c}'] = summarize(r, dt, lambda j: sorted(int(x[0]) for x in j['result']['list']))

# 4) OKX (SWAP)
for c in COINS:
    r, dt = get(f'https://www.okx.com/api/v5/market/history-candles?instId={c}-USDT-SWAP&bar=1m&limit=100')
    out[f'okx {c}'] = summarize(r, dt, lambda j: sorted(int(x[0]) for x in j['data']))

# 5) Hyperliquid
r, dt = get('https://api.hyperliquid.xyz/info', method='POST', json={'type': 'meta'})
try:
    uni = [u['name'] for u in r.json()['universe']]
    out['hyperliquid meta'] = {'n': len(uni), 'have': {c: c in uni for c in COINS}}
except Exception as e:
    out['hyperliquid meta'] = {'err': str(e)[:200]}
now = int(time.time() * 1000)
for c in COINS:
    for itv, back in (('1m', 30), ('15m', 400)):
        r, dt = get('https://api.hyperliquid.xyz/info', method='POST',
                    json={'type': 'candleSnapshot', 'req': {'coin': c, 'interval': itv, 'startTime': now - back * 86400000, 'endTime': now}})
        out[f'hyperliquid {c} {itv}'] = summarize(r, dt, lambda j: [x['t'] for x in j])
    r, dt = get('https://api.hyperliquid.xyz/info', method='POST',
                json={'type': 'fundingHistory', 'coin': c, 'startTime': 1704067200000})
    out[f'hyperliquid funding {c}'] = summarize(r, dt, lambda j: [x['time'] for x in j])

# 6) Gate / MEXC / Bitget (대체)
for c in COINS:
    r, dt = get(f'https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract={c}_USDT&interval=1m&from=1735689600&to=1735749600')
    out[f'gate {c}'] = summarize(r, dt, lambda j: [x['t'] * 1000 for x in j])
    r, dt = get(f'https://contract.mexc.com/api/v1/contract/kline/{c}_USDT?interval=Min1&start=1735689600&end=1735749600')
    out[f'mexc {c}'] = summarize(r, dt, lambda j: [t * 1000 for t in j['data']['time']])
    r, dt = get(f'https://api.bitget.com/api/v2/mix/market/history-candles?symbol={c}USDT&productType=usdt-futures&granularity=1m&endTime=1735749600000&limit=200')
    out[f'bitget {c}'] = summarize(r, dt, lambda j: sorted(int(x[0]) for x in j['data']))

os.makedirs('lab/out', exist_ok=True)
json.dump(out, open('lab/out/probe_crypto.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(out, ensure_ascii=False, indent=1))
