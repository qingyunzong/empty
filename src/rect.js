import { Fraction } from './fraction.js';

// Axis-aligned rectangle with half-open bounds: [x1, x2) x [y1, y2).
// Non-empty iff x1 < x2 and y1 < y2. Touching edges therefore overlap
// with zero area, and a container's area fully covers a contained rect.
export class Rect {
  constructor(x1, y1, x2, y2) {
    this.x1 = Fraction.parse(x1);
    this.y1 = Fraction.parse(y1);
    this.x2 = Fraction.parse(x2);
    this.y2 = Fraction.parse(y2);
    Object.freeze(this);
  }

  static from(spec) {
    if (!spec || typeof spec !== 'object') {
      throw new TypeError('rect must be an object with x1, y1, x2, y2');
    }
    return new Rect(spec.x1, spec.y1, spec.x2, spec.y2);
  }

  get isEmpty() {
    return this.x1.cmp(this.x2) >= 0 || this.y1.cmp(this.y2) >= 0;
  }

  get width() {
    return this.x2.sub(this.x1);
  }

  get height() {
    return this.y2.sub(this.y1);
  }

  area() {
    return this.isEmpty ? Fraction.ZERO : this.width.mul(this.height);
  }

  // Returns the overlapping Rect, or null when the overlap is empty
  // (including the shared-edge case, where the intersection is degenerate).
  intersect(other) {
    const x1 = this.x1.cmp(other.x1) >= 0 ? this.x1 : other.x1;
    const y1 = this.y1.cmp(other.y1) >= 0 ? this.y1 : other.y1;
    const x2 = this.x2.cmp(other.x2) <= 0 ? this.x2 : other.x2;
    const y2 = this.y2.cmp(other.y2) <= 0 ? this.y2 : other.y2;
    const rect = new Rect(x1, y1, x2, y2);
    return rect.isEmpty ? null : rect;
  }

  translate(dx, dy) {
    const fx = Fraction.parse(dx);
    const fy = Fraction.parse(dy);
    return new Rect(this.x1.add(fx), this.y1.add(fy), this.x2.add(fx), this.y2.add(fy));
  }

  // Scales about the rectangle's own min corner (x1, y1).
  scale(sx, sy) {
    const fx = Fraction.parse(sx);
    const fy = Fraction.parse(sy);
    return new Rect(
      this.x1,
      this.y1,
      this.x1.add(this.width.mul(fx)),
      this.y1.add(this.height.mul(fy)),
    );
  }

  containsPoint(x, y) {
    const px = Fraction.parse(x);
    const py = Fraction.parse(y);
    return (
      this.x1.cmp(px) <= 0 && px.cmp(this.x2) < 0 &&
      this.y1.cmp(py) <= 0 && py.cmp(this.y2) < 0
    );
  }

  toJSON() {
    return { x1: this.x1, y1: this.y1, x2: this.x2, y2: this.y2 };
  }
}
