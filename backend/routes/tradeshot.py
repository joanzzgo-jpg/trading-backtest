"""交易截圖辨識（/api/parse_trade_shot）

使用者把交易所的「交易/訂單/持倉歷史」截圖丟進來 → Claude 視覺模型讀出每筆進出場 →
回結構化 JSON → 前端把它們畫在主圖上（進場/出場箭頭＋連線＋盈虧）。

★為什麼走這條路：Pionex 官方 API **完全沒有合約(PERP)的私有端點**（文件明寫訂單只支援
  「SPOT 非策略單」）→ 合約進出場拿不到。CSV 匯出或截圖是唯二可行來源，截圖對使用者最省事。

設計要點：
・**結構化輸出**（output_config.format + json_schema）：格式由 schema 保證，不靠模型自律，
  也不必寫脆弱的文字解析。
・欄位刻意允許兩種列型：`fill`（單一成交事件）與 `position`（一列同時有開倉/平倉，
  交易所的「歷史持倉」多半長這樣）→ 兩種截圖都吃得下。
・**不確定就標 null + 記進 warnings**，不要讓模型腦補價格/時間（腦補的數字畫到圖上比沒有更糟）。
・不落地、不記錄圖片內容：圖片只在這次請求的記憶體裡，回應也不含原圖。
"""
import base64
import json
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api")

# 單張圖上限 5MB（base64 後約 6.7MB）、一次最多 8 張：避免整包請求過大被擋
_MAX_IMG_BYTES = 5 * 1024 * 1024
_MAX_IMAGES = 8
_ALLOWED_MEDIA = {"image/png", "image/jpeg", "image/webp", "image/gif"}

_SCHEMA = {
    "type": "object",
    "properties": {
        "records": {
            "type": "array",
            "description": "每一筆交易紀錄，依畫面由上到下的順序",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["fill", "position"],
                        "description": "fill=單一成交事件(只有一個時間/價格)；position=同一列同時有開倉與平倉",
                    },
                    "symbol": {"type": "string", "description": "標的，如 BTCUSDT/BTC_USDT_PERP；讀不到填空字串"},
                    "side": {
                        "type": "string",
                        "enum": ["long", "short", "buy", "sell", "unknown"],
                        "description": "方向。做多/買入=long/buy，做空/賣出=short/sell",
                    },
                    "entry_time": {"type": ["string", "null"], "description": "開倉/成交時間，畫面上的原字串照抄(勿改格式、勿補年份)"},
                    "entry_price": {"type": ["number", "null"]},
                    "exit_time": {"type": ["string", "null"], "description": "平倉時間；kind=fill 時為 null"},
                    "exit_price": {"type": ["number", "null"]},
                    "qty": {"type": ["number", "null"], "description": "數量/委託量(幣的數量，不是金額)"},
                    "pnl": {"type": ["number", "null"], "description": "已實現盈虧，虧損為負數"},
                    "fee": {"type": ["number", "null"]},
                    "leverage": {"type": ["number", "null"]},
                    "note": {"type": "string", "description": "其他有用資訊(如 平倉方式/訂單類型)；沒有填空字串"},
                },
                "required": ["kind", "symbol", "side", "entry_time", "entry_price",
                             "exit_time", "exit_price", "qty", "pnl", "fee", "leverage", "note"],
                "additionalProperties": False,
            },
        },
        "exchange": {"type": "string", "description": "從介面外觀判斷的交易所名稱，不確定填空字串"},
        "time_format": {"type": "string", "description": "時間欄位的格式說明(如 'YYYY-MM-DD HH:mm:ss'、'MM-DD HH:mm')與是否缺年份"},
        "warnings": {
            "type": "array",
            "items": {"type": "string"},
            "description": "任何看不清楚/被遮住/需要使用者確認的地方",
        },
    },
    "required": ["records", "exchange", "time_format", "warnings"],
    "additionalProperties": False,
}

_SYSTEM = """你是交易紀錄辨識工具。使用者提供交易所的交易/訂單/持倉歷史截圖，你要把每一列讀成結構化資料。

規則：
1. **只讀畫面上真的看得到的東西**。看不清楚、被遮住、被截斷的欄位一律填 null，並在 warnings 說明是哪一列的哪個欄位。
   絕對不要推測或補齊數字——錯的價格/時間會被畫到 K 線圖上誤導使用者，比沒有資料更糟。
2. 時間欄位**照抄畫面上的原始字串**，不要改成別的格式、不要自行補年份。年份缺漏請在 time_format 說明。
3. 數字去掉千分位逗號與貨幣符號；虧損的盈虧要是負數。
4. 一列同時有「開倉價」與「平倉價」→ kind="position"；只有單一成交時間與價格 → kind="fill"。
5. 表頭列、合計列、分頁按鈕不是交易紀錄，不要收進 records。
6. 同一張圖有多個標的很正常，各列照自己的標的填。"""


class ShotReq(BaseModel):
    images: list[str]          # base64（可含 data:image/png;base64, 前綴）
    hint: str = ""             # 使用者補充（例：這是 Pionex 合約歷史、時區 UTC+8）
    model: str = ""            # 保留：預設用 claude-opus-5


def _decode(img: str) -> tuple[str, str]:
    """回傳 (media_type, 純 base64)。順手驗大小與型別，壞的直接擋掉不送給模型。"""
    media = "image/png"
    b64 = img
    if img.startswith("data:"):
        head, _, rest = img.partition(",")
        b64 = rest
        media = head[5:].split(";")[0] or media
    if media not in _ALLOWED_MEDIA:
        raise HTTPException(400, f"不支援的圖片格式：{media}")
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        raise HTTPException(400, "圖片不是合法的 base64")
    if len(raw) > _MAX_IMG_BYTES:
        raise HTTPException(400, f"圖片太大（{len(raw)//1024}KB），請壓到 5MB 以內")
    if not raw:
        raise HTTPException(400, "空圖片")
    return media, b64


@router.post("/parse_trade_shot")
def parse_trade_shot(req: ShotReq):
    """截圖 → 結構化交易紀錄。回 {records, exchange, time_format, warnings, usage}。"""
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise HTTPException(503, "伺服器未設定 ANTHROPIC_API_KEY，無法辨識截圖")
    if not req.images:
        raise HTTPException(400, "沒有圖片")
    if len(req.images) > _MAX_IMAGES:
        raise HTTPException(400, f"一次最多 {_MAX_IMAGES} 張")

    content: list = []
    for img in req.images:
        media, b64 = _decode(img)
        content.append({"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}})
    ask = "請把這些截圖裡的每一筆交易紀錄讀成結構化資料。"
    if req.hint.strip():
        ask += f"\n使用者補充：{req.hint.strip()[:500]}"
    content.append({"type": "text", "text": ask})

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model=(req.model or "claude-opus-5"),
            max_tokens=16000,
            system=_SYSTEM,
            messages=[{"role": "user", "content": content}],
            # 結構化輸出：格式由 schema 保證(不必解析自由文字)。
            # effort=medium：OCR 類抽取不需要最高強度，但也別用 low(數字看錯的代價很高)。
            # ⚠ 不要關 thinking：Opus 5 關掉 thinking 有 <thinking> 標籤漏進輸出的已知狀況，
            #    用「開著思考 + 降 effort」控成本才是對的做法。
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": _SCHEMA}},
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"辨識服務錯誤：{type(e).__name__}: {str(e)[:200]}")

    if getattr(msg, "stop_reason", "") == "refusal":
        raise HTTPException(422, "模型拒絕處理這張圖片")
    if msg.stop_reason == "max_tokens":
        raise HTTPException(413, "紀錄太多一次讀不完，請分批截圖")

    text = next((b.text for b in msg.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except Exception:
        raise HTTPException(502, "辨識結果不是合法 JSON")

    u = msg.usage
    data["usage"] = {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens}
    return data
