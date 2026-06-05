const MAX_FETCH_CHARS = 80_000;
const MAX_RETURN_CHARS = 20_000;

const ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function urlsInText(text: string, limit = 2): string[] {
  const out: string[] = [];
  const re = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  for (const m of text.matchAll(re)) {
    const url = m[0]!.replace(/[.,;:!?]+$/, "");
    if (!out.includes(url)) out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, raw: string) => {
    const key = raw.toLowerCase();
    if (key[0] === "#") {
      const n = key[1] === "x" ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    }
    return ENTITY[key] ?? "";
  });
}

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

export async function fetchUrlText(url: string): Promise<{ url: string; title?: string; text: string; chars: number }> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are supported");
  const res = await fetch(u, {
    headers: {
      "user-agent": "Gearbox/0.1 (+https://github.com/AnayGarodia/gearbox)",
      accept: "text/html,text/plain,application/json;q=0.8,*/*;q=0.2",
    },
  });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const raw = (await res.text()).slice(0, MAX_FETCH_CHARS);
  const contentType = res.headers.get("content-type") ?? "";
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
  const text = (/html/i.test(contentType) || /<html|<body|<p\b|<div\b/i.test(raw) ? stripHtml(raw) : raw.trim()).slice(0, MAX_RETURN_CHARS);
  if (!text) throw new Error("fetched URL had no readable text");
  return { url: u.toString(), title: title ? decodeEntities(title) : undefined, text, chars: text.length };
}
