/**
 * Accumulated Total Calculator (Kalkulator ng Naipong Kabuuan)
 *
 * Kinakalkula ang tumatakbong naipong kabuuan ng token usage sa iba't ibang run.
 * Tumatanggap ng na-parse na bilang ng token (mula sa parseTokenCounts) at isang
 * naunang naipong kabuuan, pagkatapos ay ibinabalik ang bagong naipong kabuuan.
 *
 * Kung walang ibinigay na naunang naipong kabuuan (undefined/null), ini-initialize
 * ito sa 0 bago idagdag ang kabuuan ng kasalukuyang run.
 *
 * Ang resulta ay ibinabalik bilang parehong numero at bilang isang locale-formatted
 * na string na may mga kuwit (hal. "3,873").
 */

export interface AccumulatedTotalResult {
  /** Ang naunang naipong kabuuan bago ang run na ito (0 kung wala). */
  priorTotal: number;
  /** Ang kabuuang bilang ng token ng kasalukuyang run. */
  currentRunTotal: number;
  /** Ang bagong naipong kabuuan pagkatapos idagdag ang kasalukuyang run. */
  newTotal: number;
  /** Ang bagong naipong kabuuan na naka-format na may mga kuwit (hal. "3,873"). */
  formatted: string;
}

/**
 * Kinakalkula ang bagong naipong kabuuan batay sa bilang ng token ng kasalukuyang run
 * at isang opsyonal na naunang naipong kabuuan.
 *
 * @param currentRunTotal - Ang kabuuang bilang ng token para sa kasalukuyang run.
 * @param priorAccumulatedTotal - Ang naipong kabuuan mula sa mga naunang run (default 0).
 * @returns AccumulatedTotalResult na may bagong kabuuan at ang naka-format na string nito.
 */
export function computeAccumulatedTotal(
  currentRunTotal: number,
  priorAccumulatedTotal?: number
): AccumulatedTotalResult {
  const priorTotal = priorAccumulatedTotal ?? 0;
  const newTotal = priorTotal + currentRunTotal;

  return {
    priorTotal,
    currentRunTotal,
    newTotal,
    formatted: newTotal.toLocaleString("en-US"),
  };
}
