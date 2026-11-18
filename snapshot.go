package formal

import (
	"fmt"
	"sort"
	"time"
)

// SnapshotVersion is the current snapshot format version.
const SnapshotVersion = 1

// Record is one pending message in a Snapshot.
type Record struct {
	ID       string    `json:"id"`
	Due      time.Time `json:"due"`
	Payload  any       `json:"payload,omitempty"`
	Sequence uint64    `json:"sequence,omitempty"`
}

// Snapshot contains all pending messages. Due is absolute, so restoring at a
// later instant preserves the exact remaining delay rather than restarting the
// original delay.
type Snapshot struct {
	Version int       `json:"version"`
	TakenAt time.Time `json:"taken_at"`
	Entries []Record  `json:"entries"`
}

// Snapshot returns a stable, due-ordered copy of all pending messages.
func (s *Scheduler) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()

	records := make([]Record, 0, len(s.messages))
	for _, e := range s.messages {
		if e.state != statePending {
			continue
		}
		records = append(records, Record{
			ID:       e.id,
			Due:      e.due,
			Payload:  e.payload,
			Sequence: e.sequence,
		})
	}
	sort.SliceStable(records, func(i, j int) bool {
		if !records[i].Due.Equal(records[j].Due) {
			return records[i].Due.Before(records[j].Due)
		}
		return records[i].Sequence < records[j].Sequence
	})
	return Snapshot{
		Version: SnapshotVersion,
		TakenAt: s.clock.Now(),
		Entries: records,
	}
}

// Restore rebuilds the wheel from a snapshot. The scheduler must contain no
// pending messages. Deadlines remain absolute; messages already overdue at the
// new clock time are emitted by the next Advance or Poll.
func (s *Scheduler) Restore(snapshot Snapshot) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.messages) != 0 {
		return ErrRestoreNotEmpty
	}
	if snapshot.Version != 0 && snapshot.Version != SnapshotVersion {
		return fmt.Errorf("%w: %d", ErrSnapshotVersion, snapshot.Version)
	}

	seen := make(map[string]struct{}, len(snapshot.Entries))
	var maxSequence uint64
	for _, record := range snapshot.Entries {
		if record.ID == "" {
			return ErrEmptyID
		}
		if _, ok := seen[record.ID]; ok {
			return fmt.Errorf("%w: %q", ErrDuplicateID, record.ID)
		}
		seen[record.ID] = struct{}{}
		if record.Sequence > maxSequence {
			maxSequence = record.Sequence
		}
	}

	now := s.clock.Now()
	nowNs := now.UnixNano()
	autoSequence := maxSequence
	for _, record := range snapshot.Entries {
		sequence := record.Sequence
		if sequence == 0 {
			autoSequence++
			sequence = autoSequence
		}
		e := &entry{
			id:       record.ID,
			due:      record.Due,
			dueNs:    record.Due.UnixNano(),
			payload:  record.Payload,
			sequence: sequence,
			state:    statePending,
		}
		s.messages[e.id] = e
		s.placeLocked(e, nowNs)
	}
	s.sequence = autoSequence
	s.lastNowNs = now
	s.hasNow = true
	return nil
}

// Replay is an alias for Restore.
func (s *Scheduler) Replay(snapshot Snapshot) error { return s.Restore(snapshot) }
