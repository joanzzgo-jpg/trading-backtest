"""
台股資料抓取 - 歷史日線用 FinMind，分鐘/小時用 yfinance（不需 token）
"""
import re as _re
import time as _time
import logging
import pandas as pd
import requests
from datetime import datetime, timedelta, date

_log = logging.getLogger("taiwan")

FINMIND_API_URL = "https://api.finmindtrade.com/api/v4/data"


def fetch_tw_stock(symbol: str, start: str, end: str, api_token: str = "") -> pd.DataFrame:
    """
    抓取台股 OHLCV 資料
    symbol: 股票代號，例如 "2330" (台積電)
    start/end: "YYYY-MM-DD"
    """
    params = {
        "dataset": "TaiwanStockPrice",
        "data_id": symbol,
        "start_date": start,
        "end_date": end,
        "token": api_token,
    }
    resp = requests.get(FINMIND_API_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != 200:
        raise ValueError(f"FinMind API 錯誤: {data.get('msg', '未知錯誤')}")

    records = data.get("data", [])
    if not records:
        raise ValueError(f"找不到 {symbol} 的資料")

    df = pd.DataFrame(records)
    df = df.rename(columns={
        "date": "time",
        "open": "open",
        "max": "high",
        "min": "low",
        "close": "close",
        "Trading_Volume": "volume",
    })
    df["time"] = pd.to_datetime(df["time"])
    df = df[["time", "open", "high", "low", "close", "volume"]].copy()
    df = df.sort_values("time").reset_index(drop=True)

    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    return df


def resample_tw(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """將日線資料聚合為週線或月線"""
    if timeframe == "1d":
        return df
    # 月線用 ME（月末最後一天），與台股月K對齊；週線用週五
    rule = {"1w": "W-FRI", "1M": "ME"}.get(timeframe, "1d")
    df = df.set_index("time")
    resampled = df.resample(rule).agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
    }).dropna(subset=["open"])
    resampled = resampled.reset_index()
    return resampled


def fetch_tw_intraday(symbol: str, timeframe: str, start: str, end: str, api_token: str = "") -> pd.DataFrame:
    """抓取台股分鐘 K 線並聚合為 5m / 15m / 1h"""
    params = {
        "dataset": "TaiwanStockPriceMinute",
        "data_id": symbol,
        "start_date": start,
        "end_date": end,
        "token": api_token,
    }
    resp = requests.get(FINMIND_API_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != 200:
        raise ValueError(f"FinMind 分鐘資料錯誤: {data.get('msg', '未知錯誤')}")

    records = data.get("data", [])
    if not records:
        raise ValueError(f"找不到 {symbol} 的分鐘資料（需登入 FinMind 免費帳號取得 token）")

    df = pd.DataFrame(records)
    # FinMind 分鐘資料欄位: date, Time, open, high, low, close, volume
    time_col  = "date" if "date" in df.columns else "Date"
    clock_col = "Time" if "Time" in df.columns else "time"
    df["time"] = pd.to_datetime(df[time_col].astype(str) + " " + df[clock_col].astype(str))

    col_map = {}
    for c in df.columns:
        cl = c.lower()
        if cl in ("open","high","low","close","volume") and c not in col_map.values():
            col_map[c] = cl
    df = df.rename(columns=col_map)
    df = df[["time","open","high","low","close","volume"]].copy()
    for c in ["open","high","low","close","volume"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.sort_values("time").dropna(subset=["open"]).reset_index(drop=True)

    rule = {"5m": "5min", "15m": "15min", "1h": "h"}.get(timeframe, "5min")
    df = df.set_index("time")
    df = df.resample(rule).agg({"open":"first","high":"max","low":"min","close":"last","volume":"sum"})
    df = df.dropna(subset=["open"]).reset_index()
    return df


YF_TF_MAP = {"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "1h"}  # yfinance 不支援 4h，用 1h 替代

# yfinance 各 interval 最多可回溯天數
# 注意：1h 改用 15m 內部重採樣（避開 yfinance 1h 對台股的成交量缺漏 bug），
# 所以實際 1h 上限受 15m 60 天限制
# 留 2 天 buffer：yfinance 邊界嚴格小於、fetch_tw_intraday_yf 又會 end+1 → 一共佔 2 天
YF_MAX_DAYS = {"1m": 7, "5m": 58, "15m": 58, "1h": 58}   # 1m yfinance 僅近 7 天


def _yf_history(ticker, interval: str, start: str, end: str):
    """呼叫 yfinance history，回傳 DataFrame；空或失敗回 None。"""
    try:
        raw = ticker.history(start=start, end=end, interval=interval, auto_adjust=True)
        return raw if not raw.empty else None
    except Exception as e:
        _log.warning(f"[yf_history] {ticker.ticker} {interval} {start}~{end}: {e}")
        return None


def fetch_tw_daily_yf(symbol: str, start: str, end: str) -> pd.DataFrame:
    """
    用 yfinance 抓台股日線資料（不需 token，盤中即更新）。
    先試 .TW 再試 .TWO；end 自動 +1 天確保包含當日。
    """
    import yfinance as yf
    from datetime import date, timedelta
    try:
        end_incl = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    except Exception:
        end_incl = (date.today() + timedelta(days=1)).isoformat()
    for suffix in (".TW", ".TWO"):
        raw = _yf_history(yf.Ticker(f"{symbol}{suffix}"), "1d", start, end_incl)
        if raw is None:
            continue
        df = raw[["Open", "High", "Low", "Close", "Volume"]].copy()
        df.columns = ["open", "high", "low", "close", "volume"]
        idx = pd.to_datetime(df.index)
        if idx.tz is not None:
            idx = idx.tz_convert("Asia/Taipei").tz_localize(None)
        idx = idx.normalize()
        df.index = idx
        df.index.name = "time"
        df = df.reset_index()
        df["time"] = pd.to_datetime(df["time"])
        for col in ["open", "high", "low", "close", "volume"]:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        return df.dropna(subset=["close"])
    raise ValueError(f"找不到 {symbol} 的日線資料（yfinance .TW/.TWO 均失敗）")


def fetch_tw_intraday_yf(symbol: str, timeframe: str, start: str, end: str) -> pd.DataFrame:
    """
    用 yfinance 抓台股分鐘/小時資料（不需 token）。
    先試 .TW 再試 .TWO；若指定範圍失敗，自動縮短至近 30 天重試。

    注意：1h 改用 15m 內部重採樣（避開 yfinance 1h 對台股的「成交量缺漏 + 開盤
    錯位」bug——yfinance 直接抓 1h 會少 35% 成交量、第一根落在 10:00 而非 09:00）。
    """
    import yfinance as yf
    from datetime import date, timedelta

    # 1h 內部用 15m 重組（解決 yfinance 1h bug）
    src_tf      = "15m" if timeframe == "1h" else timeframe
    interval    = YF_TF_MAP.get(src_tf, "1h")
    # yfinance end 不含當天，+1 天確保抓到今日資料
    end_incl    = (date.today() + timedelta(days=1)).isoformat()
    short_start = (date.today() - timedelta(days=30)).isoformat()
    end_incl_req = (date.fromisoformat(end) + timedelta(days=1)).isoformat() if end else end_incl

    for suffix in (".TW", ".TWO"):
        ticker = yf.Ticker(f"{symbol}{suffix}")
        raw = _yf_history(ticker, interval, start, end_incl_req)
        if raw is None:
            raw = _yf_history(ticker, interval, short_start, end_incl)
        if raw is None:
            continue
        df = raw[["Open", "High", "Low", "Close", "Volume"]].copy()
        df.columns = ["open", "high", "low", "close", "volume"]
        idx = pd.to_datetime(df.index)
        if idx.tz is None:
            idx = idx.tz_localize("Asia/Taipei")
        idx = idx.tz_convert("UTC").tz_localize(None)
        df.index = idx
        df.index.name = "time"
        df = df.reset_index()
        # Floor to bar boundary so partial/in-progress bars (e.g. stamped 11:40
        # by yfinance instead of 11:00) align to clean period starts.
        src_freq = {"1m": "1min", "5m": "5min", "15m": "15min"}.get(src_tf, "60min")
        df["time"] = pd.to_datetime(df["time"]).dt.floor(src_freq)
        df = df.drop_duplicates(subset=["time"], keep="last").reset_index(drop=True)
        df = df.dropna(subset=["close"])
        # ─ TW 開盤集合競價過濾 ──────────────────────────────
        # yfinance 對台股 15m/1h 在 09:00 會放一根 vol=0「集合競價快照」棒：
        # 第一根 1h「10:00」實際缺資料，第一根 15m「09:00」有資料但若 yfinance
        # 回傳 vol=0 就濾掉。一律過濾以避免長影線誤導圖表。
        df = df[df["volume"] > 0].reset_index(drop=True)
        # ─ 台股交易時間過濾（09:00-13:30 Taipei）──────────
        # 防 yfinance 偶爾回傳 13:30 收盤集合競價 bar 或盤前/盤後 bar
        tpe_min = ((df["time"].dt.hour + 8) % 24) * 60 + df["time"].dt.minute
        df = df[(tpe_min >= 9 * 60) & (tpe_min < 13 * 60 + 30)].reset_index(drop=True)
        # ─ 1h 內部重採樣（15m → 1h，對齊台北 09:00 為第一根） ──
        # 用 origin="start_day" + offset="1h" 把 1h bins 對齊到 UTC 01:00（=台北
        # 09:00），讓第一根 1h 包含 09:00-09:59 完整成交量（解決 yfinance 1h bug）。
        if timeframe == "1h":
            df = df.set_index("time").resample(
                "1h", origin="start_day", offset="1h"
            ).agg({
                "open": "first", "high": "max", "low": "min",
                "close": "last", "volume": "sum",
            }).dropna(subset=["open"]).reset_index()
        return df
    raise ValueError(f"找不到 {symbol} 的分鐘資料（請確認代號正確，例如 2330）")


TWSE_MIS_URL     = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
TWSE_MIS_HEADERS = {"Referer": "https://mis.twse.com.tw/stock/index.jsp"}
# TWSE opendata：全上市股票每日行情（盤中更新）
TWSE_DAY_ALL_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
# TPEX opendata：全上櫃股票每日行情
TPEX_DAY_ALL_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"

# 備援熱門清單（opendata 失敗時用 MIS 抓這 50 支）
TW_POPULAR = [
    ("2330","tse"),("2317","tse"),("2454","tse"),("2412","tse"),("2308","tse"),
    ("2382","tse"),("2881","tse"),("2882","tse"),("2886","tse"),("2891","tse"),
    ("2884","tse"),("2885","tse"),("2892","tse"),("2002","tse"),("1301","tse"),
    ("1303","tse"),("1326","tse"),("2357","tse"),("2303","tse"),("3711","tse"),
    ("2379","tse"),("2395","tse"),("4904","tse"),("4938","tse"),("3034","tse"),
    ("3008","tse"),("2327","tse"),("2376","tse"),("2408","tse"),("5880","tse"),
    ("2890","tse"),("6505","tse"),("1216","tse"),("2912","tse"),("2301","tse"),
    ("2353","tse"),("2409","tse"),("3045","tse"),("2887","tse"),("2615","tse"),
    ("2603","tse"),("2609","tse"),("2610","tse"),("2618","tse"),("2883","tse"),
    ("2880","tse"),("2337","tse"),("6669","otc"),("3231","otc"),("6770","tse"),
]

TW_NAME_MAP = {
    "2330":"台積電","2317":"鴻海","2454":"聯發科","2412":"中華電","2308":"台達電",
    "2382":"廣達","2881":"富邦金","2882":"國泰金","2886":"兆豐金","2891":"中信金",
    "2884":"玉山金","2885":"元大金","2892":"第一金","2002":"中鋼","1301":"台塑",
    "1303":"南亞","1326":"台化","2357":"華碩","2303":"聯電","3711":"日月光投控",
    "2379":"瑞昱","2395":"研華","4904":"遠傳","4938":"和碩","3034":"聯詠",
    "3008":"大立光","2327":"國巨","2376":"技嘉","2408":"南亞科","5880":"合庫金",
    "2890":"永豐金","6505":"台塑化","1216":"統一","2912":"統一超","2301":"光寶科",
    "2353":"宏碁","2409":"友達","3045":"台灣大","2887":"台新金","2615":"萬海",
    "2603":"長榮","2609":"陽明","2610":"華航","2618":"長榮航","2883":"開發金",
    "2880":"華南金","2337":"旺宏","6669":"緯穎","3231":"緯創","6770":"力積電",
}


def _parse_tw_change(s: str) -> float:
    """解析 TWSE/TPEX 漲跌字串，正負均支援（含 ▲▼ 或 +- 前綴）。"""
    s = (s or "").strip()
    if not s or s in ("---", "--", ""):
        return 0.0
    neg = s.startswith("-") or "▼" in s
    clean = _re.sub(r"[^0-9.]", "", s)
    if not clean:
        return 0.0
    val = float(clean)
    return -val if neg else val


def fetch_tw_tickers() -> list:
    """抓取全台股（上市＋上櫃）每日行情，以漲跌幅排序。
    主力：TWSE/TPEX opendata（全量，盤中更新）。
    備援：MIS 熱門 50 支即時。
    """
    tickers: dict[str, dict] = {}

    # ── 1. TWSE 上市全量 ──────────────────────────────────────
    try:
        resp = requests.get(TWSE_DAY_ALL_URL, timeout=15)
        resp.raise_for_status()
        for d in resp.json():
            code = (d.get("Code") or "").strip()
            if not (code and code.isdigit() and len(code) == 4):
                continue
            close_s = (d.get("ClosingPrice") or "").replace(",", "").strip()
            if not close_s or close_s in ("--", "0", "0.00"):
                continue
            try:
                close      = float(close_s)
                change_amt = _parse_tw_change(d.get("Change", "0"))
                prev       = close - change_amt
                change_pct = round(change_amt / prev * 100, 2) if prev else 0.0
                vol        = float((d.get("TradeVolume") or "0").replace(",", ""))
                tickers[code] = {
                    "symbol": code, "display": code,
                    "name": (d.get("Name") or code).strip(),
                    "price": close, "change_pct": change_pct,
                    "change_amt": round(change_amt, 2), "volume": vol,
                }
            except (ValueError, TypeError):
                continue
    except Exception as e:
        _log.warning(f"[tw_tickers] TWSE opendata error: {e}")

    # ── 2. TPEX 上櫃全量 ──────────────────────────────────────
    try:
        resp = requests.get(TPEX_DAY_ALL_URL, timeout=15)
        resp.raise_for_status()
        for d in resp.json():
            code = (d.get("SecuritiesCompanyCode") or "").strip()
            if not (code and code.isdigit() and len(code) == 4):
                continue
            close_s = (d.get("Close") or "").replace(",", "").strip()
            if not close_s or close_s in ("--", "0", "0.00"):
                continue
            if code in tickers:
                continue  # TSE 優先
            try:
                close      = float(close_s)
                change_amt = _parse_tw_change(d.get("Change", "0"))
                prev       = close - change_amt
                change_pct = round(change_amt / prev * 100, 2) if prev else 0.0
                vol        = float((d.get("Volume") or "0").replace(",", ""))
                tickers[code] = {
                    "symbol": code, "display": code,
                    "name": (d.get("CompanyName") or code).strip(),
                    "price": close, "change_pct": change_pct,
                    "change_amt": round(change_amt, 2), "volume": vol,
                }
            except (ValueError, TypeError):
                continue
    except Exception as e:
        _log.warning(f"[tw_tickers] TPEX opendata error: {e}")

    # ── 3. MIS 即時補強（盤中），或 opendata 失敗時的備援 ────────
    ex_ch = "|".join(f"{ex}_{sym}.tw" for sym, ex in TW_POPULAR)
    try:
        resp = requests.get(
            TWSE_MIS_URL,
            params={"ex_ch": ex_ch, "json": "1", "delay": "0"},
            headers=TWSE_MIS_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        for d in resp.json().get("msgArray", []):
            sym = d.get("c", "")
            if not sym:
                continue
            z = d.get("z", "-")
            y = d.get("y", "-")
            if not z or z == "-":
                z = y
            if not y or y == "-":
                continue
            try:
                price      = float(z)
                prev       = float(y)
                change_amt = round(price - prev, 2)
                change_pct = round((change_amt / prev * 100) if prev else 0.0, 2)
                raw_vol    = d.get("v", "0") or "0"
                volume     = float(raw_vol.replace(",", "")) * 1000
                name       = d.get("n", "") or TW_NAME_MAP.get(sym, sym)
                tickers[sym] = {
                    "symbol": sym, "display": sym, "name": name,
                    "price": price, "change_pct": change_pct,
                    "change_amt": change_amt, "volume": volume,
                }
            except (ValueError, TypeError):
                continue
    except Exception as e:
        _log.warning(f"[tw_tickers] MIS error: {e}")

    result = [t for t in tickers.values() if t["price"] > 0]
    result.sort(key=lambda x: x["change_pct"], reverse=True)
    return result


def fetch_tw_latest_bar_yf(symbol: str):
    """用 yfinance 抓最新一根日線（盤中即更新，盤後取當日收盤）"""
    try:
        import yfinance as yf
        for suffix in (".TW", ".TWO"):
            raw = yf.Ticker(f"{symbol}{suffix}").history(
                period="5d", interval="1d", auto_adjust=True
            )
            if raw.empty:
                continue
            last = raw.iloc[-1]
            ts = pd.Timestamp(raw.index[-1])
            if ts.tzinfo is not None:
                ts = ts.tz_convert("Asia/Taipei").tz_localize(None)
            else:
                # naive timestamp 假設已是台北時間（yfinance 日線通常如此）
                pass
            ts = ts.normalize()  # 取日期部分（00:00:00）
            return {
                "time":   ts,
                "open":   float(last["Open"]),
                "high":   float(last["High"]),
                "low":    float(last["Low"]),
                "close":  float(last["Close"]),
                "volume": float(last["Volume"]),
            }
    except Exception:
        pass
    return None


def fetch_tw_realtime(symbol: str):
    """
    TWSE MIS 即時報價（盤中）。
    先試上市(tse)，再試上櫃(otc)。
    z（最新成交）盤中偶爾為 '-'，改用委買最佳價補位；盤後或無委買才回 None。
    """
    def _f(s, fallback="0"):
        try:
            return float(str(s or fallback).replace(",", ""))
        except Exception:
            return float(str(fallback).replace(",", ""))

    for exchange in ("tse", "otc"):
        try:
            resp = requests.get(
                TWSE_MIS_URL,
                params={"ex_ch": f"{exchange}_{symbol}.tw", "json": "1", "delay": "0"},
                headers=TWSE_MIS_HEADERS,
                timeout=6,
            )
            resp.raise_for_status()
            arr = resp.json().get("msgArray", [])
            if not arr:
                continue
            d = arr[0]
            date_str = d.get("d", "")
            if not date_str:
                continue
            # z = 最新成交價；盤中可能瞬間為 '-'，改用委買最佳價補位
            z = (d.get("z") or "-").strip()
            if z == "-":
                b_raw = (d.get("b") or "").split("_")[0].strip()
                if b_raw and b_raw not in ("-", ""):
                    z = b_raw  # 委買最佳價作為近似現價
                else:
                    continue   # 真的沒有即時報價，試下一個交易所
            time_str = d.get("t", "09:00:00")
            ts = datetime.strptime(f"{date_str} {time_str}", "%Y%m%d %H:%M:%S")
            volume = _f(d.get("v"), "0") * 1000  # 張 → 股
            return {
                "time":   ts,
                "open":   _f(d.get("o"), z),
                "high":   _f(d.get("h"), z),
                "low":    _f(d.get("l"), z),
                "close":  _f(z),
                "volume": volume,
            }
        except Exception:
            continue
    return None


def search_tw_stock(keyword: str, api_token: str = "") -> list[dict]:
    """搜尋台股代號"""
    params = {
        "dataset": "TaiwanStockInfo",
        "token": api_token,
    }
    resp = requests.get(FINMIND_API_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    records = data.get("data", [])

    keyword = keyword.lower()
    results = [
        {"symbol": r["stock_id"], "name": r.get("stock_name", "")}
        for r in records
        if keyword in r.get("stock_id", "").lower()
        or keyword in r.get("stock_name", "").lower()
    ]
    return results[:20]
