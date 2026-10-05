package restore

import "fmt"

// InterpretFull is the reference interpreter: it applies a complete,
// ordered log directly, skipping entries at or below the checkpoint and
// requiring strict continuity afterwards. Restore must agree with it.
func InterpretFull(checkpoint int, log []Entry) ([]Entry, error) {
	var applied []Entry
	expect := checkpoint + 1
	for _, e := range log {
		if e.Seq <= checkpoint {
			continue
		}
		if e.Seq != expect {
			return nil, fmt.Errorf("full log not continuous after checkpoint: want seq %d, got %d", expect, e.Seq)
		}
		applied = append(applied, e)
		expect++
	}
	return applied, nil
}
