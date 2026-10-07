import { desc } from "drizzle-orm";
import { db } from "@/db";
import { events, signals, trades } from "@/db/schema";
import { computeStats } from "@/lib/risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Trade history, signal history and P/L statistics straight from PostgreSQL. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "trades";
  const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 60));

  if (kind === "signals") {
    const rows = await db.select().from(signals).orderBy(desc(signals.createdAt)).limit(limit);
    return Response.json({ ok: true, rows });
  }

  if (kind === "log") {
    const rows = await db.select().from(events).orderBy(desc(events.createdAt)).limit(limit);
    return Response.json({ ok: true, rows });
  }

  const rows = await db.select().from(trades).orderBy(desc(trades.createdAt)).limit(limit);
  const stats = computeStats(
    rows.map((r) => ({ status: r.status, profit: r.profit, stake: r.stake, createdAt: r.createdAt })),
  );
  return Response.json({ ok: true, rows, stats });
}
