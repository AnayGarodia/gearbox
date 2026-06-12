export function highlight(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = "";
  for (let i = 0; i < values.length; i++) {
    out += strings[i] + `[${values[i]}]`;
  }
  return out;
}
