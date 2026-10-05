package sim

import "bytes"

// Snapshooter captures a restorable image of a simulator. Implementations
// other than Sim.Snapshot may be used to validate the checker against
// faulty snapshot logic.
type Snapshooter func(*Sim) Snapshot

// FindMinimalDivergence verifies the jump-and-continue property: for every
// event index i (0..len(events)), it replays events[0:i], takes a snapshot
// with snapFn, restores a fresh simulator from it, replays events[i:] and
// compares the final state byte-for-byte with an uninterrupted full replay.
//
// It returns the minimal event index at which the jumped run diverges from
// the full replay, or -1 if every jump point is consistent.
func FindMinimalDivergence(cfg Config, events []Event, snapFn Snapshooter) int {
	full := New(cfg)
	full.Run(events, 0, len(events))
	want := full.StateBytes()

	for i := 0; i <= len(events); i++ {
		head := New(cfg)
		head.Run(events, 0, i)
		snap := snapFn(head)

		jumped := Restore(cfg, snap)
		jumped.Run(events, i, len(events))
		if !bytes.Equal(jumped.StateBytes(), want) {
			return i
		}
	}
	return -1
}
