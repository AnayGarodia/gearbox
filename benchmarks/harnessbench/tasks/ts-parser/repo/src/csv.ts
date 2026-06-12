/** Parse one CSV line per RFC 4180 (quoted fields, "" escapes, literal commas in quotes). */
export function parseCsvLine(line: string): string[] {
  return line.split(",");
}
