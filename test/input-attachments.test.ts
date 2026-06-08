import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageChipLabel, imageContent, imagePathsInText, loadImageAttachment, replaceImagePathWithMarker } from "../src/image.ts";
import { buildContext } from "../src/context/builder.ts";
import { findModel } from "../src/providers.ts";
import { formatSearchResults } from "../src/websearch.ts";

test("dragged or pasted image paths become model image parts", () => {
  const dir = mkdtempSync(join(tmpdir(), "gearbox-img-"));
  try {
    const path = join(dir, "screen shot.png");
    writeFileSync(path, new Uint8Array([137, 80, 78, 71]));

    const paths = imagePathsInText(`please inspect "${path}"`, process.cwd());
    expect(paths).toEqual([path]);

    const img = loadImageAttachment(path);
    expect(img.mimeType).toBe("image/png");
    const content = imageContent("what is wrong here?", [img]) as any[];
    expect(content[0]).toEqual({ type: "text", text: "what is wrong here?" });
    expect(content[1].type).toBe("image");
    expect(content[1].mediaType).toBe("image/png");
    expect(content[1].image.length).toBe(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("image path markers hide the dragged absolute path", () => {
  const path = "/tmp/Gearbox Screenshots/Screenshot 2026-06-06 at 13.04.04.png";
  const marker = imageChipLabel(path);
  expect(marker).toBe("[image: Screenshot 2026-06-06 at 13.04.04.png]");
  const shown = replaceImagePathWithMarker(`fix "${path}" please`, path, marker);
  expect(shown).toBe(`fix ${marker} please`);
  expect(shown).not.toContain("/tmp/Gearbox");
});

test("buildContext preserves multimodal user content as the current turn", () => {
  const model = findModel("sonnet-4.6")!;
  const content = [{ type: "text" as const, text: "describe this" }, { type: "image" as const, image: new Uint8Array([1, 2]), mediaType: "image/png" }];
  const { messages } = buildContext({ history: [], userText: "describe this", userContent: content, model });
  const last = messages[messages.length - 1] as any;
  expect(last.role).toBe("user");
  // The volatile turn-context may be prepended as a text part, but the user's own
  // multimodal parts (text + image) are preserved, in order, at the end.
  const parts: any[] = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
  expect(parts.slice(-2)).toEqual(content);
});

test("web search formatting gives the model citations it can fetch next", () => {
  const out = formatSearchResults("gearbox", [
    { title: "Gearbox docs", url: "https://example.com/docs", snippet: "Install and configure the tool." },
  ]);
  expect(out).toContain("1. Gearbox docs");
  expect(out).toContain("https://example.com/docs");
  expect(out).toContain("Install and configure");
});
