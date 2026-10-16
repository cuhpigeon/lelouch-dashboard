import { ageSeconds, decryptBlob, isStale, noteStamp } from "./blob.js";

const ACCOUNTS = ["safe", "bold"];
const COL = { safe: "#58a6ff", bold: "#d29922" };
const BUCKETS = ["<20c", "20-30c", "30-50c", "50-70c", "70c+"];
const POLL_MS = 15000;

const $ = (id) => document.getElementById(id);
const charts = {};
let data = null;
let mode = "demo"; // demo | live | error
let openRow = null;
let repIdx = 0;
let routeGen = 0;
let pollTimer = 0;
let sourceUrl = "";
let keyB64 = "";
let lastError = "";
let lastStamp = "";
let lastNewMs = null;
let shown = [];

Chart.defaults.color = "#8b949e";
Chart.defaults.borderColor = "#30363d";
Chart.defaults.font.family = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

function usd(v) {
  if (v == null || v === "" || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
}
function pc(v) {
  return v == null || v === "" ? "—" : `${v}%`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}
function cst(ms) {
  return new Date(ms - 6 * 3600e3).toISOString().slice(11, 16) + " CST";
}
function emptyAccount(name) {
  return {
    name,
    start_usd: null,
    epoch_cst: null,
    equity: null,
    pnl: null,
    trades: 0,
    wins: 0,
    win_rate: null,
    peak: null,
    max_dd_pct: null,
    cur_dd_pct: null,
    curve: [],
    trade_list: [],
    blocks: {},
    no_trade_count: 0,
    by_bucket: {},
    by_side: {},
    by_exit: {},
    by_order: {},
    calibration: { n: 0, brier_model: null, brier_market: null, bins: [] },
  };
}
function account(name) {
  return data?.accounts?.[name] || emptyAccount(name);
}

function chart(id, cfg) {
  const canvas = $(id);
  if (!canvas || typeof Chart === "undefined") return;
  if (charts[id]) {
    charts[id].data = cfg.data;
    if (cfg.options) charts[id].options = cfg.options;
    charts[id].update("none");
    return;
  }
  charts[id] = new Chart(canvas, cfg);
}
function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}
function opt(extra = {}) {
  return Object.assign(
    {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { labels: { boxWidth: 12 } } },
    },
    extra
  );
}

function readHash() {
  const raw = location.hash.replace(/^#/, "");
  const out = new Map();
  if (!raw) return out;
  for (const part of raw.split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = decodeURIComponent(part.slice(0, i).replace(/\+/g, " "));
    const val = decodeURIComponent(part.slice(i + 1));
    out.set(key, val);
  }
  return out;
}

function freshnessLine() {
  if (mode === "demo") {
    const when = data?.generated_cst ? ` · snapshot taken ${data.generated_cst}` : "";
    return `Example data${when}`;
  }
  if (mode === "error" && !data) return lastError || "No data";
  const age = ageSeconds(lastNewMs);
  const ageBit = age == null ? "Waiting for data" : `Updated ${age}s ago`;
  const gen = data?.generated_cst ? ` · ${data.generated_cst}` : "";
  const err = lastError ? ` · poll failed: ${lastError}` : "";
  return `${ageBit}${gen} · polls every 15s${err}`;
}

function tick() {
  const gen = $("gen");
  if (gen) gen.textContent = freshnessLine();
  const banner = $("stale");
  if (!banner) return;
  const show = mode === "live" && isStale(lastNewMs);
  banner.hidden = !show;
  if (show) {
    const age = ageSeconds(lastNewMs);
    banner.textContent = `STALE — no new data for ${age}s`;
  }
}

function render() {
  const modeBanner = $("modeBanner");
  if (mode === "demo") {
    modeBanner.hidden = false;
    modeBanner.className = "card example";
    modeBanner.innerHTML = `<b>Example data.</b> <span class="mut">This is the embedded snapshot, not a live feed. Open the page with <code>#src=&lt;blob url&gt;&amp;k=&lt;base64 key&gt;</code> to decrypt a live blob. Nothing here can change trading.</span>`;
  } else if (!data && lastError) {
    modeBanner.hidden = false;
    modeBanner.className = "card error";
    modeBanner.innerHTML = `<b>No data.</b> <span class="mut">${esc(lastError)}</span>`;
  } else {
    modeBanner.hidden = true;
    modeBanner.innerHTML = "";
  }
  tick();
  if (!data) {
    $("stat").innerHTML = "";
    $("acct").innerHTML = `<div class="card empty">No account data.</div>`;
    $("liveK").innerHTML = `<div class="empty">No recorder data yet.</div>`;
    $("liveT").textContent = "";
    $("res").innerHTML = `<div class="empty">No results recorded.</div>`;
    $("trades").innerHTML = `<div class="empty">No trades.</div>`;
    $("tsum").textContent = "";
    $("blkEx").innerHTML = "";
    $("side").innerHTML = `<div class="empty">No trades yet.</div>`;
    $("brier").innerHTML = "";
    $("rtabs").innerHTML = "";
    $("rep").textContent = "No reports yet.";
    for (const id of ["cEq", "cSpot", "cBook", "cBlk", "cBkt", "cCal"]) destroyChart(id);
    return;
  }
  renderStatus();
  renderAccounts();
  renderEquity();
  renderLive();
  renderTrades();
  renderBreakdowns();
  renderReports();
}

function renderStatus() {
  const s = data.status || {};
  const ap = s.autopilot_heartbeat;
  const rec = s.recorder_heartbeat;
  const apTitle = ap ? `${ap.status || ""} · last ${ap.cst || ap.local || ""}` : "no heartbeat";
  const recTitle = rec ? `${rec.status || ""} · ${rec.cst || rec.local || ""}` : "";
  $("stat").innerHTML = `
    <span class="pill ${s.trading_enabled ? "on" : "off"}">Trading ${s.trading_enabled ? "ON" : "OFF"}</span>
    <span class="pill ${s.autopilot_running ? "on" : "off"}" title="${esc(apTitle)}">Autopilot ${s.autopilot_running ? "running" : "stopped"}</span>
    <span class="pill ${s.recorder_running ? "on" : "off"}" title="${esc(recTitle)}">Recorder ${s.recorder_running ? "live" : "down"}</span>`;
}

function renderAccounts() {
  $("acct").innerHTML = ACCOUNTS.map((k) => {
    const a = account(k);
    const since = a.epoch_cst ? `since ${esc(a.epoch_cst)}` : "since start";
    const pnlCls = a.pnl == null ? "" : a.pnl >= 0 ? "pos" : "neg";
    return `<div class="card acct acct-${k}"><h2 style="color:${COL[k]}">${k.toUpperCase()} <span class="mut sub">${since} · start ${usd(a.start_usd)}</span></h2>
      <div class="cards">
        <div class="kpi"><div class="l">Equity</div><div class="v">${usd(a.equity)}</div></div>
        <div class="kpi"><div class="l">P&amp;L</div><div class="v ${pnlCls}">${usd(a.pnl)}</div></div>
        <div class="kpi"><div class="l">Win rate</div><div class="v">${pc(a.win_rate)}</div><div class="mut">${a.wins}/${a.trades} trades</div></div>
        <div class="kpi"><div class="l">Max drawdown</div><div class="v neg">${pc(a.max_dd_pct)}</div><div class="mut">now ${pc(a.cur_dd_pct)} · peak ${usd(a.peak)}</div></div>
      </div></div>`;
  }).join("");
}

function renderEquity() {
  const datasets = ACCOUNTS.map((k) => ({
    label: k,
    borderColor: COL[k],
    backgroundColor: COL[k],
    stepped: true,
    pointRadius: 3,
    borderWidth: 2,
    data: (account(k).curve || [])
      .filter((p) => p && p.utc)
      .map((p) => ({ x: Date.parse(p.utc), y: p.equity, t: p.t })),
  }));
  chart("cEq", {
    type: "line",
    data: { datasets },
    options: opt({
      parsing: false,
      scales: {
        x: { type: "linear", ticks: { maxTicksLimit: 8, callback: (v) => cst(v) } },
        y: { ticks: { callback: (v) => "$" + v } },
      },
      plugins: {
        legend: { labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.raw?.t || "",
            label: (item) => `${item.dataset.label}: $${item.raw.y}`,
          },
        },
      },
    }),
  });
}

function renderLive() {
  const L = data.live || {};
  const l = L.latest;
  if (!l) {
    $("liveT").textContent = "";
    $("liveK").innerHTML = `<div class="empty">No recorder data yet.</div>`;
    destroyChart("cSpot");
    destroyChart("cBook");
  } else {
    $("liveT").textContent = `${l.ticker || L.ticker || ""} · closes ${L.close_cst || ""}`;
    const up = Number(l.spot_median) >= Number(l.strike);
    const plain = (v) => (v == null || v === "" ? "—" : esc(v));
    const cells = [
      ["BTC spot", plain(l.spot_median == null ? null : Number(l.spot_median).toFixed(2))],
      ["Strike", plain(l.strike)],
      ["vs strike", `<span class="${up ? "pos" : "neg"}">${esc(l.dist_bp)} bp ${up ? "▲" : "▼"}</span>`],
      ["Min left", plain(l.minutes_left == null ? null : Number(l.minutes_left).toFixed(1))],
      ["YES bid/ask", plain(`${l.yes_bid} / ${l.yes_ask}`)],
      ["NO bid/ask", plain(`${l.no_bid} / ${l.no_ask}`)],
      ["5m move", plain(`${l.move_5m_bp} bp`)],
      ["Recorded", plain((l.ts_local || "").slice(11))],
    ];
    $("liveK").innerHTML = cells
      .map(([label, value]) => `<div class="kpi"><div class="l">${label}</div><div class="v sm">${value}</div></div>`)
      .join("");
    const rows = L.rows || [];
    const lab = rows.map((r) => (r.t || "").slice(11, 19));
    chart("cSpot", {
      type: "line",
      data: {
        labels: lab,
        datasets: [
          { label: "BTC spot", data: rows.map((r) => r.spot), borderColor: "#e6edf3", pointRadius: 0, borderWidth: 1.5 },
          { label: "Strike", data: rows.map((r) => r.strike), borderColor: "#f85149", borderDash: [5, 4], pointRadius: 0 },
        ],
      },
      options: opt({ scales: { x: { ticks: { maxTicksLimit: 6 } } } }),
    });
    chart("cBook", {
      type: "line",
      data: {
        labels: lab,
        datasets: [
          { label: "YES bid", data: rows.map((r) => r.yes_bid), borderColor: "#3fb950", pointRadius: 0 },
          { label: "YES ask", data: rows.map((r) => r.yes_ask), borderColor: "#58a6ff", pointRadius: 0 },
        ],
      },
      options: opt({ scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { min: 0, max: 1 } } }),
    });
  }
  const results = L.recent_results || [];
  $("res").innerHTML = results.length
    ? `<table><thead><tr><th>Closed (CST)</th><th>Result</th><th>Strike</th><th>Settle</th></tr></thead><tbody>${results
        .map(
          (r) =>
            `<tr><td>${esc(r.close_cst)}</td><td class="${r.result === "yes" ? "pos" : "neg"}">${esc(r.result).toUpperCase()}</td><td>${esc(r.strike)}</td><td>${esc(r.expiration_value)}</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<div class="empty">No results recorded.</div>`;
}

function filters() {
  return {
    account: $("fA").value,
    side: $("fS").value,
    bucket: $("fB").value,
    exit: $("fE").value,
    result: $("fR").value,
  };
}

function renderTrades() {
  const lists = ACCOUNTS.flatMap((k) => account(k).trade_list || []);
  let rows = lists.sort((a, b) => (b.graded_utc || "").localeCompare(a.graded_utc || ""));
  const f = filters();
  rows = rows.filter((t) => Object.entries(f).every(([k, v]) => !v || t[k] === v));
  shown = rows;
  const pnl = rows.reduce((s, t) => s + (Number(t.pnl_usd) || 0), 0);
  const wins = rows.filter((t) => t.result === "win").length;
  const nWord = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  $("tsum").textContent = `${nWord(rows.length, "trade", "trades")} · ${nWord(wins, "win", "wins")} · P&L ${usd(pnl)}`;
  const scroller = $("trades");
  const top = scroller.scrollTop;
  if (!rows.length) {
    scroller.innerHTML = `<div class="empty">No trades match these filters.</div>`;
    return;
  }
  const body = rows
    .map((t, i) => {
      const id = `${t.account || ""}:${t.id || i}`;
      const open = openRow === id;
      return `<tr class="row" data-i="${i}" tabindex="0"><td>${esc(t.entry_cst)}</td><td style="color:${COL[t.account] || "inherit"}">${esc(t.account)}</td><td>${esc(t.ticker)}</td><td>${esc(t.side)}</td><td>${esc(t.price ?? "—")}</td><td>${esc(t.contracts ?? "—")}</td><td>${usd(t.cost_usd)}</td><td>${esc(t.order)}</td><td>${esc(t.exit)}</td><td class="${t.result === "win" ? "pos" : "neg"}">${esc(t.result)}</td><td class="${Number(t.pnl_usd) >= 0 ? "pos" : "neg"}">${usd(t.pnl_usd)}</td></tr>${
        open ? `<tr class="det"><td colspan="11">${detail(t)}</td></tr>` : ""
      }`;
    })
    .join("");
  scroller.innerHTML = `<table><thead><tr><th>Entry (CST)</th><th>Acct</th><th>Ticker</th><th>Side</th><th>Price</th><th>Qty</th><th>Cost</th><th>Order</th><th>Exit</th><th>Result</th><th>P&amp;L</th></tr></thead><tbody>${body}</tbody></table>`;
  scroller.scrollTop = top;
}

function detail(t) {
  const g = t.gates || {};
  const settled = t.outcome
    ? `${String(t.outcome).toUpperCase()} @ ${t.settle_value ?? "—"} · graded ${t.graded_cst || "—"}`
    : "—";
  const kv = [
    ["Model P(YES)", t.p_yes],
    ["Model P(our side)", t.model_p_side == null ? null : Number(t.model_p_side).toFixed(4)],
    ["Market mid", t.market_mid],
    ["Edge / EV per contract", t.edge ?? "not logged"],
    ["Strike", t.strike],
    ["Spot at entry", t.spot == null ? null : Number(t.spot).toFixed(2)],
    ["Minutes left at entry", t.minutes_left],
    ["Settled", settled],
    ["Fee", usd(t.fee_usd)],
    ["Sold early", t.sold_early ?? 0],
    ["Exit proceeds", usd(t.exit_proceeds_usd)],
    ["If held", usd(t.hold_pnl_usd)],
    ["Exit vs hold", usd(t.exit_vs_hold_usd)],
  ];
  const gates = Object.entries(g)
    .map(([k, v]) => {
      const verdict = v?.verdict || "";
      const extra = (v?.reasons || v?.flags || []).join("; ");
      return `<span class="pill ${verdict === "PASS" ? "on" : "off"}">${esc(k)}: ${esc(verdict)}</span> ${esc(extra)}`;
    })
    .join(" ");
  const notes = Array.isArray(t.notes) && t.notes.length ? `<div class="mut">Notes: ${esc(t.notes.join(" | "))}</div>` : "";
  const reasons = Array.isArray(t.reasons) && t.reasons.length ? `<div class="mut">Reasons: ${esc(t.reasons.join(" | "))}</div>` : "";
  const sizing = t.sizing ? `<div class="mut">Sizing: ${esc(t.sizing)}</div>` : "";
  return `<div class="cards kv">${kv
    .map(([a, b]) => `<div><div class="mut tiny">${esc(a)}</div>${esc(b ?? "—")}</div>`)
    .join("")}</div><div class="checks">Checks: ${gates || '<span class="mut">no gate detail logged for this trade</span>'}</div>${sizing}${notes}${reasons}<div class="mut tiny">id ${esc(t.id)}</div>`;
}

function toggleRow(index) {
  const t = shown[index];
  if (!t) return;
  const id = `${t.account || ""}:${t.id || index}`;
  openRow = openRow === id ? null : id;
  renderTrades();
}

function renderBreakdowns() {
  const cats = [...new Set(ACCOUNTS.flatMap((k) => Object.keys(account(k).blocks || {})))];
  const wrap = $("cBlk").parentElement;
  if (!cats.length) {
    destroyChart("cBlk");
    wrap.style.height = "80px";
    $("blkEx").innerHTML = `<div class="empty slim">No blocked trades recorded.</div>`;
  } else {
    wrap.style.height = Math.max(220, cats.length * 36 + 48) + "px";
    chart("cBlk", {
      type: "bar",
      data: {
        labels: cats,
        datasets: ACCOUNTS.map((k) => ({
          label: k,
          backgroundColor: COL[k],
          data: cats.map((c) => account(k).blocks?.[c]?.count || 0),
        })),
      },
      options: opt({ indexAxis: "y", scales: { y: { ticks: { autoSkip: false } } } }),
    });
    const examples = cats
      .map((c) => {
        const sample = ACCOUNTS.flatMap((k) => account(k).blocks?.[c]?.examples || []).slice(0, 2);
        return `<div><b>${esc(c)}</b>: ${esc(sample.join(" · "))}</div>`;
      })
      .join("");
    const skipped = ACCOUNTS.map((k) => `${k} ${account(k).no_trade_count ?? 0}`).join(", ");
    $("blkEx").innerHTML = `${examples}<div class="mut">Skipped windows: ${esc(skipped)}. A window can have more than one reason.</div>`;
  }

  chart("cBkt", {
    type: "bar",
    data: {
      labels: BUCKETS,
      datasets: ACCOUNTS.map((k) => ({
        label: `${k} P&L $`,
        backgroundColor: COL[k],
        data: BUCKETS.map((b) => account(k).by_bucket?.[b]?.pnl || 0),
      })),
    },
    options: opt({
      plugins: {
        legend: { labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            afterLabel: (item) => {
              const k = item.dataset.label.split(" ")[0];
              const v = account(k).by_bucket?.[BUCKETS[item.dataIndex]];
              return v ? `${v.wins}/${v.n} wins` : "no trades";
            },
          },
        },
      },
    }),
  });

  const sideRows = [];
  for (const k of ACCOUNTS) {
    for (const [grp, obj] of [
      ["Side", account(k).by_side || {}],
      ["Exit", account(k).by_exit || {}],
      ["Order", account(k).by_order || {}],
    ]) {
      for (const [name, v] of Object.entries(obj)) {
        sideRows.push(
          `<tr><td style="color:${COL[k]}">${k}</td><td>${esc(grp)}</td><td>${esc(name)}</td><td>${esc(v.wins)}/${esc(v.n)}</td><td class="${Number(v.pnl) >= 0 ? "pos" : "neg"}">${usd(v.pnl)}</td></tr>`
        );
      }
    }
  }
  $("side").innerHTML = sideRows.length
    ? `<table><thead><tr><th>Acct</th><th>Group</th><th>Value</th><th>Wins</th><th>P&amp;L</th></tr></thead><tbody>${sideRows.join("")}</tbody></table>`
    : `<div class="empty">No trades yet.</div>`;

  $("brier").innerHTML = ACCOUNTS.map((k) => {
    const c = account(k).calibration || {};
    return `<span style="color:${COL[k]}">${k}</span>: Brier score model <b>${c.brier_model ?? "—"}</b> vs market <b>${c.brier_market ?? "—"}</b> (n=${c.n ?? 0}, lower is better)`;
  }).join(' <span class="mut">·</span> ');

  const ds = [];
  for (const k of ACCOUNTS) {
    const bins = account(k).calibration?.bins || [];
    ds.push({
      label: `${k} model`,
      borderColor: COL[k],
      backgroundColor: COL[k],
      showLine: true,
      data: bins
        .map((x, i) => (x.model_hit == null ? null : { x: i * 10 + 5, y: x.model_hit * 100, n: x.model_n }))
        .filter(Boolean),
    });
    ds.push({
      label: `${k} market`,
      borderColor: COL[k],
      borderDash: [3, 3],
      backgroundColor: "transparent",
      pointStyle: "triangle",
      showLine: true,
      data: bins
        .map((x, i) => (x.market_hit == null ? null : { x: i * 10 + 5, y: x.market_hit * 100, n: x.market_n }))
        .filter(Boolean),
    });
  }
  ds.push({
    label: "perfect",
    borderColor: "#555",
    borderDash: [6, 6],
    pointRadius: 0,
    showLine: true,
    data: [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ],
  });
  chart("cCal", {
    type: "scatter",
    data: { datasets: ds },
    options: opt({
      scales: {
        x: { min: 0, max: 100, title: { display: true, text: "predicted %" } },
        y: { min: 0, max: 100, title: { display: true, text: "actual YES %" } },
      },
      plugins: {
        legend: { labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (item) => `${item.dataset.label}: ${Number(item.raw.y).toFixed(0)}% (n=${item.raw.n ?? ""})`,
          },
        },
      },
    }),
  });
}

function renderReports(keepScroll = true) {
  const reports = data.reports || [];
  const pre = $("rep");
  const top = pre.scrollTop;
  if (!reports.length) {
    $("rtabs").innerHTML = "";
    pre.textContent = "No reports yet.";
    return;
  }
  if (repIdx >= reports.length) repIdx = 0;
  $("rtabs").innerHTML = reports
    .map((r, i) => `<button type="button" class="${i === repIdx ? "a" : ""}" data-rep="${i}">${esc(r.name)}</button>`)
    .join("");
  const r = reports[repIdx];
  pre.textContent = `${r.text || ""}\n\n— ${r.mtime_cst || ""}`;
  pre.scrollTop = keepScroll ? top : 0;
}

async function loadDemo(gen) {
  try {
    const res = await fetch("data/demo.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (gen !== routeGen) return;
    data = payload;
    lastError = "";
    lastStamp = "";
    lastNewMs = null;
    render();
  } catch (err) {
    if (gen !== routeGen) return;
    mode = "error";
    data = null;
    lastError = `Example data failed to load (${err.message || err}).`;
    render();
  }
}

async function refresh(gen) {
  try {
    const res = await fetch(sourceUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.json();
    const payload = await decryptBlob(blob, keyB64);
    if (gen !== routeGen) return;
    const noted = noteStamp(lastStamp, blob, payload);
    if (noted.changed) {
      lastStamp = noted.stamp;
      lastNewMs = noted.at;
    } else if (lastNewMs == null) {
      const parsed = Date.parse(blob.pushed_utc || "");
      lastNewMs = Number.isFinite(parsed) ? parsed : Date.now();
      lastStamp = noted.stamp || blob.pushed_utc || "";
    }
    data = payload;
    lastError = "";
    render();
  } catch (err) {
    if (gen !== routeGen) return;
    lastError = err.message || String(err);
    if (!data || mode !== "live") {
      data = null;
      render();
    } else {
      tick();
    }
  }
}

async function applyRoute() {
  const gen = ++routeGen;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = 0;
  const hash = readHash();
  const src = (hash.get("src") || "").trim();
  const key = (hash.get("k") || "").trim();
  openRow = null;
  if (src && key) {
    mode = "live";
    sourceUrl = src;
    keyB64 = key;
    lastError = "";
    data = null;
    lastStamp = "";
    lastNewMs = null;
    $("modeBanner").hidden = true;
    $("stale").hidden = true;
    $("gen").textContent = "Loading encrypted feed…";
    await refresh(gen);
    if (gen !== routeGen) return;
    pollTimer = setInterval(() => refresh(gen), POLL_MS);
    return;
  }
  sourceUrl = "";
  keyB64 = "";
  if (src || key) {
    mode = "error";
    data = null;
    lastStamp = "";
    lastNewMs = null;
    lastError = src
      ? "The URL hash has src but no k. Add the base64 AES key as k=."
      : "The URL hash has k but no src. Add the blob URL as src=.";
    render();
    return;
  }
  mode = "demo";
  lastError = "";
  await loadDemo(gen);
}

function bind() {
  for (const id of ["fA", "fS", "fB", "fE", "fR"]) {
    $(id).addEventListener("change", () => {
      openRow = null;
      if (data) renderTrades();
    });
  }
  $("trades").addEventListener("click", (event) => {
    const row = event.target.closest("tr.row");
    if (!row || !$("trades").contains(row)) return;
    toggleRow(Number(row.dataset.i));
  });
  $("trades").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("tr.row");
    if (!row) return;
    event.preventDefault();
    toggleRow(Number(row.dataset.i));
  });
  $("rtabs").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-rep]");
    if (!btn) return;
    repIdx = Number(btn.dataset.rep);
    renderReports(false);
  });
  window.addEventListener("hashchange", () => {
    applyRoute();
  });
}

bind();
applyRoute();
setInterval(tick, 1000);
