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
      entry: "訊號棒下一根開盤（i+1）",
      stop:  "訊號棒最高（空）／最低（多）× (1 ± SL buffer)",
      target: "BB 中軌（中軌模式）／BB 上下軌（上下軌模式）",
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
      target: "BB 中軌 / BB 上下軌",
      notes: ["兩棒接力比同棒更可靠，是常用的進場 setup"],
    },
    s3: {
      name: "訊號三 S3",
      subtitle: "連續三棒（放寬版）",
      icon: "▲",
      color: "#ce93d8",
      gist: "ABC 三棒接力。每棒可有 2 個指標，但 C 棒不可同時觸 BB 軌（會排除）。",
      patterns: [
        { dir: "A 棒（i）",   cond: "共振，但 CRT 與 KDJ叉不可同時出現（最多兩個指標）" },
        { dir: "B 棒（i+1）", cond: "同 A 棒規則" },
        { dir: "C 棒（i+2）", cond: "KDJ叉，但 CRT 與共振不可同時出現" },
      ],
      excludes: ["C 棒影線觸及 BB 上/下軌（high ≥ bb_upper / low ≤ bb_lower）"],
      entry: "C 棒下一根開盤（i+3）",
      stop:  "三棒最高高點（空）／最低低點（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌",
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
      target: "BB 中軌 / BB 上下軌",
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
      target: "BB 中軌 / BB 上下軌",
      notes: ["共振在中間棒；和 S4 互補形成不同的 setup pattern"],
    },
    s6: {
      name: "訊號六 S6",
      subtitle: "ABCD 四棒觸軌反轉",
      icon: "◇",
      color: "#9fa8da",
      gist: "三根「安靜」棒後突然出現觸軌反轉 K → 高品質「轉折開始」訊號。",
      patterns: [
        { dir: "A / B / C 棒", cond: "三根都無任何指標（CRT=0、KDJ=0、共振=0）" },
        { dir: "D 棒做空",     cond: "CRT = -1 AND high ≥ BB 上軌（影線觸軌）" },
        { dir: "D 棒做多",     cond: "CRT = +1 AND low ≤ BB 下軌（影線觸軌）" },
      ],
      entry: "D 棒下一根開盤（i+4）",
      stop:  "D 棒最高（空）／最低（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌",
      notes: [
        "實測勝率（中軌目標）：BTC 1d 62.5%、4h 63.2%、1h 58.5%",
        "ETH 1d 66.7%、4h 62.0%；SOL 4h 59.5%",
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
      target: "BB 中軌 / BB 上下軌",
      notes: ["S4 純淨版的放寬版本，A 棒多了 CRT 要求，C 棒不再強制無 CRT"],
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
      target: "BB 中軌 / BB 上下軌",
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
      gist: "三根 K 棒視窗內，<b>任一根</b> 觸 BB 上/下軌 + <b>任一根</b> MACD 死/金叉。比 S1-S8 寬鬆，不要求順序、可同棒可分棒。",
      patterns: [
        { dir: "A/B/C 任一根 做空", cond: "high ≥ BB 上軌 × 0.997（觸上軌）" },
        { dir: "A/B/C 任一根 做空", cond: "MACD hist 過零下降（死叉）" },
        { dir: "A/B/C 任一根 做多", cond: "low ≤ BB 下軌 × 1.003（觸下軌）" },
        { dir: "A/B/C 任一根 做多", cond: "MACD hist 過零上升（金叉）" },
      ],
      excludes: ["C 棒（視窗最末棒）影線已碰中軌"],
      entry: "C 棒下一根開盤（i+3）",
      stop:  "三棒最高高點（空）／最低低點（多） × (1 ± SL buffer)",
      target: "BB 中軌 / BB 上下軌",
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
      target: "BB 中軌 / BB 上下軌",
      notes: [
        "與 S4/S5 不同：S4 是「A 共振、B 全無、C KDJ叉」；S8 是「A 共振、B CRT、C KDJ叉」",
        "每棒承接前棒，三步累積反轉，結構最完整",
      ],
    },
  };

  // signals 列表中 s.k 用「3/4/5/6/7」（無 s 前綴），需要對應
  const _S_KEY_MAP = { abc: "abc", ab: "ab", s3: "3", s4: "4", s5: "5", s6: "6", s7: "7", s8: "8", s9: "9", s10: "10" };

  const $ = id => document.getElementById(id);

  function _statsFor(key) {
    const d = (typeof _wrCacheLast !== "undefined") ? _wrCacheLast : null;
    if (!d) return null;
    let view = (typeof _wrTargetView !== "undefined" && _wrTargetView === "band" && d.band) ? d.band : d;
    // 強化版時取巢狀 .variant
    if (typeof _wrVariantView !== "undefined" && _wrVariantView === "variant" && view && view.variant) {
      view = view.variant;
    }
    return view?.[key];
  }

  function _signalsFor(key) {
    if (typeof _lastWRSignals === "undefined" || !_lastWRSignals) return [];
    const sk = _S_KEY_MAP[key];
    const useBand = (typeof _wrTargetView !== "undefined") && _wrTargetView === "band";
    const useVariant = (typeof _wrVariantView !== "undefined") && _wrVariantView === "variant";
    return _lastWRSignals
      .filter(s => s.k === sk && (!useVariant || s.v))
      .map(s => ({
        t: s.t,
        d: s.d,
        r: useBand ? s.r_b : s.r,
        ot: useBand ? s.ot_b : s.ot,
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
    // 樣本不足 (< 30) 加警示提示：資料源可能已用盡
    const lowSample = s.total < 40
      ? ` <span class="sig-low-sample" title="樣本 < 40，資料源可能已達上限">⚠</span>`
      : "";
    return `<div class="sig-stat-row">
      <span class="sig-stat-lbl">${label}</span>
      <span class="sig-stat-val ${cls}">${s.win_rate}%</span>
      <span class="sig-stat-cnt">${s.wins}勝 / ${losses}負（共 ${s.total} 筆）${lowSample}</span>
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

  function _renderDrawer(key) {
    const info = SIGNAL_INFO[key];
    if (!info) return;
    const stats = _statsFor(key);
    const sigs  = _signalsFor(key);
    const viewLabel = (typeof _wrTargetView !== "undefined" && _wrTargetView === "band") ? "上/下軌" : "中軌";
    const variantLabel = (typeof _wrVariantView !== "undefined" && _wrVariantView === "variant") ? "強化版" : "原版";
    // 訊號名稱加 "-1" 標記強化版
    const nameWithVariant = variantLabel === "強化版" ? `${info.name}-1` : info.name;

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
          <div class="sig-dwr-sub">${info.subtitle}${variantLabel === "強化版" ? " + 量能爆發濾鏡" : ""}</div>
        </div>
        <button class="sig-dwr-close" id="sigDrawerClose">✕</button>
      </div>

      <div class="sig-dwr-body">
        <section class="sig-section">
          <p class="sig-gist">${info.gist}</p>
        </section>

        <section class="sig-section">
          <h3 class="sig-h3">訊號定義</h3>
          <div class="sig-patterns">${patternsHTML}</div>
        </section>

        ${excludesHTML}

        <section class="sig-section">
          <h3 class="sig-h3">進場 / 止損 / 目標</h3>
          <div class="sig-rule"><span class="sig-rule-lbl">進場</span><span>${info.entry}</span></div>
          <div class="sig-rule"><span class="sig-rule-lbl">止損</span><span>${info.stop}</span></div>
          <div class="sig-rule"><span class="sig-rule-lbl">目標</span><span>${info.target}</span></div>
        </section>

        <section class="sig-section">
          <h3 class="sig-h3">當前統計（${viewLabel}目標，${variantLabel}）</h3>
          ${_statRow("空單", stats?.short)}
          ${_rrBlock(stats?.short)}
          ${_statRow("多單", stats?.long)}
          ${_rrBlock(stats?.long)}
          <div class="sig-visible-line">${visibleLine}</div>
        </section>

        <section class="sig-section">
          <h3 class="sig-h3">訊號列表（最近 ${Math.min(sigs.length, 30)} 筆，點擊跳到該位置）</h3>
          <div class="sig-list-box">${recentHTML}</div>
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
    $("sigDrawerClose")?.addEventListener("click", _hide);
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
  function _hide() {
    $("signalDrawer")?.classList.add("hidden");
    document.body.classList.remove("sig-drawer-open");
    _currentKey = null;
  }

  let _currentKey = null;

  function init() {
    document.querySelectorAll(".tb-wr-block[data-sig]").forEach(blk => {
      blk.addEventListener("click", () => {
        const k = blk.dataset.sig;
        if (!k) return;
        // 同一個再點一次 = 關閉
        if (_currentKey === k && !$("signalDrawer")?.classList.contains("hidden")) _hide();
        else _show(k);
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
})();
