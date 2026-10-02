"""코인 무기한 1분봉 + 펀딩비 (바이낸스 USDⓈ-M 공개 덤프 data.binance.vision).

BTC·ZEC: 2024-01 ~ 2026-09, HYPE: 2025-05 ~, USELESS: 2025-08 ~ (상장 이후 전부)
저장: lab/out/c1m_{COIN}.npz (t ms, o h l c, qv 거래대금 USDT), lab/out/cfund_{COIN}.npz (t ms, r)
"""
from __future__ import annotations

import io
import json
import os
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests

OUT = 'lab/out'
os.makedirs(OUT, exist_ok=True)
S = requests.Session()
S.headers.update({'User-Agent': 'Mozilla/5.0'})
BASE = 'https://data.binance.vision/data/futures/um/monthly'
START = {'BTC': '2024-01', 'ZEC': '2024-01', 'HYPE': '2025-05', 'USELESS': '2025-08'}
END = '2026-09'


def months(a: str, b: str):
    y, m = map(int, a.split('-'))
    out = []
    while f'{y}-{m:02d}' <= b:
        out.append(f'{y}-{m:02d}')
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def get_zip_csv(url: str) -> list[list[str]] | None:
    for k in range(5):
        try:
            r = S.get(url, timeout=60)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            z = zipfile.ZipFile(io.BytesIO(r.content))
            txt = z.read(z.namelist()[0]).decode()
            rows = [ln.split(',') for ln in txt.strip().splitlines()]
            if rows and not rows[0][0].strip().lstrip('-').isdigit():
                rows = rows[1:]                  # 헤더
            return rows
        except Exception as e:  # noqa: BLE001
            print('  retry', url, e, flush=True)
            time.sleep(3 * (k + 1))
    return None


def fetch_coin(coin: str):
    sym = f'{coin}USDT'
    ms = months(START[coin], END)
    t0 = time.time()

    def kl(mo):
        return mo, get_zip_csv(f'{BASE}/klines/{sym}/1m/{sym}-1m-{mo}.zip')

    def fu(mo):
        return mo, get_zip_csv(f'{BASE}/fundingRate/{sym}/{sym}-fundingRate-{mo}.zip')

    with ThreadPoolExecutor(max_workers=6) as ex:
        kres = list(ex.map(kl, ms))
        fres = list(ex.map(fu, ms))
    rows = []
    miss = []
    for mo, rr in kres:
        if rr is None:
            miss.append(mo)
            continue
        rows += rr
    a = np.array([[float(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[7])] for x in rows])
    a[:, 0] = np.where(a[:, 0] > 1e14, a[:, 0] // 1000, a[:, 0])     # µs → ms
    a = a[np.argsort(a[:, 0], kind='stable')]
    _, keep = np.unique(a[:, 0], return_index=True)
    a = a[keep]
    np.savez_compressed(f'{OUT}/c1m_{coin}.npz', t=a[:, 0].astype(np.int64), o=a[:, 1], h=a[:, 2], l=a[:, 3],
                        c=a[:, 4], qv=a[:, 5].astype(np.float32))
    f = []
    for mo, rr in fres:
        for x in rr or []:
            try:
                f.append((int(float(x[0])), float(x[2])))
            except (ValueError, IndexError):
                pass
    f = np.array(sorted(set(f))) if f else np.zeros((0, 2))
    np.savez_compressed(f'{OUT}/cfund_{coin}.npz', t=f[:, 0].astype(np.int64), r=f[:, 1])
    info = {'bars': int(len(a)), 'first': time.strftime('%Y-%m-%d %H:%M', time.gmtime(a[0, 0] / 1000)),
            'last': time.strftime('%Y-%m-%d %H:%M', time.gmtime(a[-1, 0] / 1000)), 'missing_months': miss,
            'funding': int(len(f)), 'sec': round(time.time() - t0)}
    print(coin, info, flush=True)
    return coin, info


def main():
    meta = dict(fetch_coin(c) for c in START)
    json.dump(meta, open(f'{OUT}/crypto_meta.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
