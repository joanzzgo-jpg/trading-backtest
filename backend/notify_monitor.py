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

    # TP 跟著上下軌移動：用最新「已收盤」棒的上下軌，把未平自動倉的交易所 TP 重掛到對應軌
    # （空→下軌、多→上軌；只動 TP、不碰 SL）。retarget_auto_tp 內依各倉方向挑軌。
    try:
        from routes.trade import retarget_auto_tp
        if "bb_upper" in df.columns and "bb_lower" in df.columns:   # 上下軌欄位（crt.py _col_f("bb_upper"/"bb_lower")）
            _mi = -2 if forming else -1
            if len(df) >= abs(_mi):
                retarget_auto_tp(market, exchange, symbol, tf,
                                 float(df["bb_upper"].iloc[_mi]), float(df["bb_lower"].iloc[_mi]))
    except Exception as e:
        print(f"  ⚠ TP 移動 hook 失敗：{e}")

    res = _calc_crt_winrate(df, long_only=(market == "tw"))
    signals = res.get("signals") or []
    # S1~S12 已退役（無 edge）→ 不推播、不觸發自動交易；只保留 SS 系列（ss1/ss2）。
    signals = [s for s in signals if s.get("k") in ("ss1", "ss2")]

    fresh_cut = last_closed_open - (FRESH_BARS - 1) * iv

    # ── FVG 收盤確認進場（只 1h；獨立於 ss 訊號，故放在 ss 早退之前）─────────────
    # 進場訊號由 crt 的 fvg_sigs 產（收盤回補棒 + 固定 3W/6W；docs/fvg-strategy.md v2.3）。
    # 只下單、不推播訂閱者（execute_signal_trade 內建 owner 推播 + 逐帳號去重）。出場由交易所託管觸發單
    # 盤中即時觸發，下方 reconcile 只事後補記錄。
    if tf == "1h":
        try:
            _fsigs = sorted((s for s in (res.get("fvg_sigs") or []) if s.get("t")),
                            key=lambda s: _epoch(s["t"]))
            for _fs in _fsigs:
                if _epoch(_fs["t"]) < fresh_cut:        # 非最近數根收盤棒 → 不追舊缺口
                    continue
                if _fs.get("r") in ("w", "l"):          # 已結算 → 不追進場（避免開單即平倉）
                    continue
                _fd = _fs.get("d")
                _fscope = f"{market}:{exchange}:{symbol}:{tf}:fvg:{_fd}"
                _fprev = notify.last_notified(_fscope)
                if _fprev and _epoch(_fs["t"]) <= _epoch(_fprev):   # 已處理過（或更舊）→ 略過
                    continue
                try:
                    from routes.trade import execute_signal_trade
                    execute_signal_trade(market, exchange, symbol, tf, "fvg", _fd, _fs)
                except Exception as e:
                    print(f"  ⚠ FVG 自動交易 hook 失敗：{e}")
                notify.mark_notified(_fscope, _fs["t"])
        except Exception as e:
            print(f"  ⚠ FVG 進場處理失敗：{e}")

        # ── FVG 限價階梯版（影線版）：對 fvgEntry=='limit' 的帳號，『價格逼近缺口時』才掛三檔限價 ──
        # ⚠ 不在缺口一確認就掛(那會留一週殭屍掛單、卡保證金)：改成每根 1h 檢查「未過期(168根)+g+2已收盤+
        #    現價已逼近缺口(離最近檔 ≤ _NEAR_W 個 W)」才掛。限價單『提早一週掛』與『接近才掛』成交價相同，
        #    只要在價格觸及前掛上即可 → 省殭屍掛單/保證金，成交結果不變。place_fvg_limit_ladder 自帶去重。
        _NEAR_W = 1.5                                    # 現價進到離缺口 ≤1.5W 內算「逼近」
        try:
            from routes.trade import get_all_auto_cfgs, place_fvg_limit_ladder
            _limit_accts = [(nm, cfg) for nm, cfg in get_all_auto_cfgs()
                            if cfg.get("fvgEntry") == "limit"
                            and "fvg" in (cfg.get("sigs") or []) and "1h" in (cfg.get("tfs") or [])]
            if _limit_accts:
                try:
                    _px = float(df["close"].iloc[-2 if forming else -1])   # 現價＝最後已收盤棒收盤
                except Exception:
                    _px = None
                _alive_cut = last_closed_open - 167 * iv                    # 缺口確認後 168 根內仍有效
                for _g in (res.get("fvg") or []):
                    _gt = _g.get("t")
                    if not _gt or _px is None:
                        continue
                    _ge = _epoch(_gt)
                    if _ge < _alive_cut or _ge > last_closed_open - iv:     # 過期 / g+2 未收盤 → 略過
                        continue
                    _top = float(_g["top"]); _bot = float(_g["bot"]); _W = _top - _bot
                    if _W <= 0:
                        continue
                    # 逼近判定：多缺口價格由上往下跌近 top；空缺口由下往上漲近 bot。太遠 → 先不掛。
                    if _g.get("d") == "l":
                        if _px > _top + _NEAR_W * _W:
                            continue
                    else:
                        if _px < _bot - _NEAR_W * _W:
                            continue
                    for _nm, _cfg in _limit_accts:
                        try:
                            place_fvg_limit_ladder(_nm, _cfg, market, exchange, symbol, tf, _g)
                        except Exception as e:
                            print(f"  ⚠ FVG限價掛單 hook 失敗 {_nm}：{e}")
        except Exception as e:
            print(f"  ⚠ FVG限價處理失敗：{e}")

    # ── 自動交易出場對帳（所有 tf 都跑，含無 ss 訊號時的 FVG 倉）──────────────────
    # 出場全交給交易所掛的觸發單『盤中即時』觸發；此處只『對帳』：未平自動倉若交易所已無持倉
    # (觸發單已平) → 補記錄+通知。冪等且無持倉時只查一次 DB（無開倉列即略過、不打交易所 API）。
    # ⚠ 放在 ss 早退之前 → 修「該標的×時框無新 ss 訊號就早退、害既有自動倉平倉記錄/通知延宕」。
    try:
        from routes.trade import reconcile_auto_position
        reconcile_auto_position(market, exchange, symbol, tf)
    except Exception as e:
        print(f"  ⚠ 自動倉對帳 hook 失敗：{e}")
    # FVG 限價階梯版：pending 限價單成交偵測 → 掛 SL/TP / 過期撤單（只 1h，函式內已 gate）
    try:
        from routes.trade import reconcile_fvg_pending
        reconcile_fvg_pending(market, exchange, symbol, tf)
    except Exception as e:
        print(f"  ⚠ FVG限價對帳 hook 失敗：{e}")

    if not signals:
        return
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
        targets = [s for s in subs_here if s["prefs"].get("sigNotify", True) and k in (s["prefs"].get("sigs") or [])]
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

    # （自動交易出場對帳已上移到 ss 早退之前，所有 tf 都跑 → 不在此重複呼叫）

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
        targets = [s for s in subs_here if s["prefs"].get("sigNotify", True) and k in (s["prefs"].get("sigs") or [])]
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
    # 推播訂閱（推播未設 VAPID → 視為無訂閱，但自動交易仍要照跑）
    subs = notify.all_active_subs() if notify.notify_enabled() else []
    # 自動交易已開啟的帳號（獨立於推播訂閱）→ 即使沒開訊號通知，也要掃它們的標的×時框來進場。
    try:
        from routes.trade import get_all_auto_cfgs
        auto_cfgs = get_all_auto_cfgs()
    except Exception:
        auto_cfgs = []
    if not subs and not auto_cfgs:
        return
    now = time.time()

    # 套用「帳號級」偏好（時框/訊號）→ 同帳號的手機/電腦一致（每帳號讀一次）
    prefs_cache = {}
    for s in subs:
        nm = s["name"]
        if nm not in prefs_cache:
            prefs_cache[nm] = notify.account_prefs(nm)
        s["prefs"] = prefs_cache[nm]

    # 哪些時框「剛收一根新棒」（gating）→ 只算這些。納入推播訂閱 + 自動交易帳號各自的時框。
    active_tfs = set()
    for s in subs:
        for tf in (s["prefs"].get("tfs") or []):
            if tf in _TF_SEC:
                active_tfs.add(tf)
    for _nm, _cfg in auto_cfgs:
        for tf in (_cfg.get("tfs") or []):
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

    # 自動交易帳號（獨立於推播）：把它們的『合約自選 × 自動交易時框』也納入掃描。subs_here 留空＝
    # 此 combo 不推播、但 _process_combo 仍會跑 retarget/reconcile/execute_signal_trade（自動進場）。
    # 只收 crypto（自動交易僅支援永續）→ 不白掃台股/美股。combo 已存在(有訂閱者)則沿用、不覆蓋其清單。
    for name, cfg in auto_cfgs:
        if name not in wl_cache:
            wl_cache[name] = notify.account_watchlist(name)
        for w in wl_cache[name]:
            sym = w.get("symbol")
            if not sym or (w.get("market") or "crypto") != "crypto":
                continue
            mkt = w.get("market") or "crypto"
            exch = w.get("exchange") or "pionex"
            for tf in (cfg.get("tfs") or []):
                if tf in fresh_tfs:
                    combos.setdefault((mkt, exch, sym, tf), [])   # 確保此 combo 會被處理（無推播訂閱者）

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
