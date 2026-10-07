# FOREX VISION PROS — DERIV SNIPER AI

Production automated trading terminal that connects **directly to the official Deriv WebSocket API**
(`wss://ws.derivws.com/websockets/v3`) and executes **real** Deriv orders on both **DEMO** and **REAL**
accounts.

> **CRITICAL RULE** — this is not a backtesting app, not a paper-trading app and not a simulator.
> There is no simulated execution path anywhere in the codebase. Every price, candle, proposal,
> balance, contract and P/L figure originates from a live Deriv API message or from a PostgreSQL row
> written from one.

---

## 1 · Architecture

```
Browser (React / Next.js App Router)
   │  SSE  /api/stream        ← live engine state pushed from the server
   │  POST /api/command       ← operator commands
   │  GET  /api/trades        ← PostgreSQL trade ledger + P/L statistics
   ▼
Node.js runtime (server only — no Deriv token ever reaches the browser)
   │  src/lib/deriv.ts        ← official Deriv WebSocket client (ws)
   │  src/lib/engine.ts       ← trading engine: sync, strategy, execution, monitoring
   │  src/lib/strategy.ts     ← DERIV SNIPER AI weighted confirmation model
   │  src/lib/risk.ts         ← risk manager + stake management
   │  src/lib/indicators.ts   ← EMA / RSI / ADX / Momentum / ATR
   ▼
Deriv API  ←→  PostgreSQL (Drizzle ORM)
```

## 2 · Environment variables

Create a `.env` file (see `.env.example`):

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `DERIV_APP_ID` | recommended | Deriv application id from https://app.deriv.com/ (falls back to Deriv's public reference id `1089`) |
| `DERIV_API_TOKEN_DEMO` | for demo trading | API token for your Deriv **demo (virtual)** account |
| `DERIV_API_TOKEN_REAL` | for real trading | API token for your Deriv **real** account |

Tokens can also be pasted into the dashboard's *Deriv API credentials* panel. They are written to the
`settings` table on the server and are **never** returned to the browser.

Required token scopes: `read`, `trade`, `payments`, `trading_information`.

## 3 · Database

Tables are defined in `src/db/schema.ts`:

* `trades` — one row per real Deriv contract (contract id, direction, entry/exit spot, stake, payout,
  actual P/L, confidence, indicator snapshot, entry/exit reason, status)
* `signals` — every closed-candle strategy evaluation including WAIT
* `events` — Deriv API / engine audit log
* `settings` — engine configuration and server-side tokens

Initialize:

```bash
npx drizzle-kit push
```

## 4 · Production start

```bash
npm install
npm run build
npm run start
```

The app runs on any Node.js host (Node 20+). It uses the Node runtime only — the Deriv WebSocket
connection is long-lived server-side state.

## 5 · Deriv API usage

| Call | Purpose |
| --- | --- |
| `authorize` | authenticate, detect DEMO/REAL, read balance + account list |
| `ping` | 30 s keepalive |
| `ticks` | live price stream + tick sparkline |
| `ticks_history` (style `candles`) | historical + streaming OHLC (`ohlc`) at the selected granularity |
| `proposal` | real proposal for the selected symbol, duration and stake |
| `buy` | real order — returns `contract_id` |
| `proposal_open_contract` | live contract monitoring + settlement |
| `sell` | manual close/exit where supported |
| `balance` | live balance (and available balance after open exposure) |
| `portfolio` | open contracts |
| `transaction` | transaction monitoring |
| `forget` | stream cleanup on resubscribe |

**Reconnection:** on socket loss the engine blocks new trades (`SUSPENDED — Deriv reconnect in
progress`), reconnects with exponential backoff, re-authorizes, and re-synchronizes balance,
portfolio, market data and open contracts before automation may resume.

## 6 · DERIV SNIPER AI strategy

Weighted confirmation, evaluated **only on closed candles**:

| Component | Weight |
| --- | --- |
| EMA trend (EMA20/50/200) | 30 % |
| ADX (14) | 20 % |
| RSI (14) | 20 % |
| Momentum (14) | 15 % |
| Price structure | 15 % |

BUY requires all ten conditions (EMA20 > EMA50, EMA50 ≥ EMA200 or confirmed bullish transition,
price > EMA20, RSI > 55, ADX ≥ 20, Momentum > 100, ATR inside the volatility band, no conflicting
position, risk approval, confidence ≥ threshold). SELL mirrors it. Anything else is **WAIT** and the
dashboard states exactly why (`WAIT — ADX below 20`, `WAIT — confidence 63%, minimum 70%`, …).

## 7 · Execution sequence

```
BUY SIGNAL → Deriv proposal → validate proposal (id, ask price, payout, contract type, symbol)
           → Deriv buy → contract_id stored → proposal_open_contract monitoring
           → Deriv settlement → actual result written to PostgreSQL → dashboard + P/L update
```

A trade is never marked *open* without a Deriv `contract_id`, and never marked *profitable* unless
Deriv's own settlement confirms it.

## 8 · REAL account safety

1. All 14 live preflight checks must pass (connection, authentication, account detection, live price,
   candle stream, indicators, signal, proposal request, proposal response, demo purchase, contract
   monitoring, settlement, actual P/L, database recording).
2. The operator must type `CONFIRM REAL TRADING` in the *REAL ACCOUNT WARNING* gate.
3. The platform never switches from DEMO to REAL automatically.

## 9 · Risk management

Max concurrent trades (1) · max daily trades (50) · max daily loss · max consecutive losses (4) ·
cooldown (60 s) · max stake % of balance · minimum balance · fixed or %-of-balance stake · absolute
stake cap · confidence threshold (70 %) · halt-on-daily-loss · halt-on-consecutive-losses. All values
are configurable in the dashboard and persisted in PostgreSQL.

## 10 · Emergency controls

`STOP AUTO TRADING` (blocks new entries, keeps monitoring open contracts) · `CLOSE / EXIT CONTRACT`
(Deriv `sell`) · `DISCONNECT` · `RECONNECT + RESYNC` · DEMO ⇄ REAL switch.
