/**
 * Telegram and WhatsApp messaging.
 *
 * These two look symmetrical from the outside but are fundamentally different on the receive
 * side, and it's worth being explicit about why rather than papering over it:
 *
 * - **Telegram** (Bot API) supports long-polling via getUpdates, so receiving works out of the
 *   box with nothing but a bot token. Genuinely bidirectional with zero infrastructure.
 *
 * - **WhatsApp** (Meta Cloud API) has *no polling endpoint at all*. Inbound messages are only
 *   ever delivered by Meta POSTing to a public HTTPS webhook you host. That's a hard platform
 *   constraint, not an implementation shortcut. So `whatsapp_receive` reads from an in-memory
 *   buffer fed by the optional webhook listener in webhook.ts — which means it only returns
 *   anything if you run this server in a long-lived process with WHATSAPP_WEBHOOK_PORT set AND
 *   have Meta configured to reach it. Under a client that spawns a fresh process per call
 *   (xcoder's own mcp_tool does exactly this), the buffer is always empty. The tool says so in
 *   its result rather than silently returning nothing, because "no messages" and "receiving was
 *   never actually wired up" are very different answers.
 */

import { apiFetch, requireEnv, ToolError, truncate } from "./core.js";
import { drainWhatsAppInbox, webhookStatus } from "./webhook.js";

// ─── Telegram ───────────────────────────────────────────────────────────────

const TG_HINT = "Create a bot with @BotFather on Telegram and copy the token it gives you.";

function tgUrl(method: string): string {
  return `https://api.telegram.org/bot${requireEnv("TELEGRAM_BOT_TOKEN", TG_HINT)}/${method}`;
}

interface TgResponse<T> { ok: boolean; result: T; description?: string }

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number; title?: string; username?: string; first_name?: string; type: string };
    from?: { id: number; username?: string; first_name?: string };
  };
}

export async function telegramSend(args: { chatId: string; text: string; replyToMessageId?: number }) {
  if (!args.chatId || !args.text) throw new ToolError("chatId and text are required.");
  const res = await apiFetch<TgResponse<{ message_id: number }>>(tgUrl("sendMessage"), {
    method: "POST",
    body: {
      chat_id: args.chatId,
      text: args.text,
      reply_to_message_id: args.replyToMessageId,
    },
  });
  return `Sent to chat ${args.chatId}. Message id ${res.result.message_id}.`;
}

export async function telegramReceive(args: { limit?: number; offset?: number; timeoutSeconds?: number }) {
  const params: Record<string, unknown> = {
    limit: Math.min(args.limit ?? 20, 100),
    // Short poll by default. A long timeout would stall the calling model for that whole
    // duration, which is rarely what you want from a tool call.
    timeout: Math.min(args.timeoutSeconds ?? 0, 30),
  };
  if (args.offset !== undefined) params.offset = args.offset;

  const res = await apiFetch<TgResponse<TgUpdate[]>>(tgUrl("getUpdates"), {
    method: "POST",
    body: params,
    timeoutMs: ((args.timeoutSeconds ?? 0) + 20) * 1000,
  });

  const messages = res.result.filter((u) => u.message);
  if (!messages.length) {
    return (
      "No new messages.\n\n" +
      "Note: Telegram only delivers each update once per acknowledged offset. If you expected " +
      "messages here, they may have already been consumed by a previous call — pass `offset` " +
      "(last update_id + 1) to control the read position, and note that getUpdates does not " +
      "work at all while a webhook is registered for the same bot."
    );
  }

  return truncate(
    messages
      .map((u) => {
        const m = u.message!;
        const who = m.from?.username ? `@${m.from.username}` : m.from?.first_name ?? String(m.from?.id ?? "?");
        const chat = m.chat.title ?? m.chat.username ?? m.chat.first_name ?? String(m.chat.id);
        return [
          `update_id: ${u.update_id}`,
          `chat_id: ${m.chat.id} (${chat}, ${m.chat.type})`,
          `from: ${who}`,
          `at: ${new Date(m.date * 1000).toISOString()}`,
          `text: ${m.text ?? "(non-text message)"}`,
        ].join("\n");
      })
      .join("\n---\n") +
      `\n\nTo acknowledge these and avoid re-reading them, call again with offset=${messages[messages.length - 1].update_id + 1}.`
  );
}

// ─── WhatsApp (Meta Cloud API) ──────────────────────────────────────────────

const WA_HINT =
  "In Meta for Developers, create a WhatsApp Business app, then copy the phone number ID and a " +
  "(preferably permanent, system-user) access token. See README.md.";

export async function whatsappSend(args: { to: string; text: string; previewUrl?: boolean }) {
  if (!args.to || !args.text) throw new ToolError("to and text are required.");

  const token = requireEnv("WHATSAPP_TOKEN", WA_HINT);
  const phoneNumberId = requireEnv("WHATSAPP_PHONE_NUMBER_ID", WA_HINT);
  const version = process.env.WHATSAPP_API_VERSION ?? "v21.0";

  const res = await apiFetch<{ messages?: { id: string }[] }>(
    `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: "text",
        text: { body: args.text, preview_url: args.previewUrl ?? false },
      },
    }
  );

  const id = res.messages?.[0]?.id;
  return (
    `Sent to ${args.to}.${id ? ` Message id ${id}.` : ""}\n\n` +
    "Reminder: outside a 24-hour customer service window, WhatsApp only permits pre-approved " +
    "template messages — a free-form text send to a user who hasn't messaged you recently will " +
    "be rejected by Meta even though this call was well-formed."
  );
}

export async function whatsappReceive(args: { limit?: number }) {
  const status = webhookStatus();
  const messages = drainWhatsAppInbox(Math.min(args.limit ?? 20, 100));

  if (!messages.length) {
    if (!status.running) {
      return (
        "No messages — and the webhook listener is not running, so none can ever arrive.\n\n" +
        "WhatsApp's Cloud API has no polling endpoint: inbound messages are delivered only by " +
        "Meta POSTing to a public HTTPS webhook. To receive here, set WHATSAPP_WEBHOOK_PORT and " +
        "WHATSAPP_VERIFY_TOKEN, run this server as a long-lived process, expose it publicly " +
        "(a tunnel is fine for testing), and register that URL in the Meta app dashboard. " +
        "See README.md → 'Receiving WhatsApp messages'.\n\n" +
        "Note also that a client which spawns a fresh server process per tool call cannot " +
        "receive at all, because the buffer dies with the process."
      );
    }
    return `No new messages. Webhook listener is running on port ${status.port} and has received ${status.totalReceived} message(s) since start.`;
  }

  return truncate(
    messages
      .map((m) =>
        [`from: ${m.from}`, `at: ${m.timestamp}`, `message_id: ${m.id}`, `text: ${m.text}`].join("\n")
      )
      .join("\n---\n")
  );
}
