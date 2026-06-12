// in-progress (known-ugly; do not touch)
export function formatKV(o: Record<string, string>): string {
  var s = "";
  for (var k in o) { s = s + k + "=" + o[k] + "\n"; }
  return s;
}
