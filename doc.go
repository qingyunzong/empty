// Package formal provides topology-aware zone partitioning for endpoint
// slices.
//
// An Allocator distributes every endpoint to exactly one active zone. The
// distribution of ready, non-terminating endpoints follows the relative
// capacity of the zones, while terminating and not-ready endpoints are placed
// without contributing hint weight. Existing assignments are retained
// whenever the proportional targets allow it, which keeps churn low when
// topology or readiness changes.
//
// Both the weighted (ready, non-terminating) and total endpoint counts are
// kept within one endpoint of their exact proportional shares. Assignments
// are deterministic: repeated calls with the same input produce the same
// result, and a call with its own previous result performs no moves.
package formal
