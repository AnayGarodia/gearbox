// Chat-style first-turn anchoring (fullscreen). The transcript Viewport
// bottom-aligns short content (the chat convention: it sits just above the
// composer). For the FIRST prompt we override that — the prompt pins to the TOP
// and the reply fills downward — by padding the bottom with a spacer and
// scrolling so the prompt's line is the first visible row.
//
// The subtlety this module exists to get right: a turn can OVERFLOW the viewport
// transiently mid-stream (the Working indicator shrinks transcriptHeight while
// busy; a tall tool trace later collapses at settle) and then fit again. The
// anchor must SURVIVE that — follow the live tail while overflowing, then re-pin
// to the top once the settled turn fits. Dropping the anchor on the transient
// overflow is what made the first input "shift down from the top" after a turn.
// Only a deliberate user scroll disarms the anchor (handled in App, not here).
//
// Pure + tested so the fragile scroll math can't silently drift.

export interface AnchorView {
  // The prompt is pinned to the top this frame (content fits under it).
  anchorActive: boolean;
  // Empty rows appended below the content so the prompt can scroll to row 0.
  spacerLen: number;
  // Scroll offset into (lines + spacer) the Viewport should render from.
  effScroll: number;
  // Max scroll into (lines + spacer) — exported so the App effect and the render
  // agree on the bottom.
  maxScroll: number;
  // Anchored, but the turn currently overflows the viewport: follow the live tail
  // WITHOUT disarming the anchor, so it re-pins to the top if the turn later
  // collapses back to fitting.
  followTail: boolean;
}

export function anchorLayout(opts: {
  anchorTop: boolean;
  anchorOffset: number | null; // first transcript line of the anchored prompt
  linesLength: number; // total rendered transcript lines
  transcriptHeight: number; // visible rows in the scroll region
  atBottom: boolean; // following the live tail (no manual scroll-up)
  scrollTop: number; // current manual scroll position
}): AnchorView {
  const { anchorTop, anchorOffset, linesLength, transcriptHeight, atBottom, scrollTop } = opts;
  const armed = anchorTop && anchorOffset != null;
  const contentBelowAnchor = armed ? linesLength - anchorOffset! : 0;
  const anchorActive = armed && anchorOffset! <= linesLength && contentBelowAnchor <= transcriptHeight;
  const spacerLen = anchorActive ? Math.max(0, transcriptHeight - contentBelowAnchor) : 0;
  const maxScroll = Math.max(0, linesLength + spacerLen - transcriptHeight);
  const effScroll = anchorActive
    ? Math.min(anchorOffset!, maxScroll)
    : atBottom
      ? maxScroll
      : Math.min(scrollTop, maxScroll);
  const followTail = armed && contentBelowAnchor > transcriptHeight;
  return { anchorActive, spacerLen, effScroll, maxScroll, followTail };
}
