// Package formal provides an embeddable delayed-message scheduler backed by a
// hierarchical timing wheel.
//
// Deadlines are absolute time instants. A wheel slot is only an index; every
// entry retains its exact deadline, so messages in the same slot are emitted in
// deadline order and a restored process preserves the exact remaining delay.
// Cancellation unlinks an entry from its bucket immediately.
package formal
