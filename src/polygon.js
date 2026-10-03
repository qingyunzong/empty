'use strict';

const EPS = 1e-9;

function pointOnSegment(px, py, ax, ay, bx, by) {
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const scale = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
  if (Math.abs(cross) > EPS * scale * scale) return false;
  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
  if (dot < 0) return false;
  const lenSq = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
  return dot <= lenSq;
}

// Even-odd rule; points lying on an edge or vertex count as inside.
function pointInPolygon(x, y, polygon) {
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [ax, ay] = polygon[j];
    const [bx, by] = polygon[i];
    if (pointOnSegment(x, y, ax, ay, bx, by)) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y) {
      const xIntersect = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (x < xIntersect) inside = !inside;
    }
  }
  return inside;
}

module.exports = { pointInPolygon, pointOnSegment };
