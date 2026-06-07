import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { GHOSTS, type SpriteCell } from "../mascot-sprite.ts";
import { getImageMode, imageId, idColor, placeholderRows, type GhostSize } from "../image.ts";
import { renderGhost, EYES_CLOSED, TALK, type GhostCfg, type OverlayKind } from "../ghost/engine.ts";

// Boo · the ghost in the gearbox. Built parametrically (src/ui/ghost/engine.ts):
// a 20x20 pixel sprite composited from layers (body + face + palette + accessory
// + overlay) and FOLDED into half-block truecolor cells. Each character is the ▀
// upper-half block: glyph color = top pixel, background = bottom pixel, so one
// terminal row carries two pixel rows. `null` = transparent (shows the terminal
// background), so Boo floats on any theme. Rendered with Ink color props only —
// never raw ANSI, which would corrupt Ink's width math.
//
// The baked GHOSTS sprites (mascot-sprite.ts) are retained only for the opt-in
// kitty/iTerm PNG path; the default blocks path renders the engine live.

export type GhostSkin = "base" | "mint" | "pink" | "golden" | "shades";
export const SKINS: GhostSkin[] = ["base", "mint", "pink", "golden", "shades"];

// A persisted skin → an engine cfg. `shades` is now an accessory + the cool face.
const SKIN_CFG: Record<GhostSkin, GhostCfg> = {
  base: { palette: "default", face: "happy" },
  mint: { palette: "mint", face: "happy" },
  pink: { palette: "pink", face: "happy" },
  golden: { palette: "golden", face: "joy" },
  shades: { palette: "default", face: "cool", accessory: "shades" },
};
export function skinToCfg(skin: GhostSkin): GhostCfg {
  return { ...SKIN_CFG[skin] };
}

/** One sprite row → run-length-merged <Text> spans (fewer nodes, same pixels). */
function SpriteRow({ row }: { row: SpriteCell[] }) {
  const spans: React.ReactNode[] = [];
  let i = 0;
  while (i < row.length) {
    const { t, b } = row[i]!;
    let j = i + 1;
    while (j < row.length && row[j]!.t === t && row[j]!.b === b) j++;
    const n = j - i;
    if (t && b) spans.push(<Text key={i} color={t} backgroundColor={b}>{"▀".repeat(n)}</Text>);
    else if (t) spans.push(<Text key={i} color={t}>{"▀".repeat(n)}</Text>);
    else if (b) spans.push(<Text key={i} color={b}>{"▄".repeat(n)}</Text>);
    else spans.push(<Text key={i}>{" ".repeat(n)}</Text>);
    i = j;
  }
  return <Box>{spans}</Box>;
}

export function Sprite({ data }: { data: SpriteCell[][] }) {
  return (
    <Box flexDirection="column">
      {data.map((row, i) => (
        <SpriteRow key={i} row={row} />
      ))}
    </Box>
  );
}

// ── Animation ───────────────────────────────────────────────────────────────
// Deliberately calm. One shared, unhurried cadence (240ms) drives the frame-based
// animation; talk + overlays advance at half that (~480ms) and the idle bob is
// gone · motion should read as a quiet sign of life, not fidgeting. The interval
// is leaf-local (lives in the animating component), so it only ticks while that
// component is mounted and never re-renders the transcript. GEARBOX_NO_MOTION
// holds frame 0 (fully still / CI).
const NO_MOTION = !!process.env.GEARBOX_NO_MOTION;

function useTick(ms = 240, active = true): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!active || NO_MOTION) return;
    const id = setInterval(() => setT((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return NO_MOTION ? 0 : t;
}

export interface AnimSpec {
  blink?: boolean; // briefly close the eyes on a slow cycle
  talk?: boolean; // cycle the mouth shapes while "speaking"
  shake?: boolean; // ±1-col jitter, transient (error beat only)
  overlay?: OverlayKind; // a frame-driven overlay (dots, tears, confetti, …)
}

/** A live ghost: applies the anim spec to the cfg per frame and renders it. The
 *  transient shake offset is applied to a wrapping Box so the sprite itself stays
 *  cache-stable. */
export function AnimatedGhost({ cfg, scale, anim }: { cfg: GhostCfg; scale: 1 | 2; anim: AnimSpec }) {
  const tick = useTick(240, !!(anim.blink || anim.talk || anim.shake || anim.overlay));
  const slow = Math.floor(tick / 2); // calmer cadence for talk + overlays
  const frameCfg: GhostCfg = { ...cfg, scale };
  if (anim.blink && tick % 26 === 0 && tick !== 0) frameCfg.eyesOverride = EYES_CLOSED;
  if (anim.talk) frameCfg.mouthOverride = TALK[slow % TALK.length]!;
  if (anim.overlay) frameCfg.overlay = { kind: anim.overlay, frame: slow };
  const data = useMemo(() => renderGhost(frameCfg), [JSON.stringify(frameCfg)]);
  const shake = anim.shake ? tick % 2 : 0;
  return (
    <Box marginLeft={shake}>
      <Sprite data={data} />
    </Box>
  );
}

// ── In-flow state ghost (the working indicator) ──────────────────────────────
// A small, native-resolution head crop (the feet/body carry no expression and are
// dropped). Two rules keep it from being noisy: (1) ONE fixed crop window for
// EVERY state, so the ghost never changes height and the input bar below it never
// moves; (2) Boo is static through the long phases (thinking, tool) · only the
// brief, meaningful beats move: the mouth while streaming, confetti on a clean
// finish, tears on an error. The state mostly reads from the FACE + palette +
// the verb beside it.
export type MascotState = "thinking" | "streaming" | "tool" | "celebrate" | "error";

// rows 4..14 → 5 cell rows: the smallest crop that still shows a rounded head +
// eyes + mouth. Used for every state so the height is constant.
const FACE_CROP = { rowStart: 4, rowEnd: 14 };

export function stateView(state: MascotState, skin: GhostSkin): { cfg: GhostCfg; anim: AnimSpec } {
  const skinPal = SKIN_CFG[skin].palette;
  switch (state) {
    case "thinking":
      return { cfg: { palette: skinPal, face: "thinking", crop: FACE_CROP }, anim: {} };
    case "streaming":
      return { cfg: { palette: skinPal, face: "neutral", crop: FACE_CROP }, anim: { talk: true } };
    case "tool":
      return { cfg: { palette: "ice", face: "neutral", crop: FACE_CROP }, anim: {} };
    case "celebrate":
      return { cfg: { palette: "mint", face: "joy", crop: FACE_CROP }, anim: { overlay: "confetti" } };
    case "error":
      return { cfg: { palette: "ember", face: "crying", crop: FACE_CROP }, anim: { overlay: "tears" } };
  }
}

/** The (now fixed) crop height in cell rows · App uses it to budget the line. */
export const STATE_GHOST_ROWS = 5; // FACE_CROP rows 4..14 → 5 cell rows

/** The compact state ghost for the working line (blocks path). */
export function StateGhost({ state, skin }: { state: MascotState; skin: GhostSkin }) {
  const { cfg, anim } = stateView(state, skin);
  return <AnimatedGhost cfg={cfg} scale={1} anim={anim} />;
}

// ── Splash (welcome screen) ──────────────────────────────────────────────────

/** One ghost figure at a size for the KITTY path: a real PNG via placeholders. */
function KittyGhost({ variant, size }: { variant: string; size: GhostSize }) {
  const data = GHOSTS[variant]![size];
  const id = idColor(imageId(variant, size));
  const lines = placeholderRows(data[0]?.length ?? 0, data.length);
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} color={id}>{l}</Text>
      ))}
    </Box>
  );
}

/** Splash for the entry screen · Boo + wordmark + tagline. On the blocks path the
 *  ghost just blinks occasionally (calm · no float or sparkle); the kitty PNG path
 *  stays static (re-placing a PNG on a timer glitches). `size` is chosen by the
 *  caller: "big" (2×) on a roomy window, "mini" (1×) when short, "none" (wordmark). */
export function MascotSplash({ skin = "base", size = "big" }: { skin?: GhostSkin; size?: GhostSize | "none" }) {
  const kitty = getImageMode() === "kitty";
  return (
    <Box flexDirection="column" alignItems="center" marginTop={1}>
      {size !== "none" ? (
        kitty ? (
          <KittyGhost variant={skin} size={size} />
        ) : (
          <AnimatedGhost cfg={skinToCfg(skin)} scale={size === "big" ? 2 : 1} anim={{ blink: true }} />
        )
      ) : null}
      <Box marginTop={size === "none" ? 0 : 1}>
        <Text color={color.accent} bold>gearbox</Text>
      </Box>
      <Box>
        <Text color={color.dim}>one ghost · every model</Text>
      </Box>
    </Box>
  );
}
