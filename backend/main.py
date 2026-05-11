"""
FastAPI 後端主程式 - 回測系統 (模塊化版本)
"""
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.templating import Jinja2Templates
from fastapi import Request
import os, sys, time, subprocess

sys.path.insert(0, os.path.dirname(__file__))

from routes.data import router as data_router
from routes.search import router as search_router
from routes.strategies import router as strategies_router
from routes.backtest import router as backtest_router
from data.crypto import _fetch_pionex_symbols, _fetch_pionex_perp_symbols
import threading

app = FastAPI(title="回測系統")

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/static", StaticFiles(directory=os.path.join(FRONTEND_DIR, "static")), name="static")

templates = Jinja2Templates(directory=os.path.join(FRONTEND_DIR, "templates"))

# 取得 git commit hash 作為靜態資源版本號
try:
    _VER = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"],
                                   cwd=os.path.dirname(__file__),
                                   stderr=subprocess.DEVNULL).decode().strip()
except Exception:
    _VER = str(int(time.time()))


def _ticker_worker():
    """背景執行緒：每 2 秒從交易所抓 ticker 並存入記憶體快取。"""
    import time
    from data.crypto import fetch_tickers
    from utils.live_data import update as live_update
    time.sleep(3)   # 等 Pionex 標的快取預熱完畢
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
    """啟動時預熱 Pionex 標的快取，並啟動即時 ticker 背景更新。"""
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


# 註冊所有路由
app.include_router(data_router)
app.include_router(search_router)
app.include_router(strategies_router)
app.include_router(backtest_router)

