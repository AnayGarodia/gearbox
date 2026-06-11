/**
 * acp/client-fs.ts — editor-buffer-aware file tools for ACP sessions.
 *
 * When the client advertises fs capabilities, reads and writes route THROUGH
 * THE EDITOR instead of the disk: fs/read_text_file returns the unsaved
 * buffer (what the user actually sees), and fs/write_text_file lands the
 * change in the open tab. Disk-only tools would silently work against stale
 * saved copies whenever the user has unsaved edits — the classic agent-in-
 * editor correctness bug this capability exists to fix.
 *
 * Only read_file and write_file are overridden. edit_file stays on disk: its
 * value is the diff pipeline (undo snapshots, retrieval refresh), and an
 * unsaved buffer would make its exact-match edits unreliable anyway.
 */
import { tool } from "ai";
import { z } from "zod";
import { isAbsolute, resolve } from "node:path";
import { requestPermission } from "../permission.ts";

const DENIED = "Permission denied by the user — they declined this action.";

export interface ClientFsCaps {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

/** Agent → client JSON-RPC request fn (injected by the server). */
export type ClientRequest = (method: string, params: unknown) => Promise<any>;

/**
 * Build read_file/write_file overrides backed by the client's fs methods.
 * Returns only the tools the client actually supports — absent capabilities
 * leave the built-in disk tools in place.
 */
export function clientFsTools(opts: { sessionId: string; cwd: string; caps: ClientFsCaps; request: ClientRequest }): Record<string, any> {
  const { sessionId, cwd, caps, request } = opts;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  const out: Record<string, any> = {};

  if (caps.readTextFile) {
    out.read_file = tool({
      description:
        "Read a UTF-8 file from the workspace via the editor — returns the CURRENT buffer, including unsaved changes. Returns the whole file by default; for a large file pass offset (1-based start line) and/or limit.",
      inputSchema: z.object({
        path: z.string().describe("file path, relative to the workspace root"),
        offset: z.number().int().min(1).optional().describe("1-based line to start reading from"),
        limit: z.number().int().min(1).optional().describe("max number of lines to read from offset"),
      }),
      execute: async ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) => {
        const r = await request("fs/read_text_file", {
          sessionId,
          path: abs(path),
          ...(offset ? { line: offset } : {}),
          ...(limit ? { limit } : {}),
        });
        return typeof r?.content === "string" ? r.content : "(empty)";
      },
    });
  }

  if (caps.writeTextFile) {
    out.write_file = tool({
      description:
        "Create a NEW file, or fully replace an existing file's contents, via the editor (the change appears in the open tab). To change PART of an existing file, prefer edit_file.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }: { path: string; content: string }) => {
        // Same gate as the disk tool: the broker (and therefore the editor's
        // permission dialog) decides before anything is written.
        if (!(await requestPermission({ kind: "write", title: "Write a file", detail: path, root: cwd }))) throw new Error(DENIED);
        await request("fs/write_text_file", { sessionId, path: abs(path), content });
        return `wrote ${path} (${content.split("\n").length} lines, via editor)`;
      },
    });
  }

  return out;
}
