"""橘子熊台詞 API — 用 Claude 定時生成博恩風格的暗黑交易脫口秀"""
import os, time, threading
from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["bear"])

_FALLBACK = [
    "我是長期投資者。意思是我虧太多，不敢賣。",
    "他們說分散風險，別把雞蛋放同個籃子。我放了十個籃子。每個都摔了。",
    "專家說這是最後一次抄底機會。他說了九次了。",
    "漲了，後悔沒買多。跌了，後悔沒賣掉。剛好的時候，我在睡覺。",
    "做交易要控制情緒。我情緒控制得很好——已經麻木了。",
    "有人說行情不好要等待。我等了三年。行情更不好了。但我等待的技術突飛猛進。",
    "我的止損紀律非常嚴格。我從來不設止損，這樣就不會被止損了。",
    "他們說跟著趨勢走。我跟了。趨勢突然轉向。只有我還在走。",
    "虧損讓人成長。照這個速度，我快成佛了。",
    "別人恐懼我貪婪，別人貪婪我恐懼。結果我每次都在最錯的時候做對的事。",
]

_SYSTEM_PROMPT = """你是台灣脫口秀演員曾博恩的創作 AI。
請用博恩的風格寫 10 條跟交易、投資、幣圈有關的短笑話台詞。
博恩風格特點：
- 先鋪陳一個合理預期，結尾用一句話反轉或自嘲
- 句子簡短有力，最後一句是 punchline
- 暗黑、自嘲、反諷，帶點悲劇感但又讓人笑出來
- 用繁體中文，台灣口語
- 每條台詞 1~3 句，不超過 40 個字
只輸出台詞，每行一條，不要編號、不要解釋。"""

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
