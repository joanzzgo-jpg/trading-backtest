// AI 策略研究 modal — 暴力枚舉指標組合，從後端取得 Top N 結果
(function () {
  const $ = (id) => document.getElementById(id);

  function _show()  { $("aiResearchOverlay")?.classList.remove("hidden"); }
  function _hide()  { $("aiResearchOverlay")?.classList.add("hidden"); }

  function _getCheckedValues(container) {
    return Array.from(container.querySelectorAll("input[type=checkbox]:checked")).map(c => c.value);
  }

  function _useCurrentSymbol() {
    const sym = $("symbolInput")?.value?.trim();
    if (sym) $("aiSymbols").value = sym;
  }

  function _wrClass(wr) {
    if (wr >= 65) return "ai-wr-good";
    if (wr >= 50) return "ai-wr-mid";
    return "ai-wr-bad";
  }

  function _fmtPF(pf) {
    if (pf === null || pf === undefined) return "∞";
    if (pf >= 100) return "100+";
    return pf.toFixed(2);
  }

  function _fmtTest(test, ratio) {
    if (!test || test.total < 3) return `<span class="ai-test-empty">—</span>`;
    const wr = test.win_rate;
    const cls = _wrClass(wr);
    const r = ratio !== null && ratio !== undefined ? ` <span class="ai-test-ratio">×${ratio}</span>` : "";
    return `<span class="${cls}">${wr.toFixed(1)}%</span><span class="ai-test-n">/${test.total}</span>${r}`;
  }

  function _renderResults(out) {
    const root = $("aiResults");
    if (!root) return;
    const results = out.results || [];
    const labels = out.atom_labels || {};

    // 目標摘要列
    const summary = (out.per_target || []).map(t => {
      if (t.error) {
        return `<span class="ai-tgt-err">⚠ ${t.market}/${t.symbol}/${t.timeframe}: ${t.error}</span>`;
      }
      return `<span class="ai-tgt-ok">• ${t.market}/${t.symbol}/${t.timeframe}: ${t.bars} 根 from ${t.from_date}, 達門檻 ${t.matched}</span>`;
    }).join("");

    if (results.length === 0) {
      root.innerHTML = `
        <div class="ai-target-summary">${summary || "—"}</div>
        <div class="ai-empty">沒有任何組合達到最低筆數門檻。試著降低「最低筆數」或加大「回測天數」。</div>`;
      return;
    }

    const rows = results.map((r, i) => {
      const tags = r.combo.map(k => `<span class="ai-combo-tag">${labels[k] || k}</span>`).join("");
      const dirClass = r.direction === "short" ? "ai-dir-s" : "ai-dir-l";
      const wrClass  = _wrClass(r.win_rate);
      const ciClass  = _wrClass(r.ci_low);
      const robust   = r.robust ? `<span class="ai-robust" title="test/train ≥ 85%，跨期穩健">🔒</span>` : "";
      const testCell = _fmtTest(r.test, r.train_test_ratio);
      return `<tr class="${r.robust ? "ai-row-robust" : ""}">
        <td class="ai-rank">${i + 1}</td>
        <td>${r.symbol}</td>
        <td>${r.timeframe}</td>
        <td class="${dirClass}">${r.dir_label}</td>
        <td class="ai-num ${wrClass}" title="勝率（全期）">${r.win_rate.toFixed(1)}%</td>
        <td class="ai-num ${ciClass}" title="Wilson 95% 信賴下界，小樣本自動降權">${r.ci_low.toFixed(1)}%</td>
        <td class="ai-num">${r.total}</td>
        <td class="ai-num" title="平均報酬風險比">${r.avg_rr.toFixed(2)}</td>
        <td class="ai-num" title="獲利因子 = 總賺R/總賠R">${_fmtPF(r.profit_factor)}</td>
        <td class="ai-num ai-streak" title="最大連敗數">${r.max_loss_streak}</td>
        <td class="ai-num" title="out-of-sample 勝率/樣本數 / 比例">${testCell}</td>
        <td class="ai-num" title="綜合分數">${r.score.toFixed(2)}</td>
        <td>${robust}</td>
        <td><div class="ai-combo">${tags}</div></td>
      </tr>`;
    }).join("");

    root.innerHTML = `
      <div class="ai-target-summary">${summary}</div>
      <table class="ai-results-table">
        <thead><tr>
          <th>#</th><th>標的</th><th>TF</th><th>方向</th>
          <th class="ai-num" title="全期勝率">勝率</th>
          <th class="ai-num" title="Wilson 95% 信賴下界">CI低</th>
          <th class="ai-num">筆數</th>
          <th class="ai-num" title="平均報酬風險比">RR</th>
          <th class="ai-num" title="總賺R/總賠R">PF</th>
          <th class="ai-num" title="最大連敗數">連敗</th>
          <th class="ai-num" title="out-of-sample 測試集">測試</th>
          <th class="ai-num">分數</th>
          <th title="穩健標記">🔒</th>
          <th>指標組合</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  async function _run() {
    const symbolsRaw = $("aiSymbols").value.trim();
    const symbols = symbolsRaw.split(/[,\s]+/).filter(Boolean).slice(0, 6);
    if (symbols.length === 0) {
      $("aiStatus").textContent = "⚠ 請填標的";
      return;
    }
    const tfs = _getCheckedValues($("aiTfChips"));
    if (tfs.length === 0) {
      $("aiStatus").textContent = "⚠ 請選至少一個時間框架";
      return;
    }
    const sizes = _getCheckedValues(document.querySelector(".ai-size-chips")).map(Number);
    if (sizes.length === 0) {
      $("aiStatus").textContent = "⚠ 請選至少一個組合大小";
      return;
    }

    const market = $("marketSelect")?.value || "crypto";
    const exchange = $("exchangeSelect")?.value || "pionex";
    const targets = [];
    for (const s of symbols) for (const tf of tfs) {
      targets.push({ market, symbol: s, timeframe: tf, exchange });
    }
    if (targets.length > 12) {
      $("aiStatus").textContent = `⚠ 標的×TF=${targets.length}，最多 12 組`;
      return;
    }

    const body = {
      targets,
      days: parseInt($("aiDays").value, 10) || 0,
      min_trades: parseInt($("aiMinTrades").value, 10) || 10,
      stop_buffer_pct: (parseFloat($("aiStopBuf").value) || 0) / 100,
      sizes,
      top_n: parseInt($("aiTopN").value, 10) || 30,
      sort_by: $("aiSortBy").value || "score",
      max_hold: parseInt($("aiMaxHold").value, 10),
      train_split: parseFloat($("aiTrainSplit").value) || 0.7,
      robust_only: !!$("aiRobustOnly").checked,
      workers: parseInt($("aiWorkers").value, 10) || 4,
    };
    if (Number.isNaN(body.max_hold)) body.max_hold = -1;

    const btn = $("aiRunBtn");
    btn.disabled = true;
    btn.textContent = "🔄 研究中…";
    const t0 = Date.now();
    $("aiStatus").textContent = `跑 ${targets.length} 組 (symbol×TF) × ${sizes.reduce((a, s) => a + [15, 20, 15][s - 2] || 0, 0) * 2} 組合…`;

    try {
      const res = await fetch("/api/ai_research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }
      const out = await res.json();
      _renderResults(out);
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      $("aiStatus").textContent = `✓ 完成（${sec}s，掃描 ${out.total_combos_scanned || 0} 達門檻組合）`;
    } catch (e) {
      $("aiResults").innerHTML = `<div class="ai-empty" style="color:#ef5350">⚠ 失敗：${e.message}</div>`;
      $("aiStatus").textContent = "❌ 失敗";
    } finally {
      btn.disabled = false;
      btn.textContent = "🚀 開始研究";
    }
  }

  function _setTfs(values) {
    document.querySelectorAll("#aiTfChips input").forEach(c => {
      c.checked = values.includes(c.value);
    });
  }

  function _applyPreset(name) {
    const sym = $("symbolInput")?.value?.trim() || "BTC/USDT";
    if (name === "current") {
      $("aiSymbols").value = sym;
      _setTfs(["4h", "1h"]);
    } else if (name === "multi") {
      $("aiSymbols").value = "BTC/USDT,ETH/USDT,SOL/USDT";
      _setTfs(["4h", "1h"]);
    } else if (name === "deep") {
      $("aiSymbols").value = sym;
      _setTfs(["1d", "4h", "1h", "15m", "5m"]);
    }
    $("aiRobustOnly").checked = true;
    _run();
  }

  function _toggleAdv() {
    const sec = $("aiAdvSection");
    const btn = $("aiAdvToggle");
    if (!sec || !btn) return;
    const open = sec.classList.toggle("hidden");
    btn.textContent = open ? "▶ 進階參數" : "▼ 進階參數";
  }

  function init() {
    const openBtn = $("aiResearchBtn");
    if (!openBtn) return;
    openBtn.addEventListener("click", () => {
      if (!$("aiSymbols").value) _useCurrentSymbol();
      _show();
    });
    $("aiResearchClose")?.addEventListener("click", _hide);
    $("aiResearchOverlay")?.addEventListener("click", (e) => {
      if (e.target.id === "aiResearchOverlay") _hide();
    });
    $("aiSymbolUseCurrent")?.addEventListener("click", _useCurrentSymbol);
    $("aiRunBtn")?.addEventListener("click", _run);
    $("aiAdvToggle")?.addEventListener("click", _toggleAdv);
    document.querySelectorAll(".ai-preset").forEach(btn => {
      btn.addEventListener("click", () => _applyPreset(btn.dataset.preset));
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("aiResearchOverlay")?.classList.contains("hidden")) _hide();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
