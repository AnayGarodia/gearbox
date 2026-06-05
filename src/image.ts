import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface ImageAttachment {
  path: string;
  mimeType: string;
  bytes: Uint8Array;
}

function unquotePath(raw: string): string {
  return raw.trim().replace(/^file:\/\//, "").replace(/^['"]|['"]$/g, "").replace(/\\ /g, " ");
}

export function imagePathsInText(text: string, cwd = process.cwd(), limit = 6): string[] {
  const found: string[] = [];
  const add = (rawMatch: string) => {
    const raw = unquotePath(rawMatch);
    const expanded = raw.startsWith("~") ? raw.replace(/^~/, process.env.HOME ?? "~") : raw;
    const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    if (existsSync(abs) && !found.includes(abs)) found.push(abs);
  };

  const quoted = /(["'])(file:\/\/)?([^"']+\.(?:png|jpe?g|webp|gif))\1/gi;
  for (const m of text.matchAll(quoted)) {
    add(`${m[2] ?? ""}${m[3] ?? ""}`);
    if (found.length >= limit) return found;
  }

  const re = /(?:file:\/\/)?(?:~|\/|\.\.?\/|[A-Za-z0-9_.-]+\/)?(?:[^'"`\s]|\\ )+\.(?:png|jpe?g|webp|gif)\b/gi;
  for (const m of text.matchAll(re)) {
    add(m[0]!);
    if (found.length >= limit) break;
  }
  return found;
}

export function loadImageAttachment(path: string): ImageAttachment {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const ext = abs.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  const mimeType = IMAGE_EXT[ext];
  if (!mimeType) throw new Error(`unsupported image type: ${path}`);
  const size = statSync(abs).size;
  if (size > MAX_IMAGE_BYTES) throw new Error(`image is too large (${Math.round(size / 1024 / 1024)}MB): ${path}`);
  return { path: abs, mimeType, bytes: readFileSync(abs) };
}

export function imageContent(text: string, images: ImageAttachment[]): any {
  if (!images.length) return text;
  return [
    { type: "text", text },
    ...images.map((img) => ({ type: "image", image: img.bytes, mediaType: img.mimeType })),
  ];
}
