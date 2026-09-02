/**
 * Token Count Parser (Parser ng Bilang ng Token)
 *
 * Nagpa-parse ng isang token usage string (hal. mula sa output ng DeepSeek) papunta sa
 * isang structured object na may input, output, cached, at total na bilang ng token.
 * Vine-validate na ang na-parse na total ay tumutugma sa kabuuan ng input + output + cached,
 * na minamarkahan ang anumang discrepancy.
 *
 * Inaasahang format ng input:
 *   "3,592 in · 281 out · 2,944 cached — 3,873 total this run"
 *
 * Maluwag ang parser tungkol sa whitespace, comma formatting, at ang eksaktong
 * pananalita sa paligid ng mga numero — kinukuha nito ang unang apat na comma-formatted
 * na integer na natatagpuan nito ayon sa pagkakasunod: input, output, cached, total.
 */

export interface ParsedTokenCounts {
  /** Bilang ng input (prompt) na token. */
  input: number;
  /** Bilang ng output (completion) na token. */
  output: number;
  /** Bilang ng cached (context cache) na token. */
  cached: number;
  /** Kabuuang bilang ng token na iniulat sa string. */
  total: number;
  /** Kung tumutugma ang na-parse na total sa input + output + cached. */
  discrepancy: boolean;
  /** Ang inaasahang total kung isasama ang input + output + cached. */
  expectedTotal: number;
}

/**
 * Nagpa-parse ng isang token usage string papunta sa structured na bilang.
 *
 * Kinukuha ang unang apat na comma-formatted na integer mula sa input string,
 * na isinasalin ang mga ito bilang input, output, cached, at total ayon sa pagkakasunod.
 * Vine-validate na ang total === input + output + cached at itinatakda ang discrepancy
 * flag alinsunod dito.
 *
 * @param input - Ang hilaw na token usage string (hal. "3,592 in · 281 out · 2,944 cached — 3,873 total this run")
 * @returns ParsedTokenCounts na may lahat ng field na napunuan
 * @throws {Error} Kung mas kaunti sa 4 na numero ang makukuha mula sa string
 */
export function parseTokenCounts(input: string): ParsedTokenCounts {
  // Kunin ang lahat ng comma-formatted o plain na integer mula sa string
  // Tumutugma sa mga numerong tulad ng 3592, 3,592, 2,944, atbp.
  const numberPattern = /\b\d{1,3}(?:,\d{3})*\b|\b\d+\b/g;
  const matches = input.match(numberPattern);

  if (!matches || matches.length < 4) {
    throw new Error(
      `Unable to parse token counts from "${input}": expected at least 4 numbers, found ${matches?.length ?? 0}`
    );
  }

  // Alisin ang mga kuwit at i-parse bilang mga integer
  const numbers = matches.map((m) => parseInt(m.replace(/,/g, ""), 10));

  const [parsedInput, parsedOutput, parsedCached, parsedTotal] = numbers;

  const expectedTotal = parsedInput + parsedOutput + parsedCached;
  const discrepancy = parsedTotal !== expectedTotal;

  return {
    input: parsedInput,
    output: parsedOutput,
    cached: parsedCached,
    total: parsedTotal,
    discrepancy,
    expectedTotal,
  };
}
