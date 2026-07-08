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
from data.crypto import _fetch_pionex_symbols, _fetch_pionex_perp_symbols

def _build_js_bundle():
    """啟動時自動打包前端 JS bundle（取代 start.sh，Railway 部署需要）。
    若任一來源檔比 bundle 新就重建；否則沿用既有 bundle 不動。"""
    try:
        from pathlib import Path
        js = Path(os.path.dirname(__file__)) / ".." / "frontend" / "static" / "js"
        js = js.resolve()
        names = ["config","utils","charts","draw","colors","ticker","winrate","render","realtime","replay","ui","ai_research","signal_info","account","notify","trade","chartorder","xiaoa","lunar","announce","main"]
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

app = FastAPI(title="回測系統")

# ── GZip 壓縮（JS 166KB→35KB，CSS 38KB→8KB）──────────────────
app.add_middleware(GZipMiddleware, minimum_size=500)

# ── CSP 內容安全政策字串（CSP_OFF=1 → 停用；緊急關閉用）──────────────────
_CSP = "" if (os.getenv("CSP_OFF") or "").strip().lower() in ("1", "true", "on", "yes") else (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' https://unpkg.com; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
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
#   兩層桶:一般 /api/ 寬鬆(擋灌流,不動正常使用);/api/trade/ 嚴格(擋口令暴力猜)。
_RL_WIN      = 10.0                       # 視窗秒數
_RL_MAX_API  = 300                        # 一般 /api/：每 IP 每 10 秒 300 次(=30/s,遠高於正常:每秒 ticker 1 次)
_RL_MAX_TRADE = 20                        # /api/trade/：每 IP 每 10 秒 20 次(口令猜測極慢化)
_RL_BUCKETS   = {}                        # ip -> deque[timestamps]（一般）
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
            is_trade = path.startswith("/api/trade/")
            if is_trade and _rl_hit(_RL_BUCKETS_T, ip, _RL_MAX_TRADE, now):
                return PlainTextResponse("too many trade requests", status_code=429, headers={"Retry-After": "10"})
            if _rl_hit(_RL_BUCKETS, ip, _RL_MAX_API, now):
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


def _asset_ver() -> str:
    """資產版號 = git hash + 前端資產最新 mtime（bundle / css / effects / weather 取最新者）。
    每次請求即時算，本地改前端（即使沒重啟服務、沒 commit）也會改版號、破瀏覽器快取。"""
    try:
        m = max(os.path.getmtime(p) for p in (_BUNDLE_PATH, _CSS_PATH, _EFFECTS_PATH, _WEATHER_PATH) if os.path.exists(p))
        return f"{_GIT_VER}-{int(m)}"
    except Exception:
        return _GIT_VER


def _ticker_worker():
    """背景執行緒：每秒更新 crypto ticker 最新價（輕量 weight2 端點），每 6 秒重抓
    24h 漲跌幅/量。資料源為 Binance（Pionex 同流動性、價格一致、限流寬鬆）。
    這樣可達「每秒有新報價」又不撞 Binance FAPI 權重上限。"""
    from data.crypto import fetch_tickers, _fetch_fapi_prices, _fetch_spot_prices
    from utils.live_data import update as live_update
    futures, spot = [], []
    cnt = 0
    while True:
        try:
            if cnt % 15 == 0 or not (futures or spot):
                # 每 15 秒（或首次）重抓完整 24h（含漲跌幅、量）——全市場 24h ticker 權重重(fapi 40/spot 80)，
                # 6s→15s 省 6 成基載權重；現價仍每秒抓＋重算漲跌幅，前端無感
                futures = fetch_tickers("futures")
                spot    = fetch_tickers("spot")
            else:
                # 其餘每秒只抓最新價（weight 低），並用「現價＋快取24h開盤」重算漲跌幅
                # → 漲跌幅也每秒更新（24h 開盤一秒內不變，不需每秒抓 24hr 而撞權重）
                def _apply_prices(rows, prices):
                    for t in rows:
                        p = prices.get(t["symbol"])
                        if p is None:
                            continue
                        t["price"] = p
                        o = t.get("open") or 0
                        if o:
                            t["change_amt"] = round(p - o, 8)
                            t["change_pct"] = round((p - o) / o * 100, 2)
                fp = _fetch_fapi_prices()
                if fp:
                    _apply_prices(futures, fp)
                sp = _fetch_spot_prices()
                if sp:
                    _apply_prices(spot, sp)
            if futures or spot:
                live_update(futures, spot)
        except Exception:
            pass
        cnt += 1
        time.sleep(1)


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


@app.on_event("startup")
async def _warmup():
    """啟動時立即預熱並啟動背景 ticker 更新（僅 leader worker）。"""
    if not _acquire_leader():
        print("  ⓘ follower worker：背景抓取/推播/交易由 leader 負責；本 worker 只服務請求（讀共享報價快照）")
        return
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


@app.get("/")
def index(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "ver": _asset_ver()},
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
