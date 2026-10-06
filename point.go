// Package geom maintains a dynamic set of integer points keyed by ID and
// computes convex hulls and convex layers (onion peeling) for every
// persistent snapshot of the set.
//
// Conventions:
//   - Points are stored by integer ID; several IDs may share one coordinate.
//     Geometric computations see each coordinate once, but the source IDs
//     remain queryable via Snapshot.Group.
//   - Hulls are returned counterclockwise starting from the
//     lexicographically smallest point (by X, then Y).
//   - Points collinear with a hull edge are dropped; only the edge
//     endpoints are kept.
//   - If all points are collinear the hull is exactly the two endpoints
//     (or a single point / empty for degenerate inputs).
//   - Areas are returned as doubled integers (Area2) to stay exact.
//   - Convex layers peel boundary points (vertices and points collinear
//     with an edge) at every depth; ranks are 0-based from the outside.
//   - Snapshots are persistent: updates return new snapshots that share
//     structure with their ancestors, so branches never mutate each other.
package geom

// Point is a 2D integer point.
type Point struct {
	X, Y int64
}

// lessPoint orders points lexicographically by X, then Y.
func lessPoint(a, b Point) bool {
	return a.X < b.X || (a.X == b.X && a.Y < b.Y)
}

// cross returns the z-component of (a-o) x (b-o).
func cross(o, a, b Point) int64 {
	return (a.X-o.X)*(b.Y-o.Y) - (a.Y-o.Y)*(b.X-o.X)
}
