import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getEngine } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Health + real connection telemetry. */
export async function GET() {
  let dbOk = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbOk = false;
  }

  let engineState = null;
  try {
    const engine = getEngine();
    await engine.init();
    const s = engine.getState();
    engineState = {
      deriv: s.connection.status,
      account: s.account?.loginid ?? null,
      accountType: s.account ? (s.account.isVirtual ? "demo" : "real") : null,
      synced: s.synced,
      symbol: s.market.symbol,
      price: s.market.price,
    };
  } catch {
    engineState = null;
  }

  return Response.json({ ok: dbOk, db: dbOk, engine: engineState, at: new Date().toISOString() }, { status: dbOk ? 200 : 500 });
}
