import { join } from "node:path";

/** Join a user-supplied path under root; must never escape root. */
export function joinUnder(root: string, userPath: string): string {
  if (userPath.startsWith("..")) throw new Error("path escapes root");
  return join(root, userPath);
}
