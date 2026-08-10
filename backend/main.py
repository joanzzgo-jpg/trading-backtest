"""
FastAPI 後端主程式 - 回測系統 (模塊化版本)
"""
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response, PlainTextResponse
import os, sys, time, subprocess, threading
from collections import deque
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

sys.path.insert(0, os.path.dirname(__file__))

from routes.data import router as data_router
from routes.search import router as search_router
from routes.bear import router as bear_router
from routes.weather import router as weather_router
from routes.ai_research import router as ai_research_router
from routes.account import router as account_router
from routes.notify import router as notify_router
from routes.trade import router as trade_router
from routes.lunar import router as lunar_router
from routes.footprint import router as footprint_router
from routes.orderbook import router as orderbook_router
from routes.econ import router as econ_router
from data.crypto import _fetch_pionex_symbols, _fetch_pionex_perp_symbols

def _build_js_bundle():
    """啟動時自動打包前端 JS bundle（取代 start.sh，Railway 部署需要）。
    若任一來源檔比 bundle 新就重建；否則沿用既有 bundle 不動。"""
    try:
        from pathlib import Path
        js = Path(os.path.dirname(__file__)) / ".." / "frontend" / "static" / "js"
        js = js.resolve()
        # ⚠ draw / trade 已移出 bundle → 改由 main.js 於首屏後閒置時動態載入（首屏 JS 省 ~42%）。
        #   兩者對 core 的耦合皆經 typeof/window guard，且各自在載入時自我初始化（見 draw.js/trade.js 末段）。
        names = ["config","utils","charts","colors","ticker","winrate","footprint","orderbook","dom","htffvg","econ","tradeparse","tradeui","render","realtime","replay","ui","ai_research","account","chartorder","xiaoa","lunar","announce","multichart","hotkeys","main"]
        srcs = [js / f"{n}.js" for n in names]
        bundle = js / "app.bundle.js"
        srcs_exist = [p for p in srcs if p.exists()]
        if not srcs_exist:
            return
        newest = max(p.stat().st_mtime for p in srcs_exist)
        if bundle.exists() and bundle.stat().st_mtime >= newest:
            return  # 已是最新
        content = "\n".join(p.read_text(encoding="utf-8") for p in srcs_exist)
        try:
            import rjsmin
            content = rjsmin.jsmin(content)
        except ImportError:
            pass
        bundle.write_text(content, encoding="utf-8")
        print(f"  ✓ app.bundle.js rebuilt ({len(content)//1024} KB)")
    except Exception as e:
        print(f"  ⚠ bundle build failed: {e}")

_build_js_bundle()


def _build_css_bundle():
    """啟動時把 style.css 壓縮成 style.min.css（render-blocking CSS：gzip 69KB→34KB、少一半解析量）。
    來源比產物新才重建；rcssmin 缺席時退回原樣複製 → style.min.css 恆存在（不會漏 CSS 讓頁面裸奔）。"""
    try:
        from pathlib import Path
        css = (Path(os.path.dirname(__file__)) / ".." / "frontend" / "static" / "css").resolve()
        src = css / "style.css"; out = css / "style.min.css"
        if not src.exists():
            return
        if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
            return
        content = src.read_text(encoding="utf-8")
        try:
            import rcssmin
            content = rcssmin.cssmin(content)
        except Exception:
            pass   # 沒有 rcssmin（如本機未裝）→ 服務原樣，仍正確、只是沒壓縮
        out.write_text(content, encoding="utf-8")
        print(f"  ✓ style.min.css rebuilt ({len(content)//1024} KB)")
    except Exception as e:
        print(f"  ⚠ css build failed: {e}")

_build_css_bundle()


def _build_fx_min():
    """把動態載入(非首屏 bundle)的 JS 壓縮成 *.min.js：
    effects/weather/draw/trade + signal_info/notify（後兩支 2026-08-04 移出 bundle，見下）。
    這些原本原始碼直送(只靠 gzip)；minify 後閒置載入更輕(weather.js ~207KB 最有感)。
    來源比產物新才重建；缺 rjsmin 退回原樣複製 → 產物恆存在(不會讓 _loadFx 404 而繪圖/天氣/交易失效)。"""
    try:
        from pathlib import Path
        js = (Path(os.path.dirname(__file__)) / ".." / "frontend" / "static" / "js").resolve()
        try:
            import rjsmin
            _min = rjsmin.jsmin
        except Exception:
            _min = lambda s: s   # 沒 rjsmin → 原樣複製，仍正確、只是沒壓縮
        for name in ("effects", "weather", "draw", "trade", "signal_info", "notify"):
            src = js / f"{name}.js"; out = js / f"{name}.min.js"
            if not src.exists():
                continue
            if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
                continue
            out.write_text(_min(src.read_text(encoding="utf-8")), encoding="utf-8")
        print("  ✓ fx *.min.js rebuilt (effects/weather/draw/trade)")
    except Exception as e:
        print(f"  ⚠ fx min build failed: {e}")

_build_fx_min()

# 序列化：FastAPI 0.139+ 內建 Pydantic 直出 JSON bytes(快)，不再需要 default_response_class=ORJSON
# (會觸發 FastAPIDeprecationWarning)。勝率 1MB+ 大回應仍走 routes/data.py `_wr_resp` 直接回
# ORJSONResponse「實例」跳過整棵編碼樹 —— 那條路不在棄用範圍、保留。
app = FastAPI(title="回測系統")

# ── GZip 壓縮（JS 166KB→35KB，CSS 38KB→8KB）──────────────────
# 9→6：勝率 1.2MB 回應實測 78ms→23ms、體積僅 +3%(182→188KB)。
# 6→4（2026-07-30）：/api/ohlcv 改 orjson 後，壓縮變成回應時間的大頭（26497 根：總 98ms 中 87ms 是壓縮）。
#   實測 4.9MB 原始 payload：L4 43ms/1353KB vs L6 86ms/1296KB → 時間減半、體積僅 +4.4%。
#   算上傳輸時間的總耗時：20Mbps 598 vs 617ms、50Mbps 266 vs 298ms、200Mbps 100 vs 139ms(L4 全勝)；
#   只有 5Mbps 以下 L6 略優(2210 vs 2260ms、差 2%)。→ 取 L4。
#   ★這是全站中介層：每個回應的壓縮 CPU 減半 → Railway 共用 CPU 下同時也少一半 GIL 佔用。
app.add_middleware(GZipMiddleware, minimum_size=500, compresslevel=4)

# ── CSP 內容安全政策字串（CSP_OFF=1 → 停用；緊急關閉用）──────────────────
_CSP = "" if (os.getenv("CSP_OFF") or "").strip().lower() in ("1", "true", "on", "yes") else (
    "default-src 'self'; "
    # 2026-07-13 CDN 白名單全移除(unpkg/googleapis/gstatic)：庫與字型早已全部自架同源,
    # 留著=供應鏈風險(若有XSS可從unpkg載任意腳本)。如再引入外部庫,一律放 /static/vendor/。
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "font-src 'self' data:; "
    "img-src 'self' data: blob:; "
    "connect-src 'self'; "
    "worker-src 'self'; "
    "manifest-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'self'; "
    "object-src 'none'"
)

# ── 靜態檔案長期快取（?v=hash 已保證更新時 URL 改變）＋ 安全標頭 ───────────
class StaticCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.startswith("/static/"):
            # PWA manifest 不可永久快取：否則 Chrome 讀到舊 manifest（display_override/
            # 圖示/主題色更新不到 → WCO 等模式裝不起來）。改為每次重新驗證。
            if path == "/static/manifest.json":
                response.headers["Cache-Control"] = "no-cache"
            else:
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        # ── 安全標頭（全站，零風險：不影響同源自身載入的資源）──────────────
        #   X-Content-Type-Options：禁 MIME 嗅探（防把上傳/回應當可執行類型）
        #   X-Frame-Options：禁被他站 iframe 嵌入 → 防點擊劫持（本站直接開，不需被嵌）
        #   Referrer-Policy：跨站只送來源、不送完整路徑（少洩漏）
        #   HSTS：強制 HTTPS（Railway 已 HTTPS）；max-age 保守 180 天，不含 preload/子網域避免誤傷
        h = response.headers
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("X-Frame-Options", "SAMEORIGIN")
        h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        h.setdefault("Strict-Transport-Security", "max-age=15552000")
        # ── CSP：內容安全政策（縱深防禦，主要擋「載入未白名單的外部腳本/連線」＝XSS 注入面）──
        #   白名單＝本站實際用到的外部資源：unpkg(圖表庫CDN)、Google 字型。inline 腳本/事件多
        #   → script/style 需 'unsafe-inline'（仍能擋外部惡意腳本，這是主要注入途徑）。
        #   img/font 放行 data:/blob:（canvas/字型）。frame-ancestors none＝比 X-Frame 更強的禁嵌。
        #   緊急開關：設環境變數 CSP_OFF=1 即停用（萬一擋到某功能可即時關）。
        if _CSP:
            h.setdefault("Content-Security-Policy", _CSP)
        return response

app.add_middleware(StaticCacheMiddleware)

# ── 限流 + 請求大小上限（防 DoS / 灌流 / 交易口令暴力猜）──────────────────────
#   ⚠ Railway 在反向代理後 → 真實用戶 IP 由可信代理附加在 X-Forwarded-For 最右側(非最左,最左可偽造);
#     直接用 request.client 會把所有人看成同一個代理 IP → 誤鎖。故取 XFF 右數第 N 段(見 _client_ip)。
#   三層桶(2026-08-01 由兩層改三層)。原本「一般 /api/ 一律 300/10s」同時錯在兩頭:
#     ① 對輪詢太緊 — 實測單一分頁光是閒置就 21~32 次/10 秒(每秒報價+每秒 latest)。
#        限流是「每 IP」，辦公室/學校/宿舍共用一個出口 IP 時，約 10 個人就會集體撞 429。
#        這類使用者的請求既便宜又幾乎全走快取/差量，本來就不該被當成攻擊。
#     ② 對貴路徑太鬆 — /api/crt_winrate 冷路徑實測 0.53 秒、回應 ~960KB。300 次/10 秒
#        全打不同標的 = 159 CPU 秒/10 秒，機器直接躺平。也就是說舊設定擋不住真正會痛的那種灌流。
#   → 拆成「貴」「便宜」兩桶分開計數(每個請求只計入一桶,數字才是它字面的意思)。
#   額度取自實測尖峰:單分頁用比真人更快的節奏連切 8 標的×2 時框，貴路徑尖峰 6 次/10 秒、
#   便宜路徑 21 次/10 秒 → 貴 90(≈15 個重度使用者同時尖峰)、便宜 1200(≈57 個分頁)。
_RL_WIN       = 10.0                      # 視窗秒數
_RL_MAX_API   = 1200                      # 便宜/輪詢類 /api/：每 IP 每 10 秒(NAT 共用 IP 也夠)
_RL_MAX_HEAVY = 90                        # 貴路徑(見 _RL_HEAVY)：每 IP 每 10 秒
_RL_MAX_TRADE = 20                        # /api/trade/：每 IP 每 10 秒 20 次(口令猜測極慢化)
# 貴路徑=會真的去算/去抓大量資料的端點(非快取命中時單次數百毫秒、回應數百 KB)。
# ⚠ 新增這類端點時要一併加進來，否則它會落到 1200 那桶等於沒防護。
_RL_HEAVY = ("/api/crt_winrate", "/api/ohlcv", "/api/smc_coach", "/api/coach_scan",
             "/api/export_klines", "/api/footprint", "/api/ai_research")
_RL_BUCKETS   = {}                        # ip -> deque[timestamps]（便宜/輪詢）
_RL_BUCKETS_H = {}                        # ip -> deque[timestamps]（貴路徑）
_RL_BUCKETS_T = {}                        # ip -> deque[timestamps]（交易）
_MAX_BODY = 8 * 1024 * 1024               # 8MB 請求上限(帳號快照含繪圖可能較大,設寬;超過=惡意)
# 可信代理層數:真實 client IP 由可信代理(Railway)附加在 X-Forwarded-For 最右側,攻擊者只能偽造左側。
# Railway 單層代理=1;若前面再疊 CDN/代理,依實際層數設 TRUSTED_PROXY_HOPS。
_TRUSTED_PROXY_HOPS = max(1, int((os.getenv("TRUSTED_PROXY_HOPS") or "1").strip() or "1"))

def _client_ip(request: Request) -> str:
    # ⚠ 只取「右數第 N 段」(可信代理附加的)——不可用 split(",")[0](最左),那段是客戶端可任意偽造的,
    #   攻擊者每個請求塞不同假 IP 就能繞過整個限流(含 /api/trade/ 口令暴力防線)。
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if len(parts) >= _TRUSTED_PROXY_HOPS:
            return parts[-_TRUSTED_PROXY_HOPS]        # 右數第 N 段=可信代理紀錄的真實來源,偽造不到
    return request.client.host if request.client else "?"   # 無 XFF 或層數不符 → 直連 socket 對端

def _rl_hit(buckets: dict, ip: str, limit: float, now: float) -> bool:
    """回 True＝超限。順便清窗外舊時戳;桶太多時清空清理(防記憶體長胖)。"""
    dq = buckets.get(ip)
    if dq is None:
        if len(buckets) > 20000:          # IP 桶上限:超過就整批清掉(粗暴但有界,防記憶體無限長)
            buckets.clear()
        dq = deque(); buckets[ip] = dq
    while dq and now - dq[0] > _RL_WIN:
        dq.popleft()
    if len(dq) >= limit:
        return True
    dq.append(now)
    return False

class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # 請求大小上限（有 Content-Length 才擋）
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > _MAX_BODY:
            return PlainTextResponse("payload too large", status_code=413)
        path = request.url.path
        if path.startswith("/api/"):
            ip = _client_ip(request)
            now = time.time()
            if path.startswith("/api/trade/"):
                if _rl_hit(_RL_BUCKETS_T, ip, _RL_MAX_TRADE, now):
                    return PlainTextResponse("too many trade requests", status_code=429, headers={"Retry-After": "10"})
            elif path.startswith(_RL_HEAVY):
                if _rl_hit(_RL_BUCKETS_H, ip, _RL_MAX_HEAVY, now):
                    return PlainTextResponse("rate limit", status_code=429, headers={"Retry-After": "5"})
            elif _rl_hit(_RL_BUCKETS, ip, _RL_MAX_API, now):
                return PlainTextResponse("rate limit", status_code=429, headers={"Retry-After": "5"})
        return await call_next(request)

app.add_middleware(RateLimitMiddleware)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/static", StaticFiles(directory=os.path.join(FRONTEND_DIR, "static")), name="static")

templates = Jinja2Templates(directory=os.path.join(FRONTEND_DIR, "templates"))

try:
    _GIT_VER = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"],
                                       cwd=os.path.dirname(__file__),
                                       stderr=subprocess.DEVNULL).decode().strip()
except Exception:
    _GIT_VER = str(int(time.time()))
_BUNDLE_PATH  = os.path.join(FRONTEND_DIR, "static", "js", "app.bundle.js")
_CSS_PATH     = os.path.join(FRONTEND_DIR, "static", "css", "style.css")
# effects.js / weather.js 由 main.js 動態獨立載入（不在 bundle 內），版號也須隨它們變動，
# 否則只改這兩支時 /static 的 immutable 長快取會讓瀏覽器吃到舊檔。
_EFFECTS_PATH = os.path.join(FRONTEND_DIR, "static", "js", "effects.js")
_WEATHER_PATH = os.path.join(FRONTEND_DIR, "static", "js", "weather.js")
_DRAW_PATH    = os.path.join(FRONTEND_DIR, "static", "js", "draw.js")    # 動態載入（不在 bundle），版號須含它
_TRADE_PATH   = os.path.join(FRONTEND_DIR, "static", "js", "trade.js")   # 同上
_SIGINFO_PATH = os.path.join(FRONTEND_DIR, "static", "js", "signal_info.js")  # 同上（2026-08-04 移出 bundle）
_NOTIFY_PATH  = os.path.join(FRONTEND_DIR, "static", "js", "notify.js")       # 同上
_FONTS_PATH   = os.path.join(FRONTEND_DIR, "static", "vendor", "fonts.css")


def _asset_ver() -> str:
    """資產版號 = git hash + 前端資產最新 mtime（bundle / css / effects / weather / draw / trade 取最新者）。
    每次請求即時算，本地改前端（即使沒重啟服務、沒 commit）也會改版號、破瀏覽器快取。"""
    try:
        m = max(os.path.getmtime(p) for p in (_BUNDLE_PATH, _CSS_PATH, _EFFECTS_PATH, _WEATHER_PATH,
                                              _DRAW_PATH, _TRADE_PATH, _SIGINFO_PATH, _NOTIFY_PATH,
                                              _FONTS_PATH) if os.path.exists(p))
        return f"{_GIT_VER}-{int(m)}"
    except Exception:
        return _GIT_VER


# 報價價格更新的健康狀態（給 /api/_diag_mem 看：凍住是安靜壞掉，沒有這個查不出來）。
#   ts  = 最後一次「成功把新價套進清單」的時間；age 一直長大＝報價正在凍住。
#   src = 那一次的價格來源（binance / bybit / none）。
_TK_PRICE_STAT = {"ts": 0.0, "src": ""}


def _apply_ticker_prices(rows, prices):
            """把最新價套回清單。
            ★ 2026-08-08 改成「正規化比對」而非 symbol 完全相等。
              原因：清單有可能來自 Pionex（Binance 偶發失敗時的 fallback），
              代號是 BTC_USDT_PERP，而價格來源永遠是 Binance 的 BTCUSDT
              → prices.get(t["symbol"]) 永遠 None → **整列價格凍住**，
              要等 15 秒後重抓 24h 才動一下（使用者回報「合約行情跳動有問題」，
              實測 30 秒內報價完全不變、主圖卻一直在跳）。
              正規化後即使清單是 Pionex 格式，價格照樣每秒更新。
            ⚠ 只影響「比對鍵」，不動清單內容與排序。"""
            def _norm(x):
                x = (x or "").upper().replace("_", "").replace("-", "")
                return x[:-4] if x.endswith("PERP") else x
            pm = prices
            if rows and prices and rows[0].get("symbol") not in prices:
                pm = {_norm(k): v for k, v in prices.items()}   # 只在對不上時才重建索引
            for t in rows:
                p = pm.get(t["symbol"])
                if p is None:
                    p = pm.get(_norm(t["symbol"]))
                if p is None:
                    continue
                t["price"] = p
                o = t.get("open") or 0
                if o:
                    t["change_amt"] = round(p - o, 8)
                    t["change_pct"] = round((p - o) / o * 100, 2)


def _ticker_worker():
    """背景執行緒：每秒更新 crypto ticker 最新價（輕量 weight2 端點），每 6 秒重抓
    24h 漲跌幅/量。資料源為 Binance（Pionex 同流動性、價格一致、限流寬鬆）。
    這樣可達「每秒有新報價」又不撞 Binance FAPI 權重上限。"""
    from data.crypto import (fetch_tickers, _fetch_fapi_prices, _fetch_spot_prices,
                             _fetch_bybit_prices)
    from utils.live_data import update as live_update, spot_wanted as _spot_wanted
    futures, spot = [], []
    cnt = 0
    while True:
        _t0 = time.perf_counter()
        try:
            # ★ 現貨「有人看才抓」（2026-08-10）：現貨全標的實測 **3683 筆**（永續才 726 筆），
            #   無條件每秒抓＝每秒多解析 5 倍 JSON、多吃一份上游權重，而現貨只有「標的搜尋切到
            #   現貨分頁」時才看得到。省下來的 CPU 與額度直接回饋到永續那條熱路徑
            #   （Binance 限流正是來源反覆跳→K 棒抖動的源頭）。
            _want_spot = _spot_wanted()
            # ⚠⚠ 這個條件**只能看節拍，不能看「清單是不是空的」**（2026-08-10 血的教訓）。
            #   寫成 `or not futures` 看起來很合理（沒資料就趕快再抓一次），實際是一個正回饋炸彈：
            #   完整清單走的是 /fapi/v1/ticker/24hr，**權重 40**。一旦這輪抓失敗、futures 是空的，
            #   下一秒又抓、再失敗、再抓…… 40×60 = **2400/分＝剛好等於 fapi 的全部額度**。
            #   實測 /api/_diag_mem：fapi 權重直接貼在 2393/2400，權重節流於是擋下所有 Binance 請求 →
            #   主圖與報價全被迫降級到 Bybit → 就是使用者看到的「K 棒在動、行情對不上」。
            #   失敗時什麼都不做才是對的：fetch_tickers 內部已有「沿用上一份好資料」的保護，
            #   等下一個 15 秒節拍再試，成本有上限。
            if cnt % 15 == 0 or (_want_spot and not spot and cnt % 15 == 1):
                # 每 15 秒（或首次）重抓完整 24h（含漲跌幅、量）——全市場 24h ticker 權重重(fapi 40/spot 80)，
                # 6s→15s 省 6 成基載權重；現價仍每秒抓＋重算漲跌幅，前端無感
                futures = fetch_tickers("futures")
                if _want_spot:
                    spot = fetch_tickers("spot")
            else:
                # 其餘每秒只抓最新價（weight 低），並用「現價＋快取24h開盤」重算漲跌幅
                # → 漲跌幅也每秒更新（24h 開盤一秒內不變，不需每秒抓 24hr 而撞權重）
                _apply_prices = _apply_ticker_prices
                fp = _fetch_fapi_prices()
                _psrc = "binance"
                if not fp:
                    # ★ Binance 這一輪拿不到價（限流/熔斷/逾時）→ 退 Bybit，**別讓整列凍住**。
                    #   凍住是「安靜壞掉」：使用者只看到報價列不動、主圖卻在跳，於是回報
                    #   「主圖跟合約行情數值對不上」。主圖本來就有 Binance→Bybit fallback，
                    #   報價側跟著同一條鏈降級，兩邊才會是同一個交易所的數字。
                    fp = _fetch_bybit_prices()
                    _psrc = "bybit" if fp else "none"
                if fp:
                    _apply_prices(futures, fp)
                    _TK_PRICE_STAT["ts"] = time.time()
                _TK_PRICE_STAT["src"] = _psrc
                if _want_spot:
                    sp = _fetch_spot_prices()
                    if sp:
                        _apply_prices(spot, sp)
            if futures or spot:
                live_update(futures, spot)
        except Exception:
            pass
        cnt += 1
        # 週期固定 1 秒：原本「抓價完再 sleep(1)」→ 實際 ~1.3s/輪；扣掉本輪抓價耗時，
        # 讓合約報價真正每秒更新（前端也是每秒 poll，兩端對齊 → 報價列跳動更即時）。
        time.sleep(max(0.0, 1.0 - (time.perf_counter() - _t0)))


def _tw_ticker_worker():
    """背景執行緒：每 30 秒從 TWSE/TPEX opendata 抓全台股行情存入記憶體。"""
    from data.taiwan import fetch_tw_tickers
    from utils.live_data import update_tw as live_update_tw
    while True:
        try:
            tw = fetch_tw_tickers()
            if tw:
                live_update_tw(tw)
        except Exception:
            pass
        time.sleep(30)


def _tw_rt_overlay_worker():
    """背景執行緒：交易時段每 5 秒用 MIS bulk 疊台股【今日即時價】。
    分頁輪掃(不一次狂打全部→避免 MIS 速率限制)：每輪＝前 50 高量股(永遠打→即時跳動)
    ＋輪流補一批其餘 250(rot 遞移)→ 約 40 秒內全台股都更新成今日價。

    ⚠ 舊註解寫「每 3 秒／前 100 檔／30-40 秒一輪」全部與程式不符(實際 5 秒／前 50／輪掃 100 秒)，
      2026-08-03 一併更正。輪掃批量由 100 提到 250：每輪 300 檔＝3 個請求(每個間隔 0.35s)
      ＝約 0.6 req/s，正好是本函式原本就寫明的預算上限，覆蓋一輪從 ~100s 縮到 ~40s。
    ⚠ opendata 基底對冷門股會落後一整天(實測 6862 給昨收 125.0、真實 137.5)，
      所以「輪掃多久回來一次」直接等於使用者看到多舊的價 —— 別為了省流量把它調慢。"""
    from datetime import datetime as _dt, timedelta as _td
    from data.taiwan import fetch_tw_realtime_bulk
    from utils.live_data import overlay_tw, has_tw_data, get as live_get
    _rot = 0
    _miss = 0                                             # 連續空回(疑似被 MIS 封)計數
    while True:
        _nap = 5                                          # 5s/輪：~300檔(前50+輪250)、每請求0.35s間隔→~0.6req/s、避免封
        try:
            now_tpe = _dt.utcnow() + _td(hours=8)
            mod = now_tpe.hour * 60 + now_tpe.minute
            # 盤中(09:00-13:35 TPE，尾端多留 5 分收尾)且已有基底清單才疊
            if now_tpe.weekday() < 5 and 9 * 60 <= mod < 13 * 60 + 35 and has_tw_data():
                lst = live_get("tw")
                syms = [t["symbol"] for t in
                        sorted([t for t in lst if not t.get("is_future")],
                               key=lambda t: t.get("volume") or 0, reverse=True)]
                top = syms[:50]                           # 前 50 高量：每輪都打→即時跳動
                rest = syms[50:]
                batch = list(top)
                if rest:
                    n = len(rest)
                    off = (_rot * 250) % n
                    batch += rest[off:off + 250]          # 輪流補一批(250)其餘→全部約 40s 更新成今日價
                    _rot += 1
                pm = fetch_tw_realtime_bulk(batch)
                if pm:
                    overlay_tw(pm)
                    _miss = 0
                elif batch:                               # 有打但全空 → 疑似被 MIS 限流封鎖
                    _miss += 1
                    if _miss >= 2:
                        _nap = 60                         # 退避 60s 讓 MIS 解封(否則一直打→封鎖永不解，同 Pionex 教訓)
        except Exception:
            pass
        time.sleep(_nap)


def _txf_collect_worker():
    """背景執行緒：每 25 秒抓 cnyes 台指期當前時段(含夜盤)分鐘K → 存 DB，
    讓歷史分鐘從開始收集起往後累積(免費、免開戶)。cnyes 休市回上個時段→重覆 upsert 無害。"""
    import data.cnyes_futures as cx
    while True:
        try:
            cx.collect_all()
        except Exception:
            pass
        time.sleep(25)


_leader_lock_fh = None   # 持有＝持有 leader 鎖（保持開啟至 process 結束）

def _acquire_leader() -> bool:
    """搶「背景工作 leader」。多 worker 下只讓一個 process 跑背景抓取/推播/自動交易，
    避免 N 個 worker 各自輪詢 → N 倍撞 Binance/Pionex 限流、N 份推播/下單。
    用檔案鎖（flock）：搶到＝leader（回 True，持鎖至結束）。workers=1 時唯一 worker 必為 leader，
    行為與單 worker 完全一致。follower 只服務請求、讀 leader 寫到磁碟的共享報價快照。"""
    global _leader_lock_fh
    try:
        import fcntl
    except Exception:
        return True   # 非 unix（無 fcntl）→ 視為單一 worker，當 leader
    try:
        d = os.path.join(os.path.dirname(__file__), ".df_cache")
        os.makedirs(d, exist_ok=True)
        fh = open(os.path.join(d, "leader.lock"), "w")
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)   # 非阻塞獨佔鎖
        _leader_lock_fh = fh                              # 保持開啟＝持有鎖
        return True
    except (OSError, IOError):
        return False   # 已被別的 worker 鎖住 → 本 worker 當 follower
    except Exception:
        return True    # 其他異常 → 保守當 leader（至少要有一個在跑背景工作）


def _winrate_warm_worker():
    """背景預熱勝率/深歷史 → 使用者切熱門幣多半直接命中快取(近即時)、不再等 ~2s 冷啟。
    ★ 溫和版(2026-07-10)：每 90s 才暖『一個』(symbol×tf) → _calc_crt_winrate 的 0.8s GIL 佔用
      ≈ 0.8/90 ≈ 1%、線上幾乎無感。設計：① 啟動延遲 120s(避 healthcheck)；② 只 Railway、leader-only；
      ③ 只暖前 N 幣的 1h/15m；④ Binance 冷卻中該次跳過；⑤ get_crt_winrate 內建快取(已熱秒回、df 7天磁碟)。"""
    import time as _t
    try:
        from data.crypto import mark_background
        mark_background(True)                              # 預熱＝背景工作，權重吃緊時自動讓路（見 _binance_get）
    except Exception:
        pass
    _t.sleep(120)                                          # 延遲開工：先讓 app 過 healthcheck、穩定
    _TFS = ["1h", "15m"]; _N = 10; _GAP = 90               # ★ 每 90s 才暖一個 → GIL 佔用 ~1%、不卡
    while True:
        try:
            import data.crypto as _c
            from routes.data import get_crt_winrate
            from routes.trade import top_crypto_universe
            syms = [s.get("symbol") for s in (top_crypto_universe(_N) or []) if s.get("symbol")]
            for sym in syms:
                for tf in _TFS:
                    if _t.time() < getattr(_c, "_BINANCE_COOLDOWN_UNTIL", 0):
                        _t.sleep(_GAP); continue           # Binance 冷卻中 → 這次跳過、仍慢慢等
                    try:
                        # ⚠ 參數必須與前端首次請求完全一致才會命中同一 cache key：
                        #   exchange="pionex"(exchangeSelect 唯一選項)、vw=8000(_wrVwFor 初載階梯)。
                        #   2026-07-14 修正：先前用 "binance"+無 vw → key 對不上、白暖一場。
                        get_crt_winrate("crypto", sym, tf, "pionex", vw=8000)   # 冷則暖、熱則秒回
                    except Exception:
                        pass
                    _t.sleep(_GAP)                          # 慢慢來、讓路給請求(每 90s 才一次)
        except Exception as e:
            print(f"  ⚠ 勝率預熱失敗：{e}")
            _t.sleep(300)


# 這個 worker 是不是 leader（＝有沒有在跑背景執行緒）。/api/_diag_mem 會回報，
# 否則 follower 的權重/報價健康度全是 0/None，看起來像「一切正常」其實是「這裡本來就不做事」。
_IS_LEADER = False


@app.on_event("startup")
async def _warmup():
    """啟動時立即預熱並啟動背景 ticker 更新（僅 leader worker）。"""
    global _IS_LEADER
    if not _acquire_leader():
        print("  ⓘ follower worker：背景抓取/推播/交易由 leader 負責；本 worker 只服務請求（讀共享報價快照）")
        return
    _IS_LEADER = True
    import asyncio
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _fetch_pionex_symbols)
    loop.run_in_executor(None, _fetch_pionex_perp_symbols)
    # crypto 即時報價：TICKER_WS=1 → Binance WebSocket（權重近乎0，取代每秒REST輪詢）；否則沿用 REST。
    _use_ws = (os.getenv("TICKER_WS") or "").strip().lower() in ("1", "true", "on", "yes")
    if _use_ws:
        try:
            from data.crypto_ws import run_ticker_ws
            loop.create_task(run_ticker_ws())
            print("  ✓ crypto 報價走 Binance WebSocket（TICKER_WS 開）")
        except Exception as e:
            print(f"  ⚠ WS 啟動失敗，退回 REST 輪詢：{e}")
            threading.Thread(target=_ticker_worker, daemon=True).start()
    else:
        threading.Thread(target=_ticker_worker, daemon=True).start()
    threading.Thread(target=_tw_ticker_worker, daemon=True).start()
    threading.Thread(target=_tw_rt_overlay_worker, daemon=True).start()  # 台股高量股 MIS 即時疊價(3s)
    threading.Thread(target=_txf_collect_worker, daemon=True).start()   # 台指期歷史分鐘累積
    try:
        from routes.data import _tw_realtime_worker
        threading.Thread(target=_tw_realtime_worker, daemon=True).start()   # 台股即時分鐘K持續累積(無Fugle不留斷層)
    except Exception as e:
        print(f"  ⚠ 台股即時累積 worker 啟動失敗：{e}")
    try:
        import notify_monitor
        notify_monitor.start()   # CRT 訊號 Web Push 背景監控（無訂閱時自動空轉、極低成本）
    except Exception as e:
        print(f"  ⚠ 訊號監控啟動失敗：{e}")
    # 勝率預熱(溫和版)：只 Railway、延遲 120s 開工、每 90s 才暖一個(GIL佔用~1%、不卡) → 切熱門幣近即時。
    #   若仍覺卡：設 WARM_WR=0 秒關(免改碼、免 redeploy 邏輯)。
    if (os.getenv("WARM_WR", "1") != "0" and
            bool(os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_PROJECT_ID") or os.getenv("RAILWAY_SERVICE_ID"))):
        threading.Thread(target=_winrate_warm_worker, daemon=True).start()
        print("  ✓ 勝率預熱 worker(溫和版) 已排程（Railway、延遲120s、每90s一個、前10、1h/15m）")


@app.get("/")
def index(request: Request):
    # starlette 1.x 新簽名 (request, name, context)；舊 (name, {request,...}) 已移除
    return templates.TemplateResponse(
        request,
        "index.html",
        {"ver": _asset_ver()},
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/sw.js")
def service_worker():
    """從根路徑提供 service worker（PWA 需要 root scope 才能控制整站）。"""
    from fastapi.responses import FileResponse
    return FileResponse(
        os.path.join(FRONTEND_DIR, "static", "sw.js"),
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},   # SW 本身不快取，改版即時生效
    )


app.include_router(data_router)
app.include_router(search_router)
app.include_router(bear_router)
app.include_router(weather_router)
app.include_router(ai_research_router)
app.include_router(account_router)
app.include_router(notify_router)
app.include_router(trade_router)
app.include_router(lunar_router)
app.include_router(footprint_router)
from routes.tradeshot import router as tradeshot_router   # 交易截圖辨識(視覺模型讀進出場)
app.include_router(tradeshot_router)
app.include_router(orderbook_router)
app.include_router(econ_router)
