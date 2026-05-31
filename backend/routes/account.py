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
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/account")

_DB_URL = os.getenv("DATABASE_URL")
_ADMIN_KEY = os.getenv("ACCOUNT_ADMIN_KEY")
_SEED = [s.strip() for s in os.getenv("ACCOUNT_SEED", "Abc,qwer").split(",") if s.strip()]
_ON_RAILWAY = bool(os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_PROJECT_ID") or os.getenv("RAILWAY_SERVICE_ID"))
_SQLITE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".accounts.db")
_inited = False


def _use_pg() -> bool:
    return bool(_DB_URL)


def _enabled() -> bool:
    # 有 Postgres → 啟用；本機(非 Railway)無 DB → SQLite 啟用；Railway 無 DB → 停用
    return bool(_DB_URL) or not _ON_RAILWAY


def _db():
    """回 (conn, placeholder)。Postgres 用 %s、SQLite 用 ?。"""
    if _use_pg():
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


# ───────── endpoints ─────────
@router.get("/status")
def status():
    return {"enabled": _enabled()}


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
