import { LlmMessage } from "./types.js";

/**
 * Context compaction (lean-token mode) — enabled by default. Set
 * OrchestratorOptions.fullContextToken to true to keep the full history instead.
 *
 * What this does NOT touch, and why:
 *   - `reasoning_content` on any assistant message stays exactly as returned by the model, for
 *     the entire run. DeepSeek's thinking-mode API requires that once a tool call happens, the
 *     reasoning_content tied to it must be passed back unchanged on every subsequent request in
 *     that same run, or the API rejects the request outright
 *     (see https://api-docs.deepseek.com/guides/thinking_mode/). This isn't a token-savings
 *     knob — trimming it breaks the conversation.
 *   - tool_call_id linkage is never broken: every tool-role message keeps referencing a real
 *     preceding assistant tool_calls entry (same id, same function.name), which the API
 *     requires structurally. Only the *arguments* string of a stale call gets replaced.
 *
 * What this DOES touch, for read_tool and write_edit_tool:
 *   - The `content` string of tool-role (Observation) messages. That's where the bloat lives
 *     for read_tool — it returns a file's full contents, and on a task that touches the same
 *     file across several iterations (read -> edit -> re-read -> edit again...), every earlier
 *     snapshot stays in context by default, each one a full copy of a file that's since changed.
 *   - For write_edit_tool specifically, ALSO the stale call's own `function.arguments` on the
 *     assistant message that issued it. This matters because write_edit_tool's Observation is
 *     already small (just `{file, bytesWritten}`) — the actual bloat for a write is the
 *     `content`/`newStr` argument the model had to generate to perform the write in the first
 *     place, which lives on the *assistant* message, not the tool-role Observation. Without
 *     this, writing N files of S bytes each leaves N*S bytes of raw file content sitting in
 *     history forever regardless of read-side compaction, which is what actually blew a real
 *     session's context past DeepSeek's 1,048,565-token limit (see conversation notes,
 *     2026-07-25). filePath (and mode, for edit calls) are preserved in the placeholder so the
 *     model can still see *what* it wrote, just not the full historical payload.
 *   - Whenever a file at `filePath` is read or written again, every STRICTLY EARLIER read_tool
 *     or write_edit_tool call for that same path is collapsed. The latest snapshot of any given
 *     file is always left intact and readable — only stale, superseded copies are compacted.
 *     This also fixes a correctness footgun, not just a cost one: without this, an old stale
 *     full-file read/write technically stays in context looking just as authoritative as the
 *     current one, which the model has no built-in way to tell apart from the real state.
 */

export const STALE_READ_MARKER = "[stale file snapshot omitted — lean token mode]";
export const STALE_WRITE_ARGS_MARKER = "[stale write payload omitted — lean token mode]";

const COMPACTABLE_TOOLS = new Set(["read_tool", "write_edit_tool"]);

/**
 * Call after pushing a new tool-role message for a read_tool or write_edit_tool call.
 * `filePath` is the path that was just read/written; `currentToolCallId` is that call's id
 * (never compacted, since it's the fresh snapshot we want to keep).
 */
export function compactStaleFileReads(
  messages: LlmMessage[],
  filePath: string,
  currentToolCallId: string
): void {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.tool_calls) continue;

    for (const call of msg.tool_calls) {
      if (!COMPACTABLE_TOOLS.has(call.function.name)) continue;
      if (call.id === currentToolCallId) continue;

      const args = safeParseArgs(call.function.arguments);
      if (!args || args.filePath !== filePath) continue;

      // Compact the Observation (tool-role message) — the main bloat source for read_tool.
      const toolMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === call.id);
      if (toolMsg && !toolMsg.content.includes(STALE_READ_MARKER)) {
        toolMsg.content = JSON.stringify({
          content: `${STALE_READ_MARKER}: "${filePath}" was read or modified again after this point — see the latest Observation of this file for its current contents.`,
        });
      }

      // Compact the Action's own arguments — the main bloat source for write_edit_tool, where
      // the full file content the model generated lives on the assistant message itself, not
      // the (small) Observation.
      if (call.function.name === "write_edit_tool" && !call.function.arguments.includes(STALE_WRITE_ARGS_MARKER)) {
        call.function.arguments = JSON.stringify({
          filePath,
          mode: args.mode,
          _omitted: `${STALE_WRITE_ARGS_MARKER}: original content/newStr payload dropped — "${filePath}" was written again after this point.`,
        });
      }
    }
  }
}

function safeParseArgs(json: string): { filePath?: string; mode?: string } | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

