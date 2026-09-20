import * as cheerio from "cheerio";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; xcoder-websearch/1.0; +https://github.com/neural-node-labs/xcoder)";

/**
 * Real web search via DuckDuckGo's HTML results endpoint (html.duckduckgo.com/html/) — no API
 * key required. This is the same endpoint DuckDuckGo's own "lite"/no-JS search page uses, and
 * what most key-free DuckDuckGo search integrations scrape (DuckDuckGo's official Instant
 * Answer API at api.duckduckgo.com only returns knowledge-panel-style "instant answers" for a
 * narrow set of queries, not general organic results, so it isn't a substitute for this).
 *
 * DuckDuckGo wraps every result link in a redirect (`//duckduckgo.com/l/?uddg=<encoded-url>`)
 * for click tracking — decodeResultUrl() below unwraps that back to the real destination so the
 * agent gets an actual fetchable URL, not a redirect stub.
 */
export async function webSearch(query: string, limit = 8): Promise<WebSearchResult[]> {
  if (!query || !query.trim()) {
    throw new Error("web_search_tool: 'query' must not be empty.");
  }
  const cappedLimit = Math.max(1, Math.min(limit, 20));

  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`web_search_tool: DuckDuckGo returned HTTP ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // DuckDuckGo occasionally serves an anomaly/CAPTCHA challenge page instead of results
  // (typically from flagged/high-volume IPs) — surface that plainly rather than silently
  // returning zero results, which would look like "no matches" instead of "search was blocked".
  if ($(".result").length === 0 && /anomal|unusual traffic|captcha/i.test($("body").text())) {
    throw new Error(
      "web_search_tool: DuckDuckGo served a bot-check/anomaly page instead of results. This can happen with heavy request volume from one IP — try again shortly, or space out searches."
    );
  }

  const results: WebSearchResult[] = [];
  $(".result").each((_, el) => {
    if (results.length >= cappedLimit) return;

    const linkEl = $(el).find(".result__a").first();
    const title = linkEl.text().trim();
    const rawHref = linkEl.attr("href");
    if (!title || !rawHref) return;

    const url = decodeResultUrl(rawHref);
    if (!url) return;

    const snippet = $(el).find(".result__snippet").first().text().trim();

    results.push({ title, url, snippet });
  });

  return results;
}

/** Unwraps DuckDuckGo's click-tracking redirect (`//duckduckgo.com/l/?uddg=<encoded>&rut=...`)
 *  back to the real destination URL. Falls back to the raw href as-is if it's already a plain
 *  URL (DuckDuckGo doesn't always wrap every result the same way). */
function decodeResultUrl(href: string): string | null {
  try {
    const full = href.startsWith("//") ? `https:${href}` : href;
    const parsed = new URL(full, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (parsed.hostname && parsed.hostname !== "duckduckgo.com") return parsed.toString();
    return null; // an unwrapped duckduckgo.com internal link (ad slot, etc.) — not a real result
  } catch {
    return null;
  }
}
