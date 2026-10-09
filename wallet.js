import { Connection, PublicKey, VersionedTransaction } from "https://esm.sh/@solana/web3.js@1";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_BASE = "https://lite-api.jup.ag/swap/v1";
const RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";
const LAMPORTS = 1_000_000_000;
const SLIPPAGE_BPS = 150;

let provider = null;
let publicKey = null;
let connection = null;
let quoteToken = 0;
let quoteTimer = null;
let submitting = false;

const trade = {
  mint: null,
  symbol: "",
  mode: "buy",
  decimals: 0,
  decimalsLoaded: false,
  balanceRaw: "0",
  balanceUi: 0,
  quote: null,
};

const el = (id) => document.getElementById(id);
const dom = {
  connectBtn: el("wallet-connect"),
  connectLabel: el("wallet-connect-label"),
  account: el("wallet-account"),
  chip: el("wallet-chip"),
  address: el("wallet-address"),
  balance: el("wallet-balance"),
  menu: el("wallet-menu"),
  menuAddr: el("wallet-menu-addr"),
  copyBtn: el("wallet-copy"),
  explorer: el("wallet-explorer"),
  disconnect: el("wallet-disconnect"),
  modal: el("trade-modal"),
  tradeLogo: el("trade-logo"),
  tradeTitle: el("trade-title"),
  tradeSub: el("trade-sub"),
  tabs: Array.from(document.querySelectorAll(".trade-tab")),
  amountLabel: el("trade-amount-label"),
  balanceHint: el("trade-balance-hint"),
  amount: el("trade-amount"),
  unit: el("trade-unit"),
  quick: el("trade-quick"),
  quote: el("trade-quote"),
  status: el("trade-status"),
  submit: el("trade-submit"),
};

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
  if (address.length <= size * 2 + 3) return address;
  return `${address.slice(0, size)}...${address.slice(-size)}`;
}

function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return "N/A";
  if (value >= 1000) {
    return "$" + new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }
  return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatAmount(value) {
  if (value == null || Number.isNaN(value)) return "—";
  if (value === 0) return "0";
  if (value < 0.000001) return value.toExponential(2);
  if (value < 1) return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (value < 1000) return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function toast(message) {
  const toastEl = el("toast");
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast.__t);
  toast.__t = setTimeout(() => {
    toastEl.hidden = true;
  }, 2000);
}

function getProvider() {
  const p = window.phantom?.solana || window.solana;
  return p && p.isPhantom ? p : null;
}

function ensureConnection() {
  if (!connection) connection = new Connection(RPC_ENDPOINT, "confirmed");
  return connection;
}

function inputMint() {
  return trade.mode === "buy" ? SOL_MINT : trade.mint;
}

function outputMint() {
  return trade.mode === "buy" ? trade.mint : SOL_MINT;
}

function outputDecimals() {
  return trade.mode === "buy" ? trade.decimals : 9;
}

function outputSymbol() {
  return trade.mode === "buy" ? trade.symbol || "token" : "SOL";
}

async function connect() {
  const p = getProvider();
  if (!p) {
    toast("Phantom not detected — install it at phantom.app");
    window.open("https://phantom.app/", "_blank", "noopener,noreferrer");
    return;
  }
  provider = p;
  try {
    const res = await provider.connect();
    setAccount((res?.publicKey || provider.publicKey)?.toString?.() || null);
    wireProviderEvents();
    toast("Wallet connected");
  } catch (err) {
    if (err?.code === 4001) toast("Connection request rejected");
    else toast("Could not connect to Phantom");
  }
}

async function disconnect() {
  closeMenu();
  try {
    await provider?.disconnect?.();
  } catch {
    /* ignore */
  }
  setAccount(null);
  toast("Wallet disconnected");
}

function wireProviderEvents() {
  if (!provider || provider.__wired) return;
  provider.__wired = true;
  provider.on?.("disconnect", () => setAccount(null));
  provider.on?.("accountChanged", (pk) => setAccount(pk ? pk.toString() : null));
}

function setAccount(address) {
  publicKey = address || null;
  if (publicKey) {
    dom.connectBtn.hidden = true;
    dom.account.hidden = false;
    dom.address.textContent = shortAddress(publicKey, 4);
    dom.menuAddr.textContent = publicKey;
    dom.explorer.href = `https://solscan.io/account/${publicKey}`;
    dom.balance.textContent = "";
    ensureConnection();
    refreshBalance();
  } else {
    dom.connectBtn.hidden = false;
    dom.account.hidden = true;
    dom.menu.hidden = true;
    closeMenu();
  }
  updateSubmitState();
}

async function refreshBalance() {
  if (!publicKey) return;
  try {
    const lamports = await ensureConnection().getBalance(new PublicKey(publicKey));
    dom.balance.textContent = `${formatAmount(lamports / LAMPORTS)} SOL`;
  } catch {
    dom.balance.textContent = "";
  }
}

function toggleMenu() {
  dom.menu.hidden = !dom.menu.hidden;
  dom.chip.setAttribute("aria-expanded", String(!dom.menu.hidden));
}

function closeMenu() {
  if (!dom.menu) return;
  dom.menu.hidden = true;
  dom.chip?.setAttribute("aria-expanded", "false");
}

function openTrade(mint, symbol, mode = "buy") {
  if (!mint) return;
  trade.mint = mint;
  trade.symbol = symbol || "";
  trade.quote = null;
  trade.decimals = 0;
  trade.decimalsLoaded = false;
  setMode(mode || "buy");
  resetForm();
  dom.modal.hidden = false;
  requestAnimationFrame(() => dom.modal.classList.add("open"));
  document.body.classList.add("modal-open");
  const initial = (trade.symbol || "?").slice(0, 2).toUpperCase();
  dom.tradeLogo.textContent = initial;
  dom.tradeLogo.className = "trade-logo fallback";
  loadTokenMeta();
  if (publicKey) refreshBalance();
}

function closeTrade() {
  dom.modal.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => {
    dom.modal.hidden = true;
  }, 220);
}

function resetForm() {
  dom.amount.value = "";
  dom.quote.hidden = true;
  dom.quote.innerHTML = "";
  hideStatus();
  updateChrome();
}

function setMode(mode) {
  trade.mode = mode === "sell" ? "sell" : "buy";
  trade.quote = null;
  dom.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === trade.mode));
  updateChrome();
  if (dom.amount.value) scheduleQuote();
}

function updateChrome() {
  const buying = trade.mode === "buy";
  const sym = trade.symbol ? `$${trade.symbol}` : shortAddress(trade.mint, 4);
  dom.tradeTitle.textContent = buying ? `Buy ${sym}` : `Sell ${sym}`;
  dom.tradeSub.textContent = publicKey ? `Connected · ${shortAddress(publicKey, 4)}` : "Connect Phantom to trade";
  dom.amountLabel.textContent = buying ? "Amount (SOL)" : "Amount (% of holdings)";
  dom.unit.textContent = buying ? "SOL" : "%";
  dom.amount.placeholder = buying ? "0.0" : "0";
  dom.amount.max = buying ? "" : "100";
  dom.balanceHint.textContent = buying
    ? (dom.balance.textContent ? `Balance ${dom.balance.textContent}` : "")
    : (trade.balanceUi ? `Holdings ${formatAmount(trade.balanceUi)} ${trade.symbol || ""}` : "");
  renderQuick();
  updateSubmitState();
}

function renderQuick() {
  const opts = trade.mode === "buy" ? [0.1, 0.5, 1, 2] : [25, 50, 75, 100];
  dom.quick.innerHTML = opts
    .map((v) => `<button class="quick-chip" type="button" data-quick="${v}">${trade.mode === "buy" ? v + " SOL" : v + "%"}</button>`)
    .join("");
}

function updateSubmitState() {
  if (submitting) {
    dom.submit.disabled = true;
    return;
  }
  if (!publicKey) {
    dom.submit.disabled = false;
    dom.submit.textContent = "Connect wallet to trade";
    dom.submit.classList.remove("ready");
    return;
  }
  dom.submit.disabled = false;
  dom.submit.textContent = trade.mode === "buy" ? "Buy with Phantom" : "Sell with Phantom";
  dom.submit.classList.add("ready");
}

async function loadTokenMeta() {
  try {
    const info = await ensureConnection().getParsedAccountInfo(new PublicKey(trade.mint));
    const parsed = info.value?.data?.parsed?.info;
    if (parsed && typeof parsed.decimals === "number") {
      trade.decimals = parsed.decimals;
      trade.decimalsLoaded = true;
    }
    const name = parsed?.name;
    if (name) dom.tradeSub.textContent = publicKey ? `${name} · ${shortAddress(publicKey, 4)}` : `${name} · connect to trade`;
  } catch {
    /* mint may not be parsed; decimals stay 0 */
  }
  if (trade.quote) renderQuote(trade.quote);
  if (publicKey) loadTokenBalance();
}

async function loadTokenBalance() {
  if (!publicKey || !trade.mint) return;
  try {
    const res = await ensureConnection().getParsedTokenAccountsByOwner(new PublicKey(publicKey), {
      mint: new PublicKey(trade.mint),
    });
    const acc = res.value[0];
    if (!acc) {
      trade.balanceRaw = "0";
      trade.balanceUi = 0;
    } else {
      const info = acc.account.data.parsed.info.tokenAmount;
      trade.balanceRaw = info.amount;
      trade.balanceUi = info.uiAmount || 0;
      trade.decimals = info.decimals ?? trade.decimals;
    }
  } catch {
    trade.balanceUi = 0;
  }
  updateChrome();
}

function currentAmountRaw() {
  const value = Number(dom.amount.value);
  if (!value || value <= 0) return null;
  if (trade.mode === "buy") return Math.round(value * LAMPORTS).toString();
  if (!trade.balanceUi) return null;
  const raw = Math.floor((trade.balanceUi * value) / 100 * Math.pow(10, trade.decimals));
  return raw > 0 ? String(raw) : null;
}

function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(requestQuote, 450);
}

async function requestQuote() {
  const amount = currentAmountRaw();
  if (!amount) {
    dom.quote.hidden = true;
    return;
  }
  if (trade.mode === "buy" && !trade.decimalsLoaded) await loadTokenMeta();
  const token = ++quoteToken;
  dom.quote.hidden = false;
  dom.quote.innerHTML = `<span class="spinner"></span><span>Fetching best route…</span>`;
  try {
    const quote = await getQuote(inputMint(), outputMint(), amount);
    if (token !== quoteToken) return;
    trade.quote = quote;
    renderQuote(quote);
  } catch (err) {
    if (token !== quoteToken) return;
    trade.quote = null;
    dom.quote.innerHTML = `<span class="quote-warn">${escapeHtml(err.message || "No route available for this amount.")}</span>`;
  }
}

async function getQuote(inMint, outMint, amount) {
  const url =
    `${JUP_BASE}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}` +
    `&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("No swap route found — liquidity may be too low.");
  const data = await res.json();
  if (!data || !data.outAmount) throw new Error("No swap route found for this token.");
  return data;
}

function renderQuote(quote) {
  const outUi = Number(quote.outAmount) / Math.pow(10, outputDecimals());
  const impact = Number(quote.priceImpactPct || 0) * 100;
  const minUi = Number(quote.otherAmountThreshold || quote.outAmount) / Math.pow(10, outputDecimals());
  const impactCls = impact > 5 ? "bad" : impact > 2 ? "warn" : "ok";
  dom.quote.innerHTML = `
    <div class="quote-row">
      <span>You receive</span>
      <strong>≈ ${escapeHtml(formatAmount(outUi))} ${escapeHtml(outputSymbol())}</strong>
    </div>
    <div class="quote-row">
      <span>Minimum received</span>
      <span>${escapeHtml(formatAmount(minUi))} ${escapeHtml(outputSymbol())}</span>
    </div>
    <div class="quote-row">
      <span>Price impact</span>
      <span class="quote-impact ${impactCls}">${impact.toFixed(2)}%</span>
    </div>
    <div class="quote-row">
      <span>Slippage</span>
      <span>${(SLIPPAGE_BPS / 100).toFixed(2)}%</span>
    </div>`;
}

async function buildSwapTx(quote) {
  const res = await fetch(`${JUP_BASE}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: publicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.swapTransaction) {
    throw new Error(data.error || "Jupiter could not build the transaction.");
  }
  const bin = atob(data.swapTransaction);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return VersionedTransaction.deserialize(bytes);
}

async function confirmSignature(signature) {
  const conn = ensureConnection();
  for (let i = 0; i < 30; i++) {
    const status = await conn.getSignatureStatus(signature).catch(() => null);
    const value = status?.value;
    if (value) {
      if (value.err) throw new Error("Transaction failed on-chain.");
      if (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized") return true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function submitTrade() {
  if (!publicKey) {
    connect();
    return;
  }
  if (submitting) return;
  const amount = currentAmountRaw();
  if (!amount) {
    showStatus(trade.mode === "buy" ? "Enter how much SOL to spend." : "Enter a percentage of holdings to sell.", "error");
    return;
  }

  submitting = true;
  updateSubmitState();
  showStatus("Requesting the best route…", "loading");
  try {
    const quote = trade.quote || (await getQuote(inputMint(), outputMint(), amount));
    if (!quote) throw new Error("No route found.");
    showStatus("Approve the swap in your Phantom wallet…", "loading");
    const tx = await buildSwapTx(quote);
    const result = await provider.signAndSendTransaction(tx);
    const signature = result?.signature || result;
    showStatus("Transaction sent — confirming on-chain…", "loading");
    await confirmSignature(signature);
    showStatus("Swap confirmed. Balances updated.", "success");
    toast("Swap confirmed");
    refreshBalance();
    if (trade.mode === "sell") loadTokenBalance();
    trade.quote = null;
    dom.amount.value = "";
    dom.quote.hidden = true;
  } catch (err) {
    if (err?.code === 4001) showStatus("Transaction rejected in wallet.", "error");
    else showStatus(err?.message || "Swap failed. Please try again.", "error");
  } finally {
    submitting = false;
    updateSubmitState();
  }
}

function showStatus(message, type) {
  dom.status.hidden = false;
  dom.status.className = "trade-status" + (type ? " " + type : "");
  dom.status.innerHTML =
    type === "loading"
      ? `<span class="spinner"></span><span>${escapeHtml(message)}</span>`
      : `<span>${escapeHtml(message)}</span>`;
}

function hideStatus() {
  dom.status.hidden = true;
  dom.status.innerHTML = "";
}

function init() {
  dom.connectBtn?.addEventListener("click", connect);
  dom.chip?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  dom.copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(publicKey || "");
      toast("Address copied");
    } catch {
      toast("Copy failed");
    }
  });
  dom.disconnect?.addEventListener("click", disconnect);
  document.addEventListener("click", (e) => {
    if (!dom.menu?.hidden && !e.target.closest("#wallet")) closeMenu();
  });

  dom.modal?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-trade]")) closeTrade();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dom.modal.hidden) closeTrade();
  });

  dom.tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));

  dom.amount?.addEventListener("input", () => {
    dom.quote.hidden = true;
    scheduleQuote();
  });
  dom.quick?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-quick]");
    if (!chip) return;
    dom.amount.value = chip.dataset.quick;
    scheduleQuote();
  });
  dom.submit?.addEventListener("click", submitTrade);

  const p = getProvider();
  if (p) {
    p.on?.("connect", (pk) => {
      provider = p;
      setAccount(pk?.toString?.() || p.publicKey?.toString?.());
    });
  }
}

window.RugWallet = { openTrade, connect, disconnect };

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
