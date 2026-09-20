# mcp-communication

An MCP server exposing **Gmail, Google Drive, Google Calendar, GitHub, Telegram and WhatsApp**
as tools over stdio. 19 tools total.

Works with any MCP client (Claude Desktop, xcoder's own `mcp_tool`, etc.). Every provider is
optional — tools for unconfigured providers are never listed, so you can run this with only
Telegram set up and the rest simply won't appear.

```bash
npm install && npm run build
node dist/index.js --check     # print which providers are configured, then exit
```

## Tools

| Provider | Tools |
|---|---|
| Gmail | `gmail_list`, `gmail_read`, `gmail_send` |
| Drive | `drive_search`, `drive_read`, `drive_upload` |
| Calendar | `calendar_list_events`, `calendar_create_event`, `calendar_delete_event` |
| GitHub | `github_search_repos`, `github_list_issues`, `github_get_issue`, `github_create_issue`, `github_comment`, `github_read_file` |
| Telegram | `telegram_send`, `telegram_receive` |
| WhatsApp | `whatsapp_send`, `whatsapp_receive` |

## Configuration

All credentials come from environment variables. **Credentials are never accepted as tool
arguments** — tool arguments are chosen by a model, and a model that can be talked into passing
an attacker-supplied token is a credential-exfiltration path. Keeping auth out of the tool
surface removes that entirely.

### Google (Gmail + Drive + Calendar — one credential set, three APIs)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and **enable
   the Gmail API, Google Drive API, and Google Calendar API** (each separately).
2. Configure the OAuth consent screen, then create an **OAuth client ID** of type *Desktop app*.
3. Grant these scopes during consent — only the ones for what you actually want used:
   - `https://www.googleapis.com/auth/gmail.readonly` (for `gmail_list` / `gmail_read`)
   - `https://www.googleapis.com/auth/gmail.send` (for `gmail_send`)
   - `https://www.googleapis.com/auth/drive` (or `drive.readonly` if you skip `drive_upload`)
   - `https://www.googleapis.com/auth/calendar`
4. Complete the consent flow once to obtain a **refresh token**. [Google's OAuth
   Playground](https://developers.google.com/oauthplayground/) is the quickest way: set your own
   client id/secret in its settings, authorize the scopes, exchange for tokens.

```bash
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

### GitHub

Create a token at <https://github.com/settings/tokens>. Grant the narrowest scope that covers
what you want — this token is exposed to a model-driven tool surface.

- Classic: `repo` for private repos, or `public_repo` if you only touch public ones.
- Fine-grained: Contents=Read, Issues=Read+Write, Metadata=Read.

```bash
GITHUB_TOKEN=ghp_...
```

### Telegram

Message [@BotFather](https://t.me/botfather), create a bot, copy the token.

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-...
```

Receiving works out of the box via `getUpdates` long-polling — no webhook, no public URL. Two
caveats: each update is delivered once per acknowledged offset (pass the `offset` the tool
returns to advance), and `getUpdates` **does not work at all** while a webhook is registered for
the same bot.

### WhatsApp (Meta Cloud API)

1. Create a Meta for Developers app with the **WhatsApp** product added.
2. Copy the **phone number ID** and an access token — prefer a permanent System User token over
   the 24-hour temporary one.

```bash
WHATSAPP_TOKEN=EAA...
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_API_VERSION=v21.0        # optional, defaults to v21.0
```

Note that outside a 24-hour customer service window, Meta only permits **pre-approved template
messages** — a free-form `whatsapp_send` to someone who hasn't messaged you recently will be
rejected by Meta even though the call itself is well-formed.

#### Receiving WhatsApp messages

WhatsApp's Cloud API has **no polling endpoint**. Inbound messages arrive only by Meta POSTing
to a public HTTPS webhook you host. This is a platform constraint, not a gap in this server.

To make `whatsapp_receive` return anything:

```bash
WHATSAPP_WEBHOOK_PORT=8787
WHATSAPP_VERIFY_TOKEN=some-string-you-choose   # must match the Meta dashboard
WHATSAPP_APP_SECRET=...                        # strongly recommended — see below
```

Then run this server as a **long-lived process**, expose that port publicly over HTTPS (a tunnel
is fine for testing), and register the URL in the Meta app dashboard under WhatsApp → Configuration.

Three things to understand before relying on this:

- **Set `WHATSAPP_APP_SECRET`.** Without it, incoming payloads aren't signature-verified, so
  anyone who discovers your webhook URL can inject arbitrary "messages" that a model will then
  read and act on — a direct prompt-injection channel. The server warns on startup if it's unset.
- **Messages are buffered in memory and lost on exit.** There's no database here deliberately;
  persisting other people's messages to disk is a data-handling decision that belongs to whoever
  deploys this, not to a default. Reading also *drains* the buffer.
- **A client that spawns a fresh process per tool call cannot receive at all** — the buffer dies
  with the process. This includes xcoder's own `mcp_tool` (see below). Telegram doesn't have this
  problem because it polls.

## Using it from a client

### Claude Desktop

```json
{
  "mcpServers": {
    "communication": {
      "command": "node",
      "args": ["/absolute/path/to/integrations/mcp-communication/dist/index.js"],
      "env": { "GITHUB_TOKEN": "ghp_...", "TELEGRAM_BOT_TOKEN": "123456:ABC-..." }
    }
  }
}
```

### xcoder

xcoder's `mcp_tool` spawns a stdio server per call, so it works with no extra wiring:

```json
{ "action": "list", "command": "node", "args": ["integrations/mcp-communication/dist/index.js"] }
```

Credentials come from the xcoder server process's own environment. Because each call is a fresh
process, `whatsapp_receive` will never return buffered messages under this client — everything
else works normally.

## Design notes

- **One dependency** (`@modelcontextprotocol/sdk`). All six providers are plain REST calls rather
  than `googleapis`/`octokit`/etc. — a smaller dependency surface matters for something holding
  this many live credentials.
- **Errors come back as tool results, not transport failures.** A model can read and act on
  "your token expired" or "repo must be in owner/name form"; a thrown transport error just looks
  like the server broke.
- **Long results are truncated** (~8000 chars) so one tool call can't flood a model's context.
- **Bot tokens are redacted from error messages** — Telegram puts the token in the URL path, so
  an unredacted error would leak it into logs.

## Status

Verified: typechecks and builds clean; MCP handshake negotiates protocol `2024-11-05`; all 19
tools list correctly; provider gating hides unconfigured tools and refuses calls to them;
argument validation and live API error paths both return readable results (confirmed against the
real GitHub API with an invalid token).

**Not verified:** no tool has been run against a real authenticated account for any provider —
there are no live credentials in the environment this was built in. The request/response shapes
follow each provider's documented API, but first contact with a real account is where
scope/permission mismatches and response-shape surprises typically show up. Run
`node dist/index.js --check` first, then exercise one read-only tool per provider (`gmail_list`,
`drive_search`, `calendar_list_events`, `github_list_issues`, `telegram_receive`) before trusting
the write-side ones.
