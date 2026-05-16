"""橘子熊台詞 API — 用 Claude 定時生成博恩 × Jim 程建評混合風格的暗黑交易脫口秀"""
import os, time, threading
from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["bear"])

_FALLBACK = [
    # 博恩風（鋪陳→反轉自嘲，悲劇感）
    "我做價值投資。我的價值——已經貶到剩零點三了。",
    "他們說 K 線會說話。我聽了三年，它一直在罵我。",
    "幣圈的人都很有禮貌，每個人見面都說『早』。因為他們的幣已經 GG 了。",
    "我從不在群組分享訊號。分享了大家一起虧，我會內疚。",
    "我跟女友說我會用交易養她。現在是她在養我。我們關係很 healthy。",
    "他們說交易心態最重要。我心態超好——已經放棄了。",
    # Jim 程建評風（理性分析→揭露荒謬）
    "我研究 K 線三年，學到一件事：圖是過去的、未來是隨機的、虧損是確定的。",
    "技術分析有 200 種指標，這 200 種指標互相矛盾。我的策略是全部一起看，然後當機。",
    "你知道為什麼叫『散戶』嗎？因為我們散得很均勻——每支都套牢一點。",
    "我發現一件事：我覺得會漲它就跌。所以我改成覺得會跌。它還是跌。所以是我的問題。",
    "止盈設 5%、止損設 -10%。這樣贏只贏一點點、輸卻輸很多。我覺得這叫公平。",
    "我把退休金 all in 了。我說的退休金，是指退休之前不可能拿回來的那一筆。",
]

_SYSTEM_PROMPT = """你是台灣脫口秀演員曾博恩 × Jim 程建評的混合創作 AI。
請寫 10 條跟交易、投資、幣圈有關的短笑話台詞，每條挑一位的風格寫，兩位輪流穿插。

博恩風格特點：
- 先鋪陳一個合理預期，結尾用一句話反轉或自嘲
- 暗黑、悲劇感、敢碰禁忌話題（負債、感情、家庭）
- 句子簡短犀利，最後一句是 punchline
- 例：「我做價值投資。我的價值——已經貶到剩零點三了。」

Jim 程建評風格特點：
- 用理性分析的口吻講荒謬事，反差製造笑點
- 喜歡用「你知道嗎」「我發現」「我研究了」開頭
- 邏輯推導 → 結論揭露自己的愚蠢或荒謬
- 帶點工程師/書呆子人設，喜歡用數字和科學詞
- 例：「技術分析有 200 種指標，這 200 種指標互相矛盾。我的策略是全部一起看，然後當機。」

共同要求：
- 用繁體中文、台灣口語
- 每條 1~3 句、不超過 45 字
- 真的要好笑，不要平庸或老套
- 避免「韭菜」「割肉」這種已經氾濫的詞
只輸出台詞，每行一條，不要編號、不要解釋、不要標註風格。"""

_cache: dict = {"lines": _FALLBACK, "ts": 0.0}
_lock = threading.Lock()
_TTL = 20 * 60  # 20 分鐘換一批


def _generate() -> list[str]:
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        return []
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            messages=[{"role": "user", "content": "請生成 10 條台詞"}],
            system=_SYSTEM_PROMPT,
        )
        raw = msg.content[0].text.strip()
        lines = [l.strip() for l in raw.splitlines() if l.strip()]
        return lines if len(lines) >= 5 else []
    except Exception:
        return []


def _refresh():
    lines = _generate()
    if lines:
        with _lock:
            _cache["lines"] = lines
            _cache["ts"] = time.time()


def _bg_worker():
    while True:
        time.sleep(_TTL)
        _refresh()


# 啟動背景更新執行緒
_t = threading.Thread(target=_bg_worker, daemon=True)
_t.start()


@router.get("/bear-lines")
def get_bear_lines():
    # 首次或快取過期就即時生成一次（non-blocking fallback）
    with _lock:
        age = time.time() - _cache["ts"]
        lines = list(_cache["lines"])

    if age > _TTL:
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            future = ex.submit(_generate)
            try:
                new = future.result(timeout=8)
                if new:
                    with _lock:
                        _cache["lines"] = new
                        _cache["ts"] = time.time()
                    lines = new
            except Exception:
                pass

    return {"lines": lines}
