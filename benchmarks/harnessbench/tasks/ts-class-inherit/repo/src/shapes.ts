export abstract class Shape {
  abstract area(): number;

  describe(): string {
    // Bug: calls Shape.prototype.area (which doesn't exist) instead of this.area()
    const a = Shape.prototype.area;
    return `Shape: ${a ? a.call(this) : 0}`;
  }
}

export class Circle extends Shape {
  constructor(private radius: number) { super(); }
  area(): number { return Math.PI * this.radius ** 2; }
}

export class Rectangle extends Shape {
  constructor(private w: number, private h: number) { super(); }
  area(): number { return this.w * this.h; }
}
