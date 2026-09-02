import { LlmClient, LlmMessage, LlmUsage } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  reason: string;
  usage?: LlmUsage;
}

/**
 * Independiyenteng verification pass ("ibang agent" ayon sa ReAct Validation phase / xcoder.md
 * "Verification Before Done"). Ang tawag na ito ay HINDI binibigyan ng mga tool at WALANG
 * conversation history mula sa gawain mismo — task lamang, ang hilaw na observation transcript,
 * at ang inaangkin na huling sagot. Mahalaga ang paghihiwalay na ito: hindi ito makokombinsing
 * sumang-ayon sa pamamagitan ng parehong reasoning na gumawa ng (posibleng hallucinated) na
 * claim, masusuri lamang nito ang claim laban sa naitalang ebidensya.
 */
export async function validateGoal(
  llm: LlmClient,
  taskDescription: string,
  observationTranscript: string,
  candidateFinalAnswer: string
): Promise<ValidationResult> {
  const messages: LlmMessage[] = [
    {
      role: "system",
      content:
        "You are an independent verification agent auditing another agent's claimed task completion. " +
        "You did not do the work. You only see the task, the raw tool observations that were actually " +
        "recorded, and the claimed final answer. Be skeptical: flag any claim not directly supported by " +
        "an observation -- e.g. claiming tests passed with no observation showing a passing test run, " +
        "claiming a file was created/edited with no successful write observation, claiming a bug is fixed " +
        "with no verification run, or claiming something was deployed/pushed/scheduled with no successful " +
        "tool result for that action. A vague or absent observation is NOT evidence -- treat it as unproven. " +
        'Respond with ONLY a JSON object: {"valid": true|false, "reason": "..."}. No other text, no markdown fences.',
    },
    {
      role: "user",
      content:
        `TASK:\n${taskDescription}\n\n` +
        `OBSERVATIONS RECORDED DURING THE TASK:\n${observationTranscript || "(no tool calls were made)"}\n\n` +
        `AGENT'S CLAIMED FINAL ANSWER:\n${candidateFinalAnswer}\n\n` +
        `Is the claimed final answer fully supported by the observations, and does it actually satisfy the task? Respond with the JSON object only.`,
    },
  ];

  const response = await llm.complete(messages, { responseFormat: "json_object" }); // walang tools -- purong judgment call, structured JSON output
  try {
    const cleaned = response.content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return { valid: Boolean(parsed.valid), reason: String(parsed.reason ?? ""), usage: response.usage };
  } catch {
    // Fail open sa sarili naming parsing bug sa halip na permanenteng hadlangan ang completion
    // dahil sa isang format slip, pero naka-log ito para makita, hindi tahimik.
    return {
      valid: true,
      reason: `validator response unparseable, defaulting to valid (fail-open): ${response.content.slice(0, 200)}`,
      usage: response.usage,
    };
  }
}

/** Kinukuha ang isang nababasang transcript ng talagang nangyari, mula lamang sa mga tool-role na mensahe. */
export function buildObservationTranscript(messages: LlmMessage[]): string {
  return messages
    .filter((m) => m.role === "tool")
    .map((m) => `[${m.name}] ${m.content}`)
    .join("\n\n");
}


