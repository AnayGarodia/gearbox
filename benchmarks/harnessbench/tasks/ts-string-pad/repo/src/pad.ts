export function padCenter(str: string, width: number, char = " "): string {
  const total = Math.max(0, width - str.length);
  const left = Math.floor(total / 2);
  const right = Math.floor(total / 2);
  return char.repeat(left) + str + char.repeat(right);
}
