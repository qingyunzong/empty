package debugtrace

import "fmt"

// Machine is the deterministic state machine being debugged. The trace
// drives it during replay: snapshots capture and restore its state, and
// recorded inputs are re-applied in order.
type Machine interface {
	// Reset returns the machine to its initial state. It is used when a
	// jump target has no earlier snapshot and replay must start from the
	// beginning.
	Reset()
	// Apply consumes one recorded external input.
	Apply(input []byte)
	// Snapshot encodes the complete current state. The encoding must be
	// deterministic: identical states must produce identical bytes.
	Snapshot() []byte
	// Restore replaces the current state with a previously captured
	// snapshot. The snapshot bytes are verified before this is called.
	Restore(snapshot []byte) error
}

// StateAt positions m at the state that existed after the first n blocks
// of the trace were recorded (0 <= n <= t.Len()). It restores the nearest
// snapshot at or before n and replays the inputs after it, so a jump never
// requires replaying from the start.
//
// Every block involved in the jump is verified first. If any block is
// corrupt, StateAt returns a *CorruptionError locating the damage and
// leaves no guessed state behind: the machine is reset to its initial
// state before the error is returned.
func StateAt(t *Trace, n uint64, m Machine) error {
	if n > uint64(t.Len()) {
		return fmt.Errorf("debugtrace: jump target %d: %w", n, ErrOutOfRange)
	}
	if err := t.verifyPrefix(n); err != nil {
		m.Reset()
		return err
	}

	// Find the nearest snapshot at or before n. A snapshot stored at
	// index s captures the state after blocks [0, s) were applied.
	snap := -1
	for i := uint64(0); i < n; i++ {
		if t.entries[i].Kind == KindSnapshot {
			snap = int(i)
		}
	}

	if snap < 0 {
		m.Reset()
	} else if err := m.Restore(t.entries[snap].Data); err != nil {
		m.Reset()
		return fmt.Errorf("debugtrace: restore snapshot at seq %d: %w", snap, err)
	}

	start := uint64(0)
	if snap >= 0 {
		start = uint64(snap)
	}
	for i := start; i < n; i++ {
		if t.entries[i].Kind == KindInput {
			m.Apply(t.entries[i].Data)
		}
	}
	return nil
}

// SnapshotAt is a convenience wrapper that jumps to n and returns the
// machine's encoded state, ready for byte-for-byte comparison.
func SnapshotAt(t *Trace, n uint64, m Machine) ([]byte, error) {
	if err := StateAt(t, n, m); err != nil {
		return nil, err
	}
	return m.Snapshot(), nil
}
