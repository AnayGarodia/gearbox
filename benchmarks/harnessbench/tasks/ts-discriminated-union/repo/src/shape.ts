export type Shape =
  | { kind: "rect"; width: number; height: number }
  | { kind: "circle"; radius: number }
  | { kind: "triangle"; base: number; height: number };

export function area(shape: Shape): number {
  switch (shape.kind) {
    case "rect": return shape.width * shape.height;
    case "triangle": return 0.5 * shape.base * shape.height;
    default: return 0;
  }
}
