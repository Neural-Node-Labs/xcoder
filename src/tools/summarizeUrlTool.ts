import * as cheerio from "cheerio";

export interface UrlSummary {
  url: string;
  title: string;
  summary: string;
  wordCount: number;
  contentType: string;
}

/**
 * Fetches a URL, extracts its readable content (title, meta description, headings, paragraphs),
 * and returns a structured summary object.
 *
 * This tool is designed for the AI agent to read and summarize web pages — blog posts,
 * documentation, news articles, etc. It strips navigation, scripts, and styling to focus
 * on the meaningful text content.
 */
export async function summarizeUrl(url: string): Promise<UrlSummary> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; xcoder-summarizer/1.0; +https://github.com/neural-node-labs/xcoder)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml")
  ) {
    throw new Error(
      `URL ${url} returned Content-Type "${contentType}" — expected HTML. Only HTML pages can be summarized.`
    );
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Remove non-content elements
  $("script, style, nav, footer, header, aside, iframe, noscript, svg, form, button, input").remove();

  const title =
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    "(no title)";

  // Meta description
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() || "";

  // Extract headings (h1-h3) as a table of contents
  const headings: string[] = [];
  $("h1, h2, h3").each((_, el) => {
    const text = $(el).text().trim();
    if (text) headings.push(text);
  });

  // Extract paragraphs with meaningful content
  const paragraphs: string[] = [];
  $("p, li, blockquote, td, th, .content p, article p, main p").each((_, el) => {
    const text = $(el).text().trim();
    // Skip very short fragments and boilerplate
    if (text.length > 40) paragraphs.push(text);
  });

  // Also grab any article or main content block as a fallback
  let mainContent = "";
  $("article, main, .post-content, .entry-content, .article-body, [role='main']").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > mainContent.length) mainContent = text;
  });

  // Build the readable text — deduplicate and limit to avoid token blowup
  const allText = [
    ...(metaDescription ? [`Meta: ${metaDescription}`] : []),
    ...headings.map((h) => `## ${h}`),
    ...paragraphs,
    ...(mainContent && paragraphs.length < 5 ? [mainContent.slice(0, 3000)] : []),
  ].join("\n\n");

  // Truncate to ~4000 chars to keep LLM calls reasonable
  const truncated = allText.slice(0, 4000);
  const wordCount = truncated.split(/\s+/).length;

  // Generate a concise summary using the extracted content
  const summary = generateSummary(title, truncated);

  return {
    url,
    title,
    summary,
    wordCount,
    contentType,
  };
}

/**
 * Generates a concise, readable summary from the extracted page content.
 * This is a rule-based extractive summarizer — no LLM call needed.
 */
function generateSummary(title: string, content: string): string {
  const lines = content.split("\n\n").filter(Boolean);
  const headingLines = lines.filter((l) => l.startsWith("## "));
  const bodyLines = lines.filter((l) => !l.startsWith("## ") && !l.startsWith("Meta:"));

  // Build a structured summary
  const parts: string[] = [];

  parts.push(`# ${title}`);

  // Meta description
  const metaLine = lines.find((l) => l.startsWith("Meta:"));
  if (metaLine) {
    parts.push(`\n**Description:** ${metaLine.replace("Meta: ", "")}`);
  }

  // Section headings as outline
  if (headingLines.length > 0) {
    parts.push("\n**Page Structure:**");
    headingLines.slice(0, 15).forEach((h) => parts.push(`- ${h.replace("## ", "")}`));
  }

  // Key content — first few substantial paragraphs
  if (bodyLines.length > 0) {
    parts.push("\n**Key Content:**");
    const keyPoints = bodyLines.slice(0, 8);
    keyPoints.forEach((p) => {
      // Truncate very long paragraphs
      const trimmed = p.length > 500 ? p.slice(0, 500) + "..." : p;
      parts.push(`> ${trimmed}`);
    });
  }

  // Stats
  const totalWords = content.split(/\s+/).length;
  parts.push(`\n---\n*Extracted ${totalWords} words from the page.*`);

  return parts.join("\n\n");
}

