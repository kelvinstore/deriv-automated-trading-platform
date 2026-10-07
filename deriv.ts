/**
 * Official Deriv WebSocket API transport.
 * Docs: https://developers.deriv.com/  —  wss://ws.derivws.com/websockets/v3?app_id=…
 *
 * This class performs ONLY real network calls to Deriv. There is no mocked
 * mode, no stub response and no fallback data anywhere in this file.
 */

import WebSocket from "ws";
import { DEFAULT_APP_ID, DERIV_WS_URL } from "./config";

export interface DerivError {
  code: string;
  message: string;
  details?: unknown;
}

export interface DerivMessage {
  msg_type?: string;
  req_id?: number;
  error?: DerivError;
  echo_req?: Record<string, unknown>;
  [key: string]: unknown;
}

export type StreamHandler = (msg: DerivMessage) => void;

export type SocketStatus =
  | "idle"
  | "connecting"
  | "open"
  | "authorizing"
  | "ready"
  | "reconnecting"
  | "closed"
  | "error";

interface Pending {
  resolve: (msg: DerivMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  label: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class DerivSocket {
  private ws: WebSocket | null = null;
  private nextReqId = 1;
  private pending = new Map<number, Pending>();
  private streams = new Map<number, { handler: StreamHandler; payload: DerivMessage; label: string }>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private manualClose = false;
  private token: string | null = null;
  private appId: string;

  public status: SocketStatus = "idle";
  public lastError: string | null = null;
  public onStatus: (status: SocketStatus, detail?: string) => void = () => {};
  public onRawMessage: (msg: DerivMessage) => void = () => {};
  public onAuthorized: (msg: DerivMessage) => void = () => {};
  /** Called after every successful (re)connect + authorize so callers can resync. */
  public onReady: () => void = () => {};

  constructor(appId?: string) {
    this.appId = appId || process.env.DERIV_APP_ID || DEFAULT_APP_ID;
  }

  get appIdInUse(): string {
    return this.appId;
  }

  private setStatus(status: SocketStatus, detail?: string) {
    this.status = status;
    this.onStatus(status, detail);
  }

  connect(token: string | null) {
    this.token = token;
    this.manualClose = false;
    this.open();
  }

  private open() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    const url = `${DERIV_WS_URL}?app_id=${encodeURIComponent(this.appId)}&l=EN&brand=deriv`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 15_000 });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setStatus("error", this.lastError);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.attempts = 0;
      this.lastError = null;
      this.setStatus("open");
      this.startPing();
      void this.authorizeAndReady();
    });

    ws.on("message", (data: WebSocket.RawData) => {
      let msg: DerivMessage;
      try {
        msg = JSON.parse(data.toString()) as DerivMessage;
      } catch {
        return;
      }
      this.dispatch(msg);
      this.onRawMessage(msg);
    });

    ws.on("error", (err: Error) => {
      this.lastError = err.message;
      this.setStatus("error", err.message);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this.stopPing();
      this.failAllPending(`Deriv socket closed (${code} ${reason.toString() || "no reason"})`);
      // Streams must be re-established after reconnect.
      for (const [, s] of this.streams) void s;
      this.streams.clear();
      if (!this.manualClose) {
        this.setStatus("closed", `connection lost (${code})`);
        this.scheduleReconnect();
      } else {
        this.setStatus("closed", "disconnected by operator");
      }
    });
  }

  private async authorizeAndReady() {
    if (!this.token) {
      // Public market data works without authorization; account calls will fail loudly.
      this.setStatus("ready", "connected without token — market data only");
      this.onReady();
      return;
    }
    this.setStatus("authorizing");
    try {
      const res = await this.request({ authorize: this.token }, "authorize");
      if (res.error) {
        this.lastError = res.error.message;
        this.setStatus("error", `authorize failed: ${res.error.message}`);
        return;
      }
      this.onAuthorized(res);
      this.setStatus("ready", "authorized");
      this.onReady();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setStatus("error", this.lastError ?? "authorize failed");
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 30_000);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect() {
    if (this.manualClose || this.reconnectTimer) return;
    this.attempts += 1;
    const delay = Math.min(30_000, 1_000 * Math.pow(2, Math.min(this.attempts, 5)));
    this.setStatus("reconnecting", `reconnect attempt ${this.attempts} in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private failAllPending(reason: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private dispatch(msg: DerivMessage) {
    const reqId = typeof msg.req_id === "number" ? msg.req_id : undefined;
    if (reqId !== undefined) {
      const stream = this.streams.get(reqId);
      if (stream) {
        try {
          stream.handler(msg);
        } catch (err) {
          // never let a subscriber crash the socket loop
          console.error("[deriv] stream handler error", err);
        }
      }
      const p = this.pending.get(reqId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(reqId);
        p.resolve(msg);
      }
      return;
    }
    if (msg.msg_type === "ping" || msg.msg_type === "heartbeat") return;
    if (msg.error) this.lastError = msg.error.message;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Send a request and resolve with Deriv's actual response. */
  request(payload: DerivMessage, label = "request"): Promise<DerivMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`Deriv connection unavailable (${label})`));
        return;
      }
      const req_id = this.nextReqId++;
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`Deriv request timed out: ${label}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(req_id, { resolve, reject, timer, label });
      try {
        this.ws.send(JSON.stringify({ ...payload, req_id }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(req_id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Open a persistent Deriv subscription (ticks, ohlc, balance, portfolio,
   * proposal_open_contract, transaction). Subscriptions are re-registered by
   * the caller after reconnect via onReady.
   */
  async subscribe(payload: DerivMessage, handler: StreamHandler, label = "subscribe"): Promise<number> {
    const res = await this.request({ ...payload, subscribe: 1 }, label);
    if (res.error) throw new Error(`Deriv subscribe failed (${label}): ${res.error.message}`);
    const reqId = res.req_id;
    if (typeof reqId !== "number") throw new Error(`Deriv subscribe failed: ${label}`);
    this.streams.set(reqId, { handler, payload, label });
    // Deliver the initial response to the handler as well.
    handler(res);
    return reqId;
  }

  forget(reqId: number) {
    this.streams.delete(reqId);
    if (this.isConnected()) {
      this.ws?.send(JSON.stringify({ forget: reqId }));
    }
  }

  disconnect() {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.failAllPending("disconnected by operator");
    this.streams.clear();
    try {
      this.ws?.close(1000, "operator disconnect");
    } catch {
      /* noop */
    }
    this.ws = null;
    this.setStatus("closed", "disconnected by operator");
  }

  /** Allow an operator-initiated reconnect after a manual disconnect. */
  reopen() {
    this.manualClose = false;
    this.attempts = 0;
    this.open();
  }
}
