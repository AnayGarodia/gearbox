export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const clip = (s: string, n = 300) => s.replace(/\s+/g, " ").trim().slice(0, n);

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripTags(s: string): string {
  return decodeHtml(s.replace(/<[^>]+>/g, " "));
}

function normalizeDuckUrl(raw: string): string {
  const decoded = decodeHtml(raw);
  try {
    const u = new URL(decoded, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : u.toString();
  } catch {
    return decoded;
  }
}

async function braveSearch(query: string, count: number): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return [];
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(Math.min(count, 10)));
  const r = await fetch(u, { headers: { "x-subscription-token": key, accept: "application/json" } });
  if (!r.ok) throw new Error(`Brave search failed: HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.web?.results ?? []).map((x: any) => ({ title: x.title ?? "", url: x.url ?? "", snippet: clip(x.description ?? "") })).filter((x: SearchResult) => x.title && x.url);
}

async function searxngSearch(query: string, count: number): Promise<SearchResult[]> {
  const base = process.env.SEARXNG_URL || process.env.SEARXNG_SEARCH_URL;
  if (!base) return [];
  const u = new URL(base);
  u.searchParams.set("q", query);
  u.searchParams.set("format", "json");
  const r = await fetch(u);
  if (!r.ok) throw new Error(`SearXNG search failed: HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.results ?? []).slice(0, count).map((x: any) => ({ title: x.title ?? "", url: x.url ?? "", snippet: clip(x.content ?? x.snippet ?? "") })).filter((x: SearchResult) => x.title && x.url);
}

async function duckDuckGoHtml(query: string, count: number): Promise<SearchResult[]> {
  const u = new URL("https://html.duckduckgo.com/html/");
  u.searchParams.set("q", query);
  const r = await fetch(u, { headers: { "user-agent": "Gearbox/0.1 (+https://www.npmjs.com/package/gearbox-code)" } });
  if (!r.ok) throw new Error(`DuckDuckGo search failed: HTTP ${r.status}`);
  const html = await r.text();
  const rows: SearchResult[] = [];
  const resultRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/gi;
  for (const m of html.matchAll(resultRe)) {
    if (rows.length >= count) break;
    const title = clip(stripTags(m[2] ?? ""), 120);
    const url = normalizeDuckUrl(m[1] ?? "");
    const snippet = clip(stripTags(m[3] ?? m[4] ?? ""));
    if (title && /^https?:\/\//i.test(url)) rows.push({ title, url, snippet });
  }
  return rows;
}

async function duckDuckGoInstant(query: string, count: number): Promise<SearchResult[]> {
  const u = new URL("https://api.duckduckgo.com/");
  u.searchParams.set("q", query);
  u.searchParams.set("format", "json");
  u.searchParams.set("no_html", "1");
  u.searchParams.set("skip_disambig", "1");
  const r = await fetch(u);
  if (!r.ok) throw new Error(`DuckDuckGo search failed: HTTP ${r.status}`);
  const j: any = await r.json();
  const rows: SearchResult[] = [];
  if (j.AbstractURL && j.AbstractText) rows.push({ title: j.Heading || query, url: j.AbstractURL, snippet: clip(j.AbstractText) });
  const related = (j.RelatedTopics ?? []).flatMap((x: any) => x.Topics ?? [x]);
  for (const x of related) {
    if (rows.length >= count) break;
    if (x.FirstURL && x.Text) rows.push({ title: clip(x.Text, 80), url: x.FirstURL, snippet: clip(x.Text) });
  }
  return rows.slice(0, count);
}

export async function webSearch(query: string, count = 5): Promise<SearchResult[]> {
  const providers = [braveSearch, searxngSearch, duckDuckGoHtml, duckDuckGoInstant];
  let lastErr: unknown;
  for (const p of providers) {
    try {
      const rows = await p(query, count);
      if (rows.length) return rows.slice(0, count);
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

export function formatSearchResults(query: string, rows: SearchResult[]): string {
  if (!rows.length) return `No web results for "${query}". Set BRAVE_SEARCH_API_KEY or SEARXNG_URL for fuller search.`;
  return rows.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
}
