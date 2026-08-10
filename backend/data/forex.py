# -*- coding: utf-8 -*-
"""外匯（fx）資料源 —— 掛在**美股那條 yfinance 管線**上，只差代號轉換。

為什麼這樣接（2026-08-11）
    港股早就是這個模式：`fetch_us_stock` 那條路已經處理完所有踩過的坑 ——
      ・Yahoo 不支援 2h → 抓 1h 自己併（RESAMPLE_N）
      ・4h 也改由 1h 併（Yahoo 原生 4h 只能回溯 60 天，1h 有 730 天）
      ・各時框的可回溯天數上限（MAX_DAYS）與「嚴格小於」邊界的 buffer
      ・時區、盤別切日
    外匯自己再寫一套只會把這些坑重踩一遍 → 直接複用，外匯只負責「代號怎麼翻譯」。

代號規則
    前端/使用者看到的是 `EUR/USD`（與加密的 `BTC/USDT` 一致）；
    yfinance 要的是 `EURUSD=X`（黃金/白銀例外，見 _SPECIAL）。

⚠ 外匯是 24/5：週一亞洲盤開到週六凌晨，週末休市。日線在 Yahoo 是以 UTC 切日。
⚠ 沒有成交量：Yahoo 的 FX 資料 volume 恆為 0 → 前端的量圖會是空的，這是資料源本身的限制，
  不是 bug（別為了「讓量圖有東西」去塞假資料）。
"""
from typing import List

# 主要貨幣對 + 常見交叉盤 + 貴金屬（美元計價）。
# 順序＝行情列預設排序（先七大主要、再交叉、最後貴金屬）。
MAJORS = ["EUR/USD", "USD/JPY", "GBP/USD", "USD/CHF", "AUD/USD", "USD/CAD", "NZD/USD"]
CROSSES = ["EUR/JPY", "GBP/JPY", "EUR/GBP", "AUD/JPY", "EUR/AUD", "CHF/JPY",
           "CAD/JPY", "NZD/JPY", "EUR/CHF", "GBP/CHF", "AUD/NZD", "EUR/CAD"]
METALS = ["XAU/USD", "XAG/USD"]
FX_PAIRS: List[str] = MAJORS + CROSSES + METALS

# Yahoo 對貴金屬不用 `=X` 那套（XAUUSD=X 查無資料），只能用期貨代號 —— 但期貨在 Yahoo
# **延遲 10 分鐘**，且期貨對現貨有升水。→ 貴金屬改走幣安的代幣化商品（見 CRYPTO_BACKED）。
# 這裡保留期貨代號當**後備**：幣安那條掛掉時仍有東西可看。
_SPECIAL = {
    "XAU/USD": "GC=F",   # 黃金（COMEX 期貨；僅後備）
    "XAG/USD": "SI=F",   # 白銀（僅後備）
}

# ★ 2026-08-11 貴金屬改走幣安（使用者提議）。實測對照：
#     Yahoo GC=F(期貨)  4412.70　延遲 **10 分**
#     幣安 PAXGUSDT     4349.99　延遲 **0.6 分**、有成交量
#   那 −1.4% 不是代幣折價 —— GC=F 是期貨、對現貨本來就有升水（contango），
#   PAXG 追蹤的是**現貨**金價，反而比期貨更接近真實 XAU/USD。
#   好處：即時（0.6 分）、有真實成交量、24/7、而且走的是本專案已經驗證過的加密管線。
#   ⚠ 差異要知道：以 USDT 計價（≈USD，偏差通常 <0.1%）、是代幣/永續商品而非 OTC 現貨，
#     可能有溢價/折價；且加密 24/7 交易，週末仍有 K 棒（現貨黃金週末休市）。
CRYPTO_BACKED = {
    "XAU/USD": "PAXG/USDT.P",   # PAX Gold 永續：1 代幣 = 1 金衡盎司
    "XAG/USD": "XAG/USDT.P",    # 幣安白銀永續
}


def crypto_symbol(symbol: str):
    """這個外匯代號要不要改走幣安？回傳加密代號，或 None（走 yfinance）。"""
    return CRYPTO_BACKED.get((symbol or "").strip().upper())

_PAIR_SET = {p.upper() for p in FX_PAIRS}


def is_fx(symbol: str) -> bool:
    """這個代號是不是外匯（用於市場自動判斷／防呆）。"""
    return (symbol or "").strip().upper() in _PAIR_SET


def to_yf(symbol: str) -> str:
    """`EUR/USD` → `EURUSD=X`；貴金屬走 _SPECIAL 對照。

    ⚠ 已經是 yfinance 格式（含 `=X` 或 `=F`）就原樣放行 —— 呼叫端可能已經轉過，
      再轉一次會變成 `EURUSD=X=X` 而查無資料。
    """
    s = (symbol or "").strip().upper()
    if not s:
        return s
    if s.endswith("=X") or s.endswith("=F"):
        return s
    if s in _SPECIAL:
        return _SPECIAL[s]
    return s.replace("/", "").replace("-", "") + "=X"


def display(symbol: str) -> str:
    """yfinance 代號 → 顯示用（`EURUSD=X` → `EUR/USD`）。找不到就原樣回。"""
    s = (symbol or "").strip().upper()
    for k, v in _SPECIAL.items():
        if v == s:
            return k
    if s.endswith("=X"):
        b = s[:-2]
        if len(b) == 6:
            return f"{b[:3]}/{b[3:]}"
    return symbol


def search(keyword: str, limit: int = 30) -> list:
    """外匯代號搜尋（清單是固定的 21 個，純本機過濾、不打網路）。"""
    k = (keyword or "").strip().upper().replace("/", "")
    out = []
    for p in FX_PAIRS:
        if not k or k in p.replace("/", ""):
            out.append({"symbol": p, "name": p, "market": "fx"})
        if len(out) >= limit:
            break
    return out
