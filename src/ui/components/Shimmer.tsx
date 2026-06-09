import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { shimmer, shimmerFrame } from "../shimmer.ts";

// A loading label with the working-indicator's glow gliding through it — the
// same visual language as the busy line, so "alive and waiting" always looks
// like one thing. Leaf-local tick (never lifted to App), frozen under
// GEARBOX_NO_MOTION and in tests (frame 0 on first render either way).
export function ShimmerText({ text }: { text: string }) {
  const frozen = process.env.GEARBOX_NO_MOTION === "1";
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (frozen) return;
    const t = setInterval(() => setFrame(shimmerFrame()), 130);
    return () => clearInterval(t);
  }, [frozen]);
  return (
    <Text>
      {shimmer(text, frame).map((c, i) => (
        <Text key={i} color={c.color}>{c.ch}</Text>
      ))}
    </Text>
  );
}
