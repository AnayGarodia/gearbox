// Reactive terminal size. Ink does not re-render on resize by itself; this
// subscribes to stdout 'resize' so every width-dependent element reflows.
import { useEffect, useState } from "react";
import { useStdout } from "ink";

export function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    const onResize = () => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off?.("resize", onResize);
    };
  }, [stdout]);

  return size;
}
