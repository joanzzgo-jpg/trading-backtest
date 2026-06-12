"""CRT 訊號 Web Push 通知（多使用者）。

設計：
- 通知是「唯讀」功能，不碰任何金鑰/下單 → 沿用 account.py 的無密碼帳號模型即可。
- 訂閱與偏好存 DB（沿用 account.py 的 Postgres/SQLite 雙後端 _db()，同一個資料庫）。
- VAPID 金鑰由 env 提供（VAPID_PRIVATE_KEY 為 PEM、VAPID_SUBJECT 為 mailto:）；
  缺金鑰 → 通知功能停用（回 503），不影響其他功能。

資料表（與 accounts 同庫）：
- push_subs(endpoint PK, name, p256dh, auth, prefs[JSON], updated_at)
    prefs = {"enabled":bool, "tfs":[...], "sigs":[...]}
- notify_state(scope PK, last_t)   去重；scope = market:exchange:symbol:tf:sigkey:dir
"""
import os
import json
import time
import base64
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# 沿用 account.py 的 DB 連線 / 啟用判斷 / 名稱正規化（同一個資料庫，單一真相來源）
from routes import account as _acct

router = APIRouter(prefix="/api/notify")


def _coerce(v):
    """帳號快照是「整包 localStorage」，每個值都是字串 → watchlist/notifyPrefs
    其實是被二次 JSON 編碼的字串（如 '[{...}]'）。這裡若拿到字串就再解碼一次，
    否則 list/dict 直接回傳。解不出來回 None（交由呼叫端套預設）。"""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return None
    return v

# ── 預設監控設定 ──────────────────────────────────────────────
# 訊號鍵：abc=S1, ab=S2, "3".."12"=S3..S12。預設＝計入交易的 S2~S11（與 crt.py 的 _AGG 一致）。
DEFAULT_SIGS: List[str] = ["ab", "3", "4", "5", "6", "7", "8", "9", "10", "11"]
DEFAULT_TFS:  List[str] = ["1h", "4h", "1d"]
_ALL_SIGS = {"abc", "ab", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "ss1", "ss2"}
_ALL_TFS  = {"5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "1w", "1M"}

# ── VAPID（啟動時載入一次）────────────────────────────────────
_VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "mailto:joanzzgo@gmail.com")
_vapid = None            # py_vapid.Vapid02 實例
_vapid_appkey = None     # applicationServerKey（base64url，給前端 subscribe）


def _load_vapid():
    """從 env 載入 VAPID 私鑰（PEM），推導 applicationServerKey。失敗則停用通知。"""
    global _vapid, _vapid_appkey
    pem = (os.getenv("VAPID_PRIVATE_KEY") or "").strip()
    if not pem:
        return
    # .env 常把換行寫成字面 \n → 還原成真換行
    if "\\n" in pem and "\n" not in pem:
        pem = pem.replace("\\n", "\n")
    try:
        from py_vapid import Vapid02
        from cryptography.hazmat.primitives import serialization
        v = Vapid02.from_pem(pem.encode("utf-8"))
        raw = v.public_key.public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        _vapid = v
        _vapid_appkey = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    except Exception as e:
        print(f"  ⚠ VAPID 金鑰載入失敗，通知功能停用：{e}")
        _vapid = None
        _vapid_appkey = None


_load_vapid()


def notify_enabled() -> bool:
    return _vapid is not None and _acct._enabled()


def get_vapid_public_key() -> Optional[str]:
    return _vapid_appkey


# ── DB ────────────────────────────────────────────────────────
_inited = False


def _ensure_db():
    global _inited
    if _inited:
        return
    _acct._ensure_db()   # 確保 accounts 表存在（監控器要讀 watchlist）
    conn, ph = _acct._db()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS push_subs (
                endpoint   TEXT PRIMARY KEY,
                name       TEXT,
                p256dh     TEXT,
                auth       TEXT,
                prefs      TEXT,
                updated_at DOUBLE PRECISION
            )
        """ if _acct._use_pg() else """
            CREATE TABLE IF NOT EXISTS push_subs (
                endpoint   TEXT PRIMARY KEY,
                name       TEXT,
                p256dh     TEXT,
                auth       TEXT,
                prefs      TEXT,
                updated_at REAL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS notify_state (
                scope  TEXT PRIMARY KEY,
                last_t TEXT
            )
        """)
        # 事件級精確去重（止盈等「以結算時間觸發」的事件，結算順序未必同進場順序 →
        # 不能用 notify_state 的「比上次更新」邏輯，改逐事件記一筆，並定期清舊）。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS notify_seen (
                evt_key TEXT PRIMARY KEY,
                ts      REAL
            )
        """)
        # 訊號歷史（聊天室式通知中心）：每帳號每事件一筆，前端拉清單顯示。
        # sig/dir/sigt = 訊號鍵/方向/進場訊號棒時間 → 止盈止損訊息可精確「回覆」原進場訊息。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS notify_log (
                id       BIGSERIAL PRIMARY KEY,
                name     TEXT, ts REAL, event TEXT,
                title    TEXT, body TEXT,
                symbol   TEXT, market TEXT, exchange TEXT, tf TEXT,
                sig      TEXT, dir TEXT, sigt TEXT
            )
        """ if _acct._use_pg() else """
            CREATE TABLE IF NOT EXISTS notify_log (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                name     TEXT, ts REAL, event TEXT,
                title    TEXT, body TEXT,
                symbol   TEXT, market TEXT, exchange TEXT, tf TEXT,
                sig      TEXT, dir TEXT, sigt TEXT
            )
        """)
        # 通知偏好寫穿表：前端改完設定立即 POST 寫入（不等帳號快照 debounce 同步，
        # 也不會被「另一台裝置的整包舊快照」蓋回舊值 → 修「收到沒設定的策略」）。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS notify_prefs (
                name       TEXT PRIMARY KEY,
                prefs      TEXT,
                updated_at DOUBLE PRECISION
            )
        """ if _acct._use_pg() else """
            CREATE TABLE IF NOT EXISTS notify_prefs (
                name       TEXT PRIMARY KEY,
                prefs      TEXT,
                updated_at REAL
            )
        """)
        conn.commit()
        # 既有 notify_log 補欄位（已存在會失敗 → 忽略）
        for col in ("sig", "dir", "sigt"):
            try:
                conn.execute(f"ALTER TABLE notify_log ADD COLUMN {col} TEXT")
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
    finally:
        conn.close()
    _inited = True


def _require_enabled():
    if not notify_enabled():
        raise HTTPException(status_code=503, detail="通知功能未啟用（伺服器未設定 VAPID 金鑰或 DATABASE_URL）")
    _ensure_db()


def _clean_prefs(p: Optional[dict]) -> dict:
    """缺欄位（None/讀不到）→ 套預設；**明確給空清單 → 尊重空**（使用者全取消＝不要通知）。
    以前空清單會退回預設 → 使用者收到一堆沒設定的策略，不可回退。"""
    p = p or {}
    raw_sigs = p.get("sigs")
    raw_tfs  = p.get("tfs")
    sigs = list(DEFAULT_SIGS) if raw_sigs is None else [s for s in raw_sigs if s in _ALL_SIGS]
    tfs  = list(DEFAULT_TFS)  if raw_tfs  is None else [t for t in raw_tfs  if t in _ALL_TFS]
    return {"enabled": bool(p.get("enabled", True)), "sigs": sigs, "tfs": tfs}


# ── request models ────────────────────────────────────────────
class SubInfo(BaseModel):
    endpoint: str
    keys: Dict[str, str]   # {p256dh, auth}


class SubscribeReq(BaseModel):
    name: str
    subscription: SubInfo
    prefs: Optional[dict] = None


class UnsubscribeReq(BaseModel):
    endpoint: str


class TestReq(BaseModel):
    name: str


# ── 推播發送（給 /test 與背景監控器共用）──────────────────────
def send_push(sub: Dict[str, Any], payload: dict) -> bool:
    """對單一訂閱發送 Web Push。回傳是否成功；遇 404/410 自動刪除失效訂閱。"""
    if _vapid is None:
        return False
    from pywebpush import webpush, WebPushException
    info = {
        "endpoint": sub["endpoint"],
        "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
    }
    try:
        webpush(
            subscription_info=info,
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=_vapid,
            vapid_claims={"sub": _VAPID_SUBJECT},
            ttl=600,
        )
        return True
    except WebPushException as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        if code in (404, 410):
            _delete_sub(sub["endpoint"])
        else:
            print(f"  ⚠ push 失敗（{code}）：{e}")
        return False
    except Exception as e:
        print(f"  ⚠ push 例外：{e}")
        return False


def _delete_sub(endpoint: str):
    try:
        conn, ph = _acct._db()
        try:
            conn.execute(f"DELETE FROM push_subs WHERE endpoint={ph}", (endpoint,))
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


# ── 背景監控器要用的查詢 helper ───────────────────────────────
def all_active_subs() -> List[Dict[str, Any]]:
    """回所有訂閱：[{name, endpoint, p256dh, auth}]。
    偏好（時框/訊號）改為帳號級（account_prefs），跨裝置同步，不再存於每筆訂閱。"""
    if not notify_enabled():
        return []
    _ensure_db()
    conn, ph = _acct._db()
    try:
        cur = conn.execute("SELECT endpoint, name, p256dh, auth FROM push_subs")
        rows = cur.fetchall()
    finally:
        conn.close()
    return [{"name": name, "endpoint": ep, "p256dh": p256dh, "auth": auth}
            for ep, name, p256dh, auth in rows]


def account_prefs(name: str) -> dict:
    """讀某帳號的通知偏好：優先讀寫穿表 notify_prefs（改設定立即生效、不被舊快照蓋掉），
    沒有才退回帳號快照 accounts.data.notifyPrefs（舊資料相容），再沒有回預設。"""
    if name:
        try:
            conn, ph = _acct._db()
            try:
                cur = conn.execute(f"SELECT prefs FROM notify_prefs WHERE name={ph}", (name,))
                row = cur.fetchone()
                if row and row[0]:
                    return _clean_prefs(_coerce(row[0]))
                cur = conn.execute(f"SELECT data FROM accounts WHERE name={ph}", (name,))
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[0]:
                data = json.loads(row[0]) if isinstance(row[0], str) else row[0]
                return _clean_prefs(_coerce((data or {}).get("notifyPrefs")))
        except Exception:
            pass
    return _clean_prefs(None)


def account_watchlist(name: str) -> List[dict]:
    """讀某帳號同步上來的 watchlist（存在 accounts.data 的 JSON blob 內）。"""
    if not name:
        return []
    try:
        conn, ph = _acct._db()
        try:
            cur = conn.execute(f"SELECT data FROM accounts WHERE name={ph}", (name,))
            row = cur.fetchone()
        finally:
            conn.close()
        if not row or not row[0]:
            return []
        data = json.loads(row[0]) if isinstance(row[0], str) else row[0]
        wl = _coerce((data or {}).get("watchlist")) or []
        return [w for w in wl if isinstance(w, dict) and w.get("symbol")]
    except Exception:
        return []


def last_notified(scope: str) -> Optional[str]:
    """此 scope 最後推播過的訊號時間（ISO 字串）；無則 None。
    監控器據此「只推比這更新的訊號」→ 不重發、重啟也不重發。"""
    conn, ph = _acct._db()
    try:
        cur = conn.execute(f"SELECT last_t FROM notify_state WHERE scope={ph}", (scope,))
        row = cur.fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def mark_notified(scope: str, t: str):
    conn, ph = _acct._db()
    try:
        if _acct._use_pg():
            conn.execute(
                f"INSERT INTO notify_state (scope, last_t) VALUES ({ph},{ph}) "
                f"ON CONFLICT (scope) DO UPDATE SET last_t=EXCLUDED.last_t",
                (scope, t),
            )
        else:
            conn.execute(
                f"INSERT INTO notify_state (scope, last_t) VALUES ({ph},{ph}) "
                f"ON CONFLICT (scope) DO UPDATE SET last_t=excluded.last_t",
                (scope, t),
            )
        conn.commit()
    finally:
        conn.close()


def log_signal(name, ts, event, title, body, symbol, market, exchange, tf,
               sig=None, d=None, sigt=None):
    """記一筆訊號到該帳號的歷史（聊天室通知中心用），並裁切只留最近 200 筆。
    sig/d/sigt（訊號鍵/方向/進場訊號棒時間）讓止盈止損訊息能配對原進場訊息。"""
    conn, ph = _acct._db()
    try:
        conn.execute(
            f"INSERT INTO notify_log (name,ts,event,title,body,symbol,market,exchange,tf,sig,dir,sigt) "
            f"VALUES ({ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph})",
            (name, ts, event, title, body, symbol, market, exchange, tf, sig, d, sigt),
        )
        # 裁切：保留該帳號最近 200 筆
        conn.execute(
            f"DELETE FROM notify_log WHERE name={ph} AND id NOT IN "
            f"(SELECT id FROM notify_log WHERE name={ph} ORDER BY id DESC LIMIT 200)",
            (name, name),
        )
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()


def seen_event(evt_key: str) -> bool:
    """此事件是否已推過（逐事件精確去重，給止盈等事件用）。"""
    conn, ph = _acct._db()
    try:
        cur = conn.execute(f"SELECT 1 FROM notify_seen WHERE evt_key={ph}", (evt_key,))
        return cur.fetchone() is not None
    finally:
        conn.close()


def mark_event(evt_key: str):
    """記一筆已推事件，並順手清掉 14 天前的舊紀錄（避免無限增長）。"""
    now = time.time()
    conn, ph = _acct._db()
    try:
        if _acct._use_pg():
            conn.execute(
                f"INSERT INTO notify_seen (evt_key, ts) VALUES ({ph},{ph}) "
                f"ON CONFLICT (evt_key) DO NOTHING", (evt_key, now))
        else:
            conn.execute(
                f"INSERT INTO notify_seen (evt_key, ts) VALUES ({ph},{ph}) "
                f"ON CONFLICT (evt_key) DO NOTHING", (evt_key, now))
        conn.execute(f"DELETE FROM notify_seen WHERE ts < {ph}", (now - 14 * 86400,))
        conn.commit()
    finally:
        conn.close()


# ── endpoints ─────────────────────────────────────────────────
@router.get("/status")
def status():
    return {"enabled": notify_enabled(), "has_vapid": _vapid is not None}


@router.get("/feed")
def feed(name: str, limit: int = 80):
    """某帳號的訊號歷史（聊天室通知中心）。回傳由舊到新（最新在最後）。"""
    _require_enabled()
    nm = _acct._norm_name(name)
    if not nm:
        return {"items": []}
    limit = max(1, min(int(limit or 80), 200))
    conn, ph = _acct._db()
    try:
        cur = conn.execute(
            f"SELECT ts,event,title,body,symbol,market,exchange,tf,sig,dir,sigt FROM notify_log "
            f"WHERE name={ph} ORDER BY id DESC LIMIT {limit}", (nm,))
        rows = cur.fetchall()
    finally:
        conn.close()
    items = [{"ts": r[0], "event": r[1], "title": r[2], "body": r[3],
              "symbol": r[4], "market": r[5], "exchange": r[6], "tf": r[7],
              "sig": r[8], "dir": r[9], "t": r[10]}
             for r in rows]
    items.reverse()   # 由舊到新（聊天室最新在最下方）
    return {"items": items}


@router.get("/vapid_public")
def vapid_public():
    if not notify_enabled():
        raise HTTPException(status_code=503, detail="通知功能未啟用")
    return {"key": _vapid_appkey}


@router.post("/subscribe")
def subscribe(req: SubscribeReq):
    _require_enabled()
    name = _acct._norm_name(req.name)
    ep = req.subscription.endpoint
    if not ep:
        raise HTTPException(status_code=400, detail="缺少 endpoint")
    p256dh = req.subscription.keys.get("p256dh", "")
    auth = req.subscription.keys.get("auth", "")
    prefs = json.dumps(_clean_prefs(req.prefs))
    conn, ph = _acct._db()
    try:
        if _acct._use_pg():
            conn.execute(
                f"INSERT INTO push_subs (endpoint,name,p256dh,auth,prefs,updated_at) "
                f"VALUES ({ph},{ph},{ph},{ph},{ph},{ph}) "
                f"ON CONFLICT (endpoint) DO UPDATE SET "
                f"name=EXCLUDED.name, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, "
                f"prefs=EXCLUDED.prefs, updated_at=EXCLUDED.updated_at",
                (ep, name, p256dh, auth, prefs, time.time()),
            )
        else:
            conn.execute(
                f"INSERT INTO push_subs (endpoint,name,p256dh,auth,prefs,updated_at) "
                f"VALUES ({ph},{ph},{ph},{ph},{ph},{ph}) "
                f"ON CONFLICT (endpoint) DO UPDATE SET "
                f"name=excluded.name, p256dh=excluded.p256dh, auth=excluded.auth, "
                f"prefs=excluded.prefs, updated_at=excluded.updated_at",
                (ep, name, p256dh, auth, prefs, time.time()),
            )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "prefs": json.loads(prefs)}


@router.post("/unsubscribe")
def unsubscribe(req: UnsubscribeReq):
    _require_enabled()
    _delete_sub(req.endpoint)
    return {"ok": True}


class PrefsReq(BaseModel):
    name: str
    prefs: Optional[dict] = None


@router.post("/prefs")
def set_prefs(req: PrefsReq):
    """通知偏好寫穿端點：前端改完設定立即寫入（仍同時存 localStorage 供 UI 顯示）。
    修正：純靠帳號快照同步時，另一台裝置任何設定變更都會推「整包舊快照」上來，
    把剛改好的 notifyPrefs 蓋回舊值 → 收到沒設定的策略/漏收。寫穿表為單一真相來源。"""
    _require_enabled()
    name = _acct._norm_name(req.name)
    if not name:
        raise HTTPException(status_code=400, detail="缺少帳號")
    prefs = json.dumps(_clean_prefs(req.prefs))
    conn, ph = _acct._db()
    try:
        conn.execute(
            f"INSERT INTO notify_prefs (name, prefs, updated_at) VALUES ({ph},{ph},{ph}) "
            f"ON CONFLICT (name) DO UPDATE SET prefs=excluded.prefs, updated_at=excluded.updated_at",
            (name, prefs, time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "prefs": json.loads(prefs)}


@router.post("/test")
def test_push(req: TestReq):
    _require_enabled()
    name = _acct._norm_name(req.name)
    conn, ph = _acct._db()
    try:
        cur = conn.execute(
            f"SELECT endpoint, p256dh, auth FROM push_subs WHERE name={ph}", (name,)
        )
        rows = cur.fetchall()
    finally:
        conn.close()
    if not rows:
        raise HTTPException(status_code=404, detail="此帳號尚無通知訂閱")
    # 擬真範例：用與真實訊號相同的多行格式，讓使用者看到實際長相
    import time as _t
    d = _t.localtime()
    when = f"{d.tm_mon}/{d.tm_mday} {d.tm_hour:02d}:{d.tm_min:02d}"
    payload = {
        "title": "BTC/USDT · 4h（測試）",
        "body": ("S6 做空訊號 · 盈虧比 1.5\n"
                 "進場 80,815.00 → 目標 79,200.00\n"
                 f"停損 81,900.00 · {when}"),
        "tag": "test",
        "data": {"symbol": "BTC/USDT", "market": "crypto", "exchange": "pionex", "tf": "4h"},
    }
    sent = sum(1 for ep, p, a in rows
               if send_push({"endpoint": ep, "p256dh": p, "auth": a}, payload))
    # 也寫進訊號歷史（聊天室分頁），讓使用者在分頁裡看到範例
    log_signal(name, _t.time(), "entry", payload["title"], payload["body"],
               "BTC/USDT", "crypto", "pionex", "4h")
    return {"ok": True, "sent": sent, "total": len(rows)}
