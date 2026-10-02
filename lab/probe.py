"""데이터 소스 탐색 — 국내 분봉을 어디서 얼마나 길게 받을 수 있나."""
import json, time, os, re
import requests
H = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'}
out = {}
def get(url, **kw):
    t = time.time()
    try:
        r = requests.get(url, headers=H, timeout=20, **kw)
        return r, round(time.time() - t, 2)
    except Exception as e:
        return e, round(time.time() - t, 2)

def yahoo(sym, interval, rng=None, p1=None, p2=None):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval={interval}'
    url += f'&range={rng}' if rng else f'&period1={p1}&period2={p2}'
    r, dt = get(url)
    if isinstance(r, Exception):
        return {'err': str(r)}
    try:
        j = r.json()['chart']
        res = j['result'][0] if j.get('result') else None
        if not res:
            return {'status': r.status_code, 'error': j.get('error')}
        ts = res.get('timestamp') or []
        q = res['indicators']['quote'][0]
        return {'status': r.status_code, 'n': len(ts), 'first': time.strftime('%Y-%m-%d %H:%M', time.localtime(ts[0])) if ts else None,
                'last': time.strftime('%Y-%m-%d %H:%M', time.localtime(ts[-1])) if ts else None, 'sec': dt,
                'vol_nonnull': sum(1 for v in (q.get('volume') or []) if v), 'tz': res['meta'].get('exchangeTimezoneName')}
    except Exception as e:
        return {'status': r.status_code, 'parse': str(e), 'body': r.text[:300]}

now = int(time.time())
for sym in ('005930.KS', '247540.KQ'):
    for itv, rng in (('1m', '7d'), ('2m', '60d'), ('5m', '60d'), ('15m', '60d'), ('60m', '730d')):
        out[f'yahoo {sym} {itv} {rng}'] = yahoo(sym, itv, rng)
    out[f'yahoo {sym} 1m p 20-27d ago'] = yahoo(sym, '1m', p1=now - 27 * 86400, p2=now - 20 * 86400)
    out[f'yahoo {sym} 1m p 35-29d ago'] = yahoo(sym, '1m', p1=now - 35 * 86400, p2=now - 29 * 86400)

# Naver
cands = {
    'fchart minute': 'https://fchart.stock.naver.com/sise.nhn?symbol=005930&timeframe=minute&count=3000&requestType=0',
    'siseJson minute': 'https://api.finance.naver.com/siseJson.naver?symbol=005930&requestType=1&startTime=20260801&endTime=20261002&timeframe=minute',
    'm front-api minute': 'https://m.stock.naver.com/front-api/external/chart/domestic/info?symbol=005930&requestType=1&startTime=202608010900&endTime=202610021530&timeframe=minute',
    'api.stock chart minute': 'https://api.stock.naver.com/chart/domestic/item/005930/minute?startDateTime=202609010900&endDateTime=202610021530',
    'api.stock chart minute5': 'https://api.stock.naver.com/chart/domestic/item/005930/minute5?startDateTime=202608010900&endDateTime=202610021530',
}
for k, u in cands.items():
    r, dt = get(u)
    if isinstance(r, Exception):
        out[k] = {'err': str(r)}
        continue
    body = r.text
    rows = re.findall(r'20\d{10}', body)
    out[k] = {'status': r.status_code, 'len': len(body), 'sec': dt, 'n_stamps': len(rows),
              'first': min(rows) if rows else None, 'last': max(rows) if rows else None, 'head': body[:250]}

# Binance BTC 15m 2018
r, dt = get('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=15m&startTime=1520208000000&limit=1000')
out['binance 15m 2018'] = {'status': getattr(r, 'status_code', None), 'n': len(r.json()) if hasattr(r, 'json') else str(r)}
# KRX listing
try:
    import FinanceDataReader as fdr
    df = fdr.StockListing('KRX')
    out['fdr KRX'] = {'n': len(df), 'cols': list(df.columns)[:20], 'markets': df['Market'].value_counts().to_dict() if 'Market' in df else None}
except Exception as e:
    out['fdr KRX'] = {'err': str(e)[:300]}
os.makedirs('lab/out', exist_ok=True)
json.dump(out, open('lab/out/probe.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(out, ensure_ascii=False, indent=1)[:6000])
