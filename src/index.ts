export { parsePath, PathParseError } from './path.js';
export type { Point, Subpath } from './path.js';
export {
  cross,
  onSegment,
  ringEdges,
  signedArea2,
  ringDirection,
  ringContainment,
  segmentsIntersect,
  findSelfIntersections,
} from './geometry.js';
export type {
  Edge,
  RingDirection,
  RingContainment,
  IntersectionKind,
  SelfIntersection,
} from './geometry.js';
export { hitTest, hitTestPath } from './fill.js';
export type {
  FillRule,
  RingEvidence,
  RingSelfIntersections,
  HitTestResult,
  HitTestOptions,
} from './fill.js';
