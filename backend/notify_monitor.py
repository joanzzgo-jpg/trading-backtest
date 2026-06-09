"""背景訊號監控器：定時掃描使用者自選標的，CRT 訊號在最新收盤棒觸發 → Web Push 推播。

設計重點：
- **收盤棒 gating**：每個時框只在「有新棒收盤」的那一刻才重算（避免每 60s 狂算）。
- **即時、不吃 30 分勝率快取**：用短窗 df（fetch_crt_df + 小 days）即時抓最新棒；
  訊號偵測重用 _calc_crt_winrate（勝率統計不重要，只取 signals）。
- **去重**：notify_state(scope=market:exchange:symbol:tf:sigkey:dir, last_t) → 同訊號不重發、重啟也不重發。
- **新鮮度防呆**：只推「最近數根收盤棒」上的訊號，且資料須夠新 → 避免首次訂閱時把舊歷史訊號一次轟出。
- 時間基準：Binance K 線為 UTC tz-naive；以 pd.Timestamp.value（以 UTC 解讀 naive）對齊 time.time()。
"""
import time
import math
import threading

CHECK_INTERVAL = 60          # 每 60s 醒來一次
MONITOR_BARS   = 320         # 短窗抓多少根（足夠指標 lookback + 最近棒）
FRESH_BARS     = 2           # 只推最近 2 根收盤棒上的訊號

_TF_SEC = {
    "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200,
    "4h": 14400, "8h": 28800, "1d": 86400, "1w": 604800, "1M": 2592000,
}

# 訊號鍵 → 顯示名
def _sig_label(k: str) -> str:
    if k == "abc":
        return "S1"
    if k == "ab":
        return "S2"
    if k == "ss1":
        return "SS1"
    return "S" + k


def _interval_sec(tf: str):
    return _TF_SEC.get(tf)


def _monitor_days(tf: str) -> int:
    iv = _TF_SEC.get(tf, 86400)
    return max(2, math.ceil(MONITOR_BARS * iv / 86400) + 2)


def _epoch(ts) -> float:
    """pd.Timestamp / ISO 字串 → epoch 秒（naive 以 UTC 解讀，對齊 Binance 與 time.time()）。"""
    import pandas as pd
    return pd.Timestamp(ts).value / 1e9


def _fmt_price(p) -> str:
    """價格格式化：大數字加千分位、小數字保留有效位。"""
    try:
        p = float(p)
    except (TypeError, ValueError):
        return ""
    if p >= 1000:
        return f"{p:,.2f}"
    if p >= 1:
        return f"{p:.4g}"
    return f"{p:.6g}"


def _fmt_dt(iso):
    """訊號時間（UTC naive）→ 台灣時間 M/D HH:MM。"""
    import pandas as pd
    try:
        d = pd.Timestamp(iso) + pd.Timedelta(hours=8)
        return f"{d.month}/{d.day} {d.hour:02d}:{d.minute:02d}"
    except Exception:
        return ""


def _build_payload(symbol, market, exchange, tf, k, d, sig, event="entry"):
    dir_txt = "做空" if d == "s" else "做多"
    label = _sig_label(k)
    title = f"{symbol} · {tf}"
    entry = sig.get("entry"); stop = sig.get("stop"); rr = sig.get("rr")
    risk = abs(entry - stop) if (entry is not None and stop is not None) else None

    if event == "tp":
        rr_real = sig.get("rr_real")
        exit_px = None
        if entry is not None and risk and rr_real is not None:
            exit_px = entry - rr_real * risk if d == "s" else entry + rr_real * risk
        rr_show = rr_real if rr_real is not None else rr
        l1 = f"{label} {dir_txt} 止盈達成"
        if rr_show is not None:
            l1 += f" · 盈虧比 {rr_show:+.2f}"
        l2 = (f"進場 {_fmt_price(entry)}" if entry is not None else "")
        if exit_px is not None:
            l2 += f" → 出場 {_fmt_price(exit_px)}"
        l3 = _fmt_dt(sig.get("t")) + (f" → {_fmt_dt(sig.get('ot'))}" if sig.get("ot") else "")
        tag = f"{market}:{exchange}:{symbol}:{tf}:{k}:{d}:tp"
    else:
        target = None
        if entry is not None and risk and rr is not None:
            target = entry - rr * risk if d == "s" else entry + rr * risk
        l1 = f"{label} {dir_txt}訊號"
        if rr is not None:
            l1 += f" · 盈虧比 {rr:.2g}"
        l2 = (f"進場 {_fmt_price(entry)}" if entry is not None else "")
        if target is not None:
            l2 += f" → 目標 {_fmt_price(target)}"
        l3 = (f"停損 {_fmt_price(stop)}" if stop is not None else "")
        if sig.get("t"):
            l3 += (" · " if l3 else "") + _fmt_dt(sig["t"])
        tag = f"{market}:{exchange}:{symbol}:{tf}:{k}:{d}:entry"

    body = "\n".join(x for x in (l1, l2, l3) if x)
    return {
        "title": title,
        "body": body,
        "tag": tag,
        "data": {"symbol": symbol, "market": market, "exchange": exchange, "tf": tf},
    }


def _process_combo(market, exchange, symbol, tf, subs_here, now):
    from routes.data import fetch_crt_df
    from utils.data import enrich_df
    from utils.crt import _calc_crt_winrate
    import routes.notify as notify

    iv = _interval_sec(tf)
    if not iv:
        return
    df = fetch_crt_df(market, symbol, tf, _monitor_days(tf), exchange)
    if df is None or len(df) < 50:
        return
    df = enrich_df(df)

    # 去掉「正在形成中」的最後一根（Binance 會把當前未收 K 放最後）→ 只看已收盤棒
    cur_open = math.floor(now / iv) * iv
    last_open = _epoch(df["time"].iloc[-1])
    if last_open >= cur_open:
        df = df.iloc[:-1]
        if len(df) < 50:
            return
        last_open = _epoch(df["time"].iloc[-1])

    # 資料太舊（停牌/抓不到新棒）→ 跳過，避免把舊訊號當新訊號推
    if now - (last_open + iv) > max(2 * iv, 180):
        return

    res = _calc_crt_winrate(df, long_only=(market == "tw"))
    signals = res.get("signals") or []
    if not signals:
        return

    fresh_cut = last_open - (FRESH_BARS - 1) * iv
    # 由舊到新處理，每個 scope 只推「比已推過的最新時間更新」的訊號 → 不重發、不漏發
    sigs = sorted((s for s in signals if s.get("k") and s.get("t")), key=lambda s: _epoch(s["t"]))
    new_max = {}   # scope -> 本輪推到的最新訊號時間
    for sig in sigs:
        k = sig["k"]; d = sig.get("d"); t = sig["t"]
        if _epoch(t) < fresh_cut:        # 舊訊號（不在最近數根收盤棒）→ 略過
            continue
        scope = f"{market}:{exchange}:{symbol}:{tf}:{k}:{d}"
        prev = new_max.get(scope) or notify.last_notified(scope)
        if prev and _epoch(t) <= _epoch(prev):   # 已推過（或更舊）→ 略過
            continue
        targets = [s for s in subs_here if k in (s["prefs"].get("sigs") or [])]
        if not targets:
            continue
        payload = _build_payload(symbol, market, exchange, tf, k, d, sig, event="entry")
        for s in targets:
            notify.send_push(s, payload)
        for nm_ in {s["name"] for s in targets}:
            notify.log_signal(nm_, now, "entry", payload["title"], payload["body"],
                              symbol, market, exchange, tf)
        new_max[scope] = t
    for scope, t in new_max.items():
        notify.mark_notified(scope, t)

    # ── 止盈通知：訊號剛在最近數根收盤棒「結算為 win」(觸及動態中軌) → 推一次 ──
    # 重用勝率計算結果：r=='w' 表示在停損前先碰到中軌(止盈)，ot 為結算時間（中軌逐根漂移，
    # 掃描本就逐根比當下中軌，正好對應使用者要的「會動的止盈」）。停損(l) 依使用者選擇不推。
    # 結算順序未必同進場順序 → 用逐事件精確去重（seen_event/mark_event）。
    for sig in sigs:
        if sig.get("r") != "w":          # 只看「止盈達成」；停損/未結算不推
            continue
        ot = sig.get("ot")
        if not ot or _epoch(ot) < fresh_cut:   # 結算棒不在最近數根 → 不新鮮
            continue
        k = sig["k"]; d = sig.get("d")
        targets = [s for s in subs_here if k in (s["prefs"].get("sigs") or [])]
        if not targets:
            continue
        evt_key = f"tp:{market}:{exchange}:{symbol}:{tf}:{k}:{d}:{sig['t']}"
        if notify.seen_event(evt_key):
            continue
        payload = _build_payload(symbol, market, exchange, tf, k, d, sig, event="tp")
        for s in targets:
            notify.send_push(s, payload)
        for nm_ in {s["name"] for s in targets}:
            notify.log_signal(nm_, now, "tp", payload["title"], payload["body"],
                              symbol, market, exchange, tf)
        notify.mark_event(evt_key)


def _tick(last_seen: dict):
    import routes.notify as notify
    if not notify.notify_enabled():
        return
    subs = notify.all_active_subs()
    if not subs:
        return
    now = time.time()

    # 套用「帳號級」偏好（時框/訊號）→ 同帳號的手機/電腦一致（每帳號讀一次）
    prefs_cache = {}
    for s in subs:
        nm = s["name"]
        if nm not in prefs_cache:
            prefs_cache[nm] = notify.account_prefs(nm)
        s["prefs"] = prefs_cache[nm]

    # 哪些時框「剛收一根新棒」（gating）→ 只算這些
    active_tfs = set()
    for s in subs:
        for tf in (s["prefs"].get("tfs") or []):
            if tf in _TF_SEC:
                active_tfs.add(tf)
    fresh_tfs = set()
    for tf in active_tfs:
        iv = _TF_SEC[tf]
        cur_open = math.floor(now / iv) * iv
        prev = last_seen.get(tf)
        last_seen[tf] = cur_open
        if prev is None or cur_open != prev:   # 首次見到 or 新棒收盤 → 處理
            fresh_tfs.add(tf)
    if not fresh_tfs:
        return

    # 組出唯一 (market,exchange,symbol,tf) → 關注它的訂閱清單（watchlist 每帳號快取一次）
    wl_cache = {}
    combos = {}
    for s in subs:
        name = s["name"]
        if name not in wl_cache:
            wl_cache[name] = notify.account_watchlist(name)
        for w in wl_cache[name]:
            sym = w.get("symbol")
            if not sym:
                continue
            mkt = w.get("market") or "crypto"
            exch = w.get("exchange") or "pionex"
            for tf in (s["prefs"].get("tfs") or []):
                if tf in fresh_tfs:
                    combos.setdefault((mkt, exch, sym, tf), []).append(s)

    for (mkt, exch, sym, tf), subs_here in combos.items():
        try:
            _process_combo(mkt, exch, sym, tf, subs_here, now)
        except Exception as e:
            print(f"  ⚠ 訊號監控 {mkt}:{exch}:{sym}:{tf} 失敗：{e}")


def run_monitor_loop():
    """背景執行緒入口（daemon）。"""
    last_seen = {}
    # 啟動後稍等，讓 app 完成預熱
    time.sleep(20)
    while True:
        try:
            _tick(last_seen)
        except Exception as e:
            print(f"  ⚠ 訊號監控 tick 失敗：{e}")
        time.sleep(CHECK_INTERVAL)


def start():
    threading.Thread(target=run_monitor_loop, daemon=True).start()
