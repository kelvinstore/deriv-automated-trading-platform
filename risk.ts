/**
 * Risk manager. Pure decision logic — it never invents balances; the balance
 * it is given is the one returned by Deriv's `balance` call.
 */

import type { RiskConfig } from "./config";

export interface RiskState {
  balance: number;
  openTrades: number;
  todayTradeCount: number;
  todayProfit: number;
  consecutiveLosses: number;
  secondsSinceLastTrade: number | null;
  hasOpenTrade: boolean;
}

export interface RiskDecision {
  approved: boolean;
  blockers: string[];
  stake: number;
  stakeBasis: string;
}

export function evaluateRisk(cfg: RiskConfig, state: RiskState): RiskDecision {
  const blockers: string[] = [];

  if (state.hasOpenTrade) blockers.push("existing trade active");
  if (state.openTrades >= cfg.maxConcurrentTrades)
    blockers.push(`max concurrent trades ${cfg.maxConcurrentTrades} reached`);
  if (state.todayTradeCount >= cfg.maxDailyTrades)
    blockers.push(`daily trade limit ${cfg.maxDailyTrades} reached`);
  if (cfg.stopOnDailyLoss && state.todayProfit <= -Math.abs(cfg.maxDailyLoss))
    blockers.push(`daily loss limit ${cfg.maxDailyLoss} reached — trading halted for today`);
  if (cfg.stopOnConsecutiveLosses && state.consecutiveLosses >= cfg.maxConsecutiveLosses)
    blockers.push(`${state.consecutiveLosses} consecutive losses — halt until a winning reset`);
  if (cfg.cooldownSeconds > 0 && state.secondsSinceLastTrade !== null && state.secondsSinceLastTrade < cfg.cooldownSeconds)
    blockers.push(`cooldown active (${Math.ceil(cfg.cooldownSeconds - state.secondsSinceLastTrade)}s remaining)`);
  if (state.balance < cfg.minBalance)
    blockers.push(`balance below minimum ${cfg.minBalance}`);
  if (state.balance <= 0) blockers.push("no available balance returned by Deriv");

  let stake = 0;
  if (cfg.stakeMode === "fixed") {
    stake = cfg.fixedStake;
  } else {
    stake = (state.balance * cfg.percentStake) / 100;
  }
  const maxByPercent = (state.balance * cfg.maxStakePercent) / 100;
  const cap = Math.max(0, Math.min(maxByPercent, cfg.maxStakeAbsolute));
  if (stake > cap) stake = cap;
  stake = Math.round(stake * 100) / 100;

  if (!(stake > 0)) blockers.push("calculated stake is zero — increase stake settings");
  if (stake > state.balance) blockers.push("calculated stake exceeds Deriv balance");

  return {
    approved: blockers.length === 0 && stake > 0,
    blockers,
    stake,
    stakeBasis:
      cfg.stakeMode === "fixed"
        ? `fixed stake ${cfg.fixedStake} (capped at ${cfg.maxStakePercent}% of balance)`
        : `${cfg.percentStake}% of Deriv balance ${state.balance.toFixed(2)} (cap ${cfg.maxStakeAbsolute})`,
  };
}

/** Trade ledger statistics straight from persisted Deriv results. */
export interface TradeStatRow {
  status: string;
  profit: number | null;
  stake: number | null;
  createdAt: Date | string;
}

export interface Stats {
  totalTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  sold: number;
  winRate: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  todayTrades: number;
  todayProfit: number;
  consecutiveLosses: number;
  bestStreak: number;
  avgStake: number;
}

export function computeStats(rows: TradeStatRow[], now = new Date()): Stats {
  let wins = 0;
  let losses = 0;
  let sold = 0;
  let openTrades = 0;
  let net = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let stakeSum = 0;
  let stakeCount = 0;
  let todayTrades = 0;
  let todayProfit = 0;
  let consecutiveLosses = 0;
  let currentLossStreak = 0;
  let bestStreak = 0;

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const ordered = [...rows].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  for (const r of ordered) {
    const created = new Date(r.createdAt);
    const profit = r.profit ?? 0;
    if (r.stake && r.stake > 0) {
      stakeSum += r.stake;
      stakeCount++;
    }
    if (created.getTime() >= todayStart.getTime()) {
      todayTrades++;
      if (r.status !== "open") todayProfit += profit;
    }
    if (r.status === "open") {
      openTrades++;
      continue;
    }
    net += profit;
    if (r.status === "won") {
      wins++;
      grossProfit += profit;
      currentLossStreak = 0;
    } else if (r.status === "lost") {
      losses++;
      grossLoss += profit;
      currentLossStreak++;
      bestStreak = Math.max(bestStreak, currentLossStreak);
    } else if (r.status === "sold") {
      sold++;
      if (profit >= 0) {
        grossProfit += profit;
        currentLossStreak = 0;
      } else {
        grossLoss += profit;
        currentLossStreak++;
        bestStreak = Math.max(bestStreak, currentLossStreak);
      }
    }
    consecutiveLosses = currentLossStreak;
  }

  const settled = wins + losses + sold;
  return {
    totalTrades: rows.length,
    openTrades,
    wins,
    losses,
    sold,
    winRate: settled > 0 ? Math.round((wins / settled) * 1000) / 10 : 0,
    netProfit: Math.round(net * 100) / 100,
    grossProfit: Math.round(grossProfit * 100) / 100,
    grossLoss: Math.round(grossLoss * 100) / 100,
    todayTrades,
    todayProfit: Math.round(todayProfit * 100) / 100,
    consecutiveLosses,
    bestStreak,
    avgStake: stakeCount > 0 ? Math.round((stakeSum / stakeCount) * 100) / 100 : 0,
  };
}
