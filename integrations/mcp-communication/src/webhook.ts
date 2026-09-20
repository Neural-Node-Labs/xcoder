/**
 * Optional HTTP listener for inbound WhatsApp messages.
 *
 * Only starts if WHATSAPP_WEBHOOK_PORT is set. It exists because WhatsApp's Cloud API is
 * push-only — there is no endpoint to poll for inbound messages — so the only way for
 * `whatsapp_receive` to ever return anything is for this process to be reachable by Meta and
 * to have been running when the message arrived.
 *
 * Deliberate limits, so nobody mistakes this for production messaging infrastructure:
 * - Messages live in a bounded in-memory ring buffer and are **lost when the process exits**.
 *   There's no database here on purpose; persisting other people's messages to disk is a
 *   meaningful data-handling decision that belongs to whoever deploys this, not to a default.
 * - Reading drains the buffer, so two consumers would steal each other's messages.
 * - It speaks plain HTTP. Meta requires HTTPS, so in practice this sits behind a tunnel or a
 *   reverse proxy that terminates TLS.
 */

import { createServer, type Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface InboundMessage {
  id: string;
  from: string;
  text: string;
  timestamp: string;
}

const MAX_BUFFERED = 200;
const inbox: InboundMessage[] = [];
let server: Server | null = null;
let totalReceived = 0;

export function webhookStatus(): { running: boolean; port?: number; buffered: number; totalReceived: number } {
  const port = process.env.WHATSAPP_WEBHOOK_PORT ? Number(process.env.WHATSAPP_WEBHOOK_PORT) : undefined;
  return { running: server !== null, port, buffered: inbox.length, totalReceived };
}

/** Returns up to `limit` buffered messages, removing them from the buffer. */
export function drainWhatsAppInbox(limit: number): InboundMessage[] {
  return inbox.splice(0, limit);
}

/**
 * Verifies Meta's X-Hub-Signature-256 header against the raw request body. Without this, anyone
 * who discovers the webhook URL could inject arbitrary "messages" that a model would then read
 * and act on — a straightforward prompt-injection channel. Enabled whenever WHATSAPP_APP_SECRET
 * is set; the server warns at startup if it isn't.
 */
function signatureValid(rawBody: string, header: string | undefined): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // verification disabled — warned about at startup
  if (!header?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf-8").digest();
  const provided = Buffer.from(header.slice("sha256=".length), "hex");
  // Lengths must match before timingSafeEqual, which throws on a mismatch.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function extractMessages(payload: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const msg of change?.value?.messages ?? []) {
        // Only plain text is surfaced. Media/location/interactive payloads are references that
        // need a second authenticated download to be useful, which isn't wired up here.
        if (msg?.type !== "text") continue;
        out.push({
          id: String(msg.id ?? ""),
          from: String(msg.from ?? ""),
          text: String(msg.text?.body ?? ""),
          timestamp: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : new Date().toISOString(),
        });
      }
    }
  }
  return out;
}

/** Starts the listener if configured. Returns a human-readable status line for the startup log. */
export function maybeStartWebhook(): string | null {
  const portRaw = process.env.WHATSAPP_WEBHOOK_PORT;
  if (!portRaw) return null;

  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return `WHATSAPP_WEBHOOK_PORT="${portRaw}" is not a valid port — webhook listener not started.`;
  }

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // Meta's one-time subscription handshake: echo hub.challenge if the token matches.
    if (req.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && verifyToken && token === verifyToken && challenge) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(challenge);
        return;
      }
      res.writeHead(403).end("verification failed");
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // Hard cap so an oversized body can't exhaust memory.
      if (raw.length > 1_000_000) {
        res.writeHead(413).end();
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!signatureValid(raw, req.headers["x-hub-signature-256"] as string | undefined)) {
        res.writeHead(401).end("bad signature");
        return;
      }
      // Always 200 quickly — Meta retries aggressively on non-2xx, and a retry storm is worse
      // than dropping one malformed payload.
      res.writeHead(200).end("ok");

      try {
        const messages = extractMessages(JSON.parse(raw));
        for (const m of messages) {
          inbox.push(m);
          totalReceived++;
          if (inbox.length > MAX_BUFFERED) inbox.shift(); // drop oldest
        }
      } catch {
        /* malformed payload — already acknowledged, nothing useful to do */
      }
    });
  });

  server.listen(port);

  const warnings: string[] = [];
  if (!verifyToken) warnings.push("WHATSAPP_VERIFY_TOKEN unset — Meta's subscription handshake will fail");
  if (!process.env.WHATSAPP_APP_SECRET) {
    warnings.push("WHATSAPP_APP_SECRET unset — incoming payloads are NOT signature-verified, so anyone who finds this URL can inject messages");
  }

  return `WhatsApp webhook listening on :${port}${warnings.length ? `\n  ⚠ ${warnings.join("\n  ⚠ ")}` : ""}`;
}

export function stopWebhook(): void {
  server?.close();
  server = null;
}
