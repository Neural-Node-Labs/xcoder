import { LlmResponse, ToolCall } from "./types.js";

/**
 * Nadedetect ang PM-2026-07-25-001 ("Silent File Truncation in write_edit_tool") bago ito
 * mangyari, sa halip na pagkatapos.
 *
 * Root cause ayon sa postmortem na iyon: naputol ang completion ng LLM dahil sa max_tokens
 * budget habang bumubuo ng isang malaking `content`/`newStr` na argumento para sa
 * write_edit_tool, at ang naputol na value ay naisulat sa disk nang walang babala. Ang
 * sarili nitong pagsisiyasat ng postmortem ay nakapag-infer lamang nang hindi direkta (mga
 * byte-size boundary na katakut-takot na tumugma sa isang 4096-token budget) dahil walang
 * anumang bagay sa pipeline ang sumuri sa tanging signal na talagang tuwirang nagsasabi
 * nito: ang sariling `finish_reason` field ng API. Ang mga OpenAI-compatible na API
 * (kasama ang DeepSeek) ay nagbabalik ng `finish_reason: "length"` na partikular na
 * nangangahulugang "tumigil ito dahil sa max_tokens, hindi dahil natapos na ang model."
 * Ang katumbas ng Anthropic (`stop_reason: "max_tokens"`) ay na-normalize sa parehong
 * "length" na value sa loob ng callAnthropic ng deepseekClient.ts.
 *
 * Mga tool na maaaring lehitimong sapat kalaki ang mga argumento para maabot ito. Ang mga
 * read-only/small-argument na tool (read_tool, grep_tool, run_command_tool, ...) ay hindi
 * nasa panganib dito — maliit ang mga argumento ng mga ito anuman ang laki ng file, kaya't
 * ang isang "length" finish sa mga turn na iyon ay hindi nagpapahiwatig ng naputol na tool output.
 */
const LARGE_PAYLOAD_TOOLS = new Set(["write_edit_tool"]);

export interface TruncationCheckResult {
  /** Mga tool call mula sa tugon na ito na ligtas i-dispatch nang normal. */
  safeCalls: ToolCall[];
  /** Mga tool call na pinigil dahil malamang na naputol ang mga argumento nito habang binubuo. */
  blockedCalls: ToolCall[];
}

/**
 * Hinahati ang tool_calls ng isang response sa mga ligtas i-dispatch at mga dapat pigilin dahil
 * bumagsak ang `finish_reason === "length"` sa isang turn na naglalaman ng large-payload na
 * tool call. Tawagin ito kaagad pagkatapos matanggap ang isang response at bago i-dispatch ang
 * alinman sa mga tool_calls nito.
 */
export function checkForTruncatedToolCalls(response: LlmResponse): TruncationCheckResult {
  if (response.finishReason !== "length") {
    return { safeCalls: response.toolCalls, blockedCalls: [] };
  }

  const safeCalls: ToolCall[] = [];
  const blockedCalls: ToolCall[] = [];
  for (const call of response.toolCalls) {
    (LARGE_PAYLOAD_TOOLS.has(call.function.name) ? blockedCalls : safeCalls).push(call);
  }
  return { safeCalls, blockedCalls };
}

/** Observation text na ibinabalik para sa isang pinigilang tawag, para makapag-retry nang
 *  produktibo ang ReAct loop sa halip na tahimik na maabot ng naputol na content ang disk. */
export function truncationWarningFor(call: ToolCall): string {
  return JSON.stringify({
    error: true,
    truncated: true,
    message:
      `This ${call.function.name} call was withheld: the response that generated it was cut off ` +
      `by the completion token limit (finish_reason: "length") while still generating the ` +
      `content/newStr argument, so it is very likely incomplete mid-file. Writing it would ` +
      `silently truncate the file (see incident PM-2026-07-25-001). ` +
      `Break this write into smaller pieces -- e.g. multiple write_edit_tool calls with ` +
      `mode='edit' to append each section -- and try again with less content per call.`,
  });
}
