"""帳號 + 跨裝置同步（設定與自選）—— 帳號只用「名稱」、無密碼、且只能由後台建立。

依使用者要求：
- 不用密碼：換裝置輸入管理員發給的帳號名稱，即可取回雲端設定與自選。
- 不用註冊：使用者端不能自行建立帳號；查無帳號 → 拒絕（請向管理員索取）。
- 只能由後台提供：用受保護的 admin 端點建立帳號（需 ACCOUNT_ADMIN_KEY），
  或直接在資料庫 INSERT。一般使用者無法新增。

儲存：Railway Postgres（環境變數 DATABASE_URL）。未設 → 端點回 503、前端隱藏入口、App 照常。
資料模型：accounts(name PK, data JSONB, updated_at)；data = 整包 localStorage 快照（設定+自選）。

建立帳號（後台，擇一）：
  1) 設環境變數 ACCOUNT_ADMIN_KEY，然後：
     curl -X POST .../api/account/admin/create -H 'Content-Type: application/json' \
          -d '{"key":"你的ADMIN_KEY","name":"noah"}'
  2) Railway 的 Postgres 直接 SQL：INSERT INTO accounts(name,data,updated_at) VALUES('noah','{}',0);
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
# 後台預設提供的帳號（大小寫敏感）。可用環境變數 ACCOUNT_SEED 覆寫（逗號分隔）。
_SEED = [s.strip() for s in os.getenv("ACCOUNT_SEED", "Abc,qwer").split(",") if s.strip()]
_inited = False


def _enabled() -> bool:
    return bool(_DB_URL)


def _conn():
    import psycopg
    url = _DB_URL.replace("postgres://", "postgresql://", 1) if _DB_URL else _DB_URL
    return psycopg.connect(url, connect_timeout=8)


def _ensure_db():
    global _inited
    if _inited or not _enabled():
        return
    with _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                name       TEXT PRIMARY KEY,
                data       JSONB,
                updated_at DOUBLE PRECISION
            )
        """)
        # 種入後台預設帳號（大小寫敏感、已存在則不動其資料）
        for nm in _SEED:
            c.execute(
                "INSERT INTO accounts (name, data, updated_at) VALUES (%s,'{}',%s) ON CONFLICT (name) DO NOTHING",
                (nm, time.time()),
            )
        c.commit()
    _inited = True


def _require_enabled():
    if not _enabled():
        raise HTTPException(status_code=503, detail="帳號功能未啟用（伺服器未設定 DATABASE_URL）")
    _ensure_db()


def _norm_name(name: str) -> str:
    # 大小寫敏感（依使用者要求）：只去頭尾空白，不轉小寫 → "Abc" ≠ "abc"
    return (name or "").strip()


def _valid_name(name: str) -> bool:
    return bool(name) and 2 <= len(name) <= 40 and not re.search(r"[\s\x00-\x1f]", name)


# ───────── request models ─────────
class LoginReq(BaseModel):
    name: str
    data: Optional[dict] = None     # 帳號雲端為空時，用本機目前設定初始化


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
    """用帳號名稱登入（帳號須已由後台建立）：
    - 查無帳號 → 404（不自動註冊）。
    - 雲端已有設定 → 回 data（前端套用 + reload）。
    - 雲端為空（剛建立）→ 用本機目前設定初始化雲端，回 existed=True/data={}。
    """
    _require_enabled()
    name = _norm_name(req.name)
    if not _valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱需 2~40 字、不含空白")
    try:
        with _conn() as c:
            cur = c.execute("SELECT data FROM accounts WHERE name=%s", (name,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="查無此帳號，請向管理員索取")
            data = row[0] or {}
            if not data and req.data:
                # 雲端空帳號 → 用本機現有設定初始化
                c.execute("UPDATE accounts SET data=%s, updated_at=%s WHERE name=%s",
                          (json.dumps(req.data), time.time(), name))
                c.commit()
                data = {}   # 回空 → 前端知道是「初始化」不需 reload
            return {"ok": True, "name": name, "data": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"登入失敗：{e}")


@router.post("/sync")
def sync(req: SyncReq):
    """上傳整包快照（僅限已存在的帳號；不存在不建立）。"""
    _require_enabled()
    name = _norm_name(req.name)
    if not _valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱不正確")
    try:
        with _conn() as c:
            cur = c.execute(
                "UPDATE accounts SET data=%s, updated_at=%s WHERE name=%s",
                (json.dumps(req.data or {}), time.time(), name),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="查無此帳號")
            c.commit()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"同步失敗：{e}")
    return {"ok": True}


@router.post("/admin/create")
def admin_create(req: AdminCreateReq):
    """後台建立帳號（需 ACCOUNT_ADMIN_KEY）。一般使用者無法呼叫。"""
    _require_enabled()
    if not _ADMIN_KEY or not secrets.compare_digest(req.key or "", _ADMIN_KEY):
        raise HTTPException(status_code=403, detail="無權限")
    name = _norm_name(req.name)
    if not _valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱需 2~40 字、不含空白")
    try:
        with _conn() as c:
            cur = c.execute("SELECT 1 FROM accounts WHERE name=%s", (name,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail="帳號已存在")
            c.execute("INSERT INTO accounts (name, data, updated_at) VALUES (%s,%s,%s)",
                      (name, "{}", time.time()))
            c.commit()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"建立失敗：{e}")
    return {"ok": True, "name": name}
