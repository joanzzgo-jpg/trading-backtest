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
    if k == "ss2":
        return "SS2"
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
    """event: entry=進場訊號 / tp=止盈達成 / sl=止損出場。"""
    dir_txt = "做空" if d == "s" else "做多"
    label = _sig_label(k)
    title = f"{symbol} · {tf}"
    entry = sig.get("entry"); stop = sig.get("stop"); rr = sig.get("rr")
    risk = abs(entry - stop) if (entry is not None and stop is not None) else None

    if event in ("tp", "sl"):
        rr_real = sig.get("rr_real")     # 止損時引擎已給 -1.0
        exit_px = None
        if entry is not None and risk and rr_real is not None:
            exit_px = entry - rr_real * risk if d == "s" else entry + rr_real * risk
        rr_show = rr_real if rr_real is not None else rr
        mark = "✅" if event == "tp" else "❌"   # 止盈勾勾 / 止損叉叉（推播與聊天室都吃 body）
        l1 = f"{mark} {label} {dir_txt} " + ("止盈達成" if event == "tp" else "止損出場")
        if rr_show is not None:
            l1 += f" · 盈虧比 {rr_show:+.2f}"
        l2 = (f"進場 {_fmt_price(entry)}" if entry is not None else "")
        if exit_px is not None:
            l2 += f" → 出場 {_fmt_price(exit_px)}"
        l3 = _fmt_dt(sig.get("t")) + (f" → {_fmt_dt(sig.get('ot'))}" if sig.get("ot") else "")
        tag = f"{market}:{exchange}:{symbol}:{tf}:{k}:{d}:{event}"
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
        # t=進場訊號棒時間（UTC naive ISO）→ 前端點通知可跳到對應時框與時間位置
        "data": {"symbol": symbol, "market": market, "exchange": exchange, "tf": tf,
                 "t": str(sig.get("t") or "")},
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

    # ⚠ 不丟「正在形成中」的最後一根：CRT 訊號棒需要「下一根(進場棒)」存在，引擎才會輸出
    #   （bull/bear 切片到 [1:n-1]，最後一根永遠不能當訊號棒）。若像以前丟掉形成棒，最後已收盤
    #   棒就變成最後一根→當不了訊號棒→要再等下一根收盤才偵測到，整整慢一根 K（曾發生：15m 訊號
    #   棒 11:15 一收盤主圖就標記，推播卻拖到 11:30）。保留形成棒當「進場棒」，即可在訊號棒一
    #   收盤就偵測並推播（＝主圖即時標記的時點）。進場價＝進場棒開盤（一形成即固定、不 repaint），
    #   且引擎絕不會把形成棒當訊號棒 → 進場訊號無盤中 repaint 風險；止盈(TP)另以收盤棒門檻防呆。
    cur_open = math.floor(now / iv) * iv
    last_row_open = _epoch(df["time"].iloc[-1])
    forming = last_row_open >= cur_open                     # Binance 把當前未收 K 放最後
    last_closed_open = last_row_open - iv if forming else last_row_open   # 最後「已收盤」棒的 open

    # 資料太舊（停牌/抓不到新棒）→ 跳過，避免把舊訊號當新訊號推
    if now - (last_closed_open + iv) > max(2 * iv, 180):
        return

    # TP 跟著中軌移動：用最新「已收盤」棒的中軌，把未平自動倉的交易所 TP 重掛到中軌（只動 TP、不碰 SL）
    try:
        from routes.trade import retarget_auto_tp
        if "bb_middle" in df.columns:        # 中軌欄位名（crt.py 用 _col_f("bb_middle")）
            _mi = -2 if forming else -1
            if len(df) >= abs(_mi):
                retarget_auto_tp(market, exchange, symbol, tf, float(df["bb_middle"].iloc[_mi]))
    except Exception as e:
        print(f"  ⚠ TP 移動 hook 失敗：{e}")

    res = _calc_crt_winrate(df, long_only=(market == "tw"))
    signals = res.get("signals") or []
    if not signals:
        return

    fresh_cut = last_closed_open - (FRESH_BARS - 1) * iv
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
        # 自動交易：新進場訊號 → 依設定下單（自帶逐事件去重，與推播成敗無關；絕不拋例外）
        # 傳入完整 signals（含結算結果）供「敗後停手」模擬
        try:
            from routes.trade import execute_signal_trade
            execute_signal_trade(market, exchange, symbol, tf, k, d, sig, all_signals=signals)
        except Exception as e:
            print(f"  ⚠ 自動交易 hook 失敗：{e}")
        targets = [s for s in subs_here if k in (s["prefs"].get("sigs") or [])]
        if not targets:
            continue
        payload = _build_payload(symbol, market, exchange, tf, k, d, sig, event="entry")
        ok = False
        for s in targets:
            ok = notify.send_push(s, payload) or ok
        # 全部裝置都發送失敗（推播服務暫時故障）→ 不標記已推、不記歷史，
        # 下一根收盤棒（FRESH_BARS 窗內）自動重試 → 修「有訊號卻沒收到」。
        if not ok:
            continue
        for nm_ in {s["name"] for s in targets}:
            notify.log_signal(nm_, now, "entry", payload["title"], payload["body"],
                              symbol, market, exchange, tf,
                              sig=k, d=d, sigt=str(t))
        new_max[scope] = t
    for scope, t in new_max.items():
        notify.mark_notified(scope, t)

    # ── 止盈/止損通知：訊號剛在最近數根收盤棒「結算」→ 各推一次 ──
    # 重用勝率計算結果：r=='w' 表示在停損前先碰到中軌(止盈)、r=='l' 表示先打到止損，
    # ot 為結算時間（中軌逐根漂移，掃描本就逐根比當下中軌＝會動的止盈）。
    # 結算順序未必同進場順序 → 用逐事件精確去重（seen_event/mark_event）。
    for sig in sigs:
        r = sig.get("r")
        if r not in ("w", "l"):          # 未結算不推
            continue
        ot = sig.get("ot")
        # 結算棒須「在最近數根」且「已收盤」：保留形成棒後，止盈/止損可能由形成棒的盤中
        # 高低點觸發 → 那是 intrabar、會 repaint，不可推（與「收盤確認」一致，故 ot 限收盤棒）。
        if not ot or _epoch(ot) < fresh_cut or _epoch(ot) > last_closed_open:
            continue
        k = sig["k"]; d = sig.get("d")
        # 自動交易：策略判定止盈/止損 → 平掉對應自動倉位（冪等：無對應開倉紀錄就不動）
        try:
            from routes.trade import settle_signal_trade
            settle_signal_trade(market, exchange, symbol, tf, k, d, sig,
                                "tp" if r == "w" else "sl")
        except Exception as e:
            print(f"  ⚠ 自動平倉 hook 失敗：{e}")
        targets = [s for s in subs_here if k in (s["prefs"].get("sigs") or [])]
        if not targets:
            continue
        event = "tp" if r == "w" else "sl"
        evt_key = f"{event}:{market}:{exchange}:{symbol}:{tf}:{k}:{d}:{sig['t']}"
        if notify.seen_event(evt_key):
            continue
        payload = _build_payload(symbol, market, exchange, tf, k, d, sig, event=event)
        ok = False
        for s in targets:
            ok = notify.send_push(s, payload) or ok
        if not ok:                       # 全失敗 → 不標記，下一輪重試
            continue
        for nm_ in {s["name"] for s in targets}:
            notify.log_signal(nm_, now, event, payload["title"], payload["body"],
                              symbol, market, exchange, tf,
                              sig=k, d=d, sigt=str(sig["t"]))
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
