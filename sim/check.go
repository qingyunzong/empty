package sim

import "bytes"

// Result describes a replay-consistency check.
type Result struct {
	Steps      int
	DivergeAt  int // first event index whose snapshot cannot resume byte-identically; -1 if none
	Consistent bool
}

// Check runs a full replay of `steps` events, snapshotting before every
// event, then resumes from each snapshot (round-tripped through the
// binary encoding) and verifies the remaining output matches the full
// replay byte-for-byte. It reports the minimal inconsistent event index.
func Check(seed uint64, nodeCount, steps int) Result {
	return FindDivergence(seed, nodeCount, steps, nil)
}

// FindDivergence is Check with an optional tamper hook applied to each
// snapshot before resuming; it exists so tests can prove the checker
// reports the minimal divergent position when state is corrupted.
func FindDivergence(seed uint64, nodeCount, steps int, tamper func(i int, snap *Snapshot)) Result {
	full := New(seed, nodeCount)
	snaps := make([][]byte, 0, steps)
	offsets := make([]int, 0, steps)
	for i := 0; i < steps; i++ {
		snaps = append(snaps, full.Snapshot().Marshal())
		offsets = append(offsets, len(full.Output()))
		full.Step()
	}
	fullOut := full.Output()

	for i := 0; i < steps; i++ {
		snap, err := UnmarshalSnapshot(snaps[i])
		if err != nil {
			return Result{Steps: steps, DivergeAt: i}
		}
		if tamper != nil {
			tamper(i, snap)
		}
		rep := New(seed, nodeCount)
		rep.Restore(snap)
		for j := i; j < steps; j++ {
			rep.Step()
		}
		if !bytes.Equal(rep.Output(), fullOut[offsets[i]:]) {
			return Result{Steps: steps, DivergeAt: i}
		}
	}
	return Result{Steps: steps, DivergeAt: -1, Consistent: true}
}
