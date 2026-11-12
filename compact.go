package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"slices"
	"sort"
)

// Version is the sequence number stored with a record. Larger versions are
// newer.
type Version = uint64

// Snapshot is a version at which reads must remain possible.
type Snapshot = uint64

// Key is an LSM key. Keys are ordered using Go's ordinary string comparison,
// which is byte-wise lexicographic ordering.
type Key = string

// Value is an opaque record value.
type Value = []byte

// Record is one version of a key value.
//
// Tombstone marks a deletion. A read that reaches a tombstone observes the key
// as absent. The Value of a tombstone is ignored when comparing duplicate
// records; all tombstones have the same visible result.
type Record struct {
	Key       Key
	Version   Version
	Value     Value
	Tombstone bool
}

var (
	// ErrUnordered is returned when records are not ordered by ascending key
	// and, within a key, by descending version.
	ErrUnordered = errors.New("dataeng: records are not ordered by ascending key and descending version")

	// ErrConflict is returned when the same key and version occurs more than
	// once with different contents.
	ErrConflict = errors.New("dataeng: conflicting values for the same key and version")
)

// Put returns a live record.
func Put(key Key, version Version, value Value) Record {
	return Record{Key: key, Version: version, Value: value}
}

// Delete returns a tombstone record.
func Delete(key Key, version Version) Record {
	return Record{Key: key, Version: version, Tombstone: true}
}

// Compact returns the smallest subset of records that produces the same read
// result as records for every key at every snapshot.
//
// The returned records keep their input order. The input is not modified.
func Compact(records []Record, snapshots []Snapshot) ([]Record, error) {
	keep, err := KeepIndices(records, snapshots)
	if err != nil {
		return nil, err
	}

	retained := make([]Record, 0, len(keep))
	for _, index := range keep {
		retained = append(retained, records[index])
	}
	return retained, nil
}

// KeepIndices returns the ascending input indices of a smallest subset of
// records that preserves every snapshot read.
//
// When several smallest subsets exist, each run of equal visible values is
// represented by the newest record that can cover the entire run. This is the
// tie-break rule used by Compact.
func KeepIndices(records []Record, snapshots []Snapshot) ([]int, error) {
	if err := validate(records); err != nil {
		return nil, err
	}
	if len(records) == 0 || len(snapshots) == 0 {
		return []int{}, nil
	}

	snaps := append([]Snapshot(nil), snapshots...)
	slices.Sort(snaps)
	snaps = slices.Compact(snaps)

	keep := make([]bool, len(records))
	for start := 0; start < len(records); {
		end := start + 1
		for end < len(records) && records[end].Key == records[start].Key {
			end++
		}
		keepKey(records, start, end, snaps, keep)
		start = end
	}

	indices := make([]int, 0, len(records))
	for index, retained := range keep {
		if retained {
			indices = append(indices, index)
		}
	}
	return indices, nil
}

func validate(records []Record) error {
	for index := 1; index < len(records); index++ {
		previous := records[index-1]
		current := records[index]

		if current.Key < previous.Key {
			return fmt.Errorf("%w: key %q follows %q", ErrUnordered, current.Key, previous.Key)
		}
		if current.Key != previous.Key {
			continue
		}
		if current.Version > previous.Version {
			return fmt.Errorf("%w: key %q has version %d after %d", ErrUnordered, current.Key, current.Version, previous.Version)
		}
		if current.Version == previous.Version && !sameContent(previous, current) {
			return fmt.Errorf("%w: key %q version %d", ErrConflict, current.Key, current.Version)
		}
	}
	return nil
}

func sameContent(left, right Record) bool {
	if left.Tombstone != right.Tombstone {
		return false
	}
	if left.Tombstone {
		return true
	}
	return bytes.Equal(left.Value, right.Value)
}

// keepKey marks the records of one key that must be retained.
//
// For a snapshot, the first record at or below the snapshot is its answer.
// Recording those answers in increasing record-index order produces a sequence
// of visible values. A maximal run of equal values needs one witness: its last
// (oldest) group record is the newest record that can cover the whole run.
//
// The oldest absent answers are special. Once every older group has been
// dropped, those snapshots already observe absence because no retained record
// is old enough to answer them. Keeping a tombstone there would not be minimal.
func keepKey(records []Record, start, end int, snapshots []Snapshot, keep []bool) {
	group := records[start:end]

	// Snapshot order is ascending, so answer indices are non-increasing.
	groups := make([]int, 0, len(snapshots))
	previous := -1
	for _, snapshot := range snapshots {
		index := sort.Search(len(group), func(index int) bool {
			return group[index].Version <= snapshot
		})
		if index == len(group) || index == previous {
			continue
		}
		groups = append(groups, index)
		previous = index
	}
	if len(groups) == 0 {
		return
	}

	// groups starts with the oldest answers. Strip those absent groups:
	// no retained record will be old enough to answer their snapshots, so their
	// absence is preserved for free.
	for len(groups) > 0 && visibleOf(group[groups[0]]).absent {
		groups = groups[1:]
	}
	if len(groups) == 0 {
		return
	}

	// groups was collected oldest-to-newest; walk it newest-to-oldest so that
	// equal adjacent values form runs and the run's last (oldest) group is
	// selected.
	runEnd := -1
	var runColor visible
	for index := len(groups) - 1; index >= 0; index-- {
		groupIndex := groups[index]
		color := visibleOf(group[groupIndex])
		switch {
		case runEnd < 0:
			runEnd, runColor = groupIndex, color
		case color.equal(runColor):
			runEnd = groupIndex
		default:
			keep[start+runEnd] = true
			runEnd, runColor = groupIndex, color
		}
	}
	keep[start+runEnd] = true
}

// visible is the result a reader observes for a key.
type visible struct {
	absent bool
	value  Value
}

func visibleOf(record Record) visible {
	if record.Tombstone {
		return visible{absent: true}
	}
	return visible{value: record.Value}
}

func (left visible) equal(right visible) bool {
	if left.absent || right.absent {
		return left.absent == right.absent
	}
	return bytes.Equal(left.value, right.value)
}
