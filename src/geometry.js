// Point-in-polygon using the even-odd (ray casting) rule.
// Points lying exactly on an edge or vertex count as INSIDE.

function cross(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(ax, ay, bx, by, px, py) {
  if (cross(ax, ay, bx, by, px, py) !== 0) return false;
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by);
  const maxY = Math.max(ay, by);
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

// Returns "EDGE" when (px, py) lies on the polygon boundary,
// "INSIDE" when strictly inside under the even-odd rule,
// "OUTSIDE" otherwise.
export function classifyPoint(polygon, px, py) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (onSegment(xi, yi, xj, yj, px, py)) return "EDGE";
    if (yi > py !== yj > py) {
      const xIntersect = ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (px < xIntersect) inside = !inside;
    }
  }
  return inside ? "INSIDE" : "OUTSIDE";
}

export function pointInPolygon(polygon, px, py) {
  return classifyPoint(polygon, px, py) !== "OUTSIDE";
}
