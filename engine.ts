/**
 * DERIV SNIPER AI — trading engine.
 *
 * This engine performs REAL Deriv API execution only:
 *   ticks_history → closed candles → indicators → strategy → proposal →
 *   buy → proposal_open_contract → settlement → PostgreSQL record.
 *
 * There is no simulated execution path in this file. If Deriv is unreachable
 * the engine reports WAIT and refuses to trade.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { events, settings, signals, trades } from "@/db/schema";
import { DerivSocket, type DerivMessage, type SocketStatus } from "./deriv";
import {
  DEFAULT_ENGINE,
  DEFAULT_RISK,
  granularityFor,
  symbolName,
  type RiskConfig,
} from "./config";
import { MIN_CANDLES, computeIndicators, type Candle, type IndicatorSet } from "./indicators";
import { computeStats, evaluateRisk, type RiskDecision, type Stats } from "./risk";
import { evaluate, type Evaluation } from "./strategy";

export interface Tick {
  epoch: number;
  quote: number;
}

export interface ContractState {
  contractId: number;
  proposalId: string | null;
  symbol: string;
  direction: "BUY" | "SELL";
  contractType: string;
  currency: string;
  accountType: string;
  entrySpot: number | null;
  currentSpot: number | null;
  exitSpot: number | null;
  buyPrice: number | null;
  payout: number | null;
  profit: number | null;
  status: string;
  startTime: number | null;
  expiryTime: number | null;
  isSold: boolean;
  confidence: number;
  entryReason: string;
  exitReason: string | null;
}

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error" | "trade";
  channel: string;
  message: string;
}

export interface PreflightItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface EngineState {
  accountMode: "demo" | "real";
  realConfirmed: boolean;
  realUnlocked: boolean;
  autoTrading: boolean;
  autoStatus: string;
  synced: boolean;
  connection: {
    status: SocketStatus;
    detail: string;
    appId: string;
    hasToken: boolean;
    reconnects: number;
    lastMessageAt: number | null;
    lastMessage: string;
  };
  account: {
    loginid: string;
    currency: string;
    isVirtual: boolean;
    balance: number;
    available: number;
    exposure: number;
    fullname: string;
    country: string;
    accountList: { loginid: string; currency: string; isVirtual: boolean }[];
  } | null;
  market: {
    symbol: string;
    symbolName: string;
    timeframe: number;
    granularity: number;
    price: number | null;
    bid: number | null;
    ask: number | null;
    ticks: Tick[];
    lastTickAt: number | null;
    status: string;
  };
  candles: Candle[];
  currentCandle: Candle | null;
  previousCandle: Candle | null;
  indicators: IndicatorSet;
  evaluation: Evaluation | null;
  lastProposal: {
    id: string;
    symbol: string;
    contractType: string;
    askPrice: number;
    payout: number;
    spot: number;
    displayValue: string;
    at: number;
  } | null;
  openContract: ContractState | null;
  closedContract: ContractState | null;
  risk: RiskConfig;
  riskDecision: RiskDecision | null;
  stats: Stats;
  preflight: PreflightItem[];
  log: LogEntry[];
}

const EMPTY_INDICATORS: IndicatorSet = {
  ema20: null,
  ema50: null,
  ema200: null,
  rsi14: null,
  adx14: null,
  diPlus: null,
  diMinus: null,
  momentum14: null,
  atr14: null,
  atrPercent: null,
  atrMedian: null,
  ema50Slope: null,
};

const EMPTY_STATS: Stats = {
  totalTrades: 0,
  openTrades: 0,
  wins: 0,
  losses: 0,
  sold: 0,
  winRate: 0,
  netProfit: 0,
  grossProfit: 0,
  grossLoss: 0,
  todayTrades: 0,
  todayProfit: 0,
  consecutiveLosses: 0,
  bestStreak: 0,
  avgStake: 0,
};

const CONFIRM_PHRASE = "CONFIRM REAL TRADING";

class TradingEngine {
  private socket: DerivSocket;
  private listeners = new Set<(s: EngineState) => void>();
  private emitTimer: NodeJS.Timeout | null = null;
  private initialised = false;
  private initPromise: Promise<void> | null = null;
  private marketStream: number | null = null;
  private tickStream: number | null = null;
  private balanceStream: number | null = null;
  private portfolioStream: number | null = null;
  private pocStream: number | null = null;
  private txnStream: number | null = null;
  private lastTradeAt: number | null = null;
  private busy = false;

  public state: EngineState;

  constructor() {
    this.state = {
      accountMode: DEFAULT_ENGINE.accountMode,
      realConfirmed: false,
      realUnlocked: false,
      autoTrading: false,
      autoStatus: "STOPPED — operator has not armed automation",
      synced: false,
      connection: {
        status: "idle",
        detail: "not started",
        appId: "",
        hasToken: false,
        reconnects: 0,
        lastMessageAt: null,
        lastMessage: "",
      },
      account: null,
      market: {
        symbol: DEFAULT_ENGINE.symbol,
        symbolName: symbolName(DEFAULT_ENGINE.symbol),
        timeframe: DEFAULT_ENGINE.timeframe,
        granularity: granularityFor(DEFAULT_ENGINE.timeframe),
        price: null,
        bid: null,
        ask: null,
        ticks: [],
        lastTickAt: null,
        status: "waiting for Deriv ticks",
      },
      candles: [],
      currentCandle: null,
      previousCandle: null,
      indicators: EMPTY_INDICATORS,
      evaluation: null,
      lastProposal: null,
      openContract: null,
      closedContract: null,
      risk: { ...DEFAULT_RISK },
      riskDecision: null,
      stats: EMPTY_STATS,
      preflight: [],
      log: [],
    };
    this.socket = new DerivSocket();
  }

  // ---------------------------------------------------------------- lifecycle
  async init(): Promise<void> {
    if (this.initialised) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.initialised = true;
      await this.loadSettings();
      await this.refreshStats();
      this.wireSocket();
      this.connect();
    })();
    return this.initPromise;
  }

  private wireSocket() {
    this.socket.onStatus = (status, detail) => {
      this.state.connection.status = status;
      this.state.connection.detail = detail ?? "";
      this.state.connection.appId = this.socket.appIdInUse;
      if (status === "reconnecting") {
        this.state.synced = false;
        this.state.connection.reconnects += 1;
        // Safety rule 24: no new trades while the socket is down.
        if (this.state.autoTrading) {
          this.state.autoStatus = "SUSPENDED — Deriv reconnect in progress, no new trades";
        }
        this.log("warn", "socket", `Deriv connection lost — ${detail ?? "reconnecting"}. New trades blocked.`);
      }
      if (status === "closed") this.state.synced = false;
      if (status === "error") this.log("error", "socket", detail ?? "Deriv socket error");
      this.emit();
    };

    this.socket.onRawMessage = (msg) => {
      this.state.connection.lastMessageAt = Date.now();
      this.state.connection.lastMessage = msg.msg_type ?? "message";
    };

    this.socket.onAuthorized = (msg) => {
      const a = (msg.authorize ?? {}) as Record<string, unknown>;
      const isVirtual = a.is_virtual === 1 || a.is_virtual === true;
      const list = Array.isArray(a.account_list) ? (a.account_list as Record<string, unknown>[]) : [];
      this.state.account = {
        loginid: String(a.loginid ?? ""),
        currency: String(a.currency ?? ""),
        isVirtual,
        balance: Number(a.balance ?? 0),
        available: Number(a.balance ?? 0),
        exposure: 0,
        fullname: String(a.fullname ?? ""),
        country: String(a.country ?? ""),
        accountList: list.map((x) => ({
          loginid: String(x.loginid ?? ""),
          currency: String(x.currency ?? ""),
          isVirtual: x.is_virtual === 1 || x.is_virtual === true,
        })),
      };
      // Account safety: the Deriv account itself decides demo vs real.
      this.state.accountMode = isVirtual ? "demo" : "real";
      if (!isVirtual && !this.state.realConfirmed) {
        this.state.autoStatus = "BLOCKED — real account without CONFIRM REAL TRADING";
      }
      this.log(
        "info",
        "auth",
        `Deriv authorize OK — ${a.loginid} · ${isVirtual ? "DEMO / virtual" : "REAL / non-virtual"} · ${a.currency} · balance ${a.balance}`,
      );
      this.updatePreflight("connection", true, `WebSocket open to Deriv (app_id ${this.socket.appIdInUse})`);
      this.updatePreflight("auth", true, `authorize accepted for ${a.loginid}`);
      this.updatePreflight("account", true, `${isVirtual ? "DEMO (virtual)" : "REAL (non-virtual)"} · ${a.currency}`);
      this.emit();
    };

    this.socket.onReady = () => {
      void this.syncAll();
    };
  }

  private connect() {
    this.state.connection.hasToken = Boolean(this.tokenFor(this.state.accountMode));
    this.socket.connect(this.tokenFor(this.state.accountMode));
    this.emit();
  }

  private tokenFor(mode: "demo" | "real"): string | null {
    const fromEnv =
      mode === "demo" ? process.env.DERIV_API_TOKEN_DEMO : process.env.DERIV_API_TOKEN_REAL;
    const fromDb = this.tokenCache[mode];
    return fromDb || fromEnv || null;
  }

  private tokenCache: { demo: string | null; real: string | null } = { demo: null, real: null };

  // ------------------------------------------------------------------ settings
  private async loadSettings() {
    try {
      const rows = await db.select().from(settings);
      for (const row of rows) {
        const v = row.value as Record<string, unknown>;
        if (row.key === "engine") {
          if (typeof v.symbol === "string") this.state.market.symbol = v.symbol;
          if (typeof v.timeframe === "number") this.state.market.timeframe = v.timeframe;
          if (typeof v.accountMode === "string") this.state.accountMode = v.accountMode as "demo" | "real";
          if (typeof v.realConfirmed === "boolean") this.state.realConfirmed = v.realConfirmed;
          if (v.risk && typeof v.risk === "object") this.state.risk = { ...DEFAULT_RISK, ...(v.risk as RiskConfig) };
          if (typeof v.autoTrading === "boolean") this.state.autoTrading = false; // never auto-arm on boot
        }
        if (row.key === "token_demo" && typeof v.token === "string") this.tokenCache.demo = v.token;
        if (row.key === "token_real" && typeof v.token === "string") this.tokenCache.real = v.token;
      }
      this.state.market.symbolName = symbolName(this.state.market.symbol);
      this.state.market.granularity = granularityFor(this.state.market.timeframe);
      this.state.connection.hasToken = Boolean(this.tokenFor(this.state.accountMode));
    } catch (err) {
      this.log("error", "db", `settings load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async persistSettings() {
    try {
      await db
        .insert(settings)
        .values({
          key: "engine",
          value: {
            symbol: this.state.market.symbol,
            timeframe: this.state.market.timeframe,
            accountMode: this.state.accountMode,
            realConfirmed: this.state.realConfirmed,
            risk: this.state.risk,
          },
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: {
            value: {
              symbol: this.state.market.symbol,
              timeframe: this.state.market.timeframe,
              accountMode: this.state.accountMode,
              realConfirmed: this.state.realConfirmed,
              risk: this.state.risk,
            } as never,
            updatedAt: new Date(),
          },
        });
    } catch (err) {
      this.log("error", "db", `settings persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async saveToken(mode: "demo" | "real", token: string) {
    this.tokenCache[mode] = token.trim();
    try {
      await db
        .insert(settings)
        .values({ key: `token_${mode}`, value: { token: token.trim() }, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: { token: token.trim() } as never, updatedAt: new Date() },
        });
    } catch (err) {
      this.log("error", "db", `token persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.state.connection.hasToken = Boolean(this.tokenFor(this.state.accountMode));
    this.log("info", "auth", `${mode.toUpperCase()} API token stored server-side (never sent to the browser)`);
    this.emit();
    if (!this.socket.isConnected()) this.connect();
  }

  // --------------------------------------------------------------------- sync
  async syncAll() {
    // Market data first: it is public and must never be blocked by an account call.
    const parts: Array<[string, () => Promise<void>]> = [
      ["market data", () => this.subscribeMarket()],
      ["balance", () => this.subscribeBalance()],
      ["portfolio", () => this.subscribePortfolio()],
      ["transactions", () => this.subscribeTransaction()],
      ["open contracts", () => this.subscribeOpenContractIfAny()],
    ];
    const failed: string[] = [];
    for (const [name, run] of parts) {
      try {
        await run();
      } catch (err) {
        failed.push(name);
        this.log("error", "sync", `Deriv ${name} sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Trading requires a synchronized account (balance + portfolio), not just prices.
    const accountSynced = !failed.includes("balance") && !failed.includes("portfolio");
    this.state.synced = accountSynced;
    this.state.connection.detail = accountSynced
      ? "synchronized with Deriv"
      : `partial sync — ${failed.join(", ")} unavailable`;
    if (this.state.autoTrading) {
      this.state.autoStatus = accountSynced
        ? this.state.account?.isVirtual
          ? "ARMED — DEMO · live Deriv API execution"
          : "ARMED — REAL · live Deriv API execution"
        : "SUSPENDED — Deriv account not synchronized, no new trades";
    }
    await this.refreshStats();
    this.log(
      accountSynced ? "info" : "warn",
      "sync",
      accountSynced
        ? "Synchronized: balance · portfolio · market data · open contracts"
        : `Synchronization incomplete (${failed.join(", ")}) — automated entries remain blocked`,
    );
    this.emit();
  }

  private async subscribeBalance() {
    if (this.balanceStream !== null) this.socket.forget(this.balanceStream);
    this.balanceStream = await this.socket.subscribe({ balance: 1 }, (msg) => {
      const b = (msg.balance ?? {}) as Record<string, unknown>;
      if (typeof b.balance !== "number") return;
      if (!this.state.account) return;
      this.state.account.balance = Number(b.balance);
      this.state.account.exposure = this.state.openContract?.buyPrice ?? 0;
      this.state.account.available = Number(b.balance) - this.state.account.exposure;
      this.emit();
    }, "balance");
  }

  private async subscribePortfolio() {
    if (this.portfolioStream !== null) this.socket.forget(this.portfolioStream);
    this.portfolioStream = await this.socket.subscribe({ portfolio: 1 }, (msg) => {
      const p = (msg.portfolio ?? {}) as Record<string, unknown>;
      const contracts = Array.isArray(p.contracts) ? (p.contracts as Record<string, unknown>[]) : [];
      if (contracts.length > 0 && !this.state.openContract) {
        const c = contracts[0];
        this.state.openContract = {
          contractId: Number(c.contract_id),
          proposalId: null,
          symbol: String(c.underlying ?? c.symbol ?? ""),
          direction: String(c.contract_type ?? "").includes("PUT") ? "SELL" : "BUY",
          contractType: String(c.contract_type ?? ""),
          currency: String(c.currency ?? ""),
          accountType: this.state.account?.isVirtual ? "demo" : "real",
          entrySpot: numberOrNull(c.entry_spot),
          currentSpot: numberOrNull(c.current_spot),
          exitSpot: null,
          buyPrice: numberOrNull(c.buy_price),
          payout: numberOrNull(c.payout),
          profit: numberOrNull(c.profit),
          status: String(c.status ?? "open"),
          startTime: numberOrNull(c.date_start),
          expiryTime: numberOrNull(c.expiry_time),
          isSold: false,
          confidence: 0,
          entryReason: "opened outside this terminal — monitored via Deriv portfolio",
          exitReason: null,
        };
        this.log("trade", "portfolio", `Monitoring existing Deriv contract ${c.contract_id}`);
      }
      this.emit();
    }, "portfolio");
  }

  private async subscribeTransaction() {
    if (this.txnStream !== null) this.socket.forget(this.txnStream);
    this.txnStream = await this.socket.subscribe({ transaction: 1 }, (msg) => {
      const t = (msg.transaction ?? {}) as Record<string, unknown>;
      if (!t.action) return;
      this.log(
        "info",
        "transaction",
        `Deriv transaction ${String(t.action)} · ${String(t.symbol ?? "")} · amount ${String(t.amount ?? "-")} ${String(t.currency ?? "")}`,
      );
      this.emit();
    }, "transaction");
  }

  // ------------------------------------------------------------- market data
  private async subscribeMarket() {
    const { symbol, granularity } = this.state.market;
    if (this.marketStream !== null) this.socket.forget(this.marketStream);
    if (this.tickStream !== null) this.socket.forget(this.tickStream);

    this.state.market.status = "loading Deriv candle history…";
    this.state.candles = [];
    this.state.indicators = EMPTY_INDICATORS;

    const res = await this.socket.request(
      {
        ticks_history: symbol,
        adjust_start_time: 1,
        count: 260,
        end: "latest",
        start: 1,
        style: "candles",
        granularity,
      },
      `ticks_history ${symbol} ${granularity}s`,
    );

    const candles = ((res.candles ?? []) as Record<string, unknown>[]).map((c) => ({
      epoch: Number(c.epoch),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }));
    this.state.candles = candles;
    this.state.market.price = candles.length ? candles[candles.length - 1].close : null;
    this.updateCandleWindows();
    this.recompute("history");
    this.log("info", "market", `Deriv ticks_history ${symbol}: ${candles.length} closed candles @ ${granularity}s`);
    this.updatePreflight("candles", true, `${candles.length} real Deriv candles received`);

    this.marketStream = await this.socket.subscribe(
      {
        ticks_history: symbol,
        adjust_start_time: 1,
        count: 1,
        end: "latest",
        start: 1,
        style: "candles",
        granularity,
        subscribe: 1,
      },
      (msg) => {
        if (msg.msg_type === "ohlc") this.applyOhlc((msg.ohlc ?? {}) as Record<string, unknown>);
      },
      `ohlc ${symbol}`,
    );

    this.tickStream = await this.socket.subscribe({ ticks: symbol }, (msg) => {
      if (msg.msg_type !== "tick") return;
      const t = (msg.tick ?? {}) as Record<string, unknown>;
      const quote = Number(t.quote);
      if (!Number.isFinite(quote)) return;
      this.state.market.price = quote;
      this.state.market.lastTickAt = Date.now();
      this.state.market.ticks.push({ epoch: Number(t.epoch ?? Date.now() / 1000), quote });
      if (this.state.market.ticks.length > 150) this.state.market.ticks = this.state.market.ticks.slice(-150);
      this.state.market.status = "LIVE — streaming Deriv ticks";
      this.updatePreflight("price", true, `live Deriv tick ${quote}`);
      this.emit();
    }, `ticks ${symbol}`);

    this.state.market.status = "LIVE — streaming Deriv ticks";
    this.emit();
  }

  private applyOhlc(o: Record<string, unknown>) {
    const openTime = Number(o.open_time ?? o.epoch);
    const candle: Candle = {
      epoch: openTime,
      open: Number(o.open),
      high: Number(o.high),
      low: Number(o.low),
      close: Number(o.close),
    };
    const arr = this.state.candles;
    const idx = arr.findIndex((c) => c.epoch === openTime);
    if (idx >= 0) {
      arr[idx] = candle;
    } else {
      arr.push(candle);
      // A new candle means the previous one has CLOSED → evaluate it.
      this.updateCandleWindows();
      this.recompute("closed-candle");
      void this.onClosedCandle();
    }
    if (arr.length > 400) this.state.candles = arr.slice(-400);
    this.updateCandleWindows();
    this.updatePreflight("stream", true, "live Deriv ohlc candle stream active");
    this.emit();
  }

  private updateCandleWindows() {
    const arr = this.state.candles;
    this.state.currentCandle = arr.length ? arr[arr.length - 1] : null;
    this.state.previousCandle = arr.length > 1 ? arr[arr.length - 2] : null;
    if (this.state.currentCandle) this.state.market.price = this.state.currentCandle.close;
  }

  // ----------------------------------------------------------------- strategy
  private recompute(_reason: string) {
    // The final element is the FORMING candle — it must never influence a signal.
    const closed = this.state.candles.slice(0, -1);
    this.state.indicators = computeIndicators(closed);
    const decision = this.computeRiskDecision();
    const evaluation = evaluate(this.state.indicators, closed, {
      threshold: this.state.risk.confidenceThreshold,
      atrMinPercent: this.state.risk.atrMinPercent,
      atrMaxPercent: this.state.risk.atrMaxPercent,
      hasOpenTrade: Boolean(this.state.openContract),
      riskApproved: decision.approved,
      riskBlockers: decision.blockers,
      connectionReady: this.socket.isConnected() && this.state.synced,
      dataReady: closed.length >= MIN_CANDLES,
      proposalReady: true,
    });
    this.state.evaluation = evaluation;
    this.state.riskDecision = decision;
  }

  private computeRiskDecision(): RiskDecision {
    const balance = this.state.account?.balance ?? 0;
    return evaluateRisk(this.state.risk, {
      balance,
      openTrades: this.state.openContract ? 1 : 0,
      todayTradeCount: this.state.stats.todayTrades,
      todayProfit: this.state.stats.todayProfit,
      consecutiveLosses: this.state.stats.consecutiveLosses,
      secondsSinceLastTrade: this.lastTradeAt ? (Date.now() - this.lastTradeAt) / 1000 : null,
      hasOpenTrade: Boolean(this.state.openContract),
    });
  }

  private async onClosedCandle() {
    if (!this.state.evaluation) return;
    await db
      .insert(signals)
      .values({
        candleEpoch: this.state.previousCandle?.epoch ?? null,
        accountType: this.state.account?.isVirtual ? "demo" : "real",
        symbol: this.state.market.symbol,
        timeframe: this.state.market.timeframe,
        signal: this.state.evaluation.signal,
        confidence: this.state.evaluation.confidence,
        price: this.state.market.price,
        ema20: this.state.indicators.ema20,
        ema50: this.state.indicators.ema50,
        ema200: this.state.indicators.ema200,
        rsi: this.state.indicators.rsi14,
        adx: this.state.indicators.adx14,
        momentum: this.state.indicators.momentum14,
        atr: this.state.indicators.atr14,
        blockers: this.state.evaluation.blockers,
        reasons: this.state.evaluation.reasons,
      })
      .catch(() => undefined);

    if (this.state.evaluation.signal !== "WAIT" && this.state.autoTrading) {
      await this.execute(this.state.evaluation.signal);
    }
    this.emit();
  }

  // --------------------------------------------------------------- execution
  /** Real Deriv proposal → buy → contract. No local simulation of any step. */
  async execute(direction: "BUY" | "SELL") {
    if (this.busy) return { ok: false, reason: "engine busy" };
    this.busy = true;
    try {
      if (!this.socket.isConnected() || !this.state.synced) {
        return this.refuse("Deriv connection unavailable");
      }
      if (!this.state.account) return this.refuse("no authenticated Deriv account");
      if (this.state.openContract) return this.refuse("existing trade active");
      if (this.state.accountMode === "real" && !this.state.realConfirmed) {
        return this.refuse("real trading not confirmed — type CONFIRM REAL TRADING first");
      }

      const decision = this.computeRiskDecision();
      this.state.riskDecision = decision;
      if (!decision.approved) return this.refuse(`risk manager: ${decision.blockers.join(", ")}`);

      const symbol = this.state.market.symbol;
      const contractType = direction === "BUY" ? "CALL" : "PUT";
      const duration = this.state.market.timeframe;
      const currency = this.state.account.currency;

      // 1. Deriv proposal with real parameters.
      const proposalRes = await this.socket.request(
        {
          proposal: 1,
          amount: decision.stake,
          basis: "stake",
          contract_type: contractType,
          currency,
          duration,
          duration_unit: "m",
          symbol,
        },
        `proposal ${contractType} ${symbol}`,
      );
      if (proposalRes.error) {
        this.updatePreflight("proposal_req", true, "proposal request sent to Deriv");
        this.updatePreflight("proposal_res", false, `Deriv error: ${proposalRes.error.message}`);
        return this.refuse(`Deriv proposal error: ${proposalRes.error.message}`);
      }
      const p = (proposalRes.proposal ?? {}) as Record<string, unknown>;
      const askPrice = Number(p.ask_price);
      const payout = Number(p.payout);
      const proposalId = String(p.id ?? "");
      this.updatePreflight("proposal_req", true, `proposal request sent (stake ${decision.stake} ${currency})`);
      this.updatePreflight(
        "proposal_res",
        Boolean(proposalId && askPrice > 0),
        `Deriv proposal ${proposalId} · ask ${askPrice} · payout ${payout}`,
      );

      // 2. Validate the proposal before any money is committed.
      const validationError = this.validateProposal(p, symbol, contractType, decision.stake);
      if (validationError) return this.refuse(`proposal validation failed: ${validationError}`);

      this.state.lastProposal = {
        id: proposalId,
        symbol,
        contractType,
        askPrice,
        payout,
        spot: Number(p.spot ?? 0),
        displayValue: String(p.display_value ?? ""),
        at: Date.now(),
      };
      this.log(
        "trade",
        "proposal",
        `Deriv proposal ${proposalId} · ${contractType} ${symbol} · stake ${askPrice} ${currency} · payout ${payout} · spot ${p.spot}`,
      );
      this.emit();

      // 3. Real Deriv buy.
      const buyRes = await this.socket.request({ buy: proposalId, price: askPrice }, `buy ${proposalId}`);
      if (buyRes.error) {
        return this.refuse(`Deriv buy rejected: ${buyRes.error.message}`);
      }
      const b = (buyRes.buy ?? {}) as Record<string, unknown>;
      const contractId = Number(b.contract_id);
      if (!Number.isFinite(contractId)) {
        return this.refuse("Deriv buy returned no contract_id — trade NOT recorded as open");
      }

      const contract: ContractState = {
        contractId,
        proposalId,
        symbol,
        direction,
        contractType,
        currency,
        accountType: this.state.account.isVirtual ? "demo" : "real",
        entrySpot: numberOrNull(b.start_spot) ?? this.state.market.price,
        currentSpot: this.state.market.price,
        exitSpot: null,
        buyPrice: Number(b.buy_price ?? askPrice),
        payout: Number(b.payout ?? payout),
        profit: null,
        status: "open",
        startTime: numberOrNull(b.date_start) ?? Math.floor(Date.now() / 1000),
        expiryTime: null,
        isSold: false,
        confidence: this.state.evaluation?.confidence ?? 0,
        entryReason: this.state.evaluation?.entryReason ?? `${direction} confirmation`,
        exitReason: null,
      };
      this.state.openContract = contract;

      await db
        .insert(trades)
        .values({
          accountType: contract.accountType,
          loginid: this.state.account.loginid,
          currency,
          symbol,
          timeframe: this.state.market.timeframe,
          direction,
          contractType,
          contractId,
          proposalId,
          duration,
          durationUnit: "m",
          stake: contract.buyPrice ?? decision.stake,
          payout: contract.payout,
          buyPrice: contract.buyPrice,
          entrySpot: contract.entrySpot,
          status: "open",
          confidence: contract.confidence,
          ema20: this.state.indicators.ema20,
          ema50: this.state.indicators.ema50,
          ema200: this.state.indicators.ema200,
          rsi: this.state.indicators.rsi14,
          adx: this.state.indicators.adx14,
          momentum: this.state.indicators.momentum14,
          atr: this.state.indicators.atr14,
          entryReason: contract.entryReason,
          marketPrice: this.state.market.price,
          raw: { buy: b, proposal: p } as never,
        })
        .onConflictDoNothing();
      this.updatePreflight("purchase", true, `Deriv buy executed — contract ${contractId}`);
      this.log(
        "trade",
        "buy",
        `DERIV BUY EXECUTED · contract ${contractId} · ${contractType} ${symbol} · stake ${contract.buyPrice} ${currency} · payout ${contract.payout}`,
      );
      this.lastTradeAt = Date.now();
      await this.monitorContract(contractId);
      await this.refreshStats();
      return { ok: true, contractId };
    } catch (err) {
      return this.refuse(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  private validateProposal(p: Record<string, unknown>, symbol: string, contractType: string, stake: number): string | null {
    if (!p.id) return "proposal has no id";
    if (!(Number(p.ask_price) > 0)) return "proposal ask_price invalid";
    if (!(Number(p.payout) > 0)) return "proposal payout invalid";
    if (String(p.contract_type ?? "") !== contractType) return `contract_type mismatch (${String(p.contract_type)})`;
    const reqSymbol = (p.echo_req as Record<string, unknown> | undefined)?.symbol;
    if (reqSymbol && String(reqSymbol) !== symbol) return `symbol mismatch (${String(reqSymbol)})`;
    if (Number(p.ask_price) > stake * 1.05) return "ask price deviates from requested stake";
    return null;
  }

  private refuse(reason: string) {
    this.log("warn", "engine", `WAIT — ${reason}`);
    if (this.state.evaluation) this.state.evaluation = { ...this.state.evaluation, signal: "WAIT", blockers: [`WAIT — ${reason}`, ...this.state.evaluation.blockers] };
    this.emit();
    return { ok: false, reason };
  }

  private async monitorContract(contractId: number) {
    if (this.pocStream !== null) this.socket.forget(this.pocStream);
    this.pocStream = await this.socket.subscribe(
      { proposal_open_contract: 1, contract_id: contractId },
      (msg) => {
        const poc = (msg.proposal_open_contract ?? {}) as Record<string, unknown>;
        if (!poc.contract_id) return;
        this.applyContractUpdate(poc);
      },
      `proposal_open_contract ${contractId}`,
    );
  }

  private applyContractUpdate(poc: Record<string, unknown>) {
    const c = this.state.openContract;
    if (!c || Number(poc.contract_id) !== c.contractId) return;
    c.currentSpot = numberOrNull(poc.current_spot) ?? c.currentSpot;
    c.profit = numberOrNull(poc.profit) ?? c.profit;
    c.status = String(poc.status ?? c.status);
    c.expiryTime = numberOrNull(poc.expiry_time) ?? c.expiryTime;
    c.entrySpot = numberOrNull(poc.entry_tick) ?? numberOrNull(poc.entry_spot) ?? c.entrySpot;
    this.updatePreflight("monitor", true, `Deriv proposal_open_contract updates for ${c.contractId}`);

    const isSold = poc.is_sold === 1 || poc.is_sold === true;
    if (isSold) {
      c.isSold = true;
      c.exitSpot = numberOrNull(poc.exit_tick) ?? c.exitSpot;
      c.profit = numberOrNull(poc.profit) ?? c.profit;
      const derStatus = String(poc.status ?? "");
      c.status = derStatus === "won" ? "won" : derStatus === "lost" ? "lost" : "sold";
      c.exitReason = `Deriv settlement · status ${c.status} · profit ${c.profit ?? 0} ${c.currency}`;
      void this.settle(c, poc);
    }
    this.emit();
  }

  private async settle(c: ContractState, poc: Record<string, unknown>) {
    try {
      await db
        .update(trades)
        .set({
          status: c.status,
          profit: c.profit ?? 0,
          sellPrice: numberOrNull(poc.sell_price),
          exitSpot: c.exitSpot,
          exitReason: c.exitReason,
          settledAt: new Date(),
          raw: { settlement: poc } as never,
        })
        .where(eq(trades.contractId, c.contractId));
      this.updatePreflight("settlement", true, `Deriv settlement recorded for contract ${c.contractId}`);
      this.updatePreflight("pnl", c.profit !== null, `actual P/L from Deriv: ${c.profit ?? 0} ${c.currency}`);
      this.updatePreflight("db", true, "trade persisted to PostgreSQL");
      this.log(
        "trade",
        "settle",
        `CONTRACT ${c.contractId} SETTLED · ${c.status.toUpperCase()} · actual P/L ${c.profit ?? 0} ${c.currency}`,
      );
      this.state.closedContract = { ...c };
      this.state.openContract = null;
      if (this.pocStream !== null) {
        this.socket.forget(this.pocStream);
        this.pocStream = null;
      }
      await this.refreshStats();
      this.recompute("settlement");
    } catch (err) {
      this.log("error", "db", `settlement persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.emit();
  }

  /** Close/exit the open contract where Deriv supports `sell`. */
  async sellOpen() {
    const c = this.state.openContract;
    if (!c) return { ok: false, reason: "no open contract" };
    const res = await this.socket.request({ sell: c.contractId, price: 0 }, `sell ${c.contractId}`);
    if (res.error) return { ok: false, reason: res.error.message };
    const s = (res.sell ?? {}) as Record<string, unknown>;
    c.status = "sold";
    c.isSold = true;
    c.profit = numberOrNull(s.sold_for) !== null ? Number(s.sold_for) - (c.buyPrice ?? 0) : c.profit;
    c.exitReason = `manual exit via Deriv sell · sold_for ${s.sold_for}`;
    this.log("trade", "sell", `Deriv sell executed for contract ${c.contractId} · sold_for ${s.sold_for}`);
    await this.settle(c, { sell_price: s.sold_for, status: "sold", profit: c.profit, contract_id: c.contractId });
    return { ok: true };
  }

  private async subscribeOpenContractIfAny() {
    if (this.state.openContract) await this.monitorContract(this.state.openContract.contractId);
    else {
      const rows = await db
        .select()
        .from(trades)
        .where(eq(trades.status, "open"))
        .orderBy(desc(trades.createdAt))
        .limit(1);
      const row = rows[0];
      if (row && row.contractId) {
        this.state.openContract = {
          contractId: row.contractId,
          proposalId: row.proposalId,
          symbol: row.symbol,
          direction: row.direction as "BUY" | "SELL",
          contractType: row.contractType,
          currency: row.currency ?? "",
          accountType: row.accountType,
          entrySpot: row.entrySpot,
          currentSpot: row.entrySpot,
          exitSpot: null,
          buyPrice: row.buyPrice,
          payout: row.payout,
          profit: null,
          status: "open",
          startTime: Math.floor(row.createdAt.getTime() / 1000),
          expiryTime: null,
          isSold: false,
          confidence: row.confidence,
          entryReason: row.entryReason ?? "",
          exitReason: null,
        };
        await this.monitorContract(row.contractId);
      }
    }
  }

  // -------------------------------------------------------------------- stats
  async refreshStats() {
    try {
      const rows = await db
        .select({
          status: trades.status,
          profit: trades.profit,
          stake: trades.stake,
          createdAt: trades.createdAt,
        })
        .from(trades)
        .orderBy(desc(trades.createdAt))
        .limit(1000);
      this.state.stats = computeStats(rows as never[]);
      const last = rows.find((r) => r.status !== "open");
      if (last) this.lastTradeAt = last.createdAt.getTime();
    } catch {
      this.state.stats = EMPTY_STATS;
    }
  }

  // ------------------------------------------------------------------ preflight
  private updatePreflight(key: string, ok: boolean, detail: string) {
    const label = PREFLIGHT_LABELS[key] ?? key;
    const existing = this.state.preflight.find((p) => p.key === key);
    if (existing) {
      existing.ok = ok;
      existing.detail = detail;
    } else {
      this.state.preflight.push({ key, label, ok, detail });
    }
    this.state.preflight.sort((a, b) => orderOf(a.key) - orderOf(b.key));
    this.state.realUnlocked =
      Object.keys(PREFLIGHT_LABELS).every((k) => this.state.preflight.find((p) => p.key === k)?.ok === true) &&
      this.state.realConfirmed;
  }

  /**
   * Live preflight — performs the real Deriv round-trips required before any
   * REAL trading is enabled. Nothing here is faked; a proposal is genuinely
   * requested from Deriv (no buy is submitted).
   */
  async runPreflight() {
    await this.init();
    this.updatePreflight("connection", this.socket.isConnected(), this.socket.isConnected() ? "Deriv WebSocket open" : "Deriv WebSocket not open");
    this.updatePreflight("auth", Boolean(this.state.account), this.state.account ? `authorized as ${this.state.account.loginid}` : "not authorized — set an API token");
    this.updatePreflight("account", Boolean(this.state.account), this.state.account ? (this.state.account.isVirtual ? "DEMO / virtual detected" : "REAL / non-virtual detected") : "unknown");
    this.updatePreflight("price", this.state.market.lastTickAt !== null, this.state.market.price !== null ? `live price ${this.state.market.price}` : "no ticks yet");
    this.updatePreflight("candles", this.state.candles.length > 0, `${this.state.candles.length} Deriv candles`);
    this.updatePreflight("stream", this.state.currentCandle !== null, this.state.currentCandle ? `forming candle ${this.state.currentCandle.epoch}` : "no ohlc stream");
    const hasIndicators = this.state.indicators.ema20 !== null && this.state.indicators.rsi14 !== null;
    this.updatePreflight("indicators", hasIndicators, hasIndicators ? "EMA/RSI/ADX/Momentum/ATR computed" : "insufficient candles");
    this.updatePreflight("signal", Boolean(this.state.evaluation), this.state.evaluation ? `${this.state.evaluation.signal} · ${this.state.evaluation.confidence}%` : "no evaluation yet");

    // Real proposal round-trip (no execution).
    try {
      const res = await this.socket.request(
        {
          proposal: 1,
          amount: this.state.risk.fixedStake,
          basis: "stake",
          contract_type: "CALL",
          currency: this.state.account?.currency ?? "USD",
          duration: this.state.market.timeframe,
          duration_unit: "m",
          symbol: this.state.market.symbol,
        },
        "preflight proposal",
      );
      const p = (res.proposal ?? {}) as Record<string, unknown>;
      this.updatePreflight("proposal_req", true, "proposal request sent to Deriv");
      this.updatePreflight("proposal_res", Boolean(p.id), `proposal ${String(p.id ?? "-")} · ask ${String(p.ask_price ?? "-")} · payout ${String(p.payout ?? "-")}`);
    } catch (err) {
      this.updatePreflight("proposal_req", false, err instanceof Error ? err.message : String(err));
      this.updatePreflight("proposal_res", false, "no proposal response");
    }

    const settled = await db
      .select()
      .from(trades)
      .where(and(eq(trades.accountType, "demo"), sql`${trades.contractId} is not null`))
      .orderBy(desc(trades.createdAt))
      .limit(1);
    const t = settled[0];
    this.updatePreflight("purchase", Boolean(t?.contractId), t?.contractId ? `Deriv demo contract ${t.contractId} purchased` : "no demo contract purchased yet");
    this.updatePreflight("monitor", Boolean(t?.contractId), t?.contractId ? "proposal_open_contract monitored" : "awaiting first demo contract");
    this.updatePreflight("settlement", Boolean(t?.settledAt), t?.settledAt ? `settled ${t.settledAt.toISOString()}` : "awaiting settlement");
    this.updatePreflight("pnl", t?.profit !== null && t?.profit !== undefined, t ? `actual P/L ${t.profit ?? "-"} ${t.currency ?? ""}` : "awaiting settlement");
    this.updatePreflight("db", Boolean(t?.id), t ? "trade row persisted in PostgreSQL" : "no trade rows yet");

    this.state.realUnlocked = this.state.preflight.every((p) => p.ok) && this.state.realConfirmed;
    this.log("info", "preflight", `Preflight complete — ${this.state.preflight.filter((p) => p.ok).length}/${this.state.preflight.length} checks passing`);
    this.emit();
    return this.state.preflight;
  }

  // ------------------------------------------------------------------ commands
  async setMarket(symbol: string, timeframe: number) {
    this.state.market.symbol = symbol;
    this.state.market.symbolName = symbolName(symbol);
    this.state.market.timeframe = timeframe;
    this.state.market.granularity = granularityFor(timeframe);
    this.state.market.ticks = [];
    await this.persistSettings();
    this.log("info", "market", `Market set to ${symbol} · timeframe ${timeframe} min — values sent to Deriv verbatim`);
    if (this.socket.isConnected()) await this.subscribeMarket();
    this.emit();
  }

  setAutoTrading(on: boolean, reason = "operator") {
    if (on && !this.state.synced) {
      this.state.autoTrading = false;
      this.state.autoStatus = "BLOCKED — Deriv not synchronized";
      this.emit();
      return;
    }
    if (on && this.state.accountMode === "real" && !this.state.realConfirmed) {
      this.state.autoTrading = false;
      this.state.autoStatus = "BLOCKED — type CONFIRM REAL TRADING to arm real-money automation";
      this.emit();
      return;
    }
    this.state.autoTrading = on;
    this.state.autoStatus = on
      ? this.state.account?.isVirtual
        ? "ARMED — DEMO · live Deriv market + real API execution + virtual demo funds"
        : "ARMED — REAL · live Deriv market + real API execution + real funds"
      : `STOPPED — ${reason}. Existing contracts are still monitored.`;
    this.log("trade", "engine", on ? "AUTO TRADING ARMED" : `AUTO TRADING STOPPED (${reason})`);
    this.emit();
  }

  async switchAccount(mode: "demo" | "real", phrase?: string) {
    if (mode === "real") {
      if (phrase !== CONFIRM_PHRASE) {
        return { ok: false, reason: "Type CONFIRM REAL TRADING exactly to enable real-money trading." };
      }
      const pre = await this.runPreflight();
      const failing = pre.filter((p) => !p.ok);
      if (failing.length > 0) {
        return {
          ok: false,
          reason: `REAL trading locked — preflight incomplete: ${failing.map((f) => f.label).join(", ")}`,
        };
      }
      this.state.realConfirmed = true;
    }
    this.state.accountMode = mode;
    this.state.openContract = null;
    this.state.account = null;
    this.state.synced = false;
    this.setAutoTrading(false, `switching to ${mode.toUpperCase()} account`);
    await this.persistSettings();
    this.log("trade", "account", `Switching to ${mode.toUpperCase()} — re-authenticating with the Deriv ${mode} token`);
    this.socket.disconnect();
    await new Promise((r) => setTimeout(r, 400));
    this.connect();
    this.emit();
    return { ok: true };
  }

  updateRisk(patch: Partial<RiskConfig>) {
    this.state.risk = { ...this.state.risk, ...patch };
    this.recompute("risk-change");
    void this.persistSettings();
    this.log("info", "risk", `Risk configuration updated: ${JSON.stringify(patch)}`);
    this.emit();
    return this.state.risk;
  }

  reconnect() {
    this.socket.reopen();
    this.emit();
  }

  disconnect() {
    this.setAutoTrading(false, "operator disconnect");
    this.socket.disconnect();
    this.emit();
  }

  // ---------------------------------------------------------------------- log
  log(level: LogEntry["level"], channel: string, message: string) {
    this.state.log.unshift({ ts: Date.now(), level, channel, message });
    if (this.state.log.length > 250) this.state.log = this.state.log.slice(0, 250);
    void db
      .insert(events)
      .values({ level, channel, message })
      .catch(() => undefined);
    // eslint-disable-next-line no-console
    console.log(`[${channel}] ${message}`);
    this.emit();
  }

  // -------------------------------------------------------------------- state
  subscribe(fn: (s: EngineState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const snapshot = this.getState();
      for (const fn of this.listeners) {
        try {
          fn(snapshot);
        } catch {
          /* noop */
        }
      }
    }, 200);
  }

  getState(): EngineState {
    return JSON.parse(JSON.stringify(this.state)) as EngineState;
  }

  async recentTrades(limit = 50) {
    return db.select().from(trades).orderBy(desc(trades.createdAt)).limit(limit);
  }

  async dayStartTrades() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return db.select().from(trades).where(gte(trades.createdAt, start)).orderBy(desc(trades.createdAt));
  }
}

const PREFLIGHT_LABELS: Record<string, string> = {
  connection: "1 · Deriv connection",
  auth: "2 · Authentication",
  account: "3 · Account detection",
  price: "4 · Live price",
  stream: "5 · Live candle stream",
  indicators: "6 · Indicator calculation",
  signal: "7 · Signal generation",
  proposal_req: "8 · Proposal request",
  proposal_res: "9 · Proposal response",
  purchase: "10 · Demo contract purchase",
  monitor: "11 · Contract monitoring",
  settlement: "12 · Settlement",
  pnl: "13 · Actual P/L retrieval",
  db: "14 · Database recording",
};

function orderOf(key: string): number {
  const keys = Object.keys(PREFLIGHT_LABELS);
  const i = keys.indexOf(key);
  return i < 0 ? 999 : i;
}

function numberOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const globalForEngine = globalThis as typeof globalThis & { __derivSniperEngine?: TradingEngine };

export function getEngine(): TradingEngine {
  const engine = globalForEngine.__derivSniperEngine ?? new TradingEngine();
  globalForEngine.__derivSniperEngine = engine;
  return engine;
}

export { CONFIRM_PHRASE };
