const API_BASE = "https://api.rugcheck.xyz/v1/tokens";
const STATS_BASE = "https://api.rugcheck.xyz/v1";
const DEX_TOKEN_BASE = "https://api.dexscreener.com/latest/dex/tokens";
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RECENTS_KEY = "rugchecker_recents_v1";
const MAX_RECENTS = 8;

const WATCHLIST_REFRESH_MS = 120000;
const WATCHLIST_SIZE = 5;
const WATCHLIST_SHORTLIST = 10;
const WATCHLIST_POOL_CAP = 48;

const REC_MIN_MCAP = 100000;
const REC_MAX_MCAP = 300000;
const REC_MIN_PAIR_AGE_MS = 60 * 60 * 1000;

const form = document.getElementById("search-form");
const input = document.getElementById("mint-input");
const scanBtn = document.getElementById("scan-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const examplesEl = document.getElementById("examples");
const recentWrap = document.getElementById("recent-wrap");
const recentList = document.getElementById("recent-list");
const clearRecentBtn = document.getElementById("clear-recent");
const toastEl = document.getElementById("toast");
const watchlistGrid = document.getElementById("watchlist-grid");
const watchlistStatus = document.getElementById("watchlist-status");
const watchlistUpdated = document.getElementById("watchlist-updated");
const watchlistRefreshBtn = document.getElementById("watchlist-refresh");

let controller = null;
let toastTimer = null;
let watchlistController = null;
let watchlistCountdownTimer = null;
let watchlistNextAt = 0;
let watchlistLastUpdated = null;
let watchlistBusy = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function shortAddress(address, size = 4) {
  if (!address) return "";
  return `${address.slice(0, size)}...${address.slice(-size)}`;
}

function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return "N/A";
  if (value === 0) return "$0";
  if (value >= 1000) {
    return "$" + new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }
  return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return "N/A";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatPrice(value) {
  if (value == null || Number.isNaN(value)) return "N/A";
  if (value === 0) return "$0";
  if (value < 0.0001) return "$" + value.toExponential(2);
  if (value < 1) return "$" + value.toFixed(6);
  return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatAge(ms) {
  if (ms == null || Number.isNaN(ms)) return "N/A";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function scoreTier(score) {
  if (score <= 20) return { label: "Good", cls: "good", color: "var(--good)", desc: "Few or no high-risk signals detected." };
  if (score <= 40) return { label: "Caution", cls: "caution", color: "var(--caution)", desc: "Some risk signals present. Proceed carefully." };
  if (score <= 60) return { label: "Elevated", cls: "elevated", color: "var(--elevated)", desc: "Multiple risk signals detected." };
  if (score <= 80) return { label: "High risk", cls: "high", color: "var(--high)", desc: "Dangerous signals — likely high rug risk." };
  return { label: "Danger", cls: "danger", color: "var(--danger)", desc: "Extreme risk. Strong rug-pull indicators." };
}

function tierColor(score) {
  if (score <= 20) return "var(--good)";
  if (score <= 40) return "var(--caution)";
  if (score <= 60) return "var(--elevated)";
  if (score <= 80) return "var(--high)";
  return "var(--danger)";
}

function showStatus(html, type) {
  statusEl.hidden = false;
  statusEl.className = "status" + (type ? " " + type : "");
  statusEl.innerHTML = type === "loading" ? `<span class="spinner"></span><span>${escapeHtml(html)}</span>` : `<span>${escapeHtml(html)}</span>`;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 1800);
}

function shortenInput() {
  const value = input.value.trim();
  if (!value) {
    showStatus("Enter a token mint address to scan.", "error");
    return;
  }
  scan(value);
}

async function scan(mint) {
  mint = mint.trim();
  input.value = mint;

  if (!MINT_RE.test(mint)) {
    showStatus("That does not look like a valid Solana mint address. Check it and try again.", "error");
    return;
  }

  if (controller) controller.abort();
  controller = new AbortController();
  const signal = controller.signal;

  resultsEl.hidden = true;
  showStatus("Scanning token and gathering on-chain risk signals...", "loading");
  scanBtn.disabled = true;

  try {
    const [reportRes, summaryRes] = await Promise.all([
      fetch(`${API_BASE}/${mint}/report`, { signal, headers: { accept: "application/json" } }),
      fetch(`${API_BASE}/${mint}/report/summary`, { signal, headers: { accept: "application/json" } }).catch(() => null),
    ]);

    if (!reportRes.ok) {
      if (reportRes.status === 404) throw new Error("Token not found or no report is available for this mint.");
      if (reportRes.status === 429) throw new Error("Rate limited by RugCheck. Wait a few seconds and try again.");
      throw new Error(`Request failed with status ${reportRes.status}.`);
    }

    const report = await reportRes.json();
    let summary = null;
    if (summaryRes && summaryRes.ok) {
      summary = await summaryRes.json().catch(() => null);
    }

    const payload = { report, lpLockedPct: summary ? summary.lpLockedPct : null };
    render(payload);
    addRecent(report);
    statusEl.hidden = true;
    resultsEl.hidden = false;
    resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    if (err.name === "AbortError") return;
    showStatus(err.message || "Something went wrong while scanning this token.", "error");
  } finally {
    scanBtn.disabled = false;
  }
}

function verdictLabel(level) {
  if (level === "danger") return "Danger";
  if (level === "high") return "High risk";
  if (level === "caution") return "Caution";
  return "Looks healthy";
}

function buildVerdict(report, lpLockedPct) {
  const token = report.token || {};
  const meta = report.tokenMeta || {};
  const risks = Array.isArray(report.risks) ? report.risks : [];
  const flags = [];
  const order = { good: 0, caution: 1, high: 2, danger: 3 };
  let level = "good";
  const bump = (lvl) => {
    if (order[lvl] > order[level]) level = lvl;
  };

  if (report.rugged) {
    bump("danger");
    flags.push({ lvl: "danger", text: "This token is flagged as rugged — liquidity was pulled or the project was abandoned after launch." });
  }
  if (token.mintAuthority) {
    bump("danger");
    flags.push({ lvl: "danger", text: "Mint authority is still active. The creator can mint unlimited new tokens and dump them on holders." });
  }
  if (token.freezeAuthority) {
    bump("danger");
    flags.push({ lvl: "danger", text: "Freeze authority is active. The creator can freeze your tokens so you are unable to sell." });
  }

  const liquidity = typeof report.totalMarketLiquidity === "number" ? report.totalMarketLiquidity : 0;
  if (liquidity < 2000) {
    bump("danger");
    flags.push({ lvl: "danger", text: `Liquidity is only ${formatUsd(liquidity)}. A tiny sell can crash the price and the pool is easy to pull.` });
  } else if (liquidity < 25000) {
    bump("high");
    flags.push({ lvl: "high", text: `Thin liquidity (${formatUsd(liquidity)}) means high slippage and easier price manipulation.` });
  } else if (liquidity < 100000) {
    bump("caution");
    flags.push({ lvl: "caution", text: `Moderate liquidity (${formatUsd(liquidity)}).` });
  }

  const top = Array.isArray(report.topHolders) ? report.topHolders.slice(0, 10) : [];
  const sumPct = (arr) => arr.reduce((sum, h) => sum + (typeof h.pct === "number" ? h.pct : 0), 0);
  const top1 = top[0] && typeof top[0].pct === "number" ? top[0].pct : 0;
  const top10 = sumPct(top);
  if (top10 > 80) {
    bump("high");
    flags.push({ lvl: "high", text: `The top 10 wallets hold ${top10.toFixed(1)}% of supply — a handful of holders can tank the price.` });
  } else if (top10 > 50) {
    bump("caution");
    flags.push({ lvl: "caution", text: `The top 10 wallets hold ${top10.toFixed(1)}% of supply (elevated concentration).` });
  }
  if (top1 > 15) {
    bump("caution");
    flags.push({ lvl: "caution", text: `The single largest holder owns ${top1.toFixed(1)}% of supply.` });
  }

  if (typeof lpLockedPct === "number" && lpLockedPct < 50) {
    bump("high");
    flags.push({ lvl: "high", text: `Only ${lpLockedPct.toFixed(1)}% of liquidity is locked — the rest can be removed at any time.` });
  }

  if (meta && meta.mutable === true) {
    bump("caution");
    flags.push({ lvl: "caution", text: "Token metadata is mutable — name, symbol or logo can still be changed." });
  }

  risks
    .filter((r) => r.level === "danger")
    .forEach((r) => {
      bump("high");
      flags.push({ lvl: "high", text: `On-chain flag: ${r.name}${r.value ? ` (${r.value})` : ""}.` });
    });
  risks
    .filter((r) => r.level === "warn")
    .slice(0, 4)
    .forEach((r) => {
      bump("caution");
      flags.push({ lvl: "caution", text: `${r.name}${r.value ? ` (${r.value})` : ""}.` });
    });

  if (!flags.length) {
    return {
      level: "good",
      html: `<div class="verdict ${level}">
        <div class="verdict-icon good" aria-hidden="true">✓</div>
        <div>
          <div class="verdict-title">No major risks detected</div>
          <p class="verdict-text">Authorities are revoked, liquidity and holder concentration look healthy across the scanned signals. Still do your own research.</p>
        </div>
      </div>`,
    };
  }

  return {
    level,
    html: `<div class="verdict ${level}">
      <div class="verdict-head">
        <span class="verdict-badge ${level}">${verdictLabel(level)}</span>
        <span class="verdict-count">${flags.length} risk signal${flags.length > 1 ? "s" : ""} found</span>
      </div>
      <ul class="verdict-list">
        ${flags.map((f) => `<li class="${f.lvl}"><span class="verdict-dot ${f.lvl}" aria-hidden="true"></span>${escapeHtml(f.text)}</li>`).join("")}
      </ul>
    </div>`,
  };
}

function render({ report, lpLockedPct }) {
  const meta = report.tokenMeta || {};
  const file = report.fileMeta || {};
  const name = meta.name || file.name || "Unknown token";
  const symbol = meta.symbol || file.symbol || "";
  const score = typeof report.score_normalised === "number" ? report.score_normalised : 0;
  const tier = scoreTier(score);
  const mint = report.mint || "";
  const initial = (symbol || name || "?").slice(0, 2).toUpperCase();
  const logoMarkup = file.image
    ? `<img class="token-logo" alt="${escapeHtml(name)} logo" src="${escapeHtml(file.image)}" />`
    : `<span class="token-logo fallback">${escapeHtml(initial)}</span>`;
  const verdict = buildVerdict(report, lpLockedPct);

  resultsEl.innerHTML = `
    <div class="card overview">
      <div class="token-id">
        <div class="token-head">
          ${logoMarkup}
          <div class="token-id-inner">
            <h2 class="token-name">
              ${escapeHtml(name)}
              ${symbol ? `<span class="token-symbol">$${escapeHtml(symbol)}</span>` : ""}
              ${report.rugged ? `<span class="badge rugged">Rugged</span>` : ""}
            </h2>
            <div class="mint-row">
              <span class="mint-addr">${escapeHtml(mint)}</span>
              <button class="icon-btn" id="copy-mint" type="button">Copy</button>
            </div>
          </div>
        </div>
        <div class="token-links">
          <button class="buy-btn" type="button" data-trade="${escapeHtml(mint)}" data-symbol="${escapeHtml(symbol)}">Buy with Phantom</button>
          <a href="https://rugcheck.xyz/tokens/${escapeHtml(mint)}" target="_blank" rel="noopener noreferrer">RugCheck</a>
          <a href="https://solscan.io/token/${escapeHtml(mint)}" target="_blank" rel="noopener noreferrer">Solscan</a>
          <a href="https://dexscreener.com/solana/${escapeHtml(mint)}" target="_blank" rel="noopener noreferrer">DexScreener</a>
          <a href="https://jup.ag/swap/SOL-${escapeHtml(mint)}" target="_blank" rel="noopener noreferrer">Jupiter</a>
        </div>
      </div>
      <div class="score-panel">
        <div class="gauge" style="--pct:${Math.max(0, Math.min(score, 100))};--color:${tier.color}">
          <div class="gauge-inner">
            <span class="gauge-score">${score}</span>
            <span class="gauge-label">Risk score</span>
          </div>
        </div>
        <div class="score-tier" style="color:${tier.color}">${tier.label}</div>
        <p class="score-desc">${tier.desc}</p>
      </div>
    </div>

    <div class="card verdict-card">
      <h3>Risk assessment</h3>
      ${verdict.html}
    </div>

    <div class="card">
      <h3>Key signals</h3>
      <div class="stats">${renderStats(report, lpLockedPct)}</div>
    </div>

    <div class="card">
      <h3>Risk signals</h3>
      ${renderRisks(report.risks)}
    </div>

    <div class="card">
      ${renderHolders(report.topHolders, report)}
    </div>
  `;

  const logo = resultsEl.querySelector(".token-logo");
  if (logo && logo.tagName === "IMG") {
    logo.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "token-logo fallback";
      fallback.textContent = initial;
      logo.replaceWith(fallback);
    });
  }

  const copyBtn = document.getElementById("copy-mint");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => copyText(mint));
  }
}

function renderStats(report, lpLockedPct) {
  const token = report.token || {};
  const mintAuth = token.mintAuthority;
  const freezeAuth = token.freezeAuthority;
  const mutable = report.tokenMeta ? report.tokenMeta.mutable : null;

  const liquidity = stat("Liquidity", formatUsd(report.totalMarketLiquidity), report.totalMarketLiquidity > 5000 ? "ok" : "bad");
  const holders = stat("Holders", formatNumber(report.totalHolders), "muted");
  const providers = stat("LP providers", formatNumber(report.totalLPProviders), report.totalLPProviders > 1 ? "ok" : "bad");
  const price = stat("Price", formatPrice(report.price), "");

  let lockValue = "N/A";
  let lockCls = "muted";
  if (typeof lpLockedPct === "number") {
    lockValue = lpLockedPct.toFixed(1) + "%";
    lockCls = lpLockedPct >= 90 ? "ok" : lpLockedPct >= 50 ? "bad" : "bad";
  }
  const locked = stat("LP locked", lockValue, lockCls);

  const mintValue = mintAuth ? "Enabled" : "Revoked";
  const mintStat = stat("Mint authority", mintValue, mintAuth ? "bad" : "ok");

  const freezeValue = freezeAuth ? "Enabled" : "Revoked";
  const freezeStat = stat("Freeze authority", freezeValue, freezeAuth ? "bad" : "ok");

  const metaValue = mutable == null ? "Unknown" : mutable ? "Mutable" : "Immutable";
  const metaStat = stat("Metadata", metaValue, mutable == null ? "muted" : mutable ? "bad" : "ok");

  return liquidity + price + locked + holders + providers + mintStat + freezeStat + metaStat;
}

function stat(label, value, cls) {
  return `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value ${cls}">${escapeHtml(value)}</div></div>`;
}

function renderRisks(risks) {
  if (!Array.isArray(risks) || risks.length === 0) {
    return `<div class="no-risk"><span class="dot"></span>No risk signals found for this token.</div>`;
  }
  const order = { danger: 0, warn: 1, good: 2 };
  const sorted = [...risks].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
  return `<div class="risk-list">${sorted
    .map((risk) => {
      const level = risk.level === "danger" ? "danger" : risk.level === "good" ? "good" : "warn";
      return `
        <div class="risk ${level}">
          <div class="risk-body">
            <div class="risk-name">
              ${escapeHtml(risk.name)}
              ${risk.value ? `<span class="risk-value">${escapeHtml(risk.value)}</span>` : ""}
            </div>
            <div class="risk-desc">${escapeHtml(risk.description || "")}</div>
          </div>
          <span class="risk-level ${level}">${escapeHtml(level)}</span>
        </div>`;
    })
    .join("")}</div>`;
}

function avatarStyle(address) {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = (hash * 31 + address.charCodeAt(i)) % 360;
  }
  const hue = hash;
  const hue2 = (hue + 52) % 360;
  return `background:linear-gradient(140deg,hsl(${hue} 68% 62%),hsl(${hue2} 72% 46%))`;
}

function renderHolders(holders, report) {
  if (!Array.isArray(holders) || holders.length === 0) {
    return `<h3>Top holders</h3><p class="score-desc">No holder data available for this token.</p>`;
  }
  const top = holders.slice(0, 10);
  const top10 = top.reduce((sum, h) => sum + (typeof h.pct === "number" ? h.pct : 0), 0);
  const totalHolders = report && typeof report.totalHolders === "number" ? report.totalHolders : null;
  const sub = totalHolders != null ? `${formatNumber(totalHolders)} total holders` : `Top ${top.length} accounts by balance`;

  const head = `
    <div class="holders-head">
      <div>
        <h3>Top ${top.length} holders</h3>
        <p class="holders-sub">${escapeHtml(sub)}</p>
      </div>
      <span class="concentration">Top 10 hold <b>${top10.toFixed(1)}%</b></span>
    </div>`;

  const rows = top
    .map((holder, index) => {
      const rank = index + 1;
      const pct = typeof holder.pct === "number" ? holder.pct : 0;
      const width = Math.min(pct, 100);
      const risky = pct >= 20 && !holder.insider;
      const owner = holder.owner || holder.address || "";
      const medal = rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : "";
      const rankMarkup = medal ? `<span class="holder-medal ${medal}">${rank}</span>` : `#${rank}`;
      return `
        <div class="holder">
          <span class="holder-rank">${rankMarkup}</span>
          <span class="holder-avatar" style="${avatarStyle(owner || String(rank))}" aria-hidden="true"></span>
          <div class="holder-main">
            <div class="holder-top">
              <span class="holder-owner">${escapeHtml(shortAddress(owner, 6))}${holder.insider ? `<span class="holder-tag">insider</span>` : ""}</span>
            </div>
            <div class="bar"><span class="${risky ? "risky" : ""}" style="width:${width}%"></span></div>
          </div>
          <span class="holder-pct">${pct.toFixed(2)}%</span>
          <button class="holder-copy" type="button" data-copy="${escapeHtml(owner)}" aria-label="Copy holder address">Copy</button>
        </div>`;
    })
    .join("");

  return `${head}<div class="holders">${rows}</div>`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Mint address copied");
  } catch {
    showToast("Copy failed — select the address manually");
  }
}

function getRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addRecent(report) {
  const meta = report.tokenMeta || {};
  const score = typeof report.score_normalised === "number" ? report.score_normalised : 0;
  const entry = {
    mint: report.mint,
    name: meta.name || meta.symbol || shortAddress(report.mint, 5),
    score,
  };
  const recents = getRecents().filter((item) => item.mint !== entry.mint);
  recents.unshift(entry);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS)));
  } catch {
    return;
  }
  renderRecents();
}

function renderRecents() {
  const recents = getRecents();
  if (recents.length === 0) {
    recentWrap.hidden = true;
    return;
  }
  recentWrap.hidden = false;
  recentList.innerHTML = recents
    .map(
      (item) => `
        <button class="recent-item" type="button" data-mint="${escapeHtml(item.mint)}">
          <span class="tier-dot" style="background:${tierColor(item.score)}"></span>
          ${escapeHtml(item.name)} · ${escapeHtml(shortAddress(item.mint, 4))}
        </button>`
    )
    .join("");
}

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        out[index] = await worker(items[index], index);
      } catch {
        out[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

async function fetchDexData(mint, signal) {
  try {
    const res = await fetch(`${DEX_TOKEN_BASE}/${mint}`, { signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = Array.isArray(data.pairs) ? data.pairs.filter((p) => p && p.chainId === "solana") : [];
    if (!pairs.length) return null;
    pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    const pair = pairs[0];
    const mcap = typeof pair.marketCap === "number" ? pair.marketCap : typeof pair.fdv === "number" ? pair.fdv : null;
    return {
      mcap,
      fdv: typeof pair.fdv === "number" ? pair.fdv : null,
      liquidityUsd: pair.liquidity ? pair.liquidity.usd : null,
      pairCreatedAt: typeof pair.pairCreatedAt === "number" ? pair.pairCreatedAt : null,
      priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
      dexId: pair.dexId || "",
      url: pair.url || "",
    };
  } catch {
    return null;
  }
}

async function fetchBoostMints(signal) {
  const urls = [
    "https://api.dexscreener.com/token-boosts/top/v1",
    "https://api.dexscreener.com/token-boosts/latest/v1",
    "https://api.dexscreener.com/token-profiles/latest/v1",
  ];
  const lists = await Promise.all(urls.map((url) => fetchJson(url, signal).catch(() => [])));
  const mints = new Set();
  lists.forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((item) => {
      if (item && item.chainId === "solana" && item.tokenAddress) mints.add(item.tokenAddress);
    });
  });
  return [...mints];
}

async function fetchCandidates(signal) {
  const [recent, search, boosts] = await Promise.all([
    fetchJson(`${STATS_BASE}/stats/recent`, signal).catch(() => []),
    fetchJson(`${STATS_BASE}/search`, signal).catch(() => []),
    fetchBoostMints(signal),
  ]);

  const pool = new Map();
  const merge = (mint, data) => {
    if (!mint) return;
    const existing = pool.get(mint) || { mint };
    pool.set(mint, {
      ...existing,
      ...data,
      meta: { ...(existing.meta || {}), ...(data.meta || {}) },
    });
  };

  (Array.isArray(search) ? search : []).forEach((t) => {
    if (!t || !t.mint) return;
    merge(t.mint, {
      holders: typeof t.holders === "number" ? t.holders : undefined,
      mcap: t.mcap,
      verified: !!t.verified,
      meta: { name: t.name, symbol: t.symbol },
    });
  });

  (Array.isArray(recent) ? recent : []).forEach((t) => {
    if (!t || !t.mint) return;
    merge(t.mint, {
      visits: t.visits || 0,
      feedScore: t.score,
      source: "recent",
      meta: {
        name: t.metadata && t.metadata.name,
        symbol: t.metadata && t.metadata.symbol,
      },
    });
  });

  boosts.forEach((mint) => merge(mint, { source: "boost" }));

  return [...pool.values()].slice(0, WATCHLIST_POOL_CAP);
}

function safetyTier(safety) {
  if (safety >= 80) return { label: "Very low risk", color: "var(--good)" };
  if (safety >= 65) return { label: "Low risk", color: "var(--good)" };
  if (safety >= 50) return { label: "Moderate risk", color: "var(--caution)" };
  if (safety >= 35) return { label: "Elevated risk", color: "var(--elevated)" };
  return { label: "High risk", color: "var(--high)" };
}

function screenCandidate(candidate, summary) {
  const risks = Array.isArray(summary.risks) ? summary.risks : [];
  const norm = typeof summary.score_normalised === "number" ? summary.score_normalised : 100;

  if (norm > 55) return null;
  if (risks.some((r) => r.level === "danger")) return null;

  let safety = 100 - Math.min(norm, 60) * 0.8;
  risks.forEach((r) => {
    if (r.level === "warn") safety -= 7;
    else if (r.level === "good") safety += 4;
  });

  const lp = typeof summary.lpLockedPct === "number" ? summary.lpLockedPct : null;
  if (lp != null) {
    if (lp >= 90) safety += 8;
    else if (lp >= 50) safety -= 2;
    else if (lp >= 10) safety -= 10;
    else safety -= 18;
  }

  const holders = typeof candidate.holders === "number" ? candidate.holders : null;
  if (holders != null) {
    if (holders >= 100000) safety += 4;
    else if (holders >= 10000) safety += 2;
    else if (holders >= 1000) safety -= 2;
    else if (holders >= 100) safety -= 6;
    else safety -= 12;
  }

  return {
    ...candidate,
    summary,
    lpLockedPct: lp,
    safety: Math.max(0, Math.min(100, Math.round(safety))),
  };
}

function refineCandidate(candidate, report) {
  if (!report || report.rugged) return null;
  const token = report.token || {};
  if (token.mintAuthority || token.freezeAuthority) return null;
  if ((report.risks || []).some((r) => r.level === "danger")) return null;

  const top = Array.isArray(report.topHolders) ? report.topHolders.slice(0, 10) : [];
  const sumPct = (arr) => arr.reduce((total, h) => total + (typeof h.pct === "number" ? h.pct : 0), 0);
  const top1 = top[0] && typeof top[0].pct === "number" ? top[0].pct : 0;
  const top5 = sumPct(top.slice(0, 5));
  const top10 = sumPct(top);
  const liquidity = typeof report.totalMarketLiquidity === "number" ? report.totalMarketLiquidity : 0;

  if (liquidity < 2000) return null;
  if (top10 > 85) return null;

  let safety = candidate.safety;
  if (top10 > 70) safety -= 15;
  else if (top10 > 50) safety -= 8;
  else if (top10 > 30) safety -= 3;

  if (liquidity >= 100000) safety += 6;
  else if (liquidity >= 20000) safety += 3;
  else if (liquidity < 8000) safety -= 6;

  return {
    ...candidate,
    report,
    top,
    top1,
    top5,
    top10,
    liquidity,
    safety: Math.max(0, Math.min(100, Math.round(safety))),
  };
}

async function loadWatchlist(signal) {
  const candidates = await fetchCandidates(signal);
  if (!candidates.length) throw new Error("No candidate feed available right now.");

  const now = Date.now();
  const enriched = (
    await mapLimit(candidates, 8, async (candidate) => {
      const dex = await fetchDexData(candidate.mint, signal);
      if (!dex || dex.mcap == null) return null;
      if (dex.mcap < REC_MIN_MCAP || dex.mcap > REC_MAX_MCAP) return null;
      if (dex.pairCreatedAt == null) return null;
      const age = now - dex.pairCreatedAt;
      if (age < REC_MIN_PAIR_AGE_MS) return null;
      return { ...candidate, dex, mcap: dex.mcap, age, pairCreatedAt: dex.pairCreatedAt };
    })
  ).filter(Boolean);

  if (!enriched.length) {
    throw new Error(`No tokens between ${formatUsd(REC_MIN_MCAP)} and ${formatUsd(REC_MAX_MCAP)} with a pair older than 1h in this cycle.`);
  }

  const screened = (
    await mapLimit(enriched, 5, async (candidate) => {
      const summary = await fetchJson(`${API_BASE}/${candidate.mint}/report/summary`, signal);
      return screenCandidate(candidate, summary);
    })
  ).filter(Boolean);

  if (!screened.length) throw new Error("No low-risk candidates in this cycle.");

  screened.sort((a, b) => b.safety - a.safety);

  const detailed = (
    await mapLimit(screened.slice(0, WATCHLIST_SHORTLIST), 4, async (candidate) => {
      const report = await fetchJson(`${API_BASE}/${candidate.mint}/report`, signal);
      return refineCandidate(candidate, report);
    })
  ).filter(Boolean);

  if (!detailed.length) throw new Error("No low-risk candidates in this cycle.");

  detailed.sort((a, b) => b.safety - a.safety);
  return detailed.slice(0, WATCHLIST_SIZE);
}

function buildExplanation(pick) {
  const r = pick.report;
  const meta = r.tokenMeta || {};
  const file = r.fileMeta || {};
  const name = meta.name || file.name || "This token";
  const symbol = meta.symbol || file.symbol || "";
  const holders = typeof r.totalHolders === "number" ? formatNumber(r.totalHolders) : "an unknown number of";
  const providers = typeof r.totalLPProviders === "number" ? r.totalLPProviders : "an unknown number of";
  const score = typeof r.score_normalised === "number" ? r.score_normalised : pick.safety;
  const tier = scoreTier(score);
  const mutable = r.tokenMeta ? r.tokenMeta.mutable : null;
  const lp = typeof pick.lpLockedPct === "number" ? `${pick.lpLockedPct.toFixed(1)}%` : null;

  const clauses = [];
  clauses.push(
    `${name}${symbol ? ` ($${symbol})` : ""} clears the core safety checks — mint and freeze authorities are revoked and there are no danger-level risk flags.`
  );
  clauses.push(
    `Supply is spread across ${holders} holders, with the top 10 wallets controlling ${pick.top10.toFixed(1)}%.`
  );
  clauses.push(
    `Liquidity sits at ${formatUsd(pick.liquidity)} across ${providers} LP provider(s)${lp ? `, with ${lp} of LP locked` : ""}.`
  );
  clauses.push(`RugCheck rates its risk ${score}/100 (${tier.label}).`);

  const watch = [];
  if (mutable === true) watch.push("metadata is still mutable");
  if (pick.top1 >= 15) watch.push(`the largest holder owns ${pick.top1.toFixed(1)}%`);
  if (pick.top10 >= 40) watch.push("top-10 concentration is elevated");
  if (watch.length) clauses.push(`Watch out: ${watch.join(", ")}.`);

  return clauses.join(" ");
}

function renderPick(pick, index) {
  const r = pick.report;
  const meta = r.tokenMeta || {};
  const file = r.fileMeta || {};
  const name = meta.name || file.name || "Unknown token";
  const symbol = meta.symbol || file.symbol || "";
  const initial = (symbol || name || "?").slice(0, 2).toUpperCase();
  const tier = safetyTier(pick.safety);

  const logo = file.image
    ? `<img class="pick-logo" data-initial="${escapeHtml(initial)}" alt="" src="${escapeHtml(file.image)}" />`
    : `<span class="pick-logo fallback">${escapeHtml(initial)}</span>`;

  const s1 = pick.top1;
  const s2 = Math.max(0, pick.top5 - pick.top1);
  const s3 = Math.max(0, pick.top10 - pick.top5);
  const s4 = Math.max(0, 100 - pick.top10);
  const xQuery = encodeURIComponent(symbol ? `$${symbol}` : name);

  return `
    <article class="pick">
      <div class="pick-head">
        ${logo}
        <div class="pick-id">
          <h3 class="pick-name">${escapeHtml(name)}${symbol ? `<span class="pick-symbol">$${escapeHtml(symbol)}</span>` : ""}</h3>
          <div class="pick-mint">${escapeHtml(shortAddress(pick.mint, 5))}${pick.age != null ? ` · ${escapeHtml(formatAge(pick.age))} old` : ""}</div>
        </div>
        <span class="pick-rank">#${index + 1}</span>
        <div class="pick-score">
          <span class="pick-score-num" style="color:${tier.color}">${pick.safety}</span>
          <span class="pick-score-label">safety</span>
        </div>
      </div>
      <p class="pick-explain">${escapeHtml(buildExplanation(pick))}</p>
      <div class="dist">
        <div class="dist-bar" title="Holder distribution">
          <span class="seg-1" style="width:${s1}%"></span>
          <span class="seg-2" style="width:${s2}%"></span>
          <span class="seg-3" style="width:${s3}%"></span>
          <span class="seg-4" style="width:${s4}%"></span>
        </div>
        <div class="dist-legend">
          <span><i class="seg-1"></i>Top 1 · ${s1.toFixed(1)}%</span>
          <span><i class="seg-2"></i>2–5 · ${s2.toFixed(1)}%</span>
          <span><i class="seg-3"></i>6–10 · ${s3.toFixed(1)}%</span>
          <span><i class="seg-4"></i>Others · ${s4.toFixed(1)}%</span>
        </div>
      </div>
      <div class="pick-stats">
        <div><div class="pick-stat-label">Price</div><div class="pick-stat-value">${escapeHtml(formatPrice(r.price))}</div></div>
        <div><div class="pick-stat-label">Market cap</div><div class="pick-stat-value">${escapeHtml(formatUsd(pick.mcap))}</div></div>
        <div><div class="pick-stat-label">Pair age</div><div class="pick-stat-value">${escapeHtml(formatAge(pick.age))}</div></div>
        <div><div class="pick-stat-label">Liquidity</div><div class="pick-stat-value">${escapeHtml(formatUsd(pick.liquidity))}</div></div>
      </div>
      <div class="pick-actions">
        <button class="trade-btn" type="button" data-trade="${escapeHtml(pick.mint)}" data-symbol="${escapeHtml(symbol)}">Buy</button>
        <a href="https://rugcheck.xyz/tokens/${escapeHtml(pick.mint)}" target="_blank" rel="noopener noreferrer">RugCheck</a>
        <a href="https://solscan.io/token/${escapeHtml(pick.mint)}" target="_blank" rel="noopener noreferrer">Solscan</a>
        <a href="https://dexscreener.com/solana/${escapeHtml(pick.mint)}" target="_blank" rel="noopener noreferrer">Chart</a>
        <a class="x-link" href="https://x.com/search?q=${xQuery}&f=live" target="_blank" rel="noopener noreferrer">Buzz</a>
      </div>
    </article>`;
}

function renderWatchlist(picks) {
  if (!picks.length) {
    watchlistGrid.innerHTML = `<div class="watchlist-empty">No low-risk candidates in this cycle. They'll refresh automatically in a couple of minutes.</div>`;
    return;
  }

  watchlistGrid.innerHTML = picks.map((pick, index) => renderPick(pick, index)).join("");

  watchlistGrid.querySelectorAll(".pick-logo").forEach((img) => {
    if (img.tagName !== "IMG") return;
    img.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "pick-logo fallback";
      fallback.textContent = img.dataset.initial || "?";
      img.replaceWith(fallback);
    });
  });
}

function setWatchlistStatus(message, loading) {
  watchlistStatus.hidden = false;
  watchlistStatus.innerHTML = loading
    ? `<span class="spinner"></span><span>${escapeHtml(message)}</span>`
    : `<span>${escapeHtml(message)}</span>`;
}

function tickWatchlist() {
  if (watchlistNextAt <= Date.now()) {
    if (document.hidden) {
      watchlistNextAt = Date.now() + 5000;
      return;
    }
    refreshWatchlist();
    return;
  }
  const remaining = Math.max(0, Math.round((watchlistNextAt - Date.now()) / 1000));
  const label = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  watchlistUpdated.textContent = `${watchlistLastUpdated ? `Updated ${watchlistLastUpdated} · ` : ""}next in ${label}`;
}

function scheduleWatchlist() {
  watchlistNextAt = Date.now() + WATCHLIST_REFRESH_MS;
  clearInterval(watchlistCountdownTimer);
  watchlistCountdownTimer = setInterval(tickWatchlist, 1000);
  tickWatchlist();
}

async function refreshWatchlist() {
  if (watchlistBusy) return;
  watchlistBusy = true;
  clearInterval(watchlistCountdownTimer);
  watchlistRefreshBtn.disabled = true;
  if (watchlistController) watchlistController.abort();
  watchlistController = new AbortController();
  const signal = watchlistController.signal;

  setWatchlistStatus("Finding low-risk candidates…", true);

  try {
    const picks = await loadWatchlist(signal);
    renderWatchlist(picks);
    watchlistStatus.hidden = true;
    watchlistLastUpdated = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (err) {
    if (err.name === "AbortError") return;
    setWatchlistStatus(err.message || "Couldn't load candidates. Retrying shortly.", false);
  } finally {
    watchlistBusy = false;
    watchlistRefreshBtn.disabled = false;
    scheduleWatchlist();
  }
}

function init() {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    shortenInput();
  });

  examplesEl.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (chip) scan(chip.dataset.mint);
  });

  recentList.addEventListener("click", (event) => {
    const item = event.target.closest(".recent-item");
    if (item) scan(item.dataset.mint);
  });

  resultsEl.addEventListener("click", (event) => {
    const copy = event.target.closest(".holder-copy");
    if (copy && copy.dataset.copy) copyText(copy.dataset.copy);
  });

  document.addEventListener("click", (event) => {
    const tradeBtn = event.target.closest("[data-trade]");
    if (!tradeBtn) return;
    event.preventDefault();
    if (window.RugWallet) {
      window.RugWallet.openTrade(tradeBtn.dataset.trade, tradeBtn.dataset.symbol || "", tradeBtn.dataset.mode || "buy");
    } else {
      showToast("Wallet is still loading — try again in a moment");
    }
  });

  clearRecentBtn.addEventListener("click", () => {
    localStorage.removeItem(RECENTS_KEY);
    renderRecents();
  });

  watchlistRefreshBtn.addEventListener("click", () => refreshWatchlist());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tickWatchlist();
  });

  renderRecents();
  refreshWatchlist();

  const hash = location.hash.replace("#", "").trim();
  if (hash && MINT_RE.test(hash)) {
    scan(hash);
  }
}

init();
