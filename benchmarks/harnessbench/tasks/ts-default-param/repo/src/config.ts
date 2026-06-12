export function getValue(value: number | boolean | string | null | undefined, defaultVal: number | boolean | string): number | boolean | string {
  return value || defaultVal;
}
