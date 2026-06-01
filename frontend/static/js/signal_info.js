// 點上方勝率欄六個訊號區塊，從左側滑出抽屜顯示該訊號詳細資訊
(function () {
  // 訊號定義資料（從 CLAUDE.md 整理）
  const SIGNAL_INFO = {
    abc: {
      name: "訊號一 ABC",
      subtitle: "同一棒三條件同時成立",
      icon: "●",
      color: "#ff6b6b",
      gist: "最簡單但發生密集；S1 <b>不計入</b>總勝率合計，僅獨立顯示作參考。",
      patterns: [
        { dir: "做空", cond: "CRT = -1（看跌完成棒） AND KDJ = -1（死叉） AND 共振 = -1（超買）" },
        { dir: "做多", cond: "CRT = +1（看漲完成棒） AND KDJ = +1（金叉） AND 共振 = +1（超賣）" },
      ],
      excludes: ["訊號棒影線已碰 BB 中軌（短：low ≤ 中軌；多：high ≥ 中軌）"],
      entry: "訊號棒下一根開盤（i+1）",
      stop:  "訊號棒最高（空）／最低（多）× (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: ["三指標同棒會發生較頻繁，但勝率最不穩定", "通常配合 ABC 與其他訊號做交叉驗證"],
    },
    ab: {
      name: "訊號二 AB",
      subtitle: "連續兩棒接力",
      icon: "■",
      color: "#ff9800",
      gist: "A 棒先做出共振（超買/超賣），B 棒接著做出 CRT＋KDJ叉。比 S1 結構嚴格。",
      patterns: [
        { dir: "A 棒（i）",   cond: "共振 = ±1（超買 / 超賣）" },
        { dir: "B 棒（i+1）", cond: "CRT = ±1 AND KDJ = ±1（同方向）" },
      ],
      excludes: [
        "B 棒同時有 resonance（會等同 S1，跳過）",
        "B 棒已碰到 BB 中軌（目標已提前觸及）",
      ],
      entry: "B 棒下一根開盤（i+2）",
      stop:  "B 棒最高（空）／最低（多）× (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: ["兩棒接力比同棒更可靠，是常用的進場 setup"],
    },
    s3: {
      name: "訊號三 S3",
      subtitle: "連續三棒（放寬版）",
      icon: "▲",
      color: "#ce93d8",
      gist: "ABC 三棒接力。每棒最多 2 個指標。死叉/金叉棒（C）刺到 BB 上/下軌（超買/超賣後反轉）正是最佳均值回歸進場點，<b>不再排除觸軌</b>，只排除碰中軌。",
      patterns: [
        { dir: "A 棒（i）",   cond: "共振，但 CRT 與 KDJ叉不可同時出現（最多兩個指標）" },
        { dir: "B 棒（i+1）", cond: "同 A 棒規則" },
        { dir: "C 棒（i+2）", cond: "KDJ叉，但 CRT 與共振不可同時出現（C 棒可觸上/下軌）" },
      ],
      excludes: ["C 棒影線已碰 BB 中軌（短：low ≤ 中軌；多：high ≥ 中軌）"],
      entry: "C 棒下一根開盤（i+3）",
      stop:  "三棒最高高點（空）／最低低點（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: ["三棒結構比 S2 更穩，但訊號量會少很多"],
    },
    s4: {
      name: "訊號四 S4",
      subtitle: "連續三棒（嚴格純淨版 A=共振）",
      icon: "◆",
      color: "#80cbc4",
      gist: "A 純共振、B 完全沒指標、C 純 KDJ 叉。最嚴格的純淨版。",
      patterns: [
        { dir: "A 棒（i）",   cond: "<b>只有</b> 共振（CRT=0、KDJ=0）" },
        { dir: "B 棒（i+1）", cond: "<b>三個指標全無</b>（CRT=0、KDJ=0、共振=0）" },
        { dir: "C 棒（i+2）", cond: "<b>只有</b> KDJ 叉（CRT=0、共振=0）" },
      ],
      excludes: ["C 棒 low/high 已碰到 BB 中軌"],
      entry: "C 棒下一根開盤（i+3）",
      stop:  "三棒最高高點（空）／最低低點（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: ["純淨版發生率低但質量高；建議搭配 BB 中軌目標"],
    },
    s5: {
      name: "訊號五 S5",
      subtitle: "連續三棒（嚴格純淨版 B=共振）",
      icon: "★",
      color: "#ffb74d",
      gist: "A 完全沒指標、B 純共振、C 純 KDJ 叉。共振位置不同於 S4。",
      patterns: [
        { dir: "A 棒（i）",   cond: "<b>三個指標全無</b>（CRT=0、KDJ=0、共振=0）" },
        { dir: "B 棒（i+1）", cond: "<b>只有</b> 共振（CRT=0、KDJ=0）" },
        { dir: "C 棒（i+2）", cond: "<b>只有</b> KDJ 叉（CRT=0、共振=0）" },
      ],
      excludes: ["C 棒 low/high 已碰到 BB 中軌"],
      entry: "C 棒下一根開盤（i+3）",
      stop:  "三棒最高高點（空）／最低低點（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: ["共振在中間棒；和 S4 互補形成不同的 setup pattern"],
    },
    s6: {
      name: "訊號六 S6",
      subtitle: "ABC 三棒觸軌反轉",
      icon: "◇",
      color: "#9fa8da",
      gist: "<b>兩根</b>「安靜」棒後突然出現觸軌反轉 K → 高品質「轉折開始」訊號。",
      patterns: [
        { dir: "A / B 棒", cond: "兩根都無任何指標（CRT=0、KDJ=0、共振=0）" },
        { dir: "C 棒做空", cond: "CRT = -1 AND high ≥ BB 上軌（影線觸軌）" },
        { dir: "C 棒做多", cond: "CRT = +1 AND low ≤ BB 下軌（影線觸軌）" },
      ],
      excludes: ["C 棒影線已碰 BB 中軌（短：low ≤ 中軌；多：high ≥ 中軌）"],
      entry: "C 棒下一根開盤（i+3）",
      stop:  "C 棒最高（空）／最低（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: [
        "原為「3 安靜棒 + 第 4 根反轉」（4 棒），因前 3 根全乾淨太嚴格、實戰常漏，改為「2 安靜棒 + 第 3 根反轉」（3 棒）",
        "「轉折開始」訊號，常見於趨勢底/頂",
      ],
    },
    s7: {
      name: "訊號七 S7",
      subtitle: "S4 寬鬆版（A 含 CRT、C 允許 CRT）",
      icon: "⬢",
      color: "#4dd0e1",
      gist: "S4 進場條件略放寬：A 棒必須含 CRT（與訊號方向一致），C 棒可有可無 CRT。比 S4 訊號更多、結構仍嚴謹。",
      patterns: [
        { dir: "A 棒（i） 做空",   cond: "CRT = -1 AND 共振 = -1 AND KDJ = 0" },
        { dir: "A 棒（i） 做多",   cond: "CRT = +1 AND 共振 = +1 AND KDJ = 0" },
        { dir: "B 棒（i+1）", cond: "<b>三個指標全無</b>（CRT=0、KDJ=0、共振=0）" },
        { dir: "C 棒（i+2）", cond: "KDJ 叉（方向一致） AND 共振 = 0（CRT 不限）" },
      ],
      excludes: ["C 棒影線已碰中軌"],
      entry: "C 棒下一根開盤（i+3）",
      stop:  "三棒最高高點（空）／最低低點（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: ["S4 純淨版的放寬版本，A 棒多了 CRT 要求，C 棒不再強制無 CRT"],
    },
    s12: {
      name: "訊號十二 S12",
      subtitle: "10 K 棒視窗：超賣/超買 → 金叉/死叉",
      icon: "❖",
      color: "#ffab91",
      gist: "10 根 K 棒視窗內，<b>共振（超賣/超買）必須先於或同時於 KDJ 叉</b>，且 KDJ 叉棒不可碰中軌。S12 <b>不計入</b>總勝率合計，僅獨立顯示。",
      patterns: [
        { dir: "做空（cross 棒 i）", cond: "KDJ 死叉（cross = -1），且過去 10 根（含當棒）內存在 共振 = -1（超買）" },
        { dir: "做多（cross 棒 i）", cond: "KDJ 金叉（cross = +1），且過去 10 根（含當棒）內存在 共振 = +1（超賣）" },
      ],
      excludes: ["KDJ 叉棒影線已碰中軌（短：low ≤ 中軌；多：high ≥ 中軌）"],
      entry: "KDJ 叉棒下一根開盤（i+1）",
      stop:  "10 棒視窗內最高（空）／最低（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: [
        "共振先表態 → 隨後出現金叉/死叉確認反轉",
        "視窗式掃描：連續同方向 cross 只計第一筆，避免重複",
        "<b>不計入</b>總勝率合計，僅作參考",
      ],
    },
    s11: {
      name: "訊號十一 S11",
      subtitle: "ABCD 四棒純淨：A純超買/賣、BC全無、D純KDJ叉",
      icon: "✸",
      color: "#aed581",
      gist: "S4 的四棒版：A 只有共振、中間兩根（B/C）完全沒指標、D 只有 KDJ 叉。比 S4 多一根「安靜」棒，要求更純淨的醞釀。",
      patterns: [
        { dir: "A 棒（i） 做空", cond: "<b>只有</b> 共振 = -1（超買；CRT=0、KDJ=0）" },
        { dir: "A 棒（i） 做多", cond: "<b>只有</b> 共振 = +1（超賣；CRT=0、KDJ=0）" },
        { dir: "B / C 棒", cond: "<b>三個指標全無</b>（CRT=0、KDJ=0、共振=0）" },
        { dir: "D 棒（i+3） 做空", cond: "<b>只有</b> KDJ 死叉（CRT=0、共振=0）" },
        { dir: "D 棒（i+3） 做多", cond: "<b>只有</b> KDJ 金叉（CRT=0、共振=0）" },
      ],
      excludes: ["A / B / C / D 四棒<b>任一根</b>影線已碰中軌（短：low ≤ 中軌；多：high ≥ 中軌）"],
      entry: "D 棒下一根開盤（i+4）",
      stop:  "四棒最高高點（空）／最低低點（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: ["S4（A共振→B無→C叉）的四棒延伸版，中間多一根安靜棒"],
    },
    s10: {
      name: "訊號十 S10",
      subtitle: "ABCD 四棒視窗：CRT + MACD 叉 + BB 觸軌",
      icon: "✪",
      color: "#90caf9",
      gist: "四根 K 棒視窗內必須<b>三條件都出現</b>：CRT 反向 + MACD 反向叉 + 觸 BB 上/下軌。比 S9（只要兩條件）更嚴格。",
      patterns: [
        { dir: "A/B/C/D 任一根 做空", cond: "CRT = -1（看跌反轉 K）" },
        { dir: "A/B/C/D 任一根 做空", cond: "MACD hist 過零下降（死叉）" },
        { dir: "A/B/C/D 任一根 做空", cond: "high ≥ BB 上軌 × 0.997（觸上軌）" },
        { dir: "A/B/C/D 任一根 做多", cond: "CRT = +1（看漲反轉 K）" },
        { dir: "A/B/C/D 任一根 做多", cond: "MACD hist 過零上升（金叉）" },
        { dir: "A/B/C/D 任一根 做多", cond: "low ≤ BB 下軌 × 1.003（觸下軌）" },
      ],
      excludes: ["四棒中任一根影線已碰 BB 中軌（短：low ≤ bb_mid；多：high ≥ bb_mid）"],
      entry: "D 棒下一根開盤（i+4）",
      stop:  "四棒最高高點（空）／最低低點（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: [
        "三條件可分布在任意棒、不需同棒、不需順序",
        "比 S9 多了 CRT 條件，更嚴格，預期勝率較高",
      ],
    },
    s9: {
      name: "訊號九 S9",
      subtitle: "三棒視窗：BB 觸軌 + MACD 叉",
      icon: "✦",
      color: "#fff176",
      gist: "三根 K 棒視窗內，<b>任一根</b> 觸 BB 上/下軌 + <b>任一根</b> MACD 死/金叉，且<b>三棒皆不可有 CRT</b>。比 S1-S8 寬鬆，不要求順序、可同棒可分棒。",
      patterns: [
        { dir: "A/B/C 任一根 做空", cond: "high ≥ BB 上軌 × 0.997（觸上軌）" },
        { dir: "A/B/C 任一根 做空", cond: "MACD hist 過零下降（死叉）" },
        { dir: "A/B/C 任一根 做多", cond: "low ≤ BB 下軌 × 1.003（觸下軌）" },
        { dir: "A/B/C 任一根 做多", cond: "MACD hist 過零上升（金叉）" },
        { dir: "三棒共同", cond: "<b>A/B/C 三棒全部不可有 CRT</b>（這是 S9 與 S10 的關鍵差異：S9 必須無 CRT、S10 必須含 CRT）" },
      ],
      excludes: ["C 棒（視窗最末棒）影線已碰中軌"],
      entry: "C 棒下一根開盤（i+3）",
      stop:  "三棒最高高點（空）／最低低點（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: [
        "兩條件可同棒可分棒，三根視窗內出現即算",
        "結構最寬鬆，訊號頻率較高，可作為其他訊號的補充",
      ],
    },
    s8: {
      name: "訊號八 S8",
      subtitle: "三棒「一棒一指標」序列",
      icon: "⬡",
      color: "#f06292",
      gist: "ABC 三棒分別出現「共振」「CRT」「KDJ 叉」其中一個指標，依序累積反轉力道。每棒只能有一個指標，最乾淨的階段式 setup。",
      patterns: [
        { dir: "A 棒（i） 做空", cond: "<b>只有</b> 共振 = -1（超買；CRT=0、KDJ=0）" },
        { dir: "A 棒（i） 做多", cond: "<b>只有</b> 共振 = +1（超賣；CRT=0、KDJ=0）" },
        { dir: "B 棒（i+1） 做空", cond: "<b>只有</b> CRT = -1（CRT 空；共振=0、KDJ=0）" },
        { dir: "B 棒（i+1） 做多", cond: "<b>只有</b> CRT = +1（CRT 多；共振=0、KDJ=0）" },
        { dir: "C 棒（i+2） 做空", cond: "<b>只有</b> KDJ 死叉（共振=0、CRT=0）" },
        { dir: "C 棒（i+2） 做多", cond: "<b>只有</b> KDJ 金叉（共振=0、CRT=0）" },
      ],
      excludes: ["C 棒影線已碰中軌"],
      entry: "C 棒下一根開盤（i+3）",
      stop:  "三棒最高高點（空）／最低低點（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌 / 1:1（止盈距離=止損距離）",
      notes: [
        "與 S4/S5 不同：S4 是「A 共振、B 全無、C KDJ叉」；S8 是「A 共振、B CRT、C KDJ叉」",
        "每棒承接前棒，三步累積反轉，結構最完整",
      ],
    },
  };

  // signals 列表中 s.k 用「3/4/5/6/7」（無 s 前綴），需要對應
  const _S_KEY_MAP = { abc: "abc", ab: "ab", s3: "3", s4: "4", s5: "5", s6: "6", s7: "7", s8: "8", s9: "9", s10: "10", s11: "11", s12: "12" };

  const $ = id => document.getElementById(id);

  // 目標標籤（中軌 / 上/下軌 / 1:1）— 與 winrate.js 的 _wrTargetView 共用
  function _viewLabel() {
    const v = (typeof _wrTargetView !== "undefined") ? _wrTargetView : "mid";
    return v === "band" ? "上/下軌" : v === "rr" ? "1:1" : "中軌";
  }

  function _statsFor(key) {
    const d = (typeof _wrCacheLast !== "undefined") ? _wrCacheLast : null;
    if (!d) return null;
    const view = (typeof _wrPickView === "function") ? _wrPickView(d) : d;
    return view?.[key];
  }

  function _signalsFor(key) {
    if (typeof _lastWRSignals === "undefined" || !_lastWRSignals) return [];
    const sk = _S_KEY_MAP[key];
    const rKey = (typeof _wrResultKey === "function") ? _wrResultKey() : "r";
    const otKey = (typeof _wrOtKey === "function") ? _wrOtKey() : "ot";
    return _lastWRSignals
      .filter(s => s.k === sk)
      .map(s => ({
        t: s.t,
        d: s.d,
        r: s[rKey],
        ot: s[otKey],
      }));
  }

  function _formatTime(iso) {
    if (!iso) return "—";
    return iso.replace("T", " ").slice(0, 16); // "YYYY-MM-DD HH:mm"
  }

  function _statRow(label, s) {
    if (!s || s.win_rate == null) {
      return `<div class="sig-stat-row"><span class="sig-stat-lbl">${label}</span><span class="sig-stat-val">—</span></div>`;
    }
    const good = s.win_rate >= 60, bad = s.win_rate < 45;
    const cls = good ? "good" : bad ? "bad" : "";
    const losses = s.losses ?? (s.total - s.wins);
    const lowSample = s.total < 40
      ? ` <span class="sig-low-sample" title="樣本 < 40，資料源可能已達上限">⚠</span>`
      : "";
    const streak = (s.max_loss_streak && s.max_loss_streak > 0)
      ? ` <span class="sig-stat-streak" title="該訊號歷史中最長連續 loss 次數">最大連敗 ${s.max_loss_streak}</span>`
      : "";
    return `<div class="sig-stat-row">
      <span class="sig-stat-lbl">${label}</span>
      <span class="sig-stat-val ${cls}">${s.win_rate}%</span>
      <span class="sig-stat-cnt">${s.wins}勝 / ${losses}負（共 ${s.total} 筆）${lowSample}${streak}</span>
    </div>`;
  }

  function _rrBlock(s) {
    if (!s || s.total == null || s.total === 0) return "";
    // 沒任何 metrics（極舊資料）就跳過
    if (s.avg_rr_est == null && s.avg_rr_act == null) return "";
    const fmtR = v => v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + " R";
    const fmtRR = v => v == null ? "—" : v.toFixed(2);
    const pf = s.profit_factor;
    const pfStr = pf === "inf" ? "∞" : (pf == null ? "—" : pf.toFixed(2));
    const pfCls = (pf === "inf" || (typeof pf === "number" && pf >= 1.5)) ? "good"
                : (typeof pf === "number" && pf < 1.0) ? "bad" : "";
    const netActCls = s.net_r_act != null && s.net_r_act > 0 ? "good"
                    : s.net_r_act != null && s.net_r_act < 0 ? "bad" : "";
    return `<div class="sig-rr-grid">
      <div class="sig-rr-col">
        <div class="sig-rr-hd">📐 預估（進場時）</div>
        <div class="sig-rr-line"><span>平均 RR</span><b>${fmtRR(s.avg_rr_est)}</b></div>
        <div class="sig-rr-line"><span>累計淨 R</span><b>${fmtR(s.net_r_est)}</b></div>
      </div>
      <div class="sig-rr-col">
        <div class="sig-rr-hd">📊 實際（含 BB 漂移）</div>
        <div class="sig-rr-line"><span>平均贏 RR</span><b>${fmtRR(s.avg_rr_act)}</b></div>
        <div class="sig-rr-line"><span>累計淨 R</span><b class="${netActCls}">${fmtR(s.net_r_act)}</b></div>
        <div class="sig-rr-line"><span>PF</span><b class="${pfCls}">${pfStr}</b></div>
      </div>
    </div>`;
  }

  // 敗後停手策略 細節抽屜
  function _renderStopDrawer() {
    const d = (typeof _wrCacheLast !== "undefined") ? _wrCacheLast : null;
    if (!d) return;
    const view = (typeof _wrPickView === "function") ? _wrPickView(d) : d;
    const viewLabel = _viewLabel();
    const variantLabel = "原版";
    const ss = view && view.stop_strategy;
    const base = view;  // 不用策略的去重總勝率（對照）
    const curBuf = (typeof _wrStopBuffer !== "undefined") ? _wrStopBuffer : 0;

    const _wrCell = (o) => {
      if (!o || o.win_rate == null) return `<span class="sig-stat-val">—</span>`;
      const c = o.win_rate >= 60 ? "good" : o.win_rate < 45 ? "bad" : "";
      const losses = (o.total != null && o.wins != null) ? (o.total - o.wins) : "—";
      return `<span class="sig-stat-val ${c}">${o.win_rate}%</span><span class="sig-stat-cnt">${o.wins}勝/${losses}負（${o.total}筆）</span>`;
    };
    const _row = (label, o) => `<div class="sig-stat-row"><span class="sig-stat-lbl">${label}</span>${_wrCell(o)}</div>`;

    const actBlock = ss ? `
      <div class="sig-rule-lbl" style="margin:4px 0">📊 實際（${viewLabel}目標）</div>
      ${_row("合計", ss)}
      ${_row("空單", ss.short)}
      ${_row("多單", ss.long)}` : `<div class="sig-empty">尚無資料</div>`;
    const estBlock = (ss && ss.est) ? `
      <div class="sig-rule-lbl" style="margin:8px 0 4px">📐 預估（進場時固定目標）</div>
      ${_row("合計", ss.est)}
      ${_row("空單", ss.est.short)}
      ${_row("多單", ss.est.long)}` : "";

    // 對照：不用策略 vs 用策略（合計）
    const cmp = (base && base.win_rate != null && ss && ss.win_rate != null) ? `
      <div class="sig-stat-row"><span class="sig-stat-lbl">不用停手（全進場）</span><span class="sig-stat-val">${base.win_rate}%</span><span class="sig-stat-cnt">${base.total}筆</span></div>
      <div class="sig-stat-row"><span class="sig-stat-lbl">敗後停手</span><span class="sig-stat-val ${ss.win_rate>=base.win_rate?'good':'bad'}">${ss.win_rate}%</span><span class="sig-stat-cnt">${ss.total}筆（${ss.win_rate>=base.win_rate?'+':''}${(ss.win_rate-base.win_rate).toFixed(1)}）</span></div>` : "";

    const html = `
      <div class="sig-dwr-hd" style="border-left:3px solid #ffb74d">
        <span class="sig-dwr-icon" style="color:#ffb74d">⏸</span>
        <div class="sig-dwr-titles">
          <div class="sig-dwr-name">敗後停手策略</div>
          <div class="sig-dwr-sub">${viewLabel}目標 · ${variantLabel}（母體同總勝率 S2~S11 去重）</div>
        </div>
        <button class="sig-dwr-close" id="sigDrawerClose">✕</button>
      </div>
      <div class="sig-dwr-body">
        <section class="sig-section">
          <p class="sig-gist">輸一次就<b>停手</b>該方向、旁觀後續同方向訊號（不計）；直到<b>同方向出現會贏的單</b>或<b>反方向訊號出現</b>才解除、從下一筆回場。用來避開連敗段。</p>
        </section>
        <section class="sig-section">
          <h3 class="sig-h3 sig-h3-toggle">規則細節 <span class="sig-collapse-arr">▾</span></h3>
          <div class="sig-sec-body">
            <ul class="sig-list">
              <li>進場中遇敗 → 該方向停手（這一敗計入）</li>
              <li>停手中：跳過該方向訊號（不計），反方向不受影響照常進場</li>
              <li>解除①：同方向出現「紙上會贏」的訊號（那筆不計，下一筆才回場）</li>
              <li>解除②：反方向訊號出現（中斷連敗，立刻打回進場中）</li>
              <li>空、多在同一條合併時間軸上各自獨立判斷</li>
            </ul>
          </div>
        </section>
        <section class="sig-section">
          <h3 class="sig-h3 sig-h3-toggle">套用後勝率 <span class="sig-collapse-arr">▾</span></h3>
          <div class="sig-sec-body">${actBlock}${estBlock}</div>
        </section>
        <section class="sig-section">
          <h3 class="sig-h3">🎯 達標建議止損（目標 80%，需 &gt;5% 則改 75%）</h3>
          <div class="sig-sec-body">
            <div id="stopSolveResult" class="sig-solve">求解中…</div>
            <div class="sig-pyr-row" style="margin-top:8px">
              <label class="sig-pyr-lbl">你的止損%（即時套用、與上方 SL 同步）</label>
              <input id="stopBufInput" class="sig-pyr-num" type="number" step="0.1" min="0" max="10" value="${curBuf}"/>
            </div>
          </div>
        </section>
        <section class="sig-section">
          <h3 class="sig-h3 sig-h3-toggle">對照（合計） <span class="sig-collapse-arr">▾</span></h3>
          <div class="sig-sec-body">${cmp || '<div class="sig-empty">尚無資料</div>'}</div>
        </section>
        <section class="sig-section">
          <h3 class="sig-h3">備註</h3>
          <ul class="sig-list">
            <li>「預估」用進場時固定目標掃描；「實際」用會隨 BB 漂移的動態目標</li>
            <li>停手中那筆回穩勝單不計入勝率（人不在場、紙上訊號）</li>
          </ul>
        </section>
      </div>`;
    const root = $("signalDrawerContent");
    if (root) root.innerHTML = html;
    root.querySelectorAll(".sig-h3-toggle").forEach(h => {
      h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed"));
    });
    $("sigDrawerClose")?.addEventListener("click", _hide);
    // 止損%輸入框：即時套用（同步上方 SL 緩衝）
    const bufInp = root.querySelector("#stopBufInput");
    if (bufInp) bufInp.addEventListener("change", () => {
      if (typeof window._setStopBuffer === "function") window._setStopBuffer(bufInp.value);
    });
    _fetchStopSolve();   // 非同步求解達標建議止損
  }

  // 求解「達 80% 敗後停手所需止損%」並填入抽屜（依目前 中軌/上下軌 + 原/強化版）
  // 更新時一律用 id 重查 live 元素、並用請求序號丟棄過時回應 → 不怕抽屜重繪/快速切換
  let _stopSolveSeq = 0;
  let _autoAppliedKey = null;   // 每個 (標的|時框|視圖) 只自動套用一次，不蓋使用者後續手動輸入
  function _fetchStopSolve() {
    const seq = ++_stopSolveSeq;
    const _set = (txt, isHtml) => {
      if (seq !== _stopSolveSeq) return;                 // 已有更新請求 → 丟棄
      const live = document.getElementById("stopSolveResult");
      if (!live) return;
      if (isHtml) live.innerHTML = txt; else live.textContent = txt;
    };
    const market   = document.getElementById("marketSelect")?.value || "crypto";
    const symbol   = document.getElementById("symbolInput")?.value?.trim() || "";
    const exchange = document.getElementById("exchangeSelect")?.value || "pionex";
    const tf       = (typeof currentTF !== "undefined" && currentTF) ? currentTF : "1d";
    if (!symbol) { _set("—"); return; }
    _set("求解中…");
    const tgt = (typeof _wrTargetView !== "undefined" && _wrTargetView === "band") ? "band" : "mid";
    const p = new URLSearchParams({ market, symbol, exchange, timeframe: tf,
      solve: 1, solve_target: tgt });
    const applyKey = `${symbol}|${tf}|${tgt}`;
    fetch("/api/crt_winrate?" + p).then(r => r.json()).then(d => {
      if (!d || d.stop_pct == null) { _set("—"); return; }
      if (d.achieved) {
        const cls = d.win_rate >= 80 ? "good" : "";
        _set(`已自動帶入止損 <b class="${cls}">${d.stop_pct}%</b> → 敗後停手 <b class="${cls}">${d.win_rate}%</b>`
          + `<span class="sig-stat-cnt">（達目標 ${d.target}%，${d.total} 筆；可於下方自行調整）</span>`
          + ` <button class="sig-apply-btn" onclick="window._setStopBuffer&&window._setStopBuffer(${d.stop_pct})">重新套用 ${d.stop_pct}%</button>`, true);
      } else {
        _set(`止損 6% 內無法達 75%；最高 <b>${d.win_rate}%</b>（止損 ${d.stop_pct}%）`
          + ` <button class="sig-apply-btn" onclick="window._setStopBuffer&&window._setStopBuffer(${d.stop_pct})">套用 ${d.stop_pct}%</button>`, true);
      }
      // 自動 key 入：每個 (標的|時框|視圖) 首次求解出可達標結果時，自動把建議止損套入
      if (d.achieved && d.stop_pct != null && _autoAppliedKey !== applyKey) {
        _autoAppliedKey = applyKey;
        const cur = (typeof _wrStopBuffer !== "undefined") ? _wrStopBuffer : 0;
        if (Math.abs(cur - d.stop_pct) > 1e-9 && typeof window._setStopBuffer === "function") {
          window._setStopBuffer(d.stop_pct);
        }
      }
    }).catch(() => { _set("求解失敗"); });
  }

  function _renderDrawer(key) {
    if (key === "__stop__") { _renderStopDrawer(); return; }
    const info = SIGNAL_INFO[key];
    if (!info) return;
    const stats = _statsFor(key);
    const sigs  = _signalsFor(key);
    const viewLabel = _viewLabel();
    const variantLabel = "原版";
    const nameWithVariant = info.name;

    const patternsHTML = (info.patterns || []).map(p =>
      `<div class="sig-pat-row"><span class="sig-pat-dir">${p.dir}</span><span class="sig-pat-cond">${p.cond}</span></div>`
    ).join("");

    const excludesHTML = (info.excludes || []).length
      ? `<section class="sig-section">
          <h3 class="sig-h3">排除條件</h3>
          <ul class="sig-list">${info.excludes.map(x => `<li>${x}</li>`).join("")}</ul>
        </section>`
      : "";

    const notesHTML = (info.notes || []).length
      ? `<section class="sig-section">
          <h3 class="sig-h3">備註</h3>
          <ul class="sig-list">${info.notes.map(n => `<li>${n}</li>`).join("")}</ul>
        </section>`
      : "";

    // 最近訊號表（最多顯示 30 筆，最新在上）
    const recentHTML = sigs.length === 0
      ? `<div class="sig-empty">目前圖表時間範圍內沒有此訊號</div>`
      : sigs.slice(-30).reverse().map(s => {
          const dirCls = s.d === "s" ? "dir-s" : "dir-l";
          const dirLbl = s.d === "s" ? "空" : "多";
          const rIcon  = s.r === "w" ? "✓" : s.r === "l" ? "✗" : "—";
          const rCls   = s.r === "w" ? "win" : s.r === "l" ? "loss" : "";
          return `<div class="sig-row" data-jump="${s.t}">
            <span class="sig-row-t">${_formatTime(s.t)}</span>
            <span class="sig-row-d ${dirCls}">${dirLbl}</span>
            <span class="sig-row-r ${rCls}">${rIcon}</span>
            <span class="sig-row-ot">${s.ot ? "→ " + _formatTime(s.ot) : ""}</span>
          </div>`;
        }).join("");

    const winsT = sigs.filter(s => s.r === "w").length;
    const lossT = sigs.filter(s => s.r === "l").length;
    const totT  = winsT + lossT;
    const wrT   = totT ? ((winsT / totT) * 100).toFixed(1) : null;
    const visibleLine = totT
      ? `當前可見：<b>${wrT}%</b> 勝率（${winsT}勝/${lossT}負，${totT}筆）`
      : `當前圖表沒有結算的訊號`;

    const html = `
      <div class="sig-dwr-hd" style="border-left:3px solid ${info.color}">
        <span class="sig-dwr-icon" style="color:${info.color}">${info.icon}</span>
        <div class="sig-dwr-titles">
          <div class="sig-dwr-name">${nameWithVariant}</div>
          <div class="sig-dwr-sub">${info.subtitle}${variantLabel === "強化版" ? " + 強化濾鏡（預估RR 0.6~1.1）" : ""}</div>
        </div>
        <button class="sig-dwr-close" id="sigDrawerClose">✕</button>
      </div>

      <div class="sig-dwr-body">
        <section class="sig-section">
          <p class="sig-gist">${info.gist}</p>
        </section>

        <section class="sig-section">
          <h3 class="sig-h3 sig-h3-toggle">訊號定義 <span class="sig-collapse-arr">▾</span></h3>
          <div class="sig-sec-body"><div class="sig-patterns">${patternsHTML}</div></div>
        </section>

        ${excludesHTML}

        <section class="sig-section">
          <h3 class="sig-h3 sig-h3-toggle">進場 / 止損 / 目標 <span class="sig-collapse-arr">▾</span></h3>
          <div class="sig-sec-body">
            <div class="sig-rule"><span class="sig-rule-lbl">進場</span><span>${info.entry}</span></div>
            <div class="sig-rule"><span class="sig-rule-lbl">止損</span><span>${info.stop}</span></div>
            <div class="sig-rule"><span class="sig-rule-lbl">目標</span><span>${info.target}</span></div>
          </div>
        </section>

        <section class="sig-section">
          <h3 class="sig-h3 sig-h3-toggle">當前統計（${viewLabel}目標，${variantLabel}） <span class="sig-collapse-arr">▾</span></h3>
          <div class="sig-sec-body">
            ${_statRow("空單", stats?.short)}
            ${_rrBlock(stats?.short)}
            ${_statRow("多單", stats?.long)}
            ${_rrBlock(stats?.long)}
            <div class="sig-visible-line">${visibleLine}</div>
          </div>
        </section>

        ${_pyrSettingsHTML()}

        <section class="sig-section">
          <h3 class="sig-h3 sig-h3-toggle">訊號列表（最近 ${Math.min(sigs.length, 30)} 筆，點擊跳到該位置） <span class="sig-collapse-arr">▾</span></h3>
          <div class="sig-sec-body"><div class="sig-list-box">${recentHTML}</div></div>
        </section>

        ${notesHTML}
      </div>
    `;
    const root = $("signalDrawerContent");
    if (root) root.innerHTML = html;

    // 綁定列點擊 → 跳轉圖表
    root.querySelectorAll(".sig-row").forEach(row => {
      row.addEventListener("click", () => {
        const t = row.dataset.jump;
        _jumpChartTo(t);
      });
    });
    // section header 點擊收合
    root.querySelectorAll(".sig-h3-toggle").forEach(h => {
      h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed"));
    });
    _bindPyrSettings(root);
    $("sigDrawerClose")?.addEventListener("click", _hide);
  }

  // 加碼設定 section（全域設定，影響所有 auto-RR 盒）
  function _pyrSettingsHTML() {
    const p = (typeof window._getPyrSettings === "function")
      ? window._getPyrSettings() : { sizeBelow: 1, sizeAbove: 1, indicator: true, bbrev: false };
    return `
      <section class="sig-section">
        <h3 class="sig-h3 sig-h3-toggle">⚙ 加碼設定 <span class="sig-collapse-arr">▾</span></h3>
        <div class="sig-sec-body">
          <div class="sig-pyr-row">
            <label class="sig-pyr-lbl" title="加碼點價格『低於入場價』時的加碼量">低於入場價加碼（× 初始倉）</label>
            <input id="pyrSizeBelow" class="sig-pyr-num" type="number" step="0.1" min="0.1" max="5" value="${p.sizeBelow}"/>
          </div>
          <div class="sig-pyr-row">
            <label class="sig-pyr-lbl" title="加碼點價格『高於（含等於）入場價』時的加碼量">高於入場價加碼（× 初始倉）</label>
            <input id="pyrSizeAbove" class="sig-pyr-num" type="number" step="0.1" min="0.1" max="5" value="${p.sizeAbove}"/>
          </div>
          <label class="sig-pyr-check">
            <input id="pyrIndicator" type="checkbox" ${p.indicator ? "checked" : ""}/>
            <span>同方向 CRT / 共振 / KDJ叉 觸發加碼</span>
          </label>
          <label class="sig-pyr-check">
            <input id="pyrBBrev" type="checkbox" ${p.bbrev ? "checked" : ""}/>
            <span>BB 反轉型態觸發（多：碰下軌＋綠K接紅K收中軌上；空：對稱）</span>
          </label>
          <div class="sig-pyr-hint">設定即時套用到主圖已展開的盈虧比盒（均減進場線會重算）</div>
        </div>
      </section>
    `;
  }

  function _bindPyrSettings(root) {
    const setFn = window._setPyrSetting;
    if (typeof setFn !== "function") return;
    const szB = root.querySelector("#pyrSizeBelow");
    if (szB) szB.addEventListener("change", () => {
      const v = Math.max(0.1, Math.min(5, parseFloat(szB.value) || 1));
      szB.value = v; setFn("sizeBelow", v);
    });
    const szA = root.querySelector("#pyrSizeAbove");
    if (szA) szA.addEventListener("change", () => {
      const v = Math.max(0.1, Math.min(5, parseFloat(szA.value) || 1));
      szA.value = v; setFn("sizeAbove", v);
    });
    const ind = root.querySelector("#pyrIndicator");
    if (ind) ind.addEventListener("change", () => setFn("indicator", ind.checked));
    const bb = root.querySelector("#pyrBBrev");
    if (bb) bb.addEventListener("change", () => setFn("bbrev", bb.checked));
  }

  function _jumpChartTo(isoTime) {
    if (!isoTime || typeof mainChart === "undefined") return;
    const t = (typeof toTime === "function") ? toTime(isoTime) : null;
    if (!t || !ohlcvData) return;
    // 找在 ohlcvData 的 index
    const idx = ohlcvData.findIndex(d => (typeof toTime === "function" ? toTime(d.time) : d.time) === t);
    if (idx < 0) return;
    const range = mainChart.timeScale().getVisibleLogicalRange();
    const span = range ? Math.max(20, range.to - range.from) : 80;
    const half = Math.floor(span / 2);
    mainChart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, idx - half),
      to:   Math.min(ohlcvData.length - 1, idx + half),
    });
  }

  function _show(key) {
    _renderDrawer(key);
    $("signalDrawer")?.classList.remove("hidden");
    document.body.classList.add("sig-drawer-open");
    _currentKey = key;
  }
  // 點 TOP3 列的「敗後停手」數字 → 開細節抽屜（winrate.js 的 onclick 呼叫）
  window._showStopStrategyDrawer = function () {
    if (_currentKey === "__stop__" && !$("signalDrawer")?.classList.contains("hidden")) _hide();
    else _show("__stop__");
  };
  function _hide() {
    $("signalDrawer")?.classList.add("hidden");
    document.body.classList.remove("sig-drawer-open");
    _currentKey = null;
  }

  let _currentKey = null;

  // 隱藏的策略 marker key set（用 signal.k 的格式："abc"/"ab"/"3".."12"）
  window._hiddenWrSigs = window._hiddenWrSigs || new Set();
  try {
    const saved = JSON.parse(localStorage.getItem("wrHiddenSigs") || "[]");
    saved.forEach(k => window._hiddenWrSigs.add(k));
  } catch (e) {}

  function init() {
    // 還原雙擊隱藏的視覺狀態
    document.querySelectorAll(".tb-wr-block[data-sig]").forEach(blk => {
      const k = _S_KEY_MAP[blk.dataset.sig];
      if (k && window._hiddenWrSigs.has(k)) blk.classList.add("sig-hidden");
    });

    document.querySelectorAll(".tb-wr-block[data-sig]").forEach(blk => {
      let _clickTimer = null;
      let _lastTs = 0;
      const DBL_MS = 350;
      blk.addEventListener("click", (e) => {
        const now = Date.now();
        if (now - _lastTs < DBL_MS) {
          // 視為雙擊 — 取消單擊計時器並 toggle 隱藏
          if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }
          _lastTs = 0;
          const sig = blk.dataset.sig;
          const k = _S_KEY_MAP[sig];
          if (!k) return;
          if (window._hiddenWrSigs.has(k)) {
            window._hiddenWrSigs.delete(k);
            blk.classList.remove("sig-hidden");
          } else {
            window._hiddenWrSigs.add(k);
            blk.classList.add("sig-hidden");
          }
          try { localStorage.setItem("wrHiddenSigs", JSON.stringify([...window._hiddenWrSigs])); } catch (er) {}
          if (typeof _renderWRSignals === "function") _renderWRSignals();
          return;
        }
        _lastTs = now;
        _clickTimer = setTimeout(() => {
          _clickTimer = null; _lastTs = 0;
          const k = blk.dataset.sig;
          if (!k) return;
          if (_currentKey === k && !$("signalDrawer")?.classList.contains("hidden")) _hide();
          else _show(k);
        }, DBL_MS);
      });
    });

    // ESC 關閉
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !$("signalDrawer")?.classList.contains("hidden")) _hide();
    });

    // 點抽屜外（但不是勝率欄區塊）→ 關閉
    document.addEventListener("click", e => {
      const drawer = $("signalDrawer");
      if (!drawer || drawer.classList.contains("hidden")) return;
      if (drawer.contains(e.target)) return;
      if (e.target.closest(".tb-wr-block")) return;  // 點別的訊號塊：交給 block 自己處理
      if (e.target.closest(".wr-stop-detail")) return;  // 點敗後停手數字：交給它自己 toggle
      _hide();
    }, true);

    // 切換中軌/上下軌、原/強化版時：如果抽屜開著，重新渲染
    ["wrTargetToggle", "wrVariantToggle"].forEach(id => {
      const tgl = $(id);
      if (!tgl) return;
      tgl.addEventListener("click", () => {
        if (_currentKey && !$("signalDrawer")?.classList.contains("hidden")) {
          setTimeout(() => _renderDrawer(_currentKey), 0);
        }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 暴露給其他模組（資料更新後重新渲染）
  window._refreshSignalDrawer = () => {
    if (_currentKey && !$("signalDrawer")?.classList.contains("hidden")) {
      _renderDrawer(_currentKey);
    }
  };
  // 給 winrate.js 的 hover 勝率項目點擊用：以 stat key（abc/ab/s3…）開該訊號詳情（再點同一個則收回）
  window._showSignalInfoByStatKey = (key) => {
    if (!key) return;
    if (_currentKey === key && !$("signalDrawer")?.classList.contains("hidden")) _hide();
    else _show(key);
  };
})();
