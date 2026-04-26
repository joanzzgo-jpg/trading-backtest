"""
加密貨幣資料抓取 - 透過 ccxt 支援 Pionex 及其他交易所
"""
import pandas as pd
import ccxt
from datetime import datetime


SUPPORTED_EXCHANGES = {
    "pionex": ccxt.binance,   # Pionex 使用 Binance 流動性，行情一致
    "binance": ccxt.binance,
    "bybit": ccxt.bybit,
    "okx": ccxt.okx,
}

TIMEFRAME_MAP = {
    "1M": "1M",
    "1w": "1w",
    "1d": "1d",
    "4h": "4h",
    "1h": "1h",
    "15m": "15m",
}


def get_exchange(exchange_id: str, api_key: str = "", api_secret: str = ""):
    cls = SUPPORTED_EXCHANGES.get(exchange_id.lower())
    if not cls:
        raise ValueError(f"不支援的交易所: {exchange_id}，支援: {list(SUPPORTED_EXCHANGES.keys())}")

    config = {"enableRateLimit": True}
    if api_key:
        config["apiKey"] = api_key
    if api_secret:
        config["secret"] = api_secret

    return cls(config)


def fetch_crypto_ohlcv(
    symbol: str,
    timeframe: str = "1d",
    start: str = None,
    end: str = None,
    exchange_id: str = "pionex",
    limit: int = 1000,
    api_key: str = "",
    api_secret: str = "",
) -> pd.DataFrame:
    """
    抓取加密貨幣 OHLCV
    symbol: 例如 "BTC/USDT"
    timeframe: "1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"
    start/end: "YYYY-MM-DD"
    """
    exchange = get_exchange(exchange_id, api_key, api_secret)

    # 只取最新 N 根（用於即時更新）
    if start is None and end is None:
        ohlcv = exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
        df = pd.DataFrame(ohlcv, columns=["time","open","high","low","close","volume"])
        df["time"] = pd.to_datetime(df["time"], unit="ms")
        return df.sort_values("time").reset_index(drop=True)

    since = None
    if start:
        since = exchange.parse8601(f"{start}T00:00:00Z")

    all_ohlcv = []
    while True:
        ohlcv = exchange.fetch_ohlcv(symbol, timeframe, since=since, limit=limit)
        if not ohlcv:
            break
        all_ohlcv.extend(ohlcv)

        # 結束條件
        last_ts = ohlcv[-1][0]
        if end:
            end_ts = exchange.parse8601(f"{end}T23:59:59Z")
            if last_ts >= end_ts:
                break
        if len(ohlcv) < limit:
            break

        since = last_ts + 1

    df = pd.DataFrame(all_ohlcv, columns=["time", "open", "high", "low", "close", "volume"])
    df["time"] = pd.to_datetime(df["time"], unit="ms")

    if end:
        end_dt = pd.to_datetime(end)
        df = df[df["time"] <= end_dt]

    df = df.drop_duplicates("time").sort_values("time").reset_index(drop=True)
    return df


def fetch_crypto_markets(exchange_id: str = "pionex") -> list[dict]:
    """取得交易所所有交易對"""
    exchange = get_exchange(exchange_id)
    markets = exchange.load_markets()
    return [
        {"symbol": s, "base": m["base"], "quote": m["quote"]}
        for s, m in markets.items()
        if m.get("active") and m.get("spot")
    ]
