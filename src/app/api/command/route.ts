import { getEngine, CONFIRM_PHRASE } from "@/lib/engine";
import type { RiskConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface CommandRequest {
  action:
    | "connect"
    | "disconnect"
    | "reconnect"
    | "setAuto"
    | "setMarket"
    | "setRisk"
    | "switchAccount"
    | "sell"
    | "preflight"
    | "saveToken";
  symbol?: string;
  timeframe?: number;
  auto?: boolean;
  mode?: "demo" | "real";
  phrase?: string;
  token?: string;
  risk?: Partial<RiskConfig>;
}

/**
 * Operator commands. Every action drives the real Deriv connection —
 * nothing here simulates trading.
 */
export async function POST(req: Request) {
  const engine = getEngine();
  await engine.init();

  let body: CommandRequest;
  try {
    body = (await req.json()) as CommandRequest;
  } catch {
    return Response.json({ ok: false, reason: "invalid JSON body" }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "connect":
        engine.reconnect();
        return Response.json({ ok: true, state: engine.getState() });

      case "disconnect":
        engine.disconnect();
        return Response.json({ ok: true, state: engine.getState() });

      case "reconnect":
        engine.reconnect();
        return Response.json({ ok: true, state: engine.getState() });

      case "setAuto":
        engine.setAutoTrading(Boolean(body.auto), "operator dashboard control");
        return Response.json({ ok: true, state: engine.getState() });

      case "setMarket": {
        const symbol = String(body.symbol ?? "").trim().toUpperCase();
        const timeframe = Number(body.timeframe ?? 1);
        if (!symbol) return Response.json({ ok: false, reason: "symbol required" }, { status: 400 });
        await engine.setMarket(symbol, timeframe);
        return Response.json({ ok: true, state: engine.getState() });
      }

      case "setRisk": {
        const risk = engine.updateRisk(body.risk ?? {});
        return Response.json({ ok: true, risk, state: engine.getState() });
      }

      case "switchAccount": {
        const mode = body.mode === "real" ? "real" : "demo";
        const result = await engine.switchAccount(mode, body.phrase ?? "");
        return Response.json(
          { ok: result.ok, reason: result.reason, phrase: CONFIRM_PHRASE, state: engine.getState() },
          { status: result.ok ? 200 : 400 },
        );
      }

      case "sell": {
        const result = await engine.sellOpen();
        return Response.json(
          { ok: result.ok, reason: result.reason, state: engine.getState() },
          { status: result.ok ? 200 : 400 },
        );
      }

      case "preflight": {
        const preflight = await engine.runPreflight();
        return Response.json({ ok: true, preflight, state: engine.getState() });
      }

      case "saveToken": {
        const mode = body.mode === "real" ? "real" : "demo";
        const token = String(body.token ?? "").trim();
        if (!token) return Response.json({ ok: false, reason: "token required" }, { status: 400 });
        await engine.saveToken(mode, token);
        return Response.json({ ok: true, state: engine.getState() });
      }

      default:
        return Response.json({ ok: false, reason: "unknown action" }, { status: 400 });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    engine.log("error", "api", `command ${body.action} failed: ${reason}`);
    return Response.json({ ok: false, reason }, { status: 500 });
  }
}
