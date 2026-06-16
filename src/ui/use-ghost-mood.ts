import { useCallback, useEffect, useRef, useState } from "react";

export type GhostOverlay = "tears" | "dots" | "load" | "zzz" | "sparkle" | "confetti" | "hearts";
export type GhostMood = { face: string; overlay?: GhostOverlay } | null;

/** One-shot splash moods (wink after a pin, hearts after a theme switch, sleepy
 *  when idle on home). `flashMood` sets a face that decays back to the base after
 *  `ms`; a real state change (typing, a turn starting) always wins because the
 *  splash only renders on the idle home/welcome screens. The decay timer is
 *  cleared on unmount so a pending flash can't fire into an unmounted tree. */
export function useGhostMood(): {
  ghostMood: GhostMood;
  setGhostMood: React.Dispatch<React.SetStateAction<GhostMood>>;
  flashMood: (face: string, overlay?: "hearts" | "sparkle" | "confetti", ms?: number) => void;
} {
  const [ghostMood, setGhostMood] = useState<GhostMood>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashMood = useCallback((face: string, overlay?: "hearts" | "sparkle" | "confetti", ms = 1600) => {
    setGhostMood({ face, overlay });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setGhostMood(null), ms);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { ghostMood, setGhostMood, flashMood };
}
