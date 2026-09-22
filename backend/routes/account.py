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
        # 共享繪圖（2026-09-08）：使用者可以把「自己在某個標的上畫的東西」分享出去，
        # 其他人看同一個標的時就看得到。**預設完全不分享**，要在畫面上明確打開才會寫進這張表。
        # ⚠ 走「寫穿表」不進 accounts.data 整包快照：
        #   ① 快照是 last-write-wins，分享內容被別台舊快照蓋掉會很難察覺；
        #   ② 更重要的是**隔離**——快照裡是使用者的全部私有資料，分享功能絕不該碰它。
        # ⚠ 一列＝一個帳號在一個標的上的繪圖；取消分享＝刪掉那一列（不是留空陣列）。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS account_shared_drawings (
                name       TEXT,
                sym        TEXT,
                d          TEXT,
                updated_at DOUBLE PRECISION,
                PRIMARY KEY (name, sym)
            )
        """ if _use_pg() else """
            CREATE TABLE IF NOT EXISTS account_shared_drawings (
                name       TEXT,
                sym        TEXT,
                d          TEXT,
                updated_at REAL,
                PRIMARY KEY (name, sym)
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
    out = {"enabled": _enabled(), "store": "postgres" if _use_pg() else "sqlite"}
    if _UPSTREAM_ON:                      # 本機才有：繪圖自動上傳 Railway 的最近一次結果
        out["upstream"] = {"url": _UPSTREAM_URL, **_relay_stat}
    return out


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


# ── 本機繪圖自動上傳到 Railway（2026-08-11，使用者要求）──────────────────────────
# 情境：在本機開發時畫的線，只會存進本機的 SQLite（backend/.accounts.db），
#       Railway 上同名帳號完全看不到 → 換到手機/正式站就沒有那些線。
#
# ★ 只搬「繪圖」那一格，不整包推上去。
#   `accounts.data` 是**整包 localStorage 快照**，本機那份跟線上那份是不同的世界
#   （自選、設定、通知偏好、其他裝置存的東西都在裡面）。整包推上去＝把手機上的設定洗掉。
#   所以流程是：拉線上快照 → **只換掉 tv_drawings_v2 這一格** → 推回去。
# ★ 合併是**逐標的**（`{...線上, ...本機}`）：本機沒畫過的標的沿用線上的，
#   不會因為本機沒有就把手機畫的線刪掉；本機把某標的清空（存 []）則會照樣同步過去。
# ⚠ 快照裡每個值都是**字串**（localStorage.getItem 的結果）→ 讀要 json.loads、寫要 json.dumps，
#   直接當 dict 用會壞（見 memory project_account-snapshot-string-values）。
# ⚠ 絕不在請求執行緒裡做：整段丟背景執行緒，上游掛掉/慢也不影響本機存檔。
# ⚠ 只在**本機**啟用（_ON_RAILWAY 為真就關掉），否則線上會自己轉發給自己。
_UPSTREAM_URL = os.getenv("ACCOUNT_UPSTREAM_URL",
                          "https://web-production-32b54d.up.railway.app").rstrip("/")
_UPSTREAM_ON = (not _ON_RAILWAY) and os.getenv("ACCOUNT_UPSTREAM", "1") != "0"
_DRAW_KEY = "tv_drawings_v2"
_relay_lock = threading.Lock()
_relay_busy: set = set()
_relay_last: dict = {}          # name → 上次成功送上去的繪圖指紋（沒變就不重送）
_relay_stat: dict = {"at": 0.0, "ok": None, "msg": "", "name": "", "symbols": 0}


def _relay_post(path: str, payload: dict, timeout: float = 12.0):
    import urllib.request
    req = urllib.request.Request(_UPSTREAM_URL + "/api/account/" + path,
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


# 「這台裝置專屬」的設定，不往上游推：推上去對方也不會套用（前端 _PULL_SKIP 會擋），
# 而且會把對方的版面/字級弄亂。★ 這份要跟 account.js 的 _ACCT_SKIP + _PULL_SKIP 對齊。
_RELAY_SKIP = {
    # _ACCT_SKIP：本來就不進雲端快照的
    "acctName", "wxCoords", "notifyFeedSeen", "tradeKey", "watchlist", "_tc",
    # _PULL_SKIP：進得去但對方不會套用的（版面、字級、這台看過什麼…）
    "perfMode", "mFontScale", "mHideWr", "mLastTab",
    "paneFlexes", "collapsedPanes", "multiChart",
    "sqdFloatPos", "symBlockOrder",
    "announceSeenVer", "symSearchHistory", "accelOn",
}


def _relay_snapshot(name: str, local_snap: dict):
    """把本機這次同步的**繪圖＋設定**一起送進上游（Railway）同名帳號。背景執行、失敗只記錄不拋。

    ⚠⚠ 繪圖與設定**必須在同一次 pull+sync 裡處理**：分成兩次讀-改-寫的話，
      第二次用的是第一次寫入「之前」拉到的快照 → 會把第一次的結果整個蓋掉。

    ・繪圖：**逐標的合併、本機優先**（up_draw 打底，local_draw 覆蓋）。
      本機有畫過的那些標的以本機為準（所以在本機刪掉一條線，線上那一檔也會少那條）；
      本機從沒碰過的標的保持線上原樣 —— 那可能是手機畫的，不該被這台清掉。
    ・設定：**鏡像**（2026-09-23 使用者：「如果本機刪除 線上也刪除」）——
      本機沒有的 key 會從線上刪掉，不是只做覆蓋。
      ⚠ 安全閥：本機一個可推的設定都沒有時**什麼都不做** —— 那時分不出
        「使用者把設定清光了」和「本機是空的/壞的」，而鏡像會直接把線上清空。
    """
    try:
        if not isinstance(local_snap, dict):
            return
        raw = local_snap.get(_DRAW_KEY)
        try:
            local_draw = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except Exception:
            local_draw = {}
        if not isinstance(local_draw, dict):
            local_draw = {}

        local_set = {k: v for k, v in local_snap.items()
                     if k not in _RELAY_SKIP and k != _DRAW_KEY}
        if not local_draw and not local_set:
            return                                   # 本機什麼都沒有 → 沒事可做

        fp = json.dumps({"d": local_draw, "s": local_set}, sort_keys=True)
        if _relay_last.get(name) == fp:
            return                                   # 跟上次送的一模一樣 → 不重送
        up = _relay_post("pull", {"name": name})
        if not up.get("exists"):
            _relay_stat.update({"at": time.time(), "ok": False, "name": name,
                                "msg": f"線上沒有「{name}」這個帳號（帳號只能由後台建立）"})
            return
        up_snap = up.get("data") or {}

        # ── 繪圖：逐標的合併，本機優先 ──
        try:
            up_draw = json.loads(up_snap.get(_DRAW_KEY) or "{}")
        except Exception:
            up_draw = {}
        if not isinstance(up_draw, dict):
            up_draw = {}
        merged = {**up_draw, **local_draw}
        if merged:
            up_snap[_DRAW_KEY] = json.dumps(merged)   # ⚠ 快照值必須是字串

        # ── 設定：鏡像（本機沒有的就刪掉）──
        added = changed = removed = 0
        if local_set:                                 # 見 docstring 的安全閥
            for k in [k for k in up_snap
                      if k not in _RELAY_SKIP and k != _DRAW_KEY and k not in local_set]:
                up_snap.pop(k, None); removed += 1
            for k, v in local_set.items():
                if k not in up_snap: added += 1
                elif up_snap[k] != v: changed += 1
                up_snap[k] = v

        _relay_post("sync", {"name": name, "data": up_snap})
        _relay_last[name] = fp
        _relay_stat.update({"at": time.time(), "ok": True, "name": name,
                            "symbols": len(local_draw),
                            "msg": f"繪圖 {len(local_draw)} 個標的；設定 +{added}/改{changed}/刪{removed}"})
        print(f"  ✏️ 已同步到線上：{name} — 繪圖 {len(local_draw)} 個標的（線上共 {len(merged)}）、"
              f"設定新增 {added} 改 {changed} 刪 {removed}")
    except Exception as e:
        _relay_stat.update({"at": time.time(), "ok": False, "name": name,
                            "msg": f"{type(e).__name__}: {str(e)[:120]}"})
        print(f"  ⚠ 同步到線上失敗（{name}）：{type(e).__name__}: {str(e)[:100]}"
              f" — 本機存檔不受影響，下次同步會再試")
    # ⚠ busy 不在這裡清：自選那條還要跑，統一由 _relay_all 收尾（見該函式）


def _local_watchlist(name: str):
    """讀本機這台的自選寫穿表 → (清單, updated_at)。讀不到回 (None, 0)。"""
    conn, ph = _db()
    try:
        cur = conn.execute(f"SELECT wl, updated_at FROM account_watchlist WHERE name={ph}", (name,))
        row = cur.fetchone()
    except Exception:
        return None, 0.0
    finally:
        conn.close()
    if not row:
        return None, 0.0
    try:
        wl = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or [])
    except Exception:
        return None, 0.0
    return (wl if isinstance(wl, list) else None), float(row[1] or 0)


def _wl_key(w):
    """自選項目的識別鍵：市場+交易所+代號（大小寫不敏感）。"""
    if not isinstance(w, dict):
        return None
    return (str(w.get("market") or "crypto").lower(),
            str(w.get("exchange") or "").lower(),
            str(w.get("symbol") or "").upper())


def _relay_watchlist(name: str):
    """把本機的自選同步到上游（Railway）同名帳號。背景執行、失敗只記錄不拋。

    ★ 2026-08-20 使用者：「自選也要更新」。繪圖那條可以逐標的合併（本機沒畫過的沿用線上），
      自選卻是**一份清單**、而且「刪掉某檔」是真實操作 —— 沒有可以躲的分割。
      所以規則按「誰比較新」走（兩邊表裡本來就有 updated_at）：
        ・本機較新 → 整份取代（本機的新增**與刪除**都會過去）
        ・線上較新 → **不送**（手機剛改過，別被本機的舊清單洗掉；本機下次拉雲端會拿到）
        ・線上讀不到時間（舊版伺服器還沒部署到）→ 退回**聯集**：只會多不會少，
          寧可少同步一次刪除，也不要在不知道誰新的情況下刪掉對方的東西。
    ⚠ 與繪圖同樣的鐵則：絕不在請求執行緒裡做；失敗不影響本機存檔。
    """
    local, lts = _local_watchlist(name)
    if local is None:
        return                                       # 本機沒有這個帳號的自選 → 沒事可做
    try:
        up = _relay_post("mywatch", {"name": name})
    except Exception as e:
        _relay_stat.update({"wl_ok": False, "wl_msg": f"拉線上自選失敗：{str(e)[:60]}"})
        return
    online = up.get("wl") if isinstance(up.get("wl"), list) else []
    ots = up.get("updated_at")
    if ots is None:                                  # 舊版上游 → 聯集（只增不減）
        seen = {_wl_key(w) for w in local if _wl_key(w)}
        merged = list(local) + [w for w in online if _wl_key(w) and _wl_key(w) not in seen]
        mode = "聯集(上游沒有時間戳)"
    elif lts > float(ots or 0):
        merged, mode = list(local), "本機較新→整份取代"
    else:
        _relay_stat.update({"wl_ok": True, "wl_msg": f"線上較新({len(online)} 檔)，本機不覆蓋"})
        return
    if [_wl_key(w) for w in merged] == [_wl_key(w) for w in online]:
        _relay_stat.update({"wl_ok": True, "wl_msg": f"自選已一致（{len(online)} 檔）"})
        return                                       # 沒變就不送
    try:
        _relay_post("savewatch", {"name": name, "wl": merged})
        _relay_stat.update({"wl_ok": True,
                            "wl_msg": f"已上傳 {len(merged)} 檔自選（{mode}）"})
    except Exception as e:
        _relay_stat.update({"wl_ok": False, "wl_msg": f"上傳自選失敗：{str(e)[:60]}"})


def _relay_all(name: str, snap: dict):
    try:
        _relay_snapshot(name, snap)
    finally:
        try:
            _relay_watchlist(name)
        except Exception:
            pass
        # ⚠ 一定要清，而且要在**兩條都跑完之後**：沒清＝這個帳號從此再也不會轉發
        #   （同 _wx_bg_refresh／_nr_bg_refresh 的教訓）。
        with _relay_lock:
            _relay_busy.discard(name)


def _kick_relay(name: str, snap: dict):
    if not _UPSTREAM_ON:
        return
    with _relay_lock:
        if name in _relay_busy:
            return                                   # 單飛：同一帳號同時只有一條在送
        _relay_busy.add(name)
    threading.Thread(target=_relay_all, args=(name, snap), daemon=True).start()


def _merge_drawings_on_sync(name: str, incoming: dict) -> dict:
    """整包快照寫入前，**繪圖那一格改成逐標的合併**，不讓一台裝置整份取代。

    ★ 2026-08-21 事故：使用者「railway 上我的 qwer 帳號繪圖都被清掉了」——
      線上從 23 標的 / 209 筆掉到 **2 標的 / 3 筆**。本機那份完好無缺（22/208），
      所以不是本機推壞的，是**某台裝置把自己那份殘缺的快照整份蓋上去**
      （事故當下線上快照只有 24 個 key，本機是 66 個）。
    根因：`tv_drawings_v2` 是**一個 localStorage key 裝所有標的**，而 `/api/account/sync`
      是整包 last-write-wins。任何一台裝置只要在「還沒把雲端那份拉下來」的狀態下畫了一筆，
      `saveDrawings()` 就會把它那份殘缺的 store 寫回去 → 同步上來 → 覆蓋掉全部。
      手機瀏覽器把站台資料清掉（iOS 常見）之後回來用，就是這個劇本。
    → 伺服器端擋：合併成 `{...原有, ...這次送上來的}`。一台裝置只能**新增/更新它知道的標的**，
      永遠不能刪掉它從沒看過的標的。
    ⚠ 代價：把某個標的的繪圖**全部刪光**不會同步出去（那個 key 會從 incoming 消失 → 保留原有）。
      刪個別線條照樣同步（那個標的的清單整份換新）。用 209 筆的風險換一個罕見操作，值得。
    ⚠ 只保護繪圖：其餘設定本來就是 last-write-wins，改動它們影響面太大且不是這次的問題。
    """
    if not isinstance(incoming, dict) or _DRAW_KEY not in incoming:
        return incoming
    try:
        conn, ph = _db()
        try:
            row = conn.execute(f"SELECT data FROM accounts WHERE name={ph}", (name,)).fetchone()
        finally:
            conn.close()
        if not row:
            return incoming
        old_snap = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or {})
        old_draw = old_snap.get(_DRAW_KEY)
        old_draw = json.loads(old_draw) if isinstance(old_draw, str) else (old_draw or {})
        new_draw = incoming.get(_DRAW_KEY)
        new_draw = json.loads(new_draw) if isinstance(new_draw, str) else (new_draw or {})
        if not isinstance(old_draw, dict) or not isinstance(new_draw, dict) or not old_draw:
            return incoming
        merged = {**old_draw, **new_draw}
        if merged == new_draw:
            return incoming                          # 沒有保住任何東西 → 原樣寫入
        kept = [k for k in old_draw if k not in new_draw]
        print(f"  🛡 繪圖保護：{name} 這次送上來 {len(new_draw)} 個標的，"
              f"保留它沒帶到的 {len(kept)} 個（{', '.join(kept[:5])}{'…' if len(kept) > 5 else ''}）")
        out = dict(incoming)
        out[_DRAW_KEY] = json.dumps(merged, ensure_ascii=False)
        return out
    except Exception as e:                           # 保護失敗不可以擋住存檔
        print(f"  ⚠ 繪圖合併保護失敗（{name}）：{type(e).__name__}: {str(e)[:80]} — 照原樣寫入")
        return incoming


@router.post("/sync")
def sync(req: SyncReq):
    _require_enabled()
    name = _norm_name(req.name)
    if not _valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱不正確")
    data = _merge_drawings_on_sync(name, req.data or {})
    conn, ph = _db()
    try:
        cur = conn.execute(f"UPDATE accounts SET data={ph}, updated_at={ph} WHERE name={ph}",
                           (json.dumps(data), time.time(), name))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="查無此帳號")
        conn.commit()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"同步失敗：{e}")
    finally:
        conn.close()
    _kick_relay(name, data)              # 本機：把繪圖那一格轉發到 Railway（背景、不擋回應）
    return {"ok": True}


class PullReq(BaseModel):
    """唯讀取回：只需要帳號名。⚠ 不要沿用 SyncReq —— 它的 data 是必填，
    前端只想「拉」的時候不必也不該帶整包快照上來（實測沿用會 422）。"""
    name: str


@router.post("/pull")
def pull(req: PullReq):
    """**唯讀**取回帳號快照（含 updated_at）。

    ★為什麼要獨立一支：原本前端想拿雲端資料只能打 /login，而 /login 會在雲端為空時
      用本機快照回寫 —— 拿來當「定期拉取」用等於每次都可能寫入。這支保證不寫任何東西。
    用途：手機端回到前景時比對 updated_at，若雲端較新就把繪圖同步下來
      （先前只有 /mywatch 拉自選，繪圖只在「登入那一刻」才會下來 → 已登入的手機
       永遠看不到電腦後來畫的線）。"""
    _require_enabled()
    name = _norm_name(req.name)
    if not _valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱不正確")
    conn, ph = _db()
    try:
        cur = conn.execute(f"SELECT data, updated_at FROM accounts WHERE name={ph}", (name,))
        row = cur.fetchone()
        if not row:
            return {"ok": True, "exists": False}
        try:
            data = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or {})
        except Exception:
            data = {}
        return {"ok": True, "exists": True, "updated_at": row[1] or 0, "data": data}
    finally:
        conn.close()


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
    # 本機：自選也轉發到 Railway（背景、不擋回應）。⚠ 一定要在這裡踢——自選走的是寫穿表，
    # 不經過 /api/account/sync，只掛在那邊的話「加/刪自選」永遠不會上線。
    _kick_relay(name, {})
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
        cur = conn.execute(f"SELECT wl, updated_at FROM account_watchlist WHERE name={ph}", (name,))
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return {"wl": [], "exists": False}
    try:
        wl = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or [])
    except Exception:
        wl = []
    # updated_at 追加回傳（2026-08-20）：本機→線上的自選轉發要靠它判誰比較新。
    # 純加法，舊前端不讀它、行為不變。
    return {"wl": wl if isinstance(wl, list) else [], "exists": True,
            "updated_at": float(row[1] or 0)}


# ══════════════════════════════════════════════════════════════
#  共享繪圖：看得到別人在同一個標的上畫了什麼
#  ⚠⚠ 隱私前提：**預設不分享**。只有使用者自己在畫面上打開開關，前端才會呼叫
#     /share_drawings 把「當前標的」那一份送上來；關掉就整列刪除。
#     既有的繪圖不會因為這個功能被動上傳 —— 沒有任何路徑會自動分享。
#  ⚠ 身分只有帳號名（跟 /sync、/savewatch 同一套，本專案沒有密碼/token）→
#     這是分享出去的東西，請當成「公開」看待。見 /shared_drawings 的註解。
# ══════════════════════════════════════════════════════════════
_SHARE_MAX_ITEMS = 400        # 單一標的最多分享幾個繪圖（防止有人塞爆）
_SHARE_MAX_BYTES = 256 * 1024 # 單一標的序列化後上限


class ShareDrawReq(BaseModel):
    name: str
    sym: str                        # 標的鍵，格式同前端 _drawSymKey()：MARKET:EXCHANGE:SYMBOL
    drawings: list | None = None    # None 或空陣列＝取消分享這個標的


@router.post("/share_drawings")
def share_drawings(req: ShareDrawReq):
    """把自己在某標的上的繪圖分享出去（或取消分享）。"""
    _require_enabled()
    name = _norm_name(req.name)
    if not _valid_name(name):
        raise HTTPException(status_code=400, detail="帳號名稱不正確")
    sym = (req.sym or "").strip().upper()[:120]
    if not sym:
        raise HTTPException(status_code=400, detail="缺少標的")
    items = req.drawings if isinstance(req.drawings, list) else []
    conn, ph = _db()
    try:
        if not items:                                   # 取消分享＝刪列
            conn.execute(f"DELETE FROM account_shared_drawings WHERE name={ph} AND sym={ph}", (name, sym))
            conn.commit()
            return {"ok": True, "n": 0}
        if len(items) > _SHARE_MAX_ITEMS:
            raise HTTPException(status_code=400,
                                detail=f"單一標的最多分享 {_SHARE_MAX_ITEMS} 個繪圖（目前 {len(items)} 個）")
        blob = json.dumps(items, ensure_ascii=False)
        if len(blob.encode("utf-8")) > _SHARE_MAX_BYTES:
            raise HTTPException(status_code=400, detail="分享內容太大")
        conn.execute(
            f"INSERT INTO account_shared_drawings (name, sym, d, updated_at) VALUES ({ph},{ph},{ph},{ph}) "
            f"ON CONFLICT (name, sym) DO UPDATE SET d=excluded.d, updated_at=excluded.updated_at",
            (name, sym, blob, time.time()))
        conn.commit()
        return {"ok": True, "n": len(items)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分享失敗：{e}")
    finally:
        conn.close()


class SharedDrawReq(BaseModel):
    sym: str
    exclude: str | None = None      # 通常帶自己的帳號名：自己的已經畫在圖上了，不必重複


@router.post("/shared_drawings")
def shared_drawings(req: SharedDrawReq):
    """取回「其他人」在這個標的上分享的繪圖。
    回 {authors:[{name, drawings, updated_at}]}。
    ⚠ 這裡回的東西會被畫到別人的圖表上 → 只回**明確分享過**的列（表裡有列＝有分享）。"""
    _require_enabled()
    sym = (req.sym or "").strip().upper()[:120]
    if not sym:
        return {"authors": []}
    me = _norm_name(req.exclude or "")
    conn, ph = _db()
    try:
        cur = conn.execute(
            f"SELECT name, d, updated_at FROM account_shared_drawings WHERE sym={ph} "
            f"ORDER BY updated_at DESC", (sym,))
        rows = cur.fetchall() or []
    except Exception:
        rows = []
    finally:
        conn.close()
    out = []
    for nm, d, ts in rows:
        if me and _norm_name(nm) == me:
            continue
        try:
            arr = json.loads(d) if isinstance(d, str) else (d or [])
        except Exception:
            continue
        if isinstance(arr, list) and arr:
            out.append({"name": nm, "drawings": arr, "updated_at": float(ts or 0)})
    return {"authors": out}


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
