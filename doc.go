// Package formal implements a deterministic, event-driven consumer-group
// rebalancing coordinator.
//
// Membership changes produce generations. A new generation is activated only
// after every member that loses a partition has acknowledged revocation, so a
// partition never has two consumable owners. Static members keep their state
// across a reconnect that happens before their session timeout. Commits carry
// the active generation and are fenced when that generation is no longer
// current; committed offsets can never move backwards.
package formal
