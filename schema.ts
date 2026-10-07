import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Every row in `trades` is created ONLY from a real Deriv API response.
 * A trade is never written as "open" unless Deriv returned a contract_id from
 * a `buy` request, and never written as won/lost unless Deriv reported
 * settlement through `proposal_open_contract`.
 */
export const trades = pgTable(
  "trades",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    accountType: text("account_type").notNull(), // 'demo' | 'real'
    loginid: text("loginid"),
    currency: text("currency"),
    symbol: text("symbol").notNull(),
    timeframe: integer("timeframe").notNull(),
    direction: text("direction").notNull(), // 'BUY' | 'SELL'
    contractType: text("contract_type").notNull(), // 'CALL' | 'PUT'
    contractId: bigint("contract_id", { mode: "number" }),
    proposalId: text("proposal_id"),
    duration: integer("duration").notNull(),
    durationUnit: text("duration_unit").notNull(),
    stake: real("stake").notNull(),
    payout: real("payout"),
    buyPrice: real("buy_price"),
    entrySpot: real("entry_spot"),
    exitSpot: real("exit_spot"),
    sellPrice: real("sell_price"),
    profit: real("profit"),
    status: text("status").notNull().default("open"), // open | won | lost | sold | error
    confidence: integer("confidence").notNull(),
    ema20: real("ema20"),
    ema50: real("ema50"),
    ema200: real("ema200"),
    rsi: real("rsi"),
    adx: real("adx"),
    momentum: real("momentum"),
    atr: real("atr"),
    entryReason: text("entry_reason"),
    exitReason: text("exit_reason"),
    marketPrice: real("market_price"),
    raw: jsonb("raw"),
  },
  (t) => [
    uniqueIndex("trades_contract_id_idx").on(t.contractId),
    index("trades_created_idx").on(t.createdAt),
    index("trades_status_idx").on(t.status),
  ],
);

/** Every closed-candle strategy evaluation (including WAIT). */
export const signals = pgTable(
  "signals",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    candleEpoch: bigint("candle_epoch", { mode: "number" }),
    accountType: text("account_type"),
    symbol: text("symbol").notNull(),
    timeframe: integer("timeframe").notNull(),
    signal: text("signal").notNull(),
    confidence: integer("confidence").notNull(),
    price: real("price"),
    ema20: real("ema20"),
    ema50: real("ema50"),
    ema200: real("ema200"),
    rsi: real("rsi"),
    adx: real("adx"),
    momentum: real("momentum"),
    atr: real("atr"),
    blockers: jsonb("blockers"),
    reasons: jsonb("reasons"),
  },
  (t) => [index("signals_created_idx").on(t.createdAt)],
);

/** Real API / engine audit trail. */
export const events = pgTable(
  "events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    level: text("level").notNull().default("info"),
    channel: text("channel").notNull().default("api"),
    message: text("message").notNull(),
    meta: jsonb("meta"),
  },
  (t) => [index("events_created_idx").on(t.createdAt)],
);

/**
 * Server-side settings. API tokens are stored here and are NEVER returned to
 * the browser — the API layer redacts them before any state is serialised.
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TradeRow = typeof trades.$inferSelect;
export type SignalRow = typeof signals.$inferSelect;
export type EventRow = typeof events.$inferSelect;
