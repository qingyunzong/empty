package crashreplay

import (
	"fmt"
	"sort"
)

// Order accepts events published in any order and returns them sorted by
// sequence number. Duplicate sequence numbers are rejected.
func Order(events []Event) ([]Event, error) {
	ordered := make([]Event, len(events))
	copy(ordered, events)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Seq < ordered[j].Seq })
	for i := 1; i < len(ordered); i++ {
		if ordered[i].Seq == ordered[i-1].Seq {
			return nil, fmt.Errorf("duplicate sequence number %d", ordered[i].Seq)
		}
	}
	return ordered, nil
}
