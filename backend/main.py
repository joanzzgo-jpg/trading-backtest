"""
FastAPI 後端主程式 - 回測系統 (模塊化版本)
"""
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
import os, sys, time, subprocess, threading

sys.path.insert(0, os.path.dirname(__file__))

from routes.data import router as data_router
from routes.search import router as search_router
from routes.strategies import router as strategies_router
from routes.backtest import router as backtest_router
from routes.bear import router as bear_router
from data.crypto import _fetch_pionex_symbols, _fetch_pionex_perp_symbols

app = FastAPI(title="回測系統")

# ── GZip 壓縮（JS 166KB→35KB，CSS 38KB→8KB）──────────────────
app.add_middleware(GZipMiddleware, minimum_size=500)

# ── 靜態檔案長期快取（?v=hash 已保證更新時 URL 改變）───────────
class StaticCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

app.add_middleware(StaticCacheMiddleware)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/static", StaticFiles(directory=os.path.join(FRONTEND_DIR, "static")), name="static")

templates = Jinja2Templates(directory=os.path.join(FRONTEND_DIR, "templates"))

try:
    _VER = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"],
                                   cwd=os.path.dirname(__file__),
                                   stderr=subprocess.DEVNULL).decode().strip()
except Exception:
    _VER = str(int(time.time()))


def _ticker_worker():
    """背景執行緒：每 2 秒從 Pionex 抓 ticker 存入記憶體。"""
    from data.crypto import fetch_tickers
    from utils.live_data import update as live_update
    while True:
        try:
            futures = fetch_tickers("futures")
            spot    = fetch_tickers("spot")
            if futures or spot:
                live_update(futures, spot)
        except Exception:
            pass
        time.sleep(2)


@app.on_event("startup")
async def _warmup():
    """啟動時立即預熱並啟動背景 ticker 更新。"""
    import asyncio
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _fetch_pionex_symbols)
    loop.run_in_executor(None, _fetch_pionex_perp_symbols)
    t = threading.Thread(target=_ticker_worker, daemon=True)
    t.start()


@app.get("/")
def index(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "ver": _VER},
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


app.include_router(data_router)
app.include_router(search_router)
app.include_router(strategies_router)
app.include_router(backtest_router)
app.include_router(bear_router)
