/** Parse "a=1\nb=2" into an object. Values may themselves contain "=". */
export function parseKV(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [k, v] = line.split("=");
    if (k && v !== undefined) out[k.trim()] = v.trim();
  }
  return out;
}
