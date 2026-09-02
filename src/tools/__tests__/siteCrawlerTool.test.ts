/**
 * Regression suite for siteCrawlerTool.ts's BFS crawl logic — exercised directly (not just
 * through the dispatcher's single-page smoke test) with a mocked global `fetch` that serves
 * a small multi-page fake site, so maxPages/maxDepth/sameDomain/dedup/link-filtering behavior
 * is actually verified rather than assumed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { crawlSiteMap, formatSiteMap, SiteMap } from "../siteCrawlerTool.js";

function htmlPage(title: string, links: string[], extraBody = ""): string {
  const anchors = links.map((l) => `<a href="${l}">link</a>`).join("\n");
  return `<html><head><title>${title}</title></head><body>${anchors}${extraBody}</body></html>`;
}

function mockResponse(opts: { ok?: boolean; status?: number; contentType?: string; body?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? opts.contentType ?? "text/html" : null) },
    text: async () => opts.body ?? "",
  };
}

/** Builds a fetch mock backed by a simple url -> response map, with a fallback 404. */
function fakeSite(pages: Record<string, ReturnType<typeof mockResponse>>) {
  return vi.fn(async (url: string) => {
    if (pages[url]) return pages[url];
    return mockResponse({ ok: false, status: 404, body: "" });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("crawlSiteMap — BFS traversal", () => {
  it("follows internal links across multiple pages and builds the graph/parent maps", async () => {
    const site = fakeSite({
      "https://example.com/": mockResponse({ body: htmlPage("Home", ["/about", "/contact"]) }),
      "https://example.com/about": mockResponse({ body: htmlPage("About", ["/"]) }),
      "https://example.com/contact": mockResponse({ body: htmlPage("Contact", []) }),
    });
    vi.stubGlobal("fetch", site);

    const map = await crawlSiteMap("https://example.com/");
    expect(map.totalPages).toBe(3);
    expect(map.pages.map((p) => p.url).sort()).toEqual([
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/contact",
    ]);
    // Home links to about+contact
    expect(map.graph["https://example.com/"].sort()).toEqual([
      "https://example.com/about",
      "https://example.com/contact",
    ]);
    // Parent of about/contact is the root (first discovered)
    expect(map.parent["https://example.com/about"]).toBe("https://example.com/");
    expect(map.parent["https://example.com/contact"]).toBe("https://example.com/");
    // Home was never enqueued as a "child" of about, since it was already visited (dedup)
    expect(map.parent["https://example.com/"]).toBeUndefined();
  });

  it("respects maxPages and stops early even if more links remain undiscovered", async () => {
    const site = fakeSite({
      "https://example.com/": mockResponse({ body: htmlPage("Home", ["/p1", "/p2", "/p3"]) }),
      "https://example.com/p1": mockResponse({ body: htmlPage("P1", []) }),
      "https://example.com/p2": mockResponse({ body: htmlPage("P2", []) }),
      "https://example.com/p3": mockResponse({ body: htmlPage("P3", []) }),
    });
    vi.stubGlobal("fetch", site);

    const map = await crawlSiteMap("https://example.com/", { maxPages: 2 });
    expect(map.totalPages).toBe(2);
  });

  it("respects maxDepth and does not enqueue pages beyond it", async () => {
    const site = fakeSite({
      "https://example.com/": mockResponse({ body: htmlPage("Home", ["/l1"]) }),
      "https://example.com/l1": mockResponse({ body: htmlPage("L1", ["/l2"]) }),
      "https://example.com/l2": mockResponse({ body: htmlPage("L2", ["/l3"]) }),
      "https://example.com/l3": mockResponse({ body: htmlPage("L3", []) }),
    });
    vi.stubGlobal("fetch", site);

    // depth 0 = root, depth 1 = l1; maxDepth:1 should visit root + l1 but not l2.
    const map = await crawlSiteMap("https://example.com/", { maxDepth: 1 });
    expect(map.pages.map((p) => p.url).sort()).toEqual(["https://example.com/", "https://example.com/l1"]);
  });

  it("excludes external-domain links when sameDomain is true (default)", async () => {
    const site = fakeSite({
      "https://example.com/": mockResponse({ body: htmlPage("Home", ["/internal", "https://other.com/external"]) }),
      "https://example.com/internal": mockResponse({ body: htmlPage("Internal", []) }),
    });
    vi.stubGlobal("fetch", site);

    const map = await crawlSiteMap("https://example.com/");
    expect(map.pages.map((p) => p.url)).not.toContain("https://other.com/external");
    expect(map.graph["https://example.com/"]).toEqual(["https://example.com/internal"]);
  });

  it("includes external-domain links when sameDomain is false", async () => {
    const site = fakeSite({
      "https://example.com/": mockResponse({ body: htmlPage("Home", ["https://other.com/external"]) }),
      "https://other.com/external": mockResponse({ body: htmlPage("External", []) }),
    });
    vi.stubGlobal("fetch", site);

    const map = await crawlSiteMap("https://example.com/", { sameDomain: false });
    expect(map.pages.map((p) => p.url)).toContain("https://other.com/external");
  });

  it("filters out mailto:, tel:, and javascript: links", async () => {
    const site = fakeSite({
      "https://example.com/": mockResponse({
        body: htmlPage("Home", ["mailto:a@example.com", "tel:+15551234567", "javascript:void(0)", "/real"]),
      }),
      "https://example.com/real": mockResponse({ body: htmlPage("Real", []) }),
    });
    vi.stubGlobal("fetch", site);

    const map = await crawlSiteMap("https://example.com/");
    expect(map.graph["https://example.com/"]).toEqual(["https://example.com/real"]);
    expect(map.totalPages).toBe(2);
  });

  it("deduplicates repeated links found on the same page", async () => {
    const site = fakeSite({
      "https://example.com/": mockResponse({ body: htmlPage("Home", ["/dup", "/dup", "/dup"]) }),
      "https://example.com/dup": mockResponse({ body: htmlPage("Dup", []) }),
    });
    vi.stubGlobal("fetch", site);

    const map = await crawlSiteMap("https://example.com/");
    expect(map.graph["https://example.com/"]).toEqual(["https://example.com/dup"]);
  });

  it("normalizes URLs with trailing slashes so they aren't crawled twice", async () => {
    const site = fakeSite({
      "https://example.com/": mockResponse({ body: htmlPage("Home", ["/about/"]) }),
      "https://example.com/about": mockResponse({ body: htmlPage("About", ["/"]) }),
    });
    vi.stubGlobal("fetch", site);

    const map = await crawlSiteMap("https://example.com/");
    expect(map.totalPages).toBe(2);
    expect(map.pages.map((p) => p.url)).toContain("https://example.com/about");
  });

  it("records an HTTP error page with its status but does not follow links from it (none to follow)", async () => {
    const site = fakeSite({
      "https://example.com/": mockResponse({ body: htmlPage("Home", ["/broken"]) }),
      "https://example.com/broken": mockResponse({ ok: false, status: 500 }),
    });
    vi.stubGlobal("fetch", site);

    const map = await crawlSiteMap("https://example.com/");
    const broken = map.pages.find((p) => p.url === "https://example.com/broken");
    expect(broken).toBeDefined();
    expect(broken!.status).toBe(500);
    expect(broken!.links).toEqual([]);
  });

  it("skips non-HTML resources instead of counting them as pages", async () => {
    const site = fakeSite({
      "https://example.com/": mockResponse({ body: htmlPage("Home", ["/doc.pdf"]) }),
      "https://example.com/doc.pdf": mockResponse({ contentType: "application/pdf", body: "%PDF-1.4..." }),
    });
    vi.stubGlobal("fetch", site);

    const map = await crawlSiteMap("https://example.com/");
    expect(map.totalPages).toBe(1);
    expect(map.pages.map((p) => p.url)).not.toContain("https://example.com/doc.pdf");
  });

  it("continues the crawl when an individual page's fetch throws (e.g. network error)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://example.com/") return mockResponse({ body: htmlPage("Home", ["/flaky", "/ok"]) });
      if (url === "https://example.com/flaky") throw new Error("network blip");
      if (url === "https://example.com/ok") return mockResponse({ body: htmlPage("OK", []) });
      return mockResponse({ ok: false, status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const map = await crawlSiteMap("https://example.com/");
    expect(map.pages.map((p) => p.url)).toContain("https://example.com/ok");
    expect(map.pages.map((p) => p.url)).not.toContain("https://example.com/flaky");
    errSpy.mockRestore();
  });

  it("computes maxDepth in the result as the deepest page actually visited", async () => {
    const site = fakeSite({
      "https://example.com/": mockResponse({ body: htmlPage("Home", ["/l1"]) }),
      "https://example.com/l1": mockResponse({ body: htmlPage("L1", []) }),
    });
    vi.stubGlobal("fetch", site);

    const map = await crawlSiteMap("https://example.com/");
    expect(map.maxDepth).toBe(1);
  });
});

describe("formatSiteMap", () => {
  function fakeMap(): SiteMap {
    return {
      rootUrl: "https://example.com/",
      totalPages: 2,
      maxDepth: 1,
      pages: [
        { url: "https://example.com/", title: "Home", depth: 0, links: ["https://example.com/about"], status: 200 },
        { url: "https://example.com/about", title: "About", depth: 1, links: [], status: 200 },
      ],
      graph: { "https://example.com/": ["https://example.com/about"], "https://example.com/about": [] },
      parent: { "https://example.com/about": "https://example.com/" },
    };
  }

  it("includes the root URL, page count, and a tree view", () => {
    const output = formatSiteMap(fakeMap());
    expect(output).toContain("Site Map for: https://example.com/");
    expect(output).toContain("Total pages: 2, Max depth: 1");
    expect(output).toContain("└── https://example.com/about");
  });

  it("lists every page's status, title, and links in the details section", () => {
    const output = formatSiteMap(fakeMap());
    expect(output).toContain("[200] https://example.com/");
    expect(output).toContain("Title: About");
    expect(output).toContain("Internal links (1):");
  });

  it("truncates a page's link list to 10 with an '... and N more' note", () => {
    const map = fakeMap();
    map.pages[0].links = Array.from({ length: 15 }, (_, i) => `https://example.com/l${i}`);
    const output = formatSiteMap(map);
    expect(output).toContain("... and 5 more");
  });
});
