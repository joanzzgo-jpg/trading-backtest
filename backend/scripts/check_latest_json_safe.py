#!/usr/bin/env python3
"""守門員之十八：/api/latest 永遠不可以回出不合法的數字（不需服務跑著，約 5 秒）

★ 2026-09-10 事故：本機日誌抓到 **216 次** `POST /api/latest → 500`，
  例外是 `ValueError: Out of range float values are not JSON compliant: nan`。
  主圖每秒的即時輪詢、自選那幾列的價格全走這支 —— 它一 500 就是使用者說的
  「K 棒停住、要重整才好」，而前端兩個呼叫點都是 `if (!res.ok) return;`
  ＝**完全靜默**，畫面上零錯誤、零提示。

★ 根因是結構性的：`_get_latest_impl` 有 8 條 return，只有走 `df_to_records()`
  的那幾條會把 NaN 換掉，另外幾條是**手工組 dict**（台股 MIS 日線／MIS 補號平盤棒／
  yfinance 單根／Finnhub、騰訊累積器）—— 上游一顆 NaN 就直接進回應。
  修法是把消毒移到**邊界**（`_scrub_latest`），這支就是驗那道邊界。

⚠ 判準一定要用 `json.dumps(..., allow_nan=False)` —— starlette 的 JSONResponse
  就是這樣序列化的。用預設的 `allow_nan=True` 測，NaN 會被寫成非法的 `NaN`
  字面值卻**不報錯** ＝ 假通過（我第一版就是這樣，差點得出「植回舊碼也沒事」的結論）。
⚠ 每個情境都要先確認「植回舊碼（直接看 `_get_latest_impl` 的原始回應）真的會壞」，
  否則代表注入根本沒走到那條路 → 回傳碼 2（測試不成立），不可以算通過。

回傳碼：0 通過／1 有洞／2 測試不成立
"""
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import pandas as pd                                   # noqa: E402
os.environ.setdefault("FINNHUB_TOKEN", "__gk_dummy__")  # 讓美股走到 Finnhub 累積器那條
import routes.data as D                               # noqa: E402
from routes.data import LatestRequest                 # noqa: E402

NAN = float("nan")


def like_starlette(obj):
    """與 FastAPI 回應完全相同的序列化方式（allow_nan=False 是關鍵）。"""
    return json.dumps(obj, allow_nan=False, default=str)


def bars_ok(resp):
    """回出去的每一根都必須是合法的 K 棒（價格有限且為正）。"""
    for r in (resp or {}).get("data") or []:
        for k in ("open", "high", "low", "close"):
            v = r.get(k)
            if not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")) or v <= 0:
                return False, f"{k}={v!r}"
    return True, ""


def df_with_nan_tail():
    """尾巴那根是 NaN 的 df（yfinance 對停牌／冷門股很常這樣）。"""
    t = pd.date_range("2026-09-08", periods=3, freq="D")
    return pd.DataFrame({
        "time": t,
        "open": [10.0, 10.5, NAN], "high": [11.0, 11.5, NAN],
        "low": [9.0, 9.5, NAN], "close": [10.5, 11.0, NAN],
        "volume": [1000.0, 1000.0, NAN],
    })


# ── 各情境：(名稱, 佈置注入的函式, 請求) ────────────────────────────────
def case_tw_yf_single():
    D.fetch_tw_realtime = lambda s: None
    D.fetch_tw_latest_bar_yf = lambda s: {
        "time": pd.Timestamp("2026-09-10"), "open": NAN, "high": NAN,
        "low": NAN, "close": NAN, "volume": NAN}


def case_tw_mis_daily():
    D.fetch_tw_realtime = lambda s: {
        "time": pd.Timestamp("2026-09-10 11:00:00").to_pydatetime(),
        "open": NAN, "high": NAN, "low": NAN, "close": NAN, "volume": NAN}


def case_tw_intraday_df():
    D.fetch_cnyes_stock_intraday = lambda s, tf: None
    D.fugle_enabled = lambda: False
    D.fetch_tw_realtime = lambda s: None
    D.fetch_tw_intraday_yf = lambda s, tf, a, b: df_with_nan_tail()


def case_crypto_df():
    D.fetch_crypto_ohlcv = lambda *a, **k: df_with_nan_tail()


def case_hk_acc():
    D.fetch_us_stock = lambda *a, **k: pd.DataFrame()
    D.fetch_hk_realtime = lambda s: {"time": pd.Timestamp("2026-09-10 10:00:00").to_pydatetime(),
                                     "close": 10.0, "volume": 100.0}
    D._hk_accumulate = lambda s, m, rt: [{
        "time": pd.Timestamp("2026-09-10 02:00:00"), "open": NAN, "high": NAN,
        "low": NAN, "close": NAN, "volume": NAN}]


def case_us_finnhub_acc():
    D.fetch_us_stock = lambda *a, **k: df_with_nan_tail().dropna()
    D.fetch_us_quote = lambda s: {"close": 100.0, "timestamp": 1}
    D._finnhub_accumulate = lambda s, m, q: [{
        "time": pd.Timestamp("2099-01-01 10:00:00"), "open": NAN, "high": NAN,
        "low": NAN, "close": NAN, "volume": NAN}]


CASES = [
    ("台股 1d → yfinance 單根（手工組 dict）", case_tw_yf_single, dict(market="tw", symbol="__GK1__", timeframe="1d")),
    ("台股 1d → MIS 即時整日棒（手工組 dict）", case_tw_mis_daily, dict(market="tw", symbol="__GK2__", timeframe="1d")),
    ("台股 5m → yfinance 盤中 df 尾巴 NaN", case_tw_intraday_df, dict(market="tw", symbol="__GK3__", timeframe="5m")),
    ("加密 1h → 交易所 df 尾巴 NaN", case_crypto_df, dict(market="crypto", symbol="__GK4__/USDT", timeframe="1h", exchange="binance")),
    ("港股 5m → 騰訊累積器（手工組 dict）", case_hk_acc, dict(market="hk", symbol="__GK5__.HK", timeframe="5m")),
    ("美股 5m → Finnhub 累積器（手工組 dict）", case_us_finnhub_acc, dict(market="us", symbol="__GK6__", timeframe="5m")),
]


def main():
    fails, invalid = [], []
    for name, setup, kw in CASES:
        setup()
        req = LatestRequest(**kw)
        # ① 植回舊碼：直接看實作的原始回應，必須真的壞掉（證明注入走到那條路了）
        try:
            raw = D._get_latest_impl(req)
            raw_ok, why = bars_ok(raw)
            like_starlette(raw)
            if raw_ok:
                invalid.append(f"{name}：注入沒生效（原始回應是乾淨的）")
                continue
        except ValueError:
            pass                                   # 正是我們要的：舊碼會 500
        except Exception as e:
            invalid.append(f"{name}：實作在注入下直接拋 {type(e).__name__}: {e}")
            continue
        # ② 邊界消毒後：必須序列化得出來，而且每根都是合法 K 棒
        D._LATEST_BAD_WARNED.clear()
        try:
            resp = D.get_latest(req)
            like_starlette(resp)
        except Exception as e:
            fails.append(f"{name}：邊界沒擋住 → {type(e).__name__}: {e}")
            continue
        ok, why = bars_ok(resp)
        if not ok:
            fails.append(f"{name}：回應裡仍有不合法的 K 棒（{why}）")
        else:
            print(f"  ✓ {name}")

    if invalid:
        print("\n⚠ 測試不成立（不是通過）：")
        for m in invalid:
            print("   -", m)
        return 2
    if fails:
        print("\n✗ /api/latest 會回出不合法的數字：")
        for m in fails:
            print("   -", m)
        return 1
    print(f"\n✓ {len(CASES)} 個情境全部擋下：/api/latest 不會再因為 NaN 回 500")
    return 0


if __name__ == "__main__":
    sys.exit(main())
