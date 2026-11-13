// Package dataeng tracks outbox slots for the transactional outbox pattern.
//
// The package never delivers messages. Callers reserve a slot while preparing
// an outbox row, mark it committed once the enclosing transaction commits,
// poll for slots ready to dispatch, and acknowledge the exact generation they
// handled. Slot sequences are strictly increasing and never reused, so a slot
// the caller abandons leaves a permanent gap rather than being filled by a
// later slot.
//
// A Tracker is not safe for concurrent use.
package dataeng
