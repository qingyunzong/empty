package dataeng

import (
	"crypto/sha256"
	"sort"
)

type snapshotState struct {
	versions map[string]uint64
	manifest map[string]RecordRef
}

func newSnapshotState() *snapshotState {
	return &snapshotState{
		versions: make(map[string]uint64),
		manifest: make(map[string]RecordRef),
	}
}

// selectNew filters records that are at or below the highest version already
// accepted for the same application record ID. The state is not changed until
// commit is called, so a failed sink write can be retried.
func (s *snapshotState) selectNew(records []Record) ([]Record, []RecordRef, int, error) {
	selected := make([]Record, 0, len(records))
	refs := make([]RecordRef, 0, len(records))
	staged := make(map[string]uint64, len(records))
	duplicates := 0

	for _, record := range records {
		if err := record.validate(); err != nil {
			return nil, nil, duplicates, err
		}

		best, seen := s.versions[record.ID]
		if stagedVersion, ok := staged[record.ID]; ok {
			best, seen = stagedVersion, true
		}
		if seen && record.Version <= best {
			duplicates++
			continue
		}

		staged[record.ID] = record.Version
		selected = append(selected, cloneRecord(record))
		refs = append(refs, RecordRef{
			ID:      record.ID,
			Version: record.Version,
			Digest:  sha256.Sum256(record.Data),
		})
	}

	return selected, refs, duplicates, nil
}

func (s *snapshotState) commit(records []Record, refs []RecordRef) {
	for i, record := range records {
		s.versions[record.ID] = record.Version
		s.manifest[record.ID] = refs[i]
	}
}

func (s *snapshotState) manifestCopy() map[string]RecordRef {
	copied := make(map[string]RecordRef, len(s.manifest))
	for id, ref := range s.manifest {
		copied[id] = ref
	}
	return copied
}

func cloneRecord(record Record) Record {
	cloned := Record{
		ID:      record.ID,
		Version: record.Version,
	}
	if record.Data != nil {
		cloned.Data = append([]byte(nil), record.Data...)
	}
	return cloned
}

func reconcile(previousSnapshotID, snapshotID string, previous, current map[string]RecordRef) Reconciliation {
	result := Reconciliation{
		PreviousSnapshotID: previousSnapshotID,
		SnapshotID:         snapshotID,
	}

	ids := make([]string, 0, len(previous)+len(current))
	seen := make(map[string]struct{}, len(previous)+len(current))
	for id := range previous {
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	for id := range current {
		if _, ok := seen[id]; !ok {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)

	for _, id := range ids {
		before, hadBefore := previous[id]
		after, hasAfter := current[id]
		switch {
		case !hadBefore:
			result.Added = append(result.Added, after)
		case !hasAfter:
			result.Removed = append(result.Removed, before)
		case before.Version != after.Version || before.Digest != after.Digest:
			result.Changed = append(result.Changed, RecordChange{Before: before, After: after})
		default:
			result.Unchanged++
		}
	}

	return result
}
