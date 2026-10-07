/**
 * Market + engine configuration.
 *
 * The symbol chosen on the dashboard is passed to Deriv verbatim
 * (`ticks`, `ticks_history`, `proposal`). Additional Deriv symbols can be
 * added to DERIV_SYMBOLS without touching the engine.
 */

export interface SymbolSpec {
  code: string;
  name: string;
  group: string;
}

export const DERIV_SYMBOLS: SymbolSpec[] = [
  { code: "1HZ75V", name: "Volatility 75 (1s) Index", group: "Derived · 1s" },
  { code: "R_75", name: "Volatility 75 Index", group: "Derived" },
  { code: "1HZ100V", name: "Volatility 100 (1s) Index", group: "Derived · 1s" },
  { code: "R_100", name: "Volatility 100 Index", group: "Derived" },
  { code: "1HZ50V", name: "Volatility 50 (1s) Index", group: "Derived · 1s" },
  { code: "R_50", name: "Volatility 50 Index", group: "Derived" },
  { code: "1HZ25V", name: "Volatility 25 (1s) Index", group: "Derived · 1s" },
  { code: "R_25", name: "Volatility 25 Index", group: "Derived" },
  { code: "R_10", name: "Volatility 10 Index", group: "Derived" },
];

export const TIMEFRAMES = [
  { minutes: 1, label: "1 MIN", granularity: 60 },
  { minutes: 5, label: "5 MIN", granularity: 300 },
  { minutes: 15, label: "15 MIN", granularity: 900 },
  { minutes: 60, label: "1 HOUR", granularity: 3600 },
] as const;

export function granularityFor(minutes: number): number {
  const tf = TIMEFRAMES.find((t) => t.minutes === minutes);
  return tf ? tf.granularity : 60;
}

export function symbolName(code: string): string {
  return DERIV_SYMBOLS.find((s) => s.code === code)?.name ?? code;
}

/** Deriv public WebSocket endpoint (official API). */
export const DERIV_WS_URL = "wss://ws.derivws.com/websockets/v3";

/** Deriv's public reference application id, used only when DERIV_APP_ID is unset. */
export const DEFAULT_APP_ID = "1089";

export interface RiskConfig {
  maxConcurrentTrades: number;
  maxDailyTrades: number;
  maxDailyLoss: number;
  maxConsecutiveLosses: number;
  cooldownSeconds: number;
  maxStakePercent: number;
  minBalance: number;
  stopOnDailyLoss: boolean;
  stopOnConsecutiveLosses: boolean;
  stakeMode: "fixed" | "percent";
  fixedStake: number;
  percentStake: number;
  maxStakeAbsolute: number;
  confidenceThreshold: number;
  atrMinPercent: number;
  atrMaxPercent: number;
  takeProfit: number;
  stopLoss: number;
}

export const DEFAULT_RISK: RiskConfig = {
  maxConcurrentTrades: 1,
  maxDailyTrades: 50,
  maxDailyLoss: 50,
  maxConsecutiveLosses: 4,
  cooldownSeconds: 60,
  maxStakePercent: 2,
  minBalance: 10,
  stopOnDailyLoss: true,
  stopOnConsecutiveLosses: true,
  stakeMode: "fixed",
  fixedStake: 1,
  percentStake: 1,
  maxStakeAbsolute: 50,
  confidenceThreshold: 70,
  atrMinPercent: 0.002,
  atrMaxPercent: 0.75,
  takeProfit: 0,
  stopLoss: 0,
};

export interface EngineConfig {
  symbol: string;
  timeframe: number;
  autoTrading: boolean;
  accountMode: "demo" | "real";
  risk: RiskConfig;
}

export const DEFAULT_ENGINE: EngineConfig = {
  symbol: "1HZ75V",
  timeframe: 1,
  autoTrading: false,
  accountMode: "demo",
  risk: DEFAULT_RISK,
};
