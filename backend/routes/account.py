"""帳號 + 跨裝置同步（設定與自選）—— 名稱-only、無密碼、無註冊、後台建立。

依使用者要求：
- 不用密碼：換裝置輸入管理員發的帳號名稱，即可取回雲端設定與自選。
- 不用註冊：使用者端不能自建；查無帳號 → 拒絕（請向管理員索取）。
- 只能由後台提供：admin 端點建立（需 ACCOUNT_ADMIN_KEY）或直接 DB INSERT。
- 大小寫敏感（"Abc" ≠ "abc"）。

儲存（雙後端）：
- 有 DATABASE_URL（Railway Postgres）→ 用 Postgres（跨重啟/多實例持久）。
- 本機開發（非 Railway 且無 DATABASE_URL）→ 用 SQLite 檔（backend/.accounts.db，已 gitignore），
  讓本機就能測試帳號功能。
- 在 Railway 上卻沒 DATABASE_URL → 停用（避免寫到會被清空的臨時檔造成假性遺失）。

資料模型：accounts(name PRIMARY KEY, data TEXT[JSON], updated_at)。data = 整包 localStorage 快照。
預設種子帳號 Abc / qwer（可用 ACCOUNT_SEED 覆寫）。
"""
import os
import json
import time
import re
import secrets
import threading
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/account")

_DB_URL = os.getenv("DATABASE_URL")
_ADMIN_KEY = os.getenv("ACCOUNT_ADMIN_KEY")
_SEED = [s.strip() for s in os.getenv("ACCOUNT_SEED", "Abc,qwer,Ctt").split(",") if s.strip()]
_ON_RAILWAY = bool(os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_PROJECT_ID") or os.getenv("RAILWAY_SERVICE_ID"))
_SQLITE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".accounts.db")
_inited = False


def _use_pg() -> bool:
    return bool(_DB_URL)


def _enabled() -> bool:
    # 一律啟用：有 DATABASE_URL → Postgres（持久）；否則 → SQLite 檔。
    # 注意：Railway 無 Postgres 時用 SQLite，檔案在重新部署時會被清空（同步資料重置、
    # 種子帳號 Abc/qwer 會重建）→ 要永久保存請在 Railway 加 Postgres（自動帶 DATABASE_URL）。
    return True


# ── Postgres 連線池（只 PG；SQLite 本地連線本就便宜、不池化）──────────────────────
# 省每次 psycopg.connect() 的 TCP+認證握手(~10-30ms)。ConnectionPool(open=True) 非阻塞(背景填池)。
# ⚠ 層層保底：① 只 PG 走池、SQLite 完全不變；② 代理 close() 前 rollback 清狀態再還池；③ 池初始化/取用
#   任一失敗 → 回退直連(＝原行為)，最壞只是沒優化、不會壞；④ DB_POOL=0 可秒關。
# （2026-07-11 healthcheck 事故真凶是 @app.on_event 裝飾器裝錯位、非此池；此池無辜、現安全加回。）
_pg_pool = None
_pg_pool_lock = threading.Lock()


def _get_pg_pool():
    """回連線池物件；停用/失敗 → None（呼叫端回退直連）。只嘗試初始化一次。"""
    global _pg_pool
    if os.getenv("DB_POOL", "1") == "0":
        return None
    if _pg_pool is not None:
        return _pg_pool or None
    with _pg_pool_lock:
        if _pg_pool is None:
            try:
                from psycopg_pool import ConnectionPool
                url = _DB_URL.replace("postgres://", "postgresql://", 1)
                _pg_pool = ConnectionPool(url, min_size=1, max_size=6, timeout=8,
                                          max_lifetime=600, kwargs={"connect_timeout": 8})
                print("  ✓ PG 連線池已啟用（min1/max6）")
            except Exception as e:
                print(f"  ⚠ PG 連線池初始化失敗、回退直連：{e}")
                _pg_pool = False
    return _pg_pool or None


class _PooledConn:
    """psycopg 連線代理：close() 還池(先 rollback 清狀態)不真斷；其餘屬性/方法轉發真連線。"""
    def __init__(self, conn, pool):
        object.__setattr__(self, "_c", conn)
        object.__setattr__(self, "_p", pool)
        object.__setattr__(self, "_done", False)

    def __getattr__(self, k):
        return getattr(object.__getattribute__(self, "_c"), k)

    def close(self):
        if object.__getattribute__(self, "_done"):
            return
        object.__setattr__(self, "_done", True)
        c = object.__getattribute__(self, "_c"); p = object.__getattribute__(self, "_p")
        try:
            c.rollback()
        except Exception:
            pass
        try:
            p.putconn(c)
        except Exception:
            try:
                c.close()
            except Exception:
                pass

    def __enter__(self):
        return object.__getattribute__(self, "_c").__enter__()

    def __exit__(self, *a):
        return object.__getattribute__(self, "_c").__exit__(*a)


def _db():
    """回 (conn, placeholder)。Postgres 用 %s（優先連線池、失敗回退直連）、SQLite 用 ?。"""
    if _use_pg():
        pool = _get_pg_pool()
        if pool is not None:
            try:
                return _PooledConn(pool.getconn(), pool), "%s"
            except Exception as e:
                print(f"  ⚠ 連線池取用失敗、本次回退直連：{e}")
        import psycopg
        url = _DB_URL.replace("postgres://", "postgresql://", 1)
        return psycopg.connect(url, connect_timeout=8), "%s"
    import sqlite3
    return sqlite3.connect(_SQLITE_PATH, timeout=8), "?"


def _ensure_db():
    global _inited
    if _inited or not _enabled():
        return
    conn, ph = _db()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                name       TEXT PRIMARY KEY,
                data       TEXT,
                updated_at DOUBLE PRECISION
            )
        """ if _use_pg() else """
            CREATE TABLE IF NOT EXISTS accounts (
                name       TEXT PRIMARY KEY,
                data       TEXT,
                updated_at REAL
            )
        """)
        # 自選走「寫穿表」當唯一真相（不進整包快照）：每次加/刪自選即寫入，換裝置/多裝置即時一致，
        # 避免整包 last-write-wins 被別台舊快照蓋掉（與 trade_userkey 同模型）。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS account_watchlist (
                name       TEXT PRIMARY KEY,
                wl         TEXT,
                updated_at DOUBLE PRECISION
            )
        """ if _use_pg() else """
            CREATE TABLE IF NOT EXISTS account_watchlist (
                name       TEXT PRIMARY KEY,
                wl         TEXT,
                updated_at REAL
            )
        """)
        for nm in _SEED:
            conn.execute(
                f"INSERT INTO accounts (name, data, updated_at) VALUES ({ph},'{{}}',{ph}) "
                f"ON CONFLICT (name) DO NOTHING",
                (nm, time.time()),
            )
        conn.commit()
    finally:
        conn.close()
    _inited = True


def _require_enabled():
    if not _enabled():
        raise HTTPException(status_code=503, detail="帳號功能未啟用（伺服器未設定 DATABASE_URL）")
    _ensure_db()


def _norm_name(name: str) -> str:
    # 大小寫敏感（依使用者要求）：只去頭尾空白，不轉小寫
    return (name or "").strip()


def _valid_name(name: str) -> bool:
    return bool(name) and 2 <= len(name) <= 40 and not re.search(r"[\s\x00-\x1f]", name)


# ───────── request models ─────────
class LoginReq(BaseModel):
    name: str
    data: Optional[dict] = None


class SyncReq(BaseModel):
    name: str
    data: dict


class AdminCreateReq(BaseModel):
    key: str
    name: str


class SaveWatchReq(BaseModel):
    name: str
    wl: list


class MyWatchReq(BaseModel):
    name: str


# ───────── endpoints ─────────
@router.get("/status")
def status():
    # store=postgres → 已接 Postgres（永久）；sqlite → 本機/未接 Postgres（Railway 重部署會重置）
    return {"enabled": _enabled(), "store": "postgres" if _use_pg() else "sqlite"}


@router.post("/login")
def login(req: LoginReq):
    _require_enabled()
    name = _norm_name(req.name)
    if not _valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱需 2~40 字、不含空白")
    conn, ph = _db()
    try:
        cur = conn.execute(f"SELECT data FROM accounts WHERE name={ph}", (name,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="查無此帳號，請向管理員索取")
        try:
            data = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or {})
        except Exception:
            data = {}
        if not data and req.data:
            conn.execute(f"UPDATE accounts SET data={ph}, updated_at={ph} WHERE name={ph}",
                         (json.dumps(req.data), time.time(), name))
            conn.commit()
            data = {}
        return {"ok": True, "name": name, "data": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"登入失敗：{e}")
    finally:
        conn.close()


@router.post("/sync")
def sync(req: SyncReq):
    _require_enabled()
    name = _norm_name(req.name)
    if not _valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱不正確")
    conn, ph = _db()
    try:
        cur = conn.execute(f"UPDATE accounts SET data={ph}, updated_at={ph} WHERE name={ph}",
                           (json.dumps(req.data or {}), time.time(), name))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="查無此帳號")
        conn.commit()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"同步失敗：{e}")
    finally:
        conn.close()
    return {"ok": True}


@router.post("/savewatch")
def save_watch(req: SaveWatchReq):
    """把自選清單寫穿到帳號的 account_watchlist 表（唯一真相）。每次加/刪自選即呼叫 →
    多裝置/換裝置即時一致，不受整包快照 last-write-wins 影響。"""
    _require_enabled()
    name = _norm_name(req.name)
    if not _valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱不正確")
    conn, ph = _db()
    try:
        conn.execute(
            f"INSERT INTO account_watchlist (name, wl, updated_at) VALUES ({ph},{ph},{ph}) "
            f"ON CONFLICT (name) DO UPDATE SET wl=excluded.wl, updated_at=excluded.updated_at",
            (name, json.dumps(req.wl or []), time.time()))
        conn.commit()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"自選同步失敗：{e}")
    finally:
        conn.close()
    return {"ok": True}


@router.post("/mywatch")
def my_watch(req: MyWatchReq):
    """取回該帳號的自選清單（登入或切回前景時拉取，覆蓋本機）。
    回 {wl: [...], exists: bool}。exists=False → 表中尚無此帳號（供前端遷移舊快照自選）。"""
    _require_enabled()
    name = _norm_name(req.name)
    if not _valid_name(name):
        return {"wl": [], "exists": False}
    conn, ph = _db()
    try:
        cur = conn.execute(f"SELECT wl FROM account_watchlist WHERE name={ph}", (name,))
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return {"wl": [], "exists": False}
    try:
        wl = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or [])
    except Exception:
        wl = []
    return {"wl": wl if isinstance(wl, list) else [], "exists": True}


@router.post("/admin/create")
def admin_create(req: AdminCreateReq):
    """後台建立帳號（需 ACCOUNT_ADMIN_KEY）。"""
    _require_enabled()
    if not _ADMIN_KEY or not secrets.compare_digest(req.key or "", _ADMIN_KEY):
        raise HTTPException(status_code=403, detail="無權限")
    name = _norm_name(req.name)
    if not _valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱需 2~40 字、不含空白")
    conn, ph = _db()
    try:
        cur = conn.execute(f"SELECT 1 FROM accounts WHERE name={ph}", (name,))
        if cur.fetchone():
            raise HTTPException(status_code=409, detail="帳號已存在")
        conn.execute(f"INSERT INTO accounts (name, data, updated_at) VALUES ({ph},'{{}}',{ph})",
                     (name, time.time()))
        conn.commit()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"建立失敗：{e}")
    finally:
        conn.close()
    return {"ok": True, "name": name}
