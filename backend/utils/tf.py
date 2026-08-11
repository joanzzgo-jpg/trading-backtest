# -*- coding: utf-8 -*-
"""時框白名單 —— 讓「不認得的時框」當場報錯，而不是靜默退回日線。

為什麼要有這個模組（2026-08-11）
    CLAUDE.md 記著一個**重複發生三次**的坑：「時框對照表漏列 → `.get(tf, 預設)`
    靜默退回日線」，台股/美股/港股各中過一次。症狀極惡毒：切過去圖上**有東西、不報錯**，
    只是那根本是日線。

    實測從 API 邊界打進來也一樣：
        POST /api/ohlcv  timeframe="99z" → **200 OK，回 500 根日線**
        POST /api/ohlcv  timeframe="3h"  → **200 OK，回 500 根日線**
    也就是說，只要有人在前端加了一個新時框、而後端某張對照表漏列，
    使用者看到的就是「標著 3H 的日線」——沒有任何一層會出聲。

    ★ 這裡選擇**結構性修法**：在 API 邊界白名單擋掉，不認得就 400。
      這樣「對照表漏列」會在導入的當下就變成明確錯誤，而不是再多一條要記得跑的檢查清單。
      （守門員 `scripts/check_tf_spacing.py` 驗的是「回來的資料間隔對不對」，
        兩者互補：白名單擋不認得的，守門員擋「認得但對照錯」的。）

⚠ 這份清單必須與前端 `frontend/static/js/config.js` 的 `TF_LABELS` 一致。
  守門員會直接讀那個檔比對，加了一邊沒加另一邊會被抓到 —— 不必靠人記得。
"""
from fastapi import HTTPException

# 與 frontend/static/js/config.js 的 TF_LABELS 同一組（8h/2h/30m 已於 2026-08 移除）
VALID_TF = ("1M", "1w", "1d", "4h", "1h", "15m", "5m", "1m")
_VALID_SET = frozenset(VALID_TF)

# K 棒單次請求根數上限。前端實際只用 320/500（更深的歷史走 start/end 範圍模式，limit=0），
# 這裡留 10 倍餘裕。⚠ 沒有上限的話任何 client 都能要求任意大的回應：
# 實測 limit=999999 會回 **60079 根**、1.7 秒 —— 線上 workers=2、記憶體有限，不該讓外部決定這個。
MAX_LIMIT = 5000


def check_tf(tf: str) -> str:
    """驗時框，不認得就 400。回傳正規化後的時框。"""
    t = (tf or "").strip()
    if t not in _VALID_SET:
        raise HTTPException(status_code=400,
                            detail=f"不支援的時間框架「{tf}」；可用：{', '.join(VALID_TF)}")
    return t


def clamp_limit(limit: int) -> int:
    """把正的 limit 夾在上限內。
    ⚠ limit<=0 是**內部約定的「無上限」**（背景補載/重播預載走 start/end 範圍模式），
      不可以在這裡改動，否則會把那條路弄壞（見 routes/data.py `_ohlcv_cache_key`）。"""
    if limit and limit > MAX_LIMIT:
        return MAX_LIMIT
    return limit
