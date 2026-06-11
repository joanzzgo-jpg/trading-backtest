"""
FastAPI 後端主程式 - 回測系統 (模塊化版本)
"""
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
import os, sys, time, subprocess, threading
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

sys.path.insert(0, os.path.dirname(__file__))

from routes.data import router as data_router
from routes.search import router as search_router
from routes.backtest import router as backtest_router
from routes.bear import router as bear_router
from routes.weather import router as weather_router
from routes.ai_research import router as ai_research_router
from routes.account import router as account_router
from routes.notify import router as notify_router
from routes.trade import router as trade_router
from data.crypto import _fetch_pionex_symbols, _fetch_pionex_perp_symbols

def _build_js_bundle():
    """啟動時自動打包前端 JS bundle（取代 start.sh，Railway 部署需要）。
    若任一來源檔比 bundle 新就重建；否則沿用既有 bundle 不動。"""
    try:
        from pathlib import Path
        js = Path(os.path.dirname(__file__)) / ".." / "frontend" / "static" / "js"
        js = js.resolve()
        names = ["config","utils","charts","draw","colors","ticker","winrate","render","realtime","replay","ui","ai_research","signal_info","account","notify","trade","backtest","main"]
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

# ── 靜態檔案長期快取（?v=hash 已保證更新時 URL 改變）───────────
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
        return response

app.add_middleware(StaticCacheMiddleware)

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
            if cnt % 6 == 0 or not (futures or spot):
                # 每 6 秒（或首次）重抓完整 24h（含漲跌幅、量）
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


@app.on_event("startup")
async def _warmup():
    """啟動時立即預熱並啟動背景 ticker 更新。"""
    import asyncio
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _fetch_pionex_symbols)
    loop.run_in_executor(None, _fetch_pionex_perp_symbols)
    threading.Thread(target=_ticker_worker,    daemon=True).start()
    threading.Thread(target=_tw_ticker_worker, daemon=True).start()
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
app.include_router(backtest_router)
app.include_router(bear_router)
app.include_router(weather_router)
app.include_router(ai_research_router)
app.include_router(account_router)
app.include_router(notify_router)
app.include_router(trade_router)
