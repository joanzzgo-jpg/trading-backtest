"""CRT 策略訊號掃描與勝率計算（numpy 向量化加速版，含中軌＋帶軌雙目標）

對比舊版以 df.iloc[i].get(col) 逐 row 取值的寫法，本版預先把所有欄位抽成 numpy array：
- 6 個主要迴圈用 vectorized mask 找出候選 index，只跑符合條件的少數幾根 K 棒
- _scan_outcome 用 array 直接取值，省下 pandas Series 介面成本（~10-50x faster）
- 每個訊號同時計算「中軌目標」與「帶軌目標」的勝負結果，前端可切換顯示
"""
import bisect
import math
import numpy as np
import pandas as pd

# FVG 視覺缺口/策略標記(多空·破·順)只在「最後 _VISUAL_WINDOW 根」上計算(勝率統計不受此限)。
# 深時框(1h~60k根)把 O(缺口×觸碰掃描) 從 N 縮到此值 → 大幅提速；標記本就截尾([-2000:]/[-12000:])，
# 取足夠大即與全量一致。可調（越大越慢越完整）。
_VISUAL_WINDOW = 20000


def _ts_val(t) -> str:
    return t.isoformat() if hasattr(t, "isoformat") else str(t)


_SCAN_MAX_HOLD = 500   # 單個訊號最長掃描 K 棒數（避免最近的未結算訊號掃到資料底）

def _first_le_idx(arr, start, thr):
    """arr[start:] 中第一個 <= thr 的索引（回傳全域索引；無則 -1）。
    NaN <= thr → False，與逐根 Python 比較完全一致（NaN 比較恆 False）。"""
    if start >= arr.shape[0]:
        return -1
    m = arr[start:] <= thr
    if not m.any():
        return -1
    return start + int(m.argmax())

def _first_ge_idx(arr, start, thr):
    """arr[start:] 中第一個 >= thr 的索引（回傳全域索引；無則 -1）。NaN >= thr → False。"""
    if start >= arr.shape[0]:
        return -1
    m = arr[start:] >= thr
    if not m.any():
        return -1
    return start + int(m.argmax())


def _calc_crt_winrate(df: pd.DataFrame, stop_buffer_pct: float = 0.0, long_only: bool = False,
                      band_ratio: float = 1.0, visual_window: int = 0,
                      stock_gap: bool = False, proto_min: float = 0.0005,
                      no_proto_ms: bool = False, no_proto_break: bool = False) -> dict:
    """no_proto_ms / no_proto_break=True：分別讓「多/空」與「破多/破空」的 B 觸發
    從單根 proto(收盤站上前根高/破前根低、非repaint)換成正常 3 根 FVG(g+1 確認、
    L[g+1]>H[g-1] / H[g+1]<L[g-1]，沿用 setup A 的 _gaps_seq 定義)。兩者獨立。"""
    """
    算主圖策略標記：FVG 缺口、多/空、破多空、順多空、特多空、研究用進出場點、VWAP，
    以及給自動交易的 fvg_sigs。（勝率統計與 S1~S12／SS 訊號已移除，見 docs/crt-winrate.md。）

    long_only：True 時只算多單（台股不能放空）。
    stop_buffer_pct / band_ratio：只影響已移除的訊號統計，參數保留給呼叫端與快取鍵，不參與計算。
    """
    n = len(df)

    # ── 全部欄位一次抽成 numpy array（避免在 6 個迴圈內反覆 df.iloc）──
    # 時間戳→ISO 字串：向量化（numpy datetime64[s]→str），取代逐根 _ts_val + pandas 慢速 __iter__，
    # 省下整體計算 ~30% 時間。tz-naive 秒精度下與 _ts_val(t.isoformat()) 完全一致；異常時退回逐根。
    try:
        times_iso = df["time"].to_numpy("datetime64[s]").astype(str).tolist()
    except Exception:
        times_iso = [_ts_val(t) for t in df["time"]]
    highs  = df["high"].to_numpy(dtype=float)
    lows   = df["low"].to_numpy(dtype=float)
    closes = df["close"].to_numpy(dtype=float)
    # 進場價：用次根 open；若無 open 欄位（不應該發生）退回用 close
    opens  = df["open"].to_numpy(dtype=float) if "open" in df.columns else closes

    def _col_f(name):
        if name not in df.columns:
            return np.full(n, np.nan, dtype=float)
        return df[name].to_numpy(dtype=float)

    bb_mid = _col_f("bb_middle")
    bb_up  = _col_f("bb_upper")
    bb_lo  = _col_f("bb_lower")
    # （band_ratio 原本用來算「帶軌止盈目標」陣列，只供已移除的訊號勝負掃描使用 → 2026-09-17 刪除；
    #   參數保留，快取鍵仍帶它，呼叫端不必改。）

    # ── S1~S12（2026-07）、SS1/SS2（2026-08-05）訊號與整套勝率統計（中軌/帶軌/1:1、連敗、敗後停手、
    #    近期勝率…）皆已移除；2026-09-17 刪掉最後殘留的「對空資料算出全零」的統計機器與輸出鍵。──
    from_date = str(df.iloc[0]["time"])[:10] if n else ""

    # ── FVG（失衡缺口，主圖視覺標記用）────────────────────────────
    # 三根K [g-1],[g],[g+1]：多頭FVG(支撐) low[g+1]>high[g-1]；空頭FVG(壓力) high[g+1]<low[g-1]。
    # 缺口寬度 > 門檻(0.3%)才算。回 {t(=g+1棒時間), top, bot, d('l'/'s'), t2(被填補時間或None)}。
    #
    # _fvg_sigs：FVG「收盤確認版」進場訊號（給自動交易；定版規格見 docs/fvg-strategy.md v2.3）。
    #   進場＝缺口確認後、168 根(1h=一週)新鮮度內，第一根『收盤回到缺口區 [bot,top]』的 K（市價進場、成交確定）。
    #   止損/止盈固定 2W/6W（W=top−bot；與前端視覺盒一致，實盤定版鎖定 2/6）。r/ot=自進場後模擬先碰
    #   止損(l)/止盈(w)，皆未碰→None(live)。獨立於 signals，不污染勝率 HUD；只在 1h 由 notify_monitor 觸發。
    _fvg = []
    _fvg_sigs = []
    _gaplist = []          # (cf_bar, top, bot, dir) 給「接1次」cascade 進出場標記用
    _bbgaps  = []          # (cf_bar, top, bot, dir) 給「布林外+FVG」均值回歸研究標記（不套 g+2 過濾，對齊 fvg_bb.py 回測）
    _fvg_break = []        # 「破多/破空」結構轉破標記(跑 proto 缺口序列、標在 g) [{t,p,d}]
    _fvg_ms    = []        # 「多/空」方向標記 [{t,d}]（吃到 setup FVG 後、窗內首次同向 proto 缺口 B，標在 B 的 g）
    _fvg_shun  = []        # 「順多/順空」：第一步同多/空(吃到未觸碰同向FVG)，第二步=影線穿透既存反向FVG [{t,d}]
    _fvg_special = []      # 「特多/特空」：多空/破多空序列 A→B→C 三連市場結構(標在 C) [{t,d}]
    _gaps_seq  = []        # (cf_bar, top, bot, dir) 依時間序的所有視覺缺口（給上面結構模式偵測用）
    try:
        _N = len(times_iso); _MS = 0.0001   # 視覺最小缺口 0.01%（自動交易訊號另設 0.3% 門檻，見下）
        _FRESH = 168          # 缺口新鮮度：確認後 168 根(1h=一週)內未回補 → 作廢、不產進場訊號
        _MAXHOLD = 200        # 最長持有：進場後 200 根仍未觸發止盈/止損 → 視為仍 live(不在此處強平)
        _last_gap = {"l": None, "s": None}  # 每方向「上一個同向缺口」(bot, W)；下方0.5W帶內的同向缺口→無效(淺色不採用)；無效缺口也連鎖往下傳
        # numpy→list 一次轉換：FVG 主迴圈逐元素存取，list(float) 遠快於 numpy 標量+float()
        #（與 _fvg_bb / _fvg_trades 區塊同一手法；NaN 轉 list 後仍 float('nan')，x!=x 判定不變）。
        _H = highs.tolist(); _L = lows.tolist(); _C = closes.tolist(); _O = opens.tolist()
        # 成交量 list（fvg_ms 止盈用：往後找「量>標記棒且同色確認棒」）；無欄位→全 NaN(比較恆 False→不觸發止盈)
        _Vms = (df["volume"].to_numpy(dtype=float).tolist() if "volume" in df.columns else [float("nan")] * _N)
        # 策略止損 = 標記棒往左跳過同向棒、找到「連續反色 K run」，取那段的極值：
        #   做空(空/破多)→ 往回跳過綠K找到紅K，收整段連續紅K，取最高 High(_swing_hi)。
        #   做多(多/破空)→ 往回跳過紅K找到綠K，收整段連續綠K，取最低 Low(_swing_lo)。
        #   紅K=收>開(up)、綠K=收<開(down)。回推上限 120 根；找不到反色 run → 退回標記前一根極值。
        def _swing_hi(_m):
            _lim = _m - 120; _j = _m - 1
            while _j >= 0 and _j >= _lim and not (_C[_j] > _O[_j]): _j -= 1   # 跳過非紅K(綠/doji)
            if _j < 0 or _j < _lim: return _H[_m - 1] if _m > 0 else _H[_m]
            _hi = _H[_j]
            while _j >= 0 and _j >= _lim and (_C[_j] > _O[_j]):               # 連續紅K run
                if _H[_j] > _hi: _hi = _H[_j]
                _j -= 1
            return _hi
        def _swing_lo(_m):
            _lim = _m - 120; _j = _m - 1
            while _j >= 0 and _j >= _lim and not (_C[_j] < _O[_j]): _j -= 1   # 跳過非綠K(紅/doji)
            if _j < 0 or _j < _lim: return _L[_m - 1] if _m > 0 else _L[_m]
            _lo = _L[_j]
            while _j >= 0 and _j >= _lim and (_C[_j] < _O[_j]):               # 連續綠K run
                if _L[_j] < _lo: _lo = _L[_j]
                _j -= 1
            return _lo
        # 視覺標記只需近段窗（圖上不會回看數年）：FVG 缺口/策略(多空·破·順)只在最後 _VW 根上算，
        #   把整段 O(缺口×觸碰掃描) 從 N 縮到 _VW → 深時框(1h~60k根)大幅提速。勝率統計(S1~SS)仍走全歷史、不受此限。
        #   _VW 取足夠大(遠超可視+合理回捲)，且各標記本就截尾([-2000:]/[-12000:])，近段結果與全量一致。
        _VW = int(visual_window) if visual_window and visual_window > 0 else _VISUAL_WINDOW
        _vw0 = max(1, _N - _VW)
        # ── 資料時間洞防護（連續市場 crypto 專用）──────────────────────────────────
        #   crypto 24/7 本不該缺根；但 df 若有大洞（曾見 BTC 1h 缺 2023→2026 整段），陣列上
        #   相鄰的兩列其實跨了數月/數年 → 3 根 FVG／proto 缺口會把它們當連續 K，製造 100%+
        #   的假缺口（bot 取到多年前舊棒高點）。這裡預算秒級時間戳與名目間隔，迴圈中跳過
        #   「三根外側跨距(g-1→g+1)遠超名目 2 根」的偽缺口。股票的隔盤跳空是合法特徵→不套用。
        try:
            _secs = df["time"].to_numpy("datetime64[s]").astype("int64")
        except Exception:
            _secs = None
        _bar_sec = 0
        if _secs is not None and len(_secs) > 10:
            _dd = np.diff(_secs); _dd = _dd[_dd > 0]
            if len(_dd):
                _bar_sec = int(np.median(_dd))
        # 外側跨距名目=2 根；放寬到 5 根（容忍偶發缺一兩根），超過＝資料斷層→該三根不成立缺口。
        _gap_span_max = 5 * _bar_sec if _bar_sec > 0 else 0
        _gap_guard = (not stock_gap) and _secs is not None and _gap_span_max > 0
        for _g in range(_vw0, _N - 1):
            if _gap_guard and (_secs[_g+1] - _secs[_g-1]) > _gap_span_max:
                continue   # 跨資料斷層：g-1/g+1 陣列相鄰但時間差極大→非真連續 K，不造缺口
            _h0 = _H[_g-1]; _l0 = _L[_g-1]
            _h2 = _H[_g+1]; _l2 = _L[_g+1]
            # NaN 檢查（x != x 只有 NaN 成立）。⚠ 不用 any(genexpr)：這個迴圈跑遍全部 K 棒，
            #   每輪都要建一個 tuple + 一個 generator，profile 上是熱點（實測 any 被呼叫 ~2 萬次/次計算）。
            #   直接展開成短路比較，語意完全相同且大多數情況第一項就結束。
            if _h0 != _h0 or _l0 != _l0 or _h2 != _h2 or _l2 != _l2:
                continue
            if _l2 > _h0 and (_l2 - _h0) / _h0 > _MS:          # 多頭缺口（支撐）候選
                _dir, _top, _bot = "l", _l2, _h0
            elif _h2 < _l0 and (_l0 - _h2) / _l0 > _MS:        # 空頭缺口（壓力）候選
                _dir, _top, _bot = "s", _l0, _h2
            else:
                continue
            # 股票：缺口＝「g 實體處沒被 g-1/g+1 影線刷到」的部分。上/下緣(g-1/g+1 影線=_top/_bot)再夾進 g 的實體範圍——
            #   g-1/g+1 影線刷到的、以及 g 實體以外的都扣掉；夾完沒剩(top<=bot)＝g 實體被刷滿/實體在缺口外→非真跳空→不畫。
            #   1313 1/28：g 是十字、實體(11.25)在缺口[11.05,11.15]外→不畫；6/4：g 實體被 g+1 下影刷滿→不畫。加密不做、維持原定義。
            if stock_gap:
                _bl = _O[_g] if _O[_g] < _C[_g] else _C[_g]   # g 實體下緣
                _bh = _C[_g] if _O[_g] < _C[_g] else _O[_g]   # g 實體上緣
                if _bl > _bot: _bot = _bl
                if _bh < _top: _top = _bh
                if _top <= _bot:
                    continue
            _gw = (_top - _bot) / (_bot if _dir == "l" else _top)
            if _gw <= _MS:
                continue
            # ── 融合單趟掃描：一次算出 _t2/_midi(中線填補)、_ett/_etm/_etb(上/中/下緣首觸)、_pens(逐深突破)。
            #   原本是三個各自 range(_g+2,_N) 的掃描(其中 _t2 與 _etm 條件完全相同、重複掃)；三合一省 ~2/3 迭代。
            #   終止：觸及最遠緣(多=下緣/空=上緣)那一刻，三者本來就同時完成(_etb/_ett 定、pens 到底) → 同點 break。
            _midi = None; _ett = _etm = _etb = None; _pens = []; _pm = None
            _mid = (_top + _bot) / 2.0
            for _j in range(_g + 2, _N):
                if _dir == "l":
                    _lj = _L[_j]
                    if _lj > _top: continue                          # 沒碰進區間
                    if _ett is None: _ett = times_iso[_j]            # 首觸上緣
                    if _etm is None and _lj <= _mid: _etm = times_iso[_j]; _midi = _j   # 中線(=填補點)
                    if _etb is None and _lj <= _bot: _etb = times_iso[_j]
                    _pv = _bot if _lj < _bot else _lj                # 封底於下緣
                    if _pm is None or _pv < _pm:
                        _pm = _pv; _pens.append({"t": times_iso[_j], "p": _pv})
                        if _pv <= _bot: break                        # 到下緣→上中下緣皆定、pens 完成
                else:
                    _hj = _H[_j]
                    if _hj < _bot: continue
                    if _etb is None: _etb = times_iso[_j]            # 首觸下緣(近端)
                    if _etm is None and _hj >= _mid: _etm = times_iso[_j]; _midi = _j
                    if _ett is None and _hj >= _top: _ett = times_iso[_j]
                    _pv = _top if _hj > _top else _hj                # 封頂於上緣
                    if _pm is None or _pv > _pm:
                        _pm = _pv; _pens.append({"t": times_iso[_j], "p": _pv})
                        if _pv >= _top: break
            _sweep = (_l0 < _L[_g] and _l0 < _l2) if _dir == "l" else (_h0 > _H[_g] and _h0 > _h2)
            # 交易位階(視覺)：止盈=2W(W=top−bot,多 top+2W／空 bot−2W)、止損=g-1 頂端(high[g-1]=_h0)。
            _W = _top - _bot
            _gsl = _h0                                               # g-1 的頂端(高點)
            _gtp = (_top + 2 * _W) if _dir == "l" else (_bot - 2 * _W)   # 止盈 2W
            # IFVG 反轉偵測：進場(到中線)後，先收盤穿破止損側(沒到止盈) → 反轉成反向 IFVG。
            _inv_t = None; _invi = None
            if _midi is not None:
                for _k in range(_midi, _N):
                    if _dir == "l":
                        if _H[_k] >= _gtp: break                                     # 先到止盈 → 不反轉
                        if _C[_k] < _gsl: _inv_t = times_iso[_k]; _invi = _k; break  # 收盤破止損(g-1頂端) → 反轉
                    else:
                        if _L[_k]  <= _gtp: break
                        if _C[_k] > _gsl: _inv_t = times_iso[_k]; _invi = _k; break  # 收盤破止損(g-1頂端) → 反轉
            # 原缺口色塊右緣：股票(stock_gap)＝「被後面 K 棒影線一碰到缺口(首觸緣 _ett)就結束/消失」
            #   (使用者定義：缺口被影線碰到即失效，不等碰中線)；未被碰過(_ett None)則延伸到右緣。
            #   加密：反轉→延伸到反轉點；否則止於「完全填補點」(多=觸下緣 _etb／空=觸上緣 _ett)。
            #   ⚠ 使用者要求：「沒完全填補的 FVG 要延續」→ 從『碰中線就停(_t2/_etm)』改為『碰最遠緣才停』；
            #     從未完全填補(_full_fill=None)→ _box_t2=None → 前端延伸到現價。只動視覺盒右緣，
            #     進場/勝率仍用 _midi/_etm/pens(不變)。
            _full_fill = _etb if _dir == "l" else _ett
            _box_t2 = _ett if stock_gap else (_inv_t if _inv_t is not None else _full_fill)
            # (_ett/_etm/_etb 上中下緣首觸 與 _pens 逐深突破 已於上方融合掃描算好)
            # 同向缺口堆疊去重：若本缺口頂端(top)落在「上一個同向缺口下緣往下 0.5W」帶內
            #   [botA-0.5*W_A, botA] → 視為太貼近上方缺口 → 無效(dim：前端淺色、不產生交易訊號)。
            #   連鎖：基準用「上一個同向缺口」不論其有效/無效，無效缺口也讓下方0.5W內的同向缺口跟著無效。
            _A = _last_gap[_dir]            # (botA, W_A)
            _dim = (_A is not None and (_A[0] - 0.5 * _A[1]) <= _top <= _A[0])
            _last_gap[_dir] = (_bot, _W)    # 不論 dim，更新為本缺口 → 連鎖向下傳遞
            # 前端可選過濾用旗標（read-only、不影響偵測/勝率）：
            #   go=g 的方向(收-開)與 g-1、g+1 皆相反(中間那根逆兩側)；gv=g 成交量 < g+1 成交量。
            _gd  = 1 if _C[_g]   > _O[_g]   else (-1 if _C[_g]   < _O[_g]   else 0)
            _gd1 = 1 if _C[_g-1] > _O[_g-1] else (-1 if _C[_g-1] < _O[_g-1] else 0)
            _gd2 = 1 if _C[_g+1] > _O[_g+1] else (-1 if _C[_g+1] < _O[_g+1] else 0)
            _go = bool(_gd != 0 and _gd != _gd1 and _gd != _gd2)
            _vg = _Vms[_g]; _vg2 = _Vms[_g+1]
            _gv = bool(_vg == _vg and _vg2 == _vg2 and _vg < _vg2)   # NaN 安全
            _fvg.append({"t": times_iso[_g+1], "top": _top, "bot": _bot, "d": _dir, "t2": _box_t2,
                         "sweep": _sweep, "sl": _gsl, "tp": _gtp, "dim": _dim, "gi": _g + 1,
                         "go": _go, "gv": _gv,
                         "ett": _ett, "etm": _etm, "etb": _etb, "pens": _pens})    # gi=缺口索引；pens=每次更深突破點
            _gaps_seq.append((_g + 1, _top, _bot, _dir))   # 依序記錄每個視覺缺口（結構模式偵測用，含 dim）
            # IFVG：反方向換色，從反轉點續延，到自己回中線被填補(或右緣)為止；位階用反向(止盈反向1W、止損=被破對側邊)。
            #   股票：缺口一被影線碰到就消失(見上)，不做 IFVG 反轉延續 → 略過。
            if _inv_t is not None and not stock_gap:
                _idir = "s" if _dir == "l" else "l"
                _isl = _top if _dir == "l" else _bot                       # 反向止損＝被破的對側邊
                _itp = (_bot - 2 * _W) if _dir == "l" else (_top + 2 * _W)   # 反向止盈 2W
                # IFVG 進場分上中下：反向後框上/中/下緣各自首次觸及（向量化：三緣各取首觸索引）。
                #   與原逐根迴圈等價——原迴圈用 `is None` 守衛=各緣「首次」，break 只在三者皆得後停掃、不改值。
                _s = _invi + 1
                if _idir == "l":   # 用 numpy 版 lows/highs（_L/_H 是 .tolist()）；值與 NaN 行為一致 → 索引相同
                    _ia = _first_le_idx(lows, _s, _top); _ib = _first_le_idx(lows, _s, _mid); _ic = _first_le_idx(lows, _s, _bot)
                else:
                    _ia = _first_ge_idx(highs, _s, _top); _ib = _first_ge_idx(highs, _s, _mid); _ic = _first_ge_idx(highs, _s, _bot)
                _iett = times_iso[_ia] if _ia >= 0 else None
                _ietm = times_iso[_ib] if _ib >= 0 else None
                _ietb = times_iso[_ic] if _ic >= 0 else None
                _it2 = _ietm                       # 盒子右端＝反向回中線
                _fvg.append({"t": _inv_t, "top": _top, "bot": _bot, "d": _idir, "t2": _it2,
                             "sweep": False, "sl": _isl, "tp": _itp, "inv": True, "dim": _dim,
                             "ett": _iett, "etm": _ietm, "etb": _ietb})

            # 無效缺口(下方0.5W帶內堆疊)：不採用 → 不產生任何交易訊號/cascade 標記（僅前端淺色顯示）。
            if _dim:
                continue
            # 以下自動交易訊號 + cascade 標記維持 0.3% 最小寬度（行為不變；視覺色塊不受此限）。
            if _gw < 0.003:
                continue
            _bbgaps.append((_g + 1, _top, _bot, _dir))   # 0.3%+ 缺口全收（不套 g+2），給布林外+FVG 研究標記

            # g+2 觸框過濾：缺口後下一根(g+2)觸及上框(多)/下框(空) → 假突破，作廢。
            #   ⚠ 只用於下方自動交易訊號(_fvg_sigs)＋cascade 標記，不影響上面的純 FVG 視覺色塊。
            # 回測驗證(1h 規格8幣 + 19幣):DD 腰斬(−10%→−6%)、報酬/DD 升 30~56%、保留缺口 avgR 更高。
            if _g + 2 < _N:
                if _dir == "l" and _L[_g+2]  <= _top: continue
                if _dir == "s" and _H[_g+2] >= _bot: continue
            _gaplist.append((_g + 1, _top, _bot, _dir))

            # ── 收盤確認進場訊號（2W/6W 固定 SL/TP；與視覺盒一致）──────────────────
            _W = _top - _bot
            if _W <= 0:
                continue
            _stop = (_bot - 2 * _W) if _dir == "l" else (_top + 2 * _W)
            _tp   = (_top + 6 * _W) if _dir == "l" else (_bot - 6 * _W)
            # 進場棒：拒絕型收盤確認（對齊已驗證 sim_confirm，逐年全正/抗滑價的定版）——
            # 多：插進缺口(low≤top) 但收盤站回 bot 上方(沒插穿) → 市價收盤進場；
            #     進場前若有 K 收破止損區(close<stop) → 放棄此缺口(不追)。空為鏡像。
            _ei = None
            _jend = min(_N, _g + 2 + _FRESH)
            for _j in range(_g + 2, _jend):
                _cj = _C[_j]; _lj = _L[_j]; _hj = _H[_j]
                if _cj != _cj or _lj != _lj or _hj != _hj:      # NaN
                    continue
                if _dir == "l":
                    if _lj <= _top and _cj > _bot: _ei = _j; break   # 插進缺口、收盤站回
                    if _cj < _stop: break                            # 進場前收破止損 → 放棄
                else:
                    if _hj >= _bot and _cj < _top: _ei = _j; break
                    if _cj > _stop: break
            if _ei is None:                                     # 未回補 / 進場前已破止損 → 不產訊號
                continue
            _r = None; _ot = None                               # 自進場次根模擬：先碰止損(l)/止盈(w)
            _hend = min(_N, _g + 2 + _MAXHOLD)                  # 持有上限自確認棒(g+1)起算，對齊 sim_confirm
            for _k in range(_ei + 1, _hend):
                _hk = _H[_k]; _lk = _L[_k]
                if _hk != _hk or _lk != _lk:
                    continue
                if _dir == "l":
                    if _lk <= _stop: _r = "l"; _ot = times_iso[_k]; break   # 先看止損（保守：同棒兩中先認賠）
                    if _hk >= _tp:   _r = "w"; _ot = times_iso[_k]; break
                else:
                    if _hk >= _stop: _r = "l"; _ot = times_iso[_k]; break
                    if _lk <= _tp:   _r = "w"; _ot = times_iso[_k]; break
            _fvg_sigs.append({"k": "fvg", "d": _dir, "t": times_iso[_ei],
                              "entry": _C[_ei], "stop": _stop, "tp": _tp,
                              "r": _r, "ot": _ot})
        # ── 股票隔盤跳空缺口（2 根相鄰、影線對影線）───────────────────────────────
        #   加密 24/7 無跳空 → stock_gap=False 時整段跳過，加密行為 100% 不變（此區完全獨立於上方 3 根 FVG）。
        #   跳空本身即 FVG：向上跳空 low[g] > high[g-1](支撐)、向下跳空 high[g] < low[g-1](壓力)；
        #   缺口上下緣一律用影線(high/low) 定，不用實體。只產生「視覺缺口盒」(含首觸上/中/下緣、逐深突破、
        #   中線填補、IFVG 反轉換色)，標 gap=True；不動 多空/破/順 策略序列(要不要讓跳空驅動策略是下一步)。
        if stock_gap:
            for _g in range(_vw0, _N - 1):
                _h0 = _H[_g-1]; _l0 = _L[_g-1]; _hg = _H[_g]; _lg = _L[_g]
                if any(_v != _v for _v in (_h0, _l0, _hg, _lg)):   # NaN
                    continue
                if _lg > _h0 and (_lg - _h0) / _h0 > _MS:          # 向上跳空（支撐）
                    _dir, _top, _bot, _gsl = "l", _lg, _h0, _h0
                elif _hg < _l0 and (_l0 - _hg) / _l0 > _MS:        # 向下跳空（壓力）
                    _dir, _top, _bot, _gsl = "s", _l0, _hg, _h0
                else:
                    continue
                _mid = (_top + _bot) / 2.0; _W = _top - _bot
                # 融合單趟掃描：首觸上/中/下緣(_ett/_etm/_etb)、中線填補(_t2/_midi)、逐深突破(_pens)。掃描自 g+1 起。
                _midi = None; _ett = _etm = _etb = None; _pens = []; _pm = None
                for _j in range(_g + 1, _N):
                    if _dir == "l":
                        _lj = _L[_j]
                        if _lj > _top: continue
                        if _ett is None: _ett = times_iso[_j]
                        if _etm is None and _lj <= _mid: _etm = times_iso[_j]; _midi = _j
                        if _etb is None and _lj <= _bot: _etb = times_iso[_j]
                        _pv = _bot if _lj < _bot else _lj
                        if _pm is None or _pv < _pm:
                            _pm = _pv; _pens.append({"t": times_iso[_j], "p": _pv})
                            if _pv <= _bot: break
                    else:
                        _hj = _H[_j]
                        if _hj < _bot: continue
                        if _etb is None: _etb = times_iso[_j]
                        if _etm is None and _hj >= _mid: _etm = times_iso[_j]; _midi = _j
                        if _ett is None and _hj >= _top: _ett = times_iso[_j]
                        _pv = _top if _hj > _top else _hj
                        if _pm is None or _pv > _pm:
                            _pm = _pv; _pens.append({"t": times_iso[_j], "p": _pv})
                            if _pv >= _top: break
                _gtp = (_top + 2 * _W) if _dir == "l" else (_bot - 2 * _W)   # 止盈 2W（與 3 根版同位階）
                # IFVG 反轉：到中線後先收盤穿破止損側(g-1 影線緣，這裡＝缺口對側 _gsl) → 反轉換色
                _inv_t = None; _invi = None
                if _midi is not None:
                    for _k in range(_midi, _N):
                        if _dir == "l":
                            if _H[_k] >= _gtp: break
                            if _C[_k] < _gsl: _inv_t = times_iso[_k]; _invi = _k; break
                        else:
                            if _L[_k] <= _gtp: break
                            if _C[_k] > _gsl: _inv_t = times_iso[_k]; _invi = _k; break
                _box_t2 = _ett   # 股票跳空缺口：被後面 K 棒影線首觸即結束/消失(不等中線、不做反轉)
                _fvg.append({"t": times_iso[_g], "top": _top, "bot": _bot, "d": _dir, "t2": _box_t2,
                             "sweep": False, "sl": _gsl, "tp": _gtp, "dim": False, "gi": _g,
                             "ett": _ett, "etm": _etm, "etb": _etb, "pens": _pens, "gap": True})
                # 股票缺口碰到即消失 → 不畫 IFVG 反轉延續（原本這裡是一段 `if False:` 的反轉延續實作，2026-09-17 刪除）
        _fvg = _fvg[-20000:]        # 平衡值:5m ~8個月缺口盒(一年 3.4萬=15MB payload 太重);方向標記 fvg_ms 另留一年(輕)
        _fvg_sigs = _fvg_sigs[-200:]

        # ── 結構轉破（破多/破空）：實際計算改跑在 proto 缺口序列上（見下方 多/空 之後的區塊）──────
        # _used：被任一標記用到的 3 根缺口索引 gi；其餘前端淡化。破多/破空改跑 proto 缺口後不再貢獻 gi，
        #        由 多/空(setup A)＋順 標記決定 used。這裡只先初始化(多/空與順會 add)。
        _used = set()

        # ── 「多/空」方向標記（2026-07-01 定義；07-03 B 改 proto 缺口·g 收盤定緣、不等 g+1）──────────
        # 空/多：setup A＝一個做空/做多 3 根 FVG，被 K 棒「逐錨更深觸碰」(封頂/封底、上/下影衝過緣 _MSOVR 作廢)後，
        #       窗(_MSWIN)內「首次新產生同向 proto 缺口」(B) → 標於 B 的 g 那根(不等 g+1)。
        #   B＝proto 缺口(下方偵測)：把原本被 g+1 限制的那條緣改用 g 自己的收盤 C[g]、g 那根即成立，
        #     右邊 g+1 只檢查沒把缺口收盤填回(干擾)。⚠ 加密 24/7 連續盤不用「g.low>g-1.high」字面 2 根缺口(必 0 個)。
        # 約束：觸碰→B 之間不能夾任何反向缺口(除非觸碰棒 cf−touch≤2 順手做的)；
        #       多：B下緣>A下緣 且 B上緣>A上緣(不得完全被A包住、可部分重疊)；空：B下緣<A上緣(重疊可)。不套「B寬<A寬」。
        # ★ 2026-09-17「跳到下一根有意義的觸碰」：多/空、順多/順空的 4 個觸碰迴圈原本對每個缺口
        #   逐根往後掃到資料尾端，絕大多數棒走 `continue`（沒碰進缺口、或沒有更深）。改成用區間極值
        #   稀疏表＋二分跳躍直接找下一根「可能改變狀態」的棒 —— 被跳過的棒在逐根版一定是 continue、
        #   不改任何狀態 → 輸出逐位元相同（守門員：對照舊版逐欄比對，含注入 NaN 的資料）。
        #   可能改變狀態的棒（做空方向，看 high；做多鏡像看 low）：
        #     還沒有錨(None)或錨是 NaN → high ≥ 缺口下緣；有錨 → high > 錨（衝過緣 10% 作廢的棒必在此集合內）。
        #   ⚠ NaN 棒在逐根版裡會被當成一次觸碰（比較全是 False → 錨變 NaN）→ 建表時 NaN 換成 ±inf，保證被找到。
        def _sp_table(_arr, _fill, _agg):
            _a = np.where(np.isnan(_arr), _fill, _arr)
            _tab = [_a]
            _k = 1
            while (1 << _k) <= len(_a):
                _pv = _tab[-1]; _hf = 1 << (_k - 1)
                _tab.append(_agg(_pv[:-_hf], _pv[_hf:]))    # 第 k 層 [i] = 區間 [i, i+2^k-1] 的極值
                _k += 1
            return _tab
        _tabH = _sp_table(highs, np.inf, np.maximum)
        _tabL = _sp_table(lows, -np.inf, np.minimum)
        _INF = math.inf

        def _nx_ge(_s, _thr):
            """從 _s 起第一個 high(NaN 視為 +inf) ≥ _thr 的棒；沒有回 _N。"""
            if _s >= _N:
                return _N
            for _k in range(len(_tabH) - 1, -1, -1):
                _lv = _tabH[_k]
                if _s < len(_lv) and _lv[_s] < _thr:
                    _s += 1 << _k
            return _s if _s < _N else _N

        def _nx_le(_s, _thr):
            """從 _s 起第一個 low(NaN 視為 -inf) ≤ _thr 的棒；沒有回 _N。"""
            if _s >= _N:
                return _N
            for _k in range(len(_tabL) - 1, -1, -1):
                _lv = _tabL[_k]
                if _s < len(_lv) and _lv[_s] > _thr:
                    _s += 1 << _k
            return _s if _s < _N else _N

        _MSWIN = 60
        _MSMIN = proto_min if proto_min and proto_min > 0 else 0.0005  # proto 缺口(B)寬度門檻(前端 B≥ 開關可切換比較)；預設 0.05%
        _SETUP_MIN = 0.0005  # setup A(視覺缺口序列 _gseq)過濾門檻：固定 0.05%，不隨 proto_min 變。
        #   ⚠ 只讓「proto B」跟著前端開關動；setup A 共用給 多空/破多空/順多空，若也跟著變會連動改到順多空(非本意)。
        _MSOVR = 0.10      # 觸碰時 K 影線衝過 setup FVG 緣 10% → 該 FVG 作廢(之後不算有效觸碰)
        # 寬度%：多用下緣為分母(top-bot)/bot、空用上緣(top-bot)/top(對齊視覺 _gw 定義)
        _gseq = [(_ci, _tp, _bt, _dr) for (_ci, _tp, _bt, _dr) in _gaps_seq
                 if (_tp - _bt) / (_bt if _dr == "l" else _tp) >= _SETUP_MIN]
        _seq_cf  = [_ci for (_ci, _tp, _bt, _dr) in _gseq]      # 缺口確認棒 cf，升序(生成序)
        # 註：原本還一起建 _seq_dr/_seq_top/_seq_bot 三條平行陣列，但下游改用 _bear/_bull 的
        #     tuple 之後就沒人讀了 → 2026-07-31 移除（順便少掃 _gseq 三趟）。
        _bear = [(_ci, _tp, _bt) for (_ci, _tp, _bt, _dr) in _gseq if _dr == "s"]
        _bull = [(_ci, _tp, _bt) for (_ci, _tp, _bt, _dr) in _gseq if _dr == "l"]
        # B＝「proto 缺口」偵測：bull＝g 收盤站上前根高點(C[g]>H[g-1])→缺口[H[g-1], C[g]]，右邊 g+1 收盤沒跌回
        #   缺口底(C[g+1]>H[g-1]＝沒干擾) → 標在 g。bear 鏡像(C[g]<L[g-1]→缺口[C[g], L[g-1]]、C[g+1]<L[g-1] 沒干擾)。
        # 兩種 B 來源都先算好，多/空 與 破多/破空 各自用 no_proto_ms / no_proto_break 挑源(獨立)。
        # ① proto 版：單根「g 收盤站上前根高/破前根低」即成立(非repaint、即時)。含未收盤暫定 _prov_proto。
        _pseq_proto = []       # (g, top, bot, dir) 依 g 升序(生成序)；同視覺窗(_vw0)
        for _g2 in range(_vw0, _N - 1):
            if _gap_guard and (_secs[_g2+1] - _secs[_g2-1]) > _gap_span_max:
                continue   # 跨資料斷層不成立 proto 缺口（否則破多/破空/多空標記會被假缺口污染）
            _hm1 = _H[_g2 - 1]; _lm1 = _L[_g2 - 1]; _cg = _C[_g2]
            if _hm1 != _hm1 or _lm1 != _lm1 or _cg != _cg:           # NaN（理由同上，不用 any(genexpr)）
                continue
            if _cg > _hm1:                                            # bull proto
                _pt, _pb, _pd = _cg, _hm1, "l"
                if (_pt - _pb) / _pb < _MSMIN: continue
            elif _cg < _lm1:                                          # bear proto
                _pt, _pb, _pd = _lm1, _cg, "s"
                if (_pt - _pb) / _pt < _MSMIN: continue
            else:
                continue
            _pseq_proto.append((_g2, _pt, _pb, _pd))
        _prov_proto = None                                 # 未收盤暫定 proto (g, top, bot, dir) 或 None
        _li = _N - 1
        if _li >= _vw0 + 1 and not (_gap_guard and (_secs[_li] - _secs[_li-1]) > _gap_span_max):
            _hm1 = _H[_li - 1]; _lm1 = _L[_li - 1]; _cg = _C[_li]
            if not any(_v != _v for _v in (_hm1, _lm1, _cg)):
                if _cg > _hm1 and (_cg - _hm1) / _hm1 >= _MSMIN:
                    _prov_proto = (_li, _cg, _hm1, "l")
                elif _cg < _lm1 and (_lm1 - _cg) / _lm1 >= _MSMIN:
                    _prov_proto = (_li, _lm1, _cg, "s")
        # ② 正常FVG 版：3 根 g+1 確認(沿用 setup A 的 _gaps_seq；cf=g+1、gap=真 FVG 區間)。g+1 已收盤→無 prov。
        _pseq_fvg = [(_ci, _tp, _bt, _dr) for (_ci, _tp, _bt, _dr) in _gaps_seq
                     if (_tp - _bt) / (_bt if _dr == "l" else _tp) >= _MSMIN]
        # 各消費者選源(獨立)：多/空 → _pseq_ms_base；破多/破空 → _pseq_break_base
        _pseq_ms_base    = _pseq_fvg if no_proto_ms    else _pseq_proto
        _prov_ms         = None      if no_proto_ms    else _prov_proto   # 正常FVG 無未收盤暫定
        _pseq_break_base = _pseq_fvg if no_proto_break else _pseq_proto
        _prov_break      = None      if no_proto_break else _prov_proto
        # 多/空比對用陣列：把暫定附加在末(不進 base → 破多空迴圈的序列不受污染)
        _pseq_ms = list(_pseq_ms_base) + ([_prov_ms] if _prov_ms else [])
        _pprov   = [False] * len(_pseq_ms_base) + ([True] if _prov_ms else [])
        _pcf  = [_p[0] for _p in _pseq_ms]; _pdr = [_p[3] for _p in _pseq_ms]
        _ptop = [_p[1] for _p in _pseq_ms]; _pbot = [_p[2] for _p in _pseq_ms]
        _ms_seen = set()                                   # 去重：同一 B(_cf2)只標一次
        for (_cf, _top, _bot) in _bear:                    # 空：setup A 為 3 根 bear FVG、B 為 proto 缺口
            _mx = None
            _touch = _cf
            while True:                                    # 跳躍版（見上方 _nx_ge 說明；以下判斷與逐根版逐行相同）
                _touch = _nx_ge(_touch + 1, _bot if (_mx is None or _mx != _mx) else math.nextafter(_mx, _INF))
                if _touch >= _N: break
                if _mx is not None and _mx >= _top: break
                if _H[_touch] > _top * (1 + _MSOVR): break
                if _H[_touch] < _bot: continue
                _r = _top if _H[_touch] > _top else _H[_touch]
                if _mx is not None and _r <= _mx: continue
                _mx = _r
                _p = bisect.bisect_right(_pcf, _touch)     # 觸碰後第一個 bear proto 缺口＝B
                _B = None
                for _q in range(_p, len(_pcf)):
                    if _pdr[_q] == "s": _B = _q; break
                if _B is None: continue
                _cf2 = _pcf[_B]
                # 空：B下緣<A上緣(重疊可)；不套「B寬<A寬」。
                if _cf2 in _ms_seen or _cf2 - _touch > _MSWIN or not _pbot[_B] < _top: continue
                _blk = False
                for _q in range(_p, _B):
                    if _pdr[_q] == "l" and _pcf[_q] - _touch > 2:
                        _blk = True; break
                if _blk: continue
                _e = {"t": times_iso[_cf2], "d": "s", "sl": _swing_hi(_cf2)}   # 做空止損=回推到第一根紅K的波段最高
                # 止盈：往後找第一根「量>標記棒(g) 且 綠色(收<開=做空K)」→ 收盤價；紅色不算(續找)。上限 200 根
                _mvm = _Vms[_cf2]
                for _z in range(_cf2 + 1, min(_N, _cf2 + 201)):
                    if _Vms[_z] > _mvm and _C[_z] < _O[_z]:
                        _e["tp"] = _C[_z]; break
                if _pprov[_B]: _e["prov"] = 1
                _fvg_ms.append(_e); _ms_seen.add(_cf2); _used.add(_cf)
        for (_cf, _top, _bot) in _bull:                    # 多（鏡像）
            _mn = None
            _touch = _cf
            while True:                                    # 跳躍版（鏡像，見 _nx_le）
                _touch = _nx_le(_touch + 1, _top if (_mn is None or _mn != _mn) else math.nextafter(_mn, -_INF))
                if _touch >= _N: break
                if _mn is not None and _mn <= _bot: break
                if _L[_touch] < _bot * (1 - _MSOVR): break
                if _L[_touch] > _top: continue
                _r = _bot if _L[_touch] < _bot else _L[_touch]
                if _mn is not None and _r >= _mn: continue
                _mn = _r
                _p = bisect.bisect_right(_pcf, _touch)
                _B = None
                for _q in range(_p, len(_pcf)):
                    if _pdr[_q] == "l": _B = _q; break
                if _B is None: continue
                _cf2 = _pcf[_B]
                # 多：B 下緣要高於 A 下緣(_pbot>_bot)＋ B 不能完全被 A 包住→上緣要突出 A 上緣(_ptop>_top)。
                #   (可部分重疊：B 下緣容許 <A 上緣；只是不得整個縮在 A 內、也不得低於 A 下緣。)不套「B寬<A寬」。
                if (_cf2 in _ms_seen or _cf2 - _touch > _MSWIN
                        or not (_pbot[_B] > _bot) or not (_ptop[_B] > _top)): continue
                _blk = False
                for _q in range(_p, _B):
                    if _pdr[_q] == "s" and _pcf[_q] - _touch > 2:
                        _blk = True; break
                if _blk: continue
                _e = {"t": times_iso[_cf2], "d": "l", "sl": _swing_lo(_cf2)}   # 做多止損=回推到第一根綠K的波段最低
                # 止盈：往後找第一根「量>標記棒(g) 且 紅色(收>開=做多K)」→ 收盤價；綠色不算(續找)。上限 200 根
                _mvm = _Vms[_cf2]
                for _z in range(_cf2 + 1, min(_N, _cf2 + 201)):
                    if _Vms[_z] > _mvm and _C[_z] > _O[_z]:
                        _e["tp"] = _C[_z]; break
                if _pprov[_B]: _e["prov"] = 1
                _fvg_ms.append(_e); _ms_seen.add(_cf2); _used.add(_cf)
        _fvg_ms.sort(key=lambda x: x["t"])
        _fvg_ms = _fvg_ms[-8000:]

        # ── 結構轉破（破多/破空）2026-07 改版：牆＝「最近一道確認 FVG」，被 K 棒影線穿破牆頂/底
        #   ＋「該根或 g+1/g+2」出現 proto → 標在那根 proto。破空(空方牆被向上破→轉多，d="s"↑青)、
        #   破多(多方牆被向下破→轉空，d="l"↓橘)。只追「前一道」FVG(新 FVG 形成即取代)＝天然新鮮度、
        #   不會去破數月前老牆。proto 沿用 _pseq(g 收盤定案、非 repaint)；未收盤最後一根暫定 proto→prov=1。
        #   _bear/_bull 來自 _gseq(3 根確認 FVG，已含 _SETUP_MIN 過濾＋資料斷層防護)，與圖上牆一致。
        _pl_bars = set(); _ps_bars = set()
        for (_pg, _pt2, _pb2, _pd2) in _pseq_break_base:   # 破多/破空專用來源(no_proto_break 決定 proto/正常FVG)
            (_pl_bars if _pd2 == "l" else _ps_bars).add(_pg)
        _prov_l = _prov_break is not None and _prov_break[3] == "l"   # 未收盤最後一根＝暫定破 proto(正常FVG 模式無)
        _prov_s = _prov_break is not None and _prov_break[3] == "s"
        _cur_bw = None; _cur_lw = None          # 最近的 空方牆 / 多方牆 (cf=g+1, top, bot)
        _bwi = 0; _lwi = 0
        for _i2 in range(_vw0, _N):
            while _bwi < len(_bear) and _bear[_bwi][0] <= _i2:   # 取代成最近的空方牆
                _cur_bw = _bear[_bwi]; _bwi += 1
            while _lwi < len(_bull) and _bull[_lwi][0] <= _i2:   # 取代成最近的多方牆
                _cur_lw = _bull[_lwi]; _lwi += 1
            # 破空：最近空方牆頂被影線(高)穿破 → 該根/g+1/g+2 首見 proto多 → 標(做多)
            if _cur_bw is not None and _i2 > _cur_bw[0] and _H[_i2] >= _cur_bw[1]:
                for _k in (_i2, _i2 + 1, _i2 + 2):
                    if _k >= _N:
                        break
                    if (_k in _pl_bars) or (_k == _li and _prov_l):
                        _e = {"t": times_iso[_k], "p": _cur_bw[2], "d": "s", "sl": _swing_lo(_k)}   # 破空=做多↑→回推第一根綠K的波段最低
                        if _k == _li and _k not in _pl_bars and _prov_l:
                            _e["prov"] = 1
                        _fvg_break.append(_e); break
                _cur_bw = None                   # 牆被破即消耗，等下一道
            # 破多：最近多方牆底被影線(低)穿破 → 該根/g+1/g+2 首見 proto空 → 標(做空)
            if _cur_lw is not None and _i2 > _cur_lw[0] and _L[_i2] <= _cur_lw[2]:
                for _k in (_i2, _i2 + 1, _i2 + 2):
                    if _k >= _N:
                        break
                    if (_k in _ps_bars) or (_k == _li and _prov_s):
                        _e = {"t": times_iso[_k], "p": _cur_lw[1], "d": "l", "sl": _swing_hi(_k)}   # 破多=做空↓→回推第一根紅K的波段最高
                        if _k == _li and _k not in _ps_bars and _prov_s:
                            _e["prov"] = 1
                        _fvg_break.append(_e); break
                _cur_lw = None
        _fvg_break.sort(key=lambda x: x["t"]);      _fvg_break = _fvg_break[-8000:]

        # ── 「順多/順空」方向標記（2026-07-02；07-03 影線穿透＋近期兩個；07-03b 近期以「穿透點」衡量、R可晚於觸碰）──
        # 順多：第一步與「多」完全相同——未觸碰的做多FVG(A)被首次碰到(逐錨更深觸碰、下影衝過下緣10%作廢)；
        #       第二步——觸碰後(含同棒)最早、且「R比A晚生成 + R是穿透當下最近兩個做空FVG之一」的
        #       「做空FVG(R)上緣被影線穿透(high>R.top)」事件 → 標「順多」於穿透那根。
        #       （「近期兩個」以『穿透點』衡量、非觸碰點：觸碰後才形成、隨即被穿透的新做空FVG才是真正的順勢延續，
        #       例:BTC 1d 2025-01-19 觸碰後才生成的多/空FVG；不往更早回溯找「還沒破的」→ 避免抓到陳年舊缺口。）
        # 中間規則：觸碰→穿透之間不能夾雜任何其他FVG(R 本身、及觸碰棒 cf−touch≤2 順手做的除外)。
        # 順空：鏡像——做空FVG(A)被碰到後，穿透當下最近兩個做多FVG之一被影線穿透下緣(low<R.bot) → 標「順空」。
        # 效能：預算每個FVG的「首次被影線穿透」事件 (brk_idx, cf) 依 brk 升序 → 錨點/近期查詢用 bisect。
        # 用 heap 單趟掃描 O(N log G) 建事件序列（上緣/下緣最先被碰者先被穿透）。
        import heapq as _hq
        _brk_s = []                                    # 做空FVG：首次 high>top 的棒（單趟天然依 brk 升序）
        _hp = []; _bi = 0
        for _j in range(_vw0, _N):                     # 缺口皆在窗內(cf≥_vw0)→ 窗前無事可做，從 _vw0 起掃
            while _bi < len(_bear) and _bear[_bi][0] < _j:   # cf<j 的缺口自 cf+1 起可被突破 → 入堆
                _hq.heappush(_hp, (_bear[_bi][1], _bear[_bi][0])); _bi += 1
            _hj = _H[_j]
            while _hp and _hp[0][0] < _hj:             # 上緣最低者先被影線穿透（NaN 比較恆 False → 自動跳過）
                _tp0, _cf0 = _hq.heappop(_hp); _brk_s.append((_j, _cf0))
        _brk_l = []                                    # 做多FVG：首次 low<bot 的棒（鏡像，堆存 -bot）
        _hp = []; _bi = 0
        for _j in range(_vw0, _N):
            while _bi < len(_bull) and _bull[_bi][0] < _j:
                _hq.heappush(_hp, (-_bull[_bi][2], _bull[_bi][0])); _bi += 1
            _lj = _L[_j]
            while _hp and -_hp[0][0] > _lj:            # 下緣最高者先被影線穿透
                _bt0, _cf0 = _hq.heappop(_hp); _brk_l.append((_j, _cf0))
        _bear_cfs = [_c[0] for _c in _bear]            # 升序(生成序)，供 bisect 找「突破當下近期的做空FVG」
        _bull_cfs = [_c[0] for _c in _bull]
        _shun_seen = set()                             # 去重：同一(突破棒,方向)只標一次

        def _shun_scan(_gaps, _rcand_cfs, _events, _d):
            """_gaps=A候選(同向)、_rcand_cfs=反向FVG的cf清單(升序)、_events=反向FVG突破事件(bj,rcf)依bj升序、_d='l'順多/'s'順空。"""
            for (_cf, _top, _bot) in _gaps:
                _anchor = None                         # 逐錨更深觸碰(與多/空同)
                _touch = _cf
                while True:                            # 跳躍版（見多/空區塊的 _nx_ge/_nx_le 說明）
                    _free = (_anchor is None or _anchor != _anchor)
                    if _d == "l":
                        _touch = _nx_le(_touch + 1, _top if _free else math.nextafter(_anchor, -_INF))
                    else:
                        _touch = _nx_ge(_touch + 1, _bot if _free else math.nextafter(_anchor, _INF))
                    if _touch >= _N: break
                    if _d == "l":
                        if _anchor is not None and _anchor <= _bot: break  # 錨達下緣→無更深觸碰(無損止掃)
                        if _L[_touch] < _bot * (1 - _MSOVR): break     # 衝過下緣10% → A作廢
                        if _L[_touch] > _top: continue                 # 沒碰進區間
                        _r = _bot if _L[_touch] < _bot else _L[_touch]
                        if _anchor is not None and _r >= _anchor: continue
                    else:
                        if _anchor is not None and _anchor >= _top: break  # 錨達上緣→無更深觸碰(無損止掃)
                        if _H[_touch] > _top * (1 + _MSOVR): break
                        if _H[_touch] < _bot: continue
                        _r = _top if _H[_touch] > _top else _H[_touch]
                        if _anchor is not None and _r <= _anchor: continue
                    _anchor = _r
                    # 觸碰後(含同棒)最早、且符合條件的「反向FVG被影線穿透」事件 → 標於穿透那根(_bk)。
                    #   條件① R 比 A 晚生成(cf(R)>cf(A))——A是「第一個」、R是「第二個」，時序不能反過來。
                    #   條件② R 是「穿透當下(_bj 那根)」字面最近兩個反向FVG之一──『近期』以穿透點衡量、非觸碰點：
                    #         觸碰後才形成、隨即被穿透的新反向FVG才是真正的順勢延續(例:BTC 1d 2025-01-19：
                    #         1/17 觸 12/19 空FVG→1/18 才生成多FVG→1/19 破其下緣；R(1/18)晚於觸碰(1/17)。)
                    #         不往更早回溯找「還沒破的」→ 避免抓到與當下結構無關的陳年舊缺口(例:BCH 2023 舊缺口)。
                    #   同棒(_bj==_touch)允許：單根大反轉棒 high 觸上方反向FVG＋low 破下方R(例:BTC 1d 2025-11-11)。
                    _p2 = bisect.bisect_left(_events, (_touch, -1))    # 第一個 bj≥touch 的事件
                    _bk = None; _rcf = None
                    for _e in range(_p2, len(_events)):
                        _bj, _c2 = _events[_e]
                        if _bj - _touch > _MSWIN: break                # 超窗(events 依 bj 升序 → 之後皆超窗)
                        if _c2 <= _cf: continue                        # 條件①：R 須晚於 A
                        _ri = bisect.bisect_right(_rcand_cfs, _bj)     # 條件②：R 為穿透當下最近兩個反向FVG之一
                        if _c2 not in _rcand_cfs[max(0, _ri - 2):_ri]: continue
                        _bk = _bj; _rcf = _c2; break
                    if _bk is None or (_bk, _d) in _shun_seen: continue
                    # 觸碰→穿透之間夾其他FVG(R 本身、及觸碰棒 cf−touch≤2 順手做的除外)→擋
                    _p = bisect.bisect_right(_seq_cf, _touch)
                    _blk = False
                    for _q in range(_p, len(_seq_cf)):
                        if _seq_cf[_q] >= _bk: break
                        if _seq_cf[_q] == _rcf: continue               # R 本身是目標、不算「夾雜」
                        if _seq_cf[_q] - _touch > 2: _blk = True; break
                    if _blk: continue
                    _se = {"t": times_iso[_bk], "d": _d, "sl": _H[_bk-1]}
                    if _bk == _N - 1: _se["prov"] = 1      # 穿透事件落在最後一根(未收盤)→暫定順(收盤才確認)
                    _fvg_shun.append(_se)
                    _shun_seen.add((_bk, _d)); _used.add(_cf); _used.add(_rcf)

        _shun_scan(_bull, _bear_cfs, _brk_s, "l")      # 順多：吃做多FVG → 近期兩個做空FVG其中一個影線穿透上緣
        _shun_scan(_bear, _bull_cfs, _brk_l, "s")      # 順空：吃做空FVG → 近期兩個做多FVG其中一個影線穿透下緣
        _fvg_shun.sort(key=lambda x: x["t"])
        _fvg_shun = _fvg_shun[-2000:]

        # ── 「特空/特多」：市場結構三連 A→B→C（使用者定義 2026-07-14）─────────────────────
        #   在「多/空(_fvg_ms)＋破多/破空(_fvg_break)」合併成的時間序列上，掃描相鄰三連
        #   （A、B、C 之間不夾其他此類標記，但三根 K 本身可不連續）：
        #   看空群＝{破多, 空}、看多群＝{破空, 多}。
        #   特空：A∈看空群、B∈看多群且 B 高點不過 A(高≤A高)、C∈看空群且「C 本身或 g+1 最低點 < B 低點」→ 標特空於 C。
        #   特多：鏡像——A∈看多群、B∈看空群且 B 低點不破 A(低≥A低)、C∈看多群且「C 本身或 g+1 最高點 > B 高點」→ 標特多於 C。
        #   方向對照：空=ms d="s"、多=ms d="l"、破空=break d="s"、破多=break d="l"。
        _fvg_special = []
        try:
            _iso2i = {}
            for _i in range(_N):
                _iso2i[times_iso[_i]] = _i
            # ⚠ 依「K 棒」分組成節點(非逐標記)：同一根可能同時有多個標記(如 5/9 同時「多」+「破空」)，
            #   使用者定義中該根算「一個 B 節點」(有破空或多即可)。逐標記會把它拆成兩節點 → A→B→C 對不上。
            #   每節點記 hasBear(有 破多 或 空) / hasBull(有 破空 或 多)；一根可兩者皆真。
            _barflag = {}   # idx -> [hasBear, hasBull]
            for _m in _fvg_ms:
                _ii = _iso2i.get(_m["t"], -1)
                if _ii < 0:
                    continue
                _e = _barflag.setdefault(_ii, [False, False])
                if _m["d"] == "s":
                    _e[0] = True    # 空 → 看空
                else:
                    _e[1] = True    # 多 → 看多
            for _m in _fvg_break:
                _ii = _iso2i.get(_m["t"], -1)
                if _ii < 0:
                    continue
                _e = _barflag.setdefault(_ii, [False, False])
                if _m["d"] == "l":
                    _e[0] = True    # 破多 → 看空
                else:
                    _e[1] = True    # 破空 → 看多
            # B 對 A 的「高不過/低不破」看**本體(開收)**，非影線 —— 使用者定調「本體沒破就行」
            #   (影線戳過 A 不算破，只要 B 實體守在 A 實體內即可)。C 破 B 仍用「最低/最高影線點」(原規格)。
            def _bodyHi(_x):
                return _O[_x] if _O[_x] > _C[_x] else _C[_x]
            def _bodyLo(_x):
                return _O[_x] if _O[_x] < _C[_x] else _C[_x]
            _nodes = sorted(_barflag.items())   # [(idx, [bear, bull]), ...] 依 K 棒時間
            for _p in range(len(_nodes) - 2):
                _ai, (_aBear, _aBull) = _nodes[_p]
                _bi, (_bBear, _bBull) = _nodes[_p + 1]
                _ci, (_cBear, _cBull) = _nodes[_p + 2]
                # 特空：A 看空、B 看多且本體高不過 A 本體、C 看空且 C(或 g+1)最低影 < B 最低影 → 標特空於 C
                if _aBear and _bBull and _cBear and _bodyHi(_bi) <= _bodyHi(_ai):
                    _clow = _L[_ci]
                    if _ci + 1 < _N and _L[_ci + 1] < _clow:
                        _clow = _L[_ci + 1]
                    if _clow < _L[_bi]:
                        _fvg_special.append({"t": times_iso[_ci], "d": "s", "sl": _swing_hi(_ci)})
                        continue
                # 特多：A 看多、B 看空且本體低不破 A 本體、C 看多且 C(或 g+1)最高影 > B 最高影 → 標特多於 C
                if _aBull and _bBear and _cBull and _bodyLo(_bi) >= _bodyLo(_ai):
                    _chigh = _H[_ci]
                    if _ci + 1 < _N and _H[_ci + 1] > _chigh:
                        _chigh = _H[_ci + 1]
                    if _chigh > _H[_bi]:
                        _fvg_special.append({"t": times_iso[_ci], "d": "l", "sl": _swing_lo(_ci)})
            _fvg_special.sort(key=lambda x: x["t"])
            _fvg_special = _fvg_special[-2000:]
        except Exception:
            _fvg_special = []

        # ── 標記「有無被用到」：未被任何標記(破多/破空/多/空)用到的主缺口 → used=False(前端淡化)。
        #     IFVG(inv)非主缺口、不在偵測序列 → 視為 used(不淡化)。
        for _z in _fvg:
            _z["used"] = True if _z.get("inv") else (_z.get("gi") in _used)
    except Exception:
        _fvg = []
        _fvg_sigs = []
        _fvg_break = []
        _fvg_ms = []
        _fvg_shun = []
        _fvg_special = []

    # ── （2026-09-17 移除）SMC 掃頂掃底／BOS·CHoCH 結構／訂單區 OB／支撐阻力 SR／自動平行通道 ─────
    #   這五層（與只給它們用的擺動 pivot 遮罩）原本只給「SR+SMC 教練」疊加層畫。教練整個移除後
    #   **全站沒有任何讀者**（前端一律 skip、後端 notify_monitor／自動交易都不讀；sweepBoost 讀的是
    #   FVG 缺口自己的 `sweep` 欄位，不是 smc_sweep）→ 卻每次算勝率都跑一遍純 Python 全棒迴圈。
    #   要找原始實作：git show 4aaeed3:backend/utils/crt.py

    # ── VWAP【階段5：移植 Pine，每日錨定；當前時框計算】────────────────────────────
    #   每根 hlc3×量 累積，遇「日期變更」重置。回傳 [{t, v}]，v=尚無量時 None。
    # 向量化(原純 Python 迴圈掃整條 ~3.4萬根 + 建 3.4萬個 dict 只留 3000 → ~5x 慢)：
    #   numpy 算 hlc3×量，pandas groupby(日).cumsum() 逐日獨立累加(不跨日→無浮點抵消)，只建最後 3000 個 dict。
    #   與舊版逐日重置結果一致(誤差 <1e-9)。分組鍵依棒間距自適應：盤中→datetime64[D](每日)、日線以上→[Y](年度)。
    _vwap = []
    try:
        if "volume" in df.columns:
            _n = len(times_iso)
            _vol = df["volume"].to_numpy(dtype=float)
            _vpos = np.where((_vol == _vol) & (_vol > 0), _vol, 0.0)   # NaN/非正量→0(不計入)
            _tp = (highs + lows + closes) / 3.0                        # 典型價 hlc3
            _pv = np.where(_vpos > 0, _tp * _vpos, 0.0)                # 只在有效量處累 PV
            # 錨定粒度依「棒間距」自適應：盤中(每根<20h)每日錨定；日線以上(1d/1w/1M)每日錨定會退化
            #（每根 K 各自成一天→groupby 每根獨立→cumsum 每根重置→VWAP=該根 hlc3、貼著 K 棒跳＝錯）
            # → 改年度錨定(YTD Anchored VWAP，每年初重置)，日/周/月線才是有意義的量加權均價。
            _tarr = np.array(times_iso, dtype="datetime64[s]")
            _med = float(np.median(np.diff(_tarr).astype("timedelta64[s]").astype(float))) if _n >= 2 else 0.0
            _dayk = _tarr.astype("datetime64[Y]") if _med >= 20 * 3600 else _tarr.astype("datetime64[D]")
            _dpv = pd.Series(_pv).groupby(_dayk).cumsum().to_numpy()   # 逐日 ΣPV
            _dv  = pd.Series(_vpos).groupby(_dayk).cumsum().to_numpy() # 逐日 ΣV
            with np.errstate(divide="ignore", invalid="ignore"):
                _vw = np.where(_dv > 0, _dpv / _dv, np.nan)            # 尚無量→NaN(前端轉 None 不畫)
            _s = max(0, _n - 3000)                                     # 只留最後 3000 根(圖上用量)
            _vwap = [{"t": times_iso[_i], "v": (None if _vw[_i] != _vw[_i] else float(_vw[_i]))}
                     for _i in range(_s, _n)]
    except Exception:
        _vwap = []

    # ── 布林通道外 + FVG 進場點（均值回歸·研究用主圖標記，讓使用者目視驗證）──────────
    #   對齊 /tmp/fvg_bb.py 回測：進場=缺口頂(top)、firsttouch 真過濾。
    #   首次觸及進場價的那根 K，若同時在布林通道外同側(多:跌破下軌 low≤bb_lower／空:突破上軌 high≥bb_upper)
    #   → 標進場；否則整筆放棄(不延後、不追)。止損 2W / 止盈 6W(W=top−bot)，模擬出勝/敗供色彩。
    #   ⚠ 純研究視覺，獨立於自動交易；bb 缺(NaN)整段退空。
    _fvg_bb = []; _fvg_bb_a = []; _fvg_bb_m = []
    try:
        _BUFb = 0.0005; _FRb = 168; _MHb = 200; _SSWIN = 3
        # numpy→list 一次轉換：純 Python 迴圈逐元素存取 list(float) 遠快於 numpy 標量+float()
        # （與下方 _fvg_trades 區塊的 _Hn/_Ln 同一手法）。NaN 轉 list 後仍為 float('nan')，x!=x 判定不變。
        _Hb = highs.tolist(); _Lb = lows.tolist(); _Cb = closes.tolist(); _Ob = opens.tolist()
        _BUb = bb_up.tolist(); _BLb = bb_lo.tolist(); _BMb = bb_mid.tolist()
        # SS1（布林軌道反轉2棒·靠軌深半）旗標，index=B棒；進場「那附近」要有同向 SS1 才算確認。對齊 crt SS1 與 fvg_bb.py。
        _ss1L = [False] * _N; _ss1S = [False] * _N
        for _b in range(1, _N):
            _a = _b - 1
            _ub = _BUb[_b]; _mb = _BMb[_b]; _lb = _BLb[_b]
            if _ub != _ub or _mb != _mb or _lb != _lb:   # NaN
                continue
            _ca = _Cb[_a]; _oa = _Ob[_a]; _la = _Lb[_a]; _ha = _Hb[_a]
            _cb = _Cb[_b]; _ob = _Ob[_b]; _lkb = _Lb[_b]; _hb = _Hb[_b]
            _lba = _BLb[_a]; _uba = _BUb[_a]
            # 多（下軌反轉）：A綠跌 B紅漲、B收>下軌、A/B任一觸下軌、B未碰中軌、SS1深(B收<(下+中)/2)
            if (_ca < _oa) and (_cb > _ob) and (_cb > _lb) \
               and ((_lba == _lba and _la <= _lba) or _lkb <= _lb) \
               and (_hb < _mb) and (_cb < (_lb + _mb) / 2.0):
                _ss1L[_b] = True
            # 空（上軌反轉）：A紅漲 B綠跌、B收<上軌、A/B任一觸上軌、B未碰中軌、SS1(B收>(上+中)/2)
            if (_ca > _oa) and (_cb < _ob) and (_cb < _ub) \
               and ((_uba == _uba and _ha >= _uba) or _hb >= _ub) \
               and (_lkb > _mb) and (_cb > (_ub + _mb) / 2.0):
                _ss1S[_b] = True
        # 出場模擬：抱到止損/止盈/超時；回 (出場棒, 勝敗, 出場價)。同棒先認止損(保守)。
        def _simx(_fb, _d, _stp, _tgt):
            _win = None; _xb = min(_N, _fb + _MHb) - 1
            for _k in range(_fb + 1, min(_N, _fb + _MHb)):
                _hk = _Hb[_k]; _lk = _Lb[_k]
                if _hk != _hk or _lk != _lk:
                    continue
                if _d == "l":
                    if _lk <= _stp: _win = False; _xb = _k; break
                    if _hk >= _tgt: _win = True;  _xb = _k; break
                else:
                    if _hk >= _stp: _win = False; _xb = _k; break
                    if _lk <= _tgt: _win = True;  _xb = _k; break
            _xp = _stp if _win is False else (_tgt if _win is True else _Cb[_xb])
            return _xb, _win, _xp

        _cands = []      # D版(三根止損+1.5R)
        _cands_a = []    # A版(g-1止損+布林軌外1W)
        for (_cf, _tp0, _bt0, _d) in _bbgaps:
            _Wb = _tp0 - _bt0
            if _Wb <= 0 or _cf < 2:
                continue
            _ep = _tp0
            # 進場棒(首次觸框 + 那附近有同向SS1)，A/D 共用；D版無布林外閘
            _fb = None
            for _j in range(_cf + 1, min(_N, _cf + 1 + _FRb)):
                _lj = _Lb[_j]; _hj = _Hb[_j]
                if _lj != _lj or _hj != _hj:
                    continue
                _touch = (_lj <= _ep * (1 - _BUFb)) if _d == "l" else (_hj >= _ep * (1 + _BUFb))
                if _touch:
                    _ssf = _ss1L if _d == "l" else _ss1S
                    if not any(_ssf[_k] for _k in range(max(0, _j - _SSWIN), _j + 1)):
                        break
                    _fb = _j
                    break
            if _fb is None:
                continue
            # ── D版：止損＝g-1/g-2/g-3 最低(多)/最高(空)、止盈＝1.5R（需 g-3=cf-4≥0）──
            if _cf >= 4:
                _stpD = min(_Lb[_cf-2], _Lb[_cf-3], _Lb[_cf-4]) if _d == "l" \
                        else max(_Hb[_cf-2], _Hb[_cf-3], _Hb[_cf-4])
                if not ((_d == "l" and _stpD >= _ep) or (_d == "s" and _stpD <= _ep)):
                    _tgtD = (_ep + 1.5*(_ep-_stpD)) if _d == "l" else (_ep - 1.5*(_stpD-_ep))
                    _xb, _win, _xp = _simx(_fb, _d, _stpD, _tgtD)
                    _cands.append((_fb, _xb, {"t": times_iso[_fb], "d": _d, "entry": _ep,
                                              "stop": _stpD, "tp": _tgtD, "win": _win,
                                              "xt": times_iso[_xb], "xp": _xp}))
            # ── A版：止損＝g-1、止盈＝布林軌外1W(1W=進場棒布林軌到g-1距離)──
            _g1 = _Lb[_cf-2] if _d == "l" else _Hb[_cf-2]
            _bandA = _BLb[_fb] if _d == "l" else _BUb[_fb]
            if _bandA == _bandA:                                   # 非 NaN
                _oneW = (_bandA - _g1) if _d == "l" else (_g1 - _bandA)
                _okstop = (_g1 < _ep) if _d == "l" else (_g1 > _ep)
                if _oneW > 0 and _okstop:
                    _tgtA = (_bandA + _oneW) if _d == "l" else (_bandA - _oneW)
                    if (_d == "l" and _tgtA > _ep) or (_d == "s" and _tgtA < _ep):
                        _xb, _win, _xp = _simx(_fb, _d, _g1, _tgtA)
                        _cands_a.append((_fb, _xb, {"t": times_iso[_fb], "d": _d, "entry": _ep,
                                                    "stop": _g1, "tp": _tgtA, "win": _win,
                                                    "xt": times_iso[_xb], "xp": _xp}))
        # busy 去重(逐方向、逐版本):一筆未出場前不開同向新單
        def _dedup(_cl):
            _cl.sort(key=lambda x: x[0])
            _out = []; _lastx = {"l": -1, "s": -1}
            for _fb, _xb, _rec in _cl:
                if _fb <= _lastx[_rec["d"]]:
                    continue
                _out.append(_rec); _lastx[_rec["d"]] = _xb
            return _out[-400:]
        # ── 中軌分側順勢版(M)：多=形成時整個FVG在中軌上、空=在中軌下；首觸即進(無SS1/布林閘)；
        #     止損=g與g-1兩根極值(多最低/空最高)；止盈=3W。分側只看FVG形成當下，之後價格跑到對側來填也算。
        _cands_m = []
        for (_cf, _tp0, _bt0, _d) in _bbgaps:
            _Wb = _tp0 - _bt0
            if _Wb <= 0 or _cf < 2:
                continue
            _m = _BMb[_cf - 1]                                  # 形成時(g棒)中軌
            if _m != _m:
                continue
            if (_d == "l" and _bt0 < _m) or (_d == "s" and _tp0 > _m):
                continue
            _ep = _tp0
            _fbm = None
            for _j in range(_cf + 1, min(_N, _cf + 1 + _FRb)):  # 首次觸框即進
                _lj = _Lb[_j]; _hj = _Hb[_j]
                if _lj != _lj or _hj != _hj:
                    continue
                if (_lj <= _ep) if _d == "l" else (_hj >= _ep):  # 影線碰邊即算(取消BUF),碰過作廢→只認首次
                    _fbm = _j; break
            if _fbm is None:
                continue
            _stpm = min(_Lb[_cf-1], _Lb[_cf-2]) if _d == "l" \
                    else max(_Hb[_cf-1], _Hb[_cf-2])
            if (_d == "l" and _stpm >= _ep) or (_d == "s" and _stpm <= _ep):
                continue
            _tgtm = (_ep + 4.0 * _Wb) if _d == "l" else (_ep - 4.0 * _Wb)  # 止盈4W(使用者要求看4W)
            _xb, _win, _xp = _simx(_fbm, _d, _stpm, _tgtm)
            _cands_m.append((_fbm, _xb, {"t": times_iso[_fbm], "d": _d, "entry": _ep,
                                         "stop": _stpm, "tp": _tgtm, "win": _win,
                                         "xt": times_iso[_xb], "xp": _xp}))
        _fvg_bb = _dedup(_cands)
        _fvg_bb_a = _dedup(_cands_a)
        _fvg_bb_m = _dedup(_cands_m)
    except Exception:
        _fvg_bb = []; _fvg_bb_a = []; _fvg_bb_m = []

    # ── FVG 進出場點（給主圖標記）──────────────────────────────────────────
    #   ⅓ 階梯版：三檔限價掛在缺口頂/中/底，影線觸及即成交；2W 止損 / 6W 止盈、抱到止損/止盈/超時。
    #   + 寬度上限 2%（濾掉抱久擋路的寬缺口）；+ 深檔拉近：三檔全成交(插到底)就把止盈改 2W 快跑。
    #   只為「視覺標記」，獨立於 _fvg_sigs（自動交易），出錯退空、不影響其他輸出。
    _fvg_trades = []
    try:
        _SMt, _TMt = 2.0, 6.0
        _Hn = highs.tolist(); _Ln = lows.tolist()   # .tolist() 比 [float(x) for x in ...] 快數倍
        _Nn = len(_Ln)
        for _wd in ("l", "s"):
            _gp = [g for g in _gaplist if g[3] == _wd]
            # 1) 每個缺口：三檔階梯成交 + 出場（不做 busy 判斷）
            _cands = []
            for (_cf, _tp0, _bt0, _d) in _gp:
                if _tp0 - _bt0 <= 0:
                    continue
                _W = _tp0 - _bt0; _mid = (_tp0 + _bt0) / 2.0
                _wr = _W / (_tp0 if _d == "l" else _bt0)          # 缺口寬度占價格比
                if _wr > 0.02:                                    # 寬度上限 2%：濾掉抱久擋路的超寬缺口
                    continue
                if _wr > 0.012:                                   # 過寬(1.2%~2%)：上框+中間兩檔、止損框−0.5W、止盈3W
                    _lv = [_tp0, _mid] if _d == "l" else [_mid, _bt0]   # 不掛最深檔(多:bot/空:top＝跑太兇那側)
                    _stp = (_bt0 - 0.5 * _W) if _d == "l" else (_tp0 + 0.5 * _W)  # 框−0.5W：同avgR但勝率26→34%、少被影線洗(2026-06-23同棒止損修正後重測)
                    _tp_far  = (_tp0 + 3.0 * _W) if _d == "l" else (_bt0 - 3.0 * _W)  # 3W：容量受限下幾乎=6W但命中率高、出場快、不堵小單
                    _tp_near = _tp_far                            # 過寬不做深檔拉近
                else:                                             # 正常窄缺口：三檔階梯 + 6W 止盈 + 深檔拉近 2W
                    _lv = [_tp0, _mid, _bt0]
                    _stp = (_bt0 - _SMt * _W) if _d == "l" else (_tp0 + _SMt * _W)
                    _tp_far  = (_tp0 + _TMt * _W) if _d == "l" else (_bt0 - _TMt * _W)
                    _tp_near = (_tp0 + 2.0 * _W) if _d == "l" else (_bt0 - 2.0 * _W)
                _tpx = _tp_far
                _deepbar = None                                   # 全成交(深檔拉近生效)的那根，給止盈價位線階梯用
                _fills = []; _filledlv = []; _res = None           # _fills=成交的K棒；_filledlv=實際成交的每一檔價(可一根多檔)
                _fe = _cf + 1 + _FRESH; _hi = min(_Nn, _cf + 1 + _FRESH + _MAXHOLD)
                for _j in range(_cf + 1, _hi):
                    _lj = _Ln[_j]; _hj = _Hn[_j]
                    if _lj != _lj or _hj != _hj:
                        continue
                    if _j <= _fe and _lv:                         # 新鮮度內 → 三檔影線觸及即成交
                        _hit = [x for x in _lv if (_lj <= x if _d == "l" else _hj >= x)]
                        if _hit:
                            _fills.append(_j)
                            _filledlv.extend(_hit)                # 一根同時穿多檔 → 全部記入(均價才正確)
                            _lv = [x for x in _lv if x not in _hit]
                            if not _lv:                           # 全檔成交(插到底) → 止盈拉近 2W 快跑
                                _tpx = _tp_near
                                if _deepbar is None: _deepbar = _j
                    if _fills:                                    # 已成交 → 檢查止損/止盈
                        # 止損：連『進場棒本身』一起算——同一根插進缺口又掃穿止損(一根突破fvg)＝當棒即止損，
                        #       不可漏算(原本 _j>_fills[0] 會把同棒止損藏掉→那筆變成拖到後面好點出場→回測虛高)。
                        if (_lj <= _stp) if _d == "l" else (_hj >= _stp): _res = ("loss", _j); break
                        # 止盈：保守起見須撐過進場棒之後才認列(同棒不認獲利，避免反向高估)。
                        if _j > _fills[0] and ((_hj >= _tpx) if _d == "l" else (_lj <= _tpx)): _res = ("win", _j); break
                    if _fills and _j >= _fills[0] + _MAXHOLD:     # 自首檔成交起算最長持有
                        break
                if not _fills:
                    continue
                _kind, _xb = _res if _res else ("live", min(_hi, _Nn) - 1)
                _cands.append({"ef": _fills[0], "xb": _xb, "d": _d, "kind": _kind, "fb": list(_fills),
                               "top": _tp0, "bot": _bt0, "sl": _stp, "tpf": _tp_far, "tpn": _tp_near,
                               "deep": _deepbar, "flv": list(_filledlv)})
            # 2) 依「進場時間」排序，貪婪選不重疊（一次一單）——修正原本用「形成時間」誤殺晚進場缺口的 bug
            #    + roll(⟳早平接刀)：持倉中價格往下碰到「下方的同向 FVG」(多:bot更低/空:top更高) →
            #      前一筆早平在新缺口進場棒、接刀進更深的同向缺口；同層/上方的新缺口仍「擋著不進」。
            #      （roll 只在深缺口落在原止損之上、價格還沒到止損就先碰到時才觸發，故天生稀少。）
            _cands.sort(key=lambda x: x["ef"])
            _busy = -1; _act = None; _act_ef = -1; _act_tp = None; _act_bt = None
            for _c in _cands:
                _ef = _c["ef"]; _xb = _c["xb"]; _d = _c["d"]
                if _act is not None and _ef < _busy:                 # 與持倉重疊
                    _below = (_c["bot"] < _act_bt) if _d == "l" else (_c["top"] > _act_tp)
                    if _ef > _act_ef and _below:                     # 價格碰到「下方(多)/上方(空)」同向缺口 → roll
                        _act["xt"] = times_iso[_ef]; _act["r"] = "roll"
                    else:                                            # 同層/上方 → 維持「擋著不進」
                        continue
                _flv = _c["flv"]
                _new = {"d": _d, "et": times_iso[_ef], "xt": times_iso[_xb],
                        "r": _c["kind"], "fills": [times_iso[b] for b in _c["fb"]],
                        "nfill": len(_flv),                                          # 實際成交檔數(可>len(fills))
                        "aentry": round(sum(_flv) / len(_flv), 8) if _flv else None, # 各檔均價(正確均價，給R/畫線用)
                        "top": round(_c["top"], 8), "bot": round(_c["bot"], 8),
                        "sl": round(_c["sl"], 8), "tpf": round(_c["tpf"], 8), "tpn": round(_c["tpn"], 8),
                        "tp2t": (times_iso[_c["deep"]] if _c["deep"] is not None else None)}
                _fvg_trades.append(_new)
                _act = _new; _act_ef = _ef; _act_tp = _c["top"]; _act_bt = _c["bot"]; _busy = _xb
        # 先依進場時間排序再截尾——否則「先全多單、後全空單」會被 [-N:] 截成只剩空單。
        _fvg_trades.sort(key=lambda x: x["et"])
        _fvg_trades = _fvg_trades[-600:]      # 上限 600：1h 約可回溯到去年底（200 只到 3 個月前）
    except Exception:
        _fvg_trades = []

    return {
        "long_only": long_only,   # 是否只算多單（台股=True）
        "from_date": from_date,
        "fvg":      _fvg,         # 失衡缺口（主圖色塊）
        "fvg_break": _fvg_break,  # 「破多/破空」結構轉破標記(跑 proto 缺口序列、標在 g)
        "fvg_ms":   _fvg_ms,      # 「多/空」方向標記(B 用 proto 缺口·g 收盤定緣、標在 g)
        "fvg_shun": _fvg_shun,    # 「順多/順空」：吃同向FVG後影線穿透既存反向FVG(順勢延續)
        "fvg_special": _fvg_special,  # 「特多/特空」：多空/破多空序列 A→B→C 三連市場結構(標在 C)
        "vwap":     _vwap,        # VWAP 成交量加權均價(階段5)
        "fvg_sigs": _fvg_sigs,    # FVG 收盤確認進場訊號（自動交易用）
        "fvg_trades": _fvg_trades,  # FVG「接1次」cascade 進出場點（主圖標記用）
        "fvg_bb":   _fvg_bb,        # D版(三根止損+1.5R)進出場點（研究用主圖標記）
        "fvg_bb_a": _fvg_bb_a,      # A版(g-1止損+布林軌外1W)進出場點（同場對比）
        "fvg_bb_m": _fvg_bb_m,      # M版(中軌分側順勢+止損g/g-1+止盈3W)進出場點
    }
