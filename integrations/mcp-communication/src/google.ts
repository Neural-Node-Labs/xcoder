/**
 * Gmail, Google Drive and Google Calendar tools. All three share one OAuth credential set (see
 * core.ts's googleAccessToken) but need their own API enabled in Google Cloud Console and their
 * own scope granted during the consent flow — see README.md for the scope list.
 */

import { googleFetch, ToolError, truncate } from "./core.js";

// ─── Gmail ──────────────────────────────────────────────────────────────────

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailHeader { name: string; value: string }
interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
}

function header(msg: GmailMessage, name: string): string {
  const found = msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

/** Gmail encodes bodies as base64url. Walks the MIME tree preferring text/plain over text/html,
 *  since a model reads plain text far better than a wall of markup. */
function extractBody(part?: GmailPart): string {
  if (!part) return "";
  if (part.body?.data && (!part.mimeType || part.mimeType.startsWith("text/"))) {
    const decoded = Buffer.from(part.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    if (part.mimeType === "text/html") return decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return decoded;
  }
  if (part.parts) {
    const plain = part.parts.find((p) => p.mimeType === "text/plain");
    if (plain) return extractBody(plain);
    for (const sub of part.parts) {
      const found = extractBody(sub);
      if (found) return found;
    }
  }
  return "";
}

export async function gmailList(args: { query?: string; maxResults?: number; labelIds?: string[] }) {
  const params = new URLSearchParams({ maxResults: String(Math.min(args.maxResults ?? 10, 50)) });
  if (args.query) params.set("q", args.query);
  for (const l of args.labelIds ?? []) params.append("labelIds", l);

  const list = await googleFetch<{ messages?: { id: string }[]; resultSizeEstimate?: number }>(
    `${GMAIL}/messages?${params}`
  );
  if (!list.messages?.length) return "No messages matched.";

  // The list endpoint returns ids only — fetch metadata for each so the result is actually
  // readable without a second round of tool calls.
  const summaries = await Promise.all(
    list.messages.map(async ({ id }) => {
      const msg = await googleFetch<GmailMessage>(
        `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
      );
      return [
        `id: ${msg.id}`,
        `from: ${header(msg, "From")}`,
        `date: ${header(msg, "Date")}`,
        `subject: ${header(msg, "Subject")}`,
        `snippet: ${msg.snippet ?? ""}`,
        msg.labelIds?.includes("UNREAD") ? "unread: yes" : "",
      ].filter(Boolean).join("\n");
    })
  );
  return truncate(summaries.join("\n---\n"));
}

export async function gmailRead(args: { messageId: string }) {
  if (!args.messageId) throw new ToolError("messageId is required.");
  const msg = await googleFetch<GmailMessage>(`${GMAIL}/messages/${args.messageId}?format=full`);
  return truncate(
    [
      `from: ${header(msg, "From")}`,
      `to: ${header(msg, "To")}`,
      `date: ${header(msg, "Date")}`,
      `subject: ${header(msg, "Subject")}`,
      "",
      extractBody(msg.payload) || msg.snippet || "(no readable text body)",
    ].join("\n")
  );
}

/** Builds an RFC 2822 message and base64url-encodes it, which is the only format Gmail's send
 *  endpoint accepts. */
function buildRawEmail(to: string, subject: string, body: string, cc?: string, bcc?: string): string {
  const lines = [`To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(
    // Encoding the subject protects non-ASCII characters, which would otherwise arrive mangled.
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body
  );
  return Buffer.from(lines.join("\r\n"), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function gmailSend(args: { to: string; subject: string; body: string; cc?: string; bcc?: string }) {
  if (!args.to || !args.subject || args.body === undefined) {
    throw new ToolError("to, subject and body are all required.");
  }
  const raw = buildRawEmail(args.to, args.subject, args.body, args.cc, args.bcc);
  const sent = await googleFetch<{ id: string; threadId: string }>(`${GMAIL}/messages/send`, {
    method: "POST",
    body: { raw },
  });
  return `Sent. Message id ${sent.id} (thread ${sent.threadId}).`;
}

// ─── Google Drive ───────────────────────────────────────────────────────────

const DRIVE = "https://www.googleapis.com/drive/v3";

/** Google Workspace native files (Docs/Sheets/Slides) can't be downloaded directly — they must
 *  be exported to a concrete format. Anything else downloads as-is via ?alt=media. */
const EXPORT_AS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export async function driveSearch(args: { query?: string; maxResults?: number }) {
  const params = new URLSearchParams({
    pageSize: String(Math.min(args.maxResults ?? 20, 100)),
    fields: "files(id,name,mimeType,modifiedTime,size,webViewLink)",
  });
  if (args.query) params.set("q", args.query);

  const res = await googleFetch<{ files?: { id: string; name: string; mimeType: string; modifiedTime: string; size?: string; webViewLink?: string }[] }>(
    `${DRIVE}/files?${params}`
  );
  if (!res.files?.length) return "No files matched.";
  return truncate(
    res.files
      .map((f) => `id: ${f.id}\nname: ${f.name}\ntype: ${f.mimeType}\nmodified: ${f.modifiedTime}${f.webViewLink ? `\nlink: ${f.webViewLink}` : ""}`)
      .join("\n---\n")
  );
}

export async function driveRead(args: { fileId: string }) {
  if (!args.fileId) throw new ToolError("fileId is required.");
  const meta = await googleFetch<{ name: string; mimeType: string }>(
    `${DRIVE}/files/${args.fileId}?fields=name,mimeType`
  );

  const exportMime = EXPORT_AS[meta.mimeType];
  const url = exportMime
    ? `${DRIVE}/files/${args.fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `${DRIVE}/files/${args.fileId}?alt=media`;

  const content = await googleFetch<string>(url);
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return truncate(`name: ${meta.name}\ntype: ${meta.mimeType}\n\n${text}`);
}

export async function driveUpload(args: { name: string; content: string; mimeType?: string; folderId?: string }) {
  if (!args.name || args.content === undefined) throw new ToolError("name and content are required.");
  const mimeType = args.mimeType ?? "text/plain";

  // Multipart upload: one request carrying both the metadata and the bytes.
  const boundary = `mcp-comm-${Date.now()}`;
  const metadata: Record<string, unknown> = { name: args.name, mimeType };
  if (args.folderId) metadata.parents = [args.folderId];

  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    "",
    args.content,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const { googleAccessToken, apiFetch } = await import("./core.js");
  const token = await googleAccessToken();
  const res = await apiFetch<{ id: string; name: string }>(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  return `Uploaded "${res.name}" (id ${res.id}).`;
}

// ─── Google Calendar ────────────────────────────────────────────────────────

const CALENDAR = "https://www.googleapis.com/calendar/v3";

interface CalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email: string; responseStatus?: string }[];
  htmlLink?: string;
}

function when(e: CalEvent): string {
  const s = e.start?.dateTime ?? e.start?.date ?? "?";
  const t = e.end?.dateTime ?? e.end?.date ?? "?";
  return `${s} → ${t}`;
}

export async function calendarList(args: { calendarId?: string; timeMin?: string; timeMax?: string; maxResults?: number; query?: string }) {
  const calendarId = encodeURIComponent(args.calendarId ?? "primary");
  const params = new URLSearchParams({
    singleEvents: "true", // expand recurring events into individual occurrences
    orderBy: "startTime",
    maxResults: String(Math.min(args.maxResults ?? 20, 100)),
    // Default to "from now" rather than the beginning of time — asking "what's on my calendar"
    // almost always means upcoming, and the whole history would flood the result.
    timeMin: args.timeMin ?? new Date().toISOString(),
  });
  if (args.timeMax) params.set("timeMax", args.timeMax);
  if (args.query) params.set("q", args.query);

  const res = await googleFetch<{ items?: CalEvent[] }>(`${CALENDAR}/calendars/${calendarId}/events?${params}`);
  if (!res.items?.length) return "No events in that range.";
  return truncate(
    res.items
      .map((e) =>
        [
          `id: ${e.id}`,
          `title: ${e.summary ?? "(no title)"}`,
          `when: ${when(e)}`,
          e.location ? `location: ${e.location}` : "",
          e.attendees?.length ? `attendees: ${e.attendees.map((a) => a.email).join(", ")}` : "",
        ].filter(Boolean).join("\n")
      )
      .join("\n---\n")
  );
}

export async function calendarCreate(args: {
  summary: string;
  start: string;
  end: string;
  calendarId?: string;
  description?: string;
  location?: string;
  attendees?: string[];
}) {
  if (!args.summary || !args.start || !args.end) throw new ToolError("summary, start and end are required.");
  const calendarId = encodeURIComponent(args.calendarId ?? "primary");

  // All-day events use { date }, timed events use { dateTime }. A bare YYYY-MM-DD means all-day.
  const isAllDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const body = {
    summary: args.summary,
    description: args.description,
    location: args.location,
    start: isAllDay(args.start) ? { date: args.start } : { dateTime: args.start },
    end: isAllDay(args.end) ? { date: args.end } : { dateTime: args.end },
    attendees: args.attendees?.map((email) => ({ email })),
  };

  const created = await googleFetch<CalEvent>(`${CALENDAR}/calendars/${calendarId}/events`, { method: "POST", body });
  return `Created "${created.summary}" (${when(created)}). Event id ${created.id}.${created.htmlLink ? `\n${created.htmlLink}` : ""}`;
}

export async function calendarDelete(args: { eventId: string; calendarId?: string }) {
  if (!args.eventId) throw new ToolError("eventId is required.");
  const calendarId = encodeURIComponent(args.calendarId ?? "primary");
  await googleFetch(`${CALENDAR}/calendars/${calendarId}/events/${args.eventId}`, { method: "DELETE" });
  return `Deleted event ${args.eventId}.`;
}
