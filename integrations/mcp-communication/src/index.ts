#!/usr/bin/env node
/**
 * mcp-communication — an MCP server exposing Gmail, Google Drive, Google Calendar, GitHub,
 * Telegram and WhatsApp as tools over stdio.
 *
 * Only tools whose provider is actually configured get listed (see core.ts's `providers`), so a
 * client never sees a tool it couldn't possibly call. Run `node dist/index.js --check` to print
 * which providers are live without starting the server.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { describeConfig, providers, ToolError } from "./core.js";
import { gmailList, gmailRead, gmailSend, driveSearch, driveRead, driveUpload, calendarList, calendarCreate, calendarDelete } from "./google.js";
import { githubSearchRepos, githubListIssues, githubGetIssue, githubCreateIssue, githubComment, githubReadFile } from "./github.js";
import { telegramSend, telegramReceive, whatsappSend, whatsappReceive } from "./messaging.js";
import { maybeStartWebhook, stopWebhook } from "./webhook.js";

type Handler = (args: any) => Promise<string>;

interface ToolDef {
  name: string;
  description: string;
  /** Which provider must be configured for this tool to be offered at all. */
  provider: keyof typeof providers;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: Handler;
}

const s = (description: string) => ({ type: "string", description });
const n = (description: string) => ({ type: "number", description });
const b = (description: string) => ({ type: "boolean", description });

const TOOLS: ToolDef[] = [
  // ─── Gmail ────────────────────────────────────────────────────────────────
  {
    name: "gmail_list",
    description: "List Gmail messages matching a Gmail search query, with sender/subject/date/snippet for each. Use this to find messages before reading one in full.",
    provider: "google",
    inputSchema: {
      type: "object",
      properties: {
        query: s("Gmail search syntax, e.g. 'from:alice@example.com is:unread newer_than:7d'. Omit for the most recent messages."),
        maxResults: n("How many messages to return, 1-50. Default 10."),
        labelIds: { type: "array", items: { type: "string" }, description: "Restrict to label ids, e.g. ['INBOX'] or ['UNREAD']." },
      },
    },
    handler: gmailList,
  },
  {
    name: "gmail_read",
    description: "Read one Gmail message in full, including its decoded plain-text body. Takes a message id from gmail_list.",
    provider: "google",
    inputSchema: { type: "object", properties: { messageId: s("Message id, as returned by gmail_list.") }, required: ["messageId"] },
    handler: gmailRead,
  },
  {
    name: "gmail_send",
    description: "Send a plain-text email from the authenticated Gmail account. This really sends — there is no draft or preview step.",
    provider: "google",
    inputSchema: {
      type: "object",
      properties: {
        to: s("Recipient address. Comma-separate for multiple."),
        subject: s("Subject line."),
        body: s("Plain-text body."),
        cc: s("Optional Cc addresses, comma-separated."),
        bcc: s("Optional Bcc addresses, comma-separated."),
      },
      required: ["to", "subject", "body"],
    },
    handler: gmailSend,
  },

  // ─── Google Drive ─────────────────────────────────────────────────────────
  {
    name: "drive_search",
    description: "Search Google Drive files, returning id, name, type and modified time for each.",
    provider: "google",
    inputSchema: {
      type: "object",
      properties: {
        query: s("Drive query syntax, e.g. \"name contains 'budget' and mimeType='application/vnd.google-apps.spreadsheet'\". Omit to list recent files."),
        maxResults: n("How many files to return, 1-100. Default 20."),
      },
    },
    handler: driveSearch,
  },
  {
    name: "drive_read",
    description: "Read a Drive file's contents as text. Google Docs/Sheets/Slides are exported to text/CSV automatically; other files are downloaded as-is.",
    provider: "google",
    inputSchema: { type: "object", properties: { fileId: s("File id, as returned by drive_search.") }, required: ["fileId"] },
    handler: driveRead,
  },
  {
    name: "drive_upload",
    description: "Create a new file in Google Drive from text content. Does not overwrite existing files — each call creates a new one.",
    provider: "google",
    inputSchema: {
      type: "object",
      properties: {
        name: s("File name including extension."),
        content: s("Text content of the file."),
        mimeType: s("MIME type. Default text/plain."),
        folderId: s("Optional parent folder id. Defaults to My Drive root."),
      },
      required: ["name", "content"],
    },
    handler: driveUpload,
  },

  // ─── Google Calendar ──────────────────────────────────────────────────────
  {
    name: "calendar_list_events",
    description: "List upcoming calendar events in a time range, with title, time, location and attendees. Recurring events are expanded into individual occurrences.",
    provider: "google",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: s("Calendar id. Default 'primary'."),
        timeMin: s("RFC3339 lower bound, e.g. '2026-01-01T00:00:00Z'. Defaults to now."),
        timeMax: s("RFC3339 upper bound. Omit for no upper bound."),
        maxResults: n("How many events to return, 1-100. Default 20."),
        query: s("Free-text search across event fields."),
      },
    },
    handler: calendarList,
  },
  {
    name: "calendar_create_event",
    description: "Create a calendar event. Use a bare date (YYYY-MM-DD) for all-day events, or a full RFC3339 timestamp for timed ones.",
    provider: "google",
    inputSchema: {
      type: "object",
      properties: {
        summary: s("Event title."),
        start: s("Start: 'YYYY-MM-DD' for all-day, or RFC3339 like '2026-03-01T14:00:00-08:00'."),
        end: s("End, same format as start."),
        calendarId: s("Calendar id. Default 'primary'."),
        description: s("Optional longer description."),
        location: s("Optional location."),
        attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses — they will be invited." },
      },
      required: ["summary", "start", "end"],
    },
    handler: calendarCreate,
  },
  {
    name: "calendar_delete_event",
    description: "Delete a calendar event by id. This is permanent and notifies attendees.",
    provider: "google",
    inputSchema: {
      type: "object",
      properties: { eventId: s("Event id, as returned by calendar_list_events."), calendarId: s("Calendar id. Default 'primary'.") },
      required: ["eventId"],
    },
    handler: calendarDelete,
  },

  // ─── GitHub ───────────────────────────────────────────────────────────────
  {
    name: "github_search_repos",
    description: "Search GitHub repositories by keyword or qualifier, returning name, stars, language and description.",
    provider: "github",
    inputSchema: {
      type: "object",
      properties: { query: s("GitHub search query, e.g. 'mcp server language:typescript stars:>100'."), maxResults: n("1-50. Default 10.") },
      required: ["query"],
    },
    handler: githubSearchRepos,
  },
  {
    name: "github_list_issues",
    description: "List issues in a repository. Note that GitHub's API also returns pull requests here; those are flagged in the output.",
    provider: "github",
    inputSchema: {
      type: "object",
      properties: {
        repo: s("Repository as 'owner/name'."),
        state: s("'open' (default), 'closed', or 'all'."),
        labels: s("Comma-separated label names to filter by."),
        maxResults: n("1-100. Default 20."),
      },
      required: ["repo"],
    },
    handler: githubListIssues,
  },
  {
    name: "github_get_issue",
    description: "Read one issue in full, including its body and up to 30 comments.",
    provider: "github",
    inputSchema: {
      type: "object",
      properties: { repo: s("Repository as 'owner/name'."), issueNumber: n("Issue number.") },
      required: ["repo", "issueNumber"],
    },
    handler: githubGetIssue,
  },
  {
    name: "github_create_issue",
    description: "Open a new issue in a repository. This is publicly visible on public repos.",
    provider: "github",
    inputSchema: {
      type: "object",
      properties: {
        repo: s("Repository as 'owner/name'."),
        title: s("Issue title."),
        body: s("Issue body in Markdown."),
        labels: { type: "array", items: { type: "string" }, description: "Label names to apply." },
      },
      required: ["repo", "title"],
    },
    handler: githubCreateIssue,
  },
  {
    name: "github_comment",
    description: "Post a comment on an existing issue or pull request. This is publicly visible on public repos.",
    provider: "github",
    inputSchema: {
      type: "object",
      properties: { repo: s("Repository as 'owner/name'."), issueNumber: n("Issue or PR number."), body: s("Comment body in Markdown.") },
      required: ["repo", "issueNumber", "body"],
    },
    handler: githubComment,
  },
  {
    name: "github_read_file",
    description: "Read a file's contents from a repository at a given branch, tag or commit. Files over 1MB are not supported.",
    provider: "github",
    inputSchema: {
      type: "object",
      properties: {
        repo: s("Repository as 'owner/name'."),
        path: s("Path within the repository, e.g. 'src/index.ts'."),
        ref: s("Branch, tag or commit SHA. Defaults to the repo's default branch."),
      },
      required: ["repo", "path"],
    },
    handler: githubReadFile,
  },

  // ─── Telegram ─────────────────────────────────────────────────────────────
  {
    name: "telegram_send",
    description: "Send a text message to a Telegram chat as the configured bot. The bot must already be in the chat (or the user must have started it).",
    provider: "telegram",
    inputSchema: {
      type: "object",
      properties: {
        chatId: s("Numeric chat id, or '@channelusername' for a public channel."),
        text: s("Message text."),
        replyToMessageId: n("Optional message id to reply to."),
      },
      required: ["chatId", "text"],
    },
    handler: telegramSend,
  },
  {
    name: "telegram_receive",
    description: "Fetch new incoming Telegram messages for the bot via getUpdates. Each update is delivered once per acknowledged offset — pass the returned offset to advance. Does not work if a webhook is registered for the bot.",
    provider: "telegram",
    inputSchema: {
      type: "object",
      properties: {
        limit: n("How many updates to fetch, 1-100. Default 20."),
        offset: n("First update_id to return; use (last update_id + 1) to acknowledge previous ones."),
        timeoutSeconds: n("Long-poll wait, 0-30. Default 0 (return immediately)."),
      },
    },
    handler: telegramReceive,
  },

  // ─── WhatsApp ─────────────────────────────────────────────────────────────
  {
    name: "whatsapp_send",
    description: "Send a WhatsApp text message via the Meta Cloud API. Outside a 24-hour customer service window Meta only allows pre-approved template messages, so free-form sends to cold contacts will be rejected.",
    provider: "whatsapp",
    inputSchema: {
      type: "object",
      properties: {
        to: s("Recipient phone number in international format without '+', e.g. '15551234567'."),
        text: s("Message text."),
        previewUrl: b("Whether to render a link preview. Default false."),
      },
      required: ["to", "text"],
    },
    handler: whatsappSend,
  },
  {
    name: "whatsapp_receive",
    description: "Read inbound WhatsApp messages received by this server's webhook listener. WhatsApp has no polling API, so this only returns messages if the webhook is configured and this process was running when they arrived; reading drains the buffer.",
    provider: "whatsapp",
    inputSchema: { type: "object", properties: { limit: n("How many messages to return, 1-100. Default 20.") } },
    handler: whatsappReceive,
  },
];

function availableTools(): ToolDef[] {
  return TOOLS.filter((t) => providers[t.provider]());
}

async function main() {
  // `--check` prints provider status and exits — useful for verifying credentials without
  // wiring the server into a client first.
  if (process.argv.includes("--check")) {
    const active = availableTools();
    console.log(`mcp-communication\n\n${describeConfig()}\n\n${active.length} of ${TOOLS.length} tools available.`);
    process.exit(0);
  }

  // stdout is the JSON-RPC channel — anything written there that isn't a protocol message
  // corrupts the stream. All diagnostics go to stderr.
  const webhookStatusLine = maybeStartWebhook();
  if (webhookStatusLine) console.error(webhookStatusLine);

  const available = availableTools();
  console.error(`mcp-communication ready — ${available.length}/${TOOLS.length} tools available.`);
  if (available.length === 0) {
    console.error("No providers configured. Set credentials (see README.md) or run with --check for details.");
  }

  const server = new Server({ name: "mcp-communication", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: availableTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);

    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    }
    if (!providers[tool.provider]()) {
      return {
        content: [{ type: "text", text: `Tool "${tool.name}" is unavailable — the ${tool.provider} provider is not configured.\n\n${describeConfig()}` }],
        isError: true,
      };
    }

    try {
      const text = await tool.handler(req.params.arguments ?? {});
      return { content: [{ type: "text", text }] };
    } catch (err) {
      // Errors are returned as tool results rather than thrown: a model can read and act on
      // "your token expired" or "chatId is required", whereas a transport-level failure just
      // looks like the server broke.
      const message = err instanceof ToolError ? [err.message, err.hint].filter(Boolean).join("\n\n") : (err as Error).message;
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopWebhook();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
