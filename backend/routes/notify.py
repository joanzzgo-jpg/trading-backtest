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
import re
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
# S1~S12 早已退役、SS 系列 2026-08-05 亦全面移除 → 目前沒有任何可訂閱的策略訊號。
_ALL_SIGS = set()
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
        # 價格提示線（2026-09-10）：使用者在圖上指定一個價位，價格碰到就推播。
        # ⚠ 存在後端而不是瀏覽器：整個重點就是「關掉網頁也會通知」——放前端等於沒做。
        # dir＝建立當下由現價決定要往上碰還是往下碰（base 記下建立時的現價，供顯示與診斷）。
        # fired_at 為 NULL＝待命；觸發後填時間並保留（讓使用者看得到「已觸發」而不是憑空消失）。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS price_alerts (
                id         TEXT PRIMARY KEY,
                name       TEXT,
                market     TEXT,
                exchange   TEXT,
                symbol     TEXT,
                price      DOUBLE PRECISION,
                base       DOUBLE PRECISION,
                dir        TEXT,
                note       TEXT,
                created_at DOUBLE PRECISION,
                fired_at   DOUBLE PRECISION
            )
        """ if _acct._use_pg() else """
            CREATE TABLE IF NOT EXISTS price_alerts (
                id         TEXT PRIMARY KEY,
                name       TEXT,
                market     TEXT,
                exchange   TEXT,
                symbol     TEXT,
                price      REAL,
                base       REAL,
                dir        TEXT,
                note       TEXT,
                created_at REAL,
                fired_at   REAL
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
    # 各類別通知獨立開關（預設皆開）：
    #   sigNotify=訊號(CRT/SS entry)、atNotify=自動交易(開/平/狀態)。（coachNotify 隨教練功能於 2026-09-17 移除）
    #   關某一類只停該類推播，不影響其他類；交易核准碼(推給管理員)不受這些開關限制。
    return {"enabled": bool(p.get("enabled", True)), "sigs": sigs, "tfs": tfs,
            "sigNotify":   bool(p.get("sigNotify", True)),
            "atNotify":    bool(p.get("atNotify", True))}


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


# ── 推播給某帳號的所有裝置（交易核准碼、管理員通知等共用）────────
def push_to_account(name: str, payload: dict) -> int:
    """推播給某帳號名下所有裝置訂閱。回成功送達數。用於交易核准 6 位碼推給管理員(qwer)。"""
    if not notify_enabled():
        return 0
    _ensure_db()
    conn, ph = _acct._db()
    try:
        cur = conn.execute(f"SELECT endpoint, p256dh, auth FROM push_subs WHERE name={ph}",
                           (_acct._norm_name(name or ""),))
        rows = cur.fetchall()
    finally:
        conn.close()
    ok = 0
    for ep, p, a in rows:
        if send_push({"endpoint": ep, "p256dh": p, "auth": a}, payload):
            ok += 1
    return ok


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
    """讀某帳號的 watchlist。真相在 account_watchlist 專屬表（/api/account/savewatch 寫穿，
    多裝置一致）；該表無此帳號才退回舊整包快照的 watchlist 欄位（相容未遷移帳號）。
    ⚠ 自選改走專屬表後，舊版只讀 data.get('watchlist') → 永遠空 → 監控器沒標的可掃
       → 自動交易/訊號通知全斷。此處改先讀專屬表修正之。"""
    if not name:
        return []
    try:
        conn, ph = _acct._db()
        try:
            # ① 專屬表（唯一真相）
            try:
                wrow = conn.execute(f"SELECT wl FROM account_watchlist WHERE name={ph}", (name,)).fetchone()
            except Exception:
                wrow = None
            if wrow and wrow[0]:
                wl = _coerce(wrow[0]) or []
                if isinstance(wl, list):
                    return [w for w in wl if isinstance(w, dict) and w.get("symbol")]
            # ② 退回舊整包快照
            row = conn.execute(f"SELECT data FROM accounts WHERE name={ph}", (name,)).fetchone()
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
    """記一筆訊號到該帳號的歷史（聊天室通知中心用），並裁切只留最近 2000 筆。
    （200 太小：自動交易繁忙時一小時就把今天稍早的訊號擠掉 → 今日摘要漏算。加大到 2000 留整天餘裕。）
    sig/d/sigt（訊號鍵/方向/進場訊號棒時間）讓止盈止損訊息能配對原進場訊息。"""
    conn, ph = _acct._db()
    try:
        conn.execute(
            f"INSERT INTO notify_log (name,ts,event,title,body,symbol,market,exchange,tf,sig,dir,sigt) "
            f"VALUES ({ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph})",
            (name, ts, event, title, body, symbol, market, exchange, tf, sig, d, sigt),
        )
        # 裁切：保留該帳號最近 2000 筆
        conn.execute(
            f"DELETE FROM notify_log WHERE name={ph} AND id NOT IN "
            f"(SELECT id FROM notify_log WHERE name={ph} ORDER BY id DESC LIMIT 20000)",
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
def feed(name: str, limit: int = 80, since: float = 0, before_id: int = 0):
    """某帳號的訊號歷史（聊天室通知中心）。回傳由舊到新（最新在最後）。
    since>0：只回 ts ≥ since 的（給「今日摘要」抓自當地午夜起的全部、不被 limit 截斷漏算）。
    before_id>0：往前翻頁——只回 id < before_id 的更早一批（聊天室往上滑載入更早，自動交易量大也找得到）。"""
    _require_enabled()
    nm = _acct._norm_name(name)
    if not nm:
        return {"items": []}
    limit = max(1, min(int(limit or 80), 200))
    before_id = max(0, int(before_id or 0))
    conn, ph = _acct._db()
    stats = None
    try:
        if since and float(since) > 0:
            # 今日摘要：數量直接用 SQL 聚合(不撈全部筆數→量再大都準、payload 小)；盈虧只解析自動平倉那幾筆。
            _sn = float(since)
            cnt = dict(conn.execute(
                f"SELECT event, COUNT(*) FROM notify_log WHERE name={ph} AND ts >= {ph} GROUP BY event",
                (nm, _sn)).fetchall())
            pnl = 0.0; has_pnl = False
            for (body,) in conn.execute(
                f"SELECT body FROM notify_log WHERE name={ph} AND ts >= {ph} "
                f"AND event IN ('atrade_tp','atrade_sl')", (nm, _sn)).fetchall():
                m = re.search(r"已實現盈虧\s*([+-]?[\d,.]+)\s*USDT", body or "")
                if m:
                    try: pnl += float(m.group(1).replace(",", "")); has_pnl = True
                    except ValueError: pass
            stats = {"sig_n": cnt.get("entry", 0), "win_n": cnt.get("atrade_tp", 0),
                     "loss_n": cnt.get("atrade_sl", 0), "pnl": round(pnl, 2), "has_pnl": has_pnl}
            # 仍回少量近期筆數供前端後備(統計以 stats 為準)
            cur = conn.execute(
                f"SELECT id,ts,event,title,body,symbol,market,exchange,tf,sig,dir,sigt FROM notify_log "
                f"WHERE name={ph} AND ts >= {ph} ORDER BY id DESC LIMIT 300", (nm, _sn))
        elif before_id > 0:
            cur = conn.execute(
                f"SELECT id,ts,event,title,body,symbol,market,exchange,tf,sig,dir,sigt FROM notify_log "
                f"WHERE name={ph} AND id < {ph} ORDER BY id DESC LIMIT {limit}", (nm, before_id))
        else:
            cur = conn.execute(
                f"SELECT id,ts,event,title,body,symbol,market,exchange,tf,sig,dir,sigt FROM notify_log "
                f"WHERE name={ph} ORDER BY id DESC LIMIT {limit}", (nm,))
        rows = cur.fetchall()
    finally:
        conn.close()
    items = [{"id": r[0], "ts": r[1], "event": r[2], "title": r[3], "body": r[4],
              "symbol": r[5], "market": r[6], "exchange": r[7], "tf": r[8],
              "sig": r[9], "dir": r[10], "t": r[11]}
             for r in rows]
    items.reverse()   # 由舊到新（聊天室最新在最下方）
    return {"items": items, "stats": stats}


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


# ══════════════════════════════════════════════════════════════
#  價格提示線：價格碰到指定價位就推播
#  ⚠ 判斷放在**後端**背景監控器（notify_monitor._price_alert_scan）——
#    「關掉網頁也會通知」是這個功能的全部意義，放前端等於沒做。
# ══════════════════════════════════════════════════════════════
_ALERT_MAX_PER_ACCT = 200        # 每帳號待命上限（防呆，不是效能瓶頸）


class AlertAddReq(BaseModel):
    name: str
    market: str
    exchange: Optional[str] = ""
    symbol: str
    price: float
    base: Optional[float] = None     # 建立當下的現價（前端傳；沒有就由後端當場抓）
    note: Optional[str] = ""


@router.post("/alerts/add")
def alerts_add(req: AlertAddReq):
    _ensure_db()
    name = _acct._norm_name(req.name or "")
    if not _acct._valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱不正確")
    sym = (req.symbol or "").strip().upper()[:60]
    if not sym:
        raise HTTPException(status_code=400, detail="缺少標的")
    try:
        price = float(req.price)
    except Exception:
        raise HTTPException(status_code=400, detail="價格不正確")
    if not (price > 0):
        raise HTTPException(status_code=400, detail="價格必須大於 0")
    market = (req.market or "crypto").strip().lower()[:10]
    exch = (req.exchange or "").strip().lower()[:20]
    base = None
    try:
        base = float(req.base) if req.base is not None else None
    except Exception:
        base = None
    if base is None or not (base > 0):
        base = _alert_price_of(market, exch, sym)
    if base is None:
        raise HTTPException(status_code=400, detail="抓不到目前價格，無法判斷方向")
    # ⚠ 方向在**建立當下**就定案：價位在現價之上＝等它漲上來，之下＝等它跌下去。
    #   不能每次掃描時才比（那樣「現價剛好在提示價附近抖動」會反覆觸發）。
    direction = "up" if price > base else "down"
    conn, ph = _acct._db()
    try:
        cur = conn.execute(
            f"SELECT COUNT(*) FROM price_alerts WHERE name={ph} AND fired_at IS NULL", (name,))
        if int((cur.fetchone() or [0])[0]) >= _ALERT_MAX_PER_ACCT:
            raise HTTPException(status_code=400, detail=f"待命中的提示線已達上限 {_ALERT_MAX_PER_ACCT} 條")
        aid = base64.urlsafe_b64encode(os.urandom(9)).decode().rstrip("=")
        conn.execute(
            f"INSERT INTO price_alerts (id,name,market,exchange,symbol,price,base,dir,note,created_at,fired_at) "
            f"VALUES ({ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},NULL)",
            (aid, name, market, exch, sym, price, base, direction, (req.note or "")[:120], time.time()))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "id": aid, "dir": direction, "base": base}


class AlertListReq(BaseModel):
    name: str
    symbol: Optional[str] = None     # 帶了就只回這一檔（畫圖用）
    market: Optional[str] = None


@router.post("/alerts/list")
def alerts_list(req: AlertListReq):
    _ensure_db()
    name = _acct._norm_name(req.name or "")
    if not _acct._valid_name(name):
        return {"alerts": []}
    conn, ph = _acct._db()
    try:
        q = f"SELECT id,market,exchange,symbol,price,base,dir,note,created_at,fired_at FROM price_alerts WHERE name={ph}"
        args = [name]
        if req.symbol:
            q += f" AND symbol={ph}"; args.append(req.symbol.strip().upper())
        if req.market:
            q += f" AND market={ph}"; args.append(req.market.strip().lower())
        q += " ORDER BY created_at DESC"
        rows = conn.execute(q, tuple(args)).fetchall() or []
    finally:
        conn.close()
    ks = ("id", "market", "exchange", "symbol", "price", "base", "dir", "note", "created_at", "fired_at")
    return {"alerts": [dict(zip(ks, r)) for r in rows]}


class AlertDelReq(BaseModel):
    name: str
    id: Optional[str] = None
    clear_fired: Optional[bool] = False    # 一次清掉所有「已觸發」的


@router.post("/alerts/del")
def alerts_del(req: AlertDelReq):
    _ensure_db()
    name = _acct._norm_name(req.name or "")
    if not _acct._valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱不正確")
    conn, ph = _acct._db()
    try:
        if req.clear_fired:
            cur = conn.execute(f"DELETE FROM price_alerts WHERE name={ph} AND fired_at IS NOT NULL", (name,))
        elif req.id:
            cur = conn.execute(f"DELETE FROM price_alerts WHERE name={ph} AND id={ph}", (name, req.id))
        else:
            raise HTTPException(status_code=400, detail="要指定 id 或 clear_fired")
        conn.commit()
        return {"ok": True, "n": cur.rowcount}
    finally:
        conn.close()


def _alert_price_of(market: str, exchange: str, symbol: str):
    """取某標的目前價。優先用背景 worker already 維護好的報價快照（免費、每秒更新）；
    ⚠ 沒有才退回真的去抓——提示線可能有幾十條，逐條打 API 會把權重吃光。"""
    try:
        from utils import live_data
        sym_u = (symbol or "").upper()
        for mk in (("futures", "spot") if market == "crypto" else ("tw",)):
            for t in live_data.get(mk) or []:
                d = str(t.get("display") or "").upper()
                sy = str(t.get("symbol") or "").upper()
                if d == sym_u or sy == sym_u:
                    px = t.get("price")
                    if isinstance(px, (int, float)) and px > 0:
                        return float(px)
    except Exception:
        pass
    # 退路：真的去抓一根最新 K（美股/港股不在報價快照裡，只能走這條）。
    # ⚠ 只在快照沒有時才走；提示線可能有幾十條，逐條打 API 會把交易所權重吃光。
    try:
        from routes.data import get_latest, LatestRequest
        r = get_latest(LatestRequest(market=market, symbol=symbol,
                                     exchange=(exchange or "binance"), timeframe="1m"))
        arr = (r or {}).get("data") or []
        if arr:
            px = arr[-1].get("close")
            if isinstance(px, (int, float)) and px > 0:
                return float(px)
    except Exception:
        pass
    return None
