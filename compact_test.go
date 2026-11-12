package dataeng

import (
	"errors"
	"slices"
	"testing"
)

func TestCompactSimpleTombstoneBoundary(t *testing.T) {
	records := []Record{
		Put("a", 10, []byte("v10")),
		Delete("a", 8),
		Put("a", 6, []byte("v6")),
	}
	snapshots := []Snapshot{6, 8, 10}

	got, err := Compact(records, snapshots)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("retained %d records, want 3: %#v", len(got), got)
	}
}

func TestCompactDropsTrailingTombstone(t *testing.T) {
	records := []Record{
		Put("a", 10, []byte("v10")),
		Delete("a", 8),
	}

	got, err := Compact(records, []Snapshot{8, 10})
	if err != nil {
		t.Fatal(err)
	}
	want := []Record{Put("a", 10, []byte("v10"))}
	if !slices.EqualFunc(got, want, func(left, right Record) bool {
		return left.Key == right.Key && left.Version == right.Version &&
			left.Tombstone == right.Tombstone && string(left.Value) == string(right.Value)
	}) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestCompactDropsAllUnneededTombstones(t *testing.T) {
	records := []Record{
		Put("a", 10, []byte("old")),
		Delete("a", 8),
	}
	snapshots := []Snapshot{8, 9}

	got, err := Compact(records, snapshots)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("retained %#v, want no records", got)
	}
}

func TestCompactEqualValuesCollapseToOldestRequiredRecord(t *testing.T) {
	records := []Record{
		Put("a", 10, []byte("same")),
		Put("a", 8, []byte("same")),
		Put("a", 5, []byte("same")),
	}

	got, err := Compact(records, []Snapshot{5, 8, 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Version != 5 {
		t.Fatalf("got %#v, want only version 5", got)
	}

	got, err = Compact(records, []Snapshot{8, 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Version != 8 {
		t.Fatalf("got %#v, want the newer witness at version 8", got)
	}
}

func TestCompactEmptyInputs(t *testing.T) {
	records := []Record{Put("a", 10, []byte("v"))}
	for _, snapshots := range [][]Snapshot{nil, {}, {5}} {
		got, err := Compact(records, snapshots)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 0 {
			t.Fatalf("snapshots %v retained %#v", snapshots, got)
		}
	}

	got, err := Compact(nil, []Snapshot{1})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("empty input retained %#v", got)
	}
}

func TestCompactMultipleKeysAndOrdering(t *testing.T) {
	records := []Record{
		Put("a", 10, []byte("a10")),
		Put("a", 8, []byte("a8")),
		Put("a", 5, []byte("a5")),
		Put("b", 9, []byte("b9")),
		Delete("b", 7),
		Put("c", 6, []byte("c6")),
		Put("c", 4, []byte("c6")),
	}
	snapshots := []Snapshot{4, 5, 7, 8, 9, 10}

	got, err := Compact(records, snapshots)
	if err != nil {
		t.Fatal(err)
	}

	want := []Record{
		Put("a", 10, []byte("a10")),
		Put("a", 8, []byte("a8")),
		Put("a", 5, []byte("a5")),
		Put("b", 9, []byte("b9")),
		Put("c", 4, []byte("c6")),
	}
	if !slices.EqualFunc(got, want, func(left, right Record) bool {
		return left.Key == right.Key && left.Version == right.Version &&
			left.Tombstone == right.Tombstone && string(left.Value) == string(right.Value)
	}) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestValidateRejectsBadInput(t *testing.T) {
	tests := []struct {
		name    string
		records []Record
		want    error
	}{
		{
			name:    "keys descending",
			records: []Record{Put("b", 1, []byte("b")), Put("a", 2, []byte("a"))},
			want:    ErrUnordered,
		},
		{
			name:    "versions ascending",
			records: []Record{Put("a", 2, []byte("old")), Put("a", 3, []byte("new"))},
			want:    ErrUnordered,
		},
		{
			name:    "duplicate version conflict",
			records: []Record{Put("a", 2, []byte("left")), Put("a", 2, []byte("right"))},
			want:    ErrConflict,
		},
		{
			name:    "tombstone conflicts with value",
			records: []Record{Delete("a", 2), Put("a", 2, []byte("value"))},
			want:    ErrConflict,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Compact(test.records, []Snapshot{1}); !errors.Is(err, test.want) {
				t.Fatalf("got error %v, want %v", err, test.want)
			}
		})
	}
}

func TestValidateAcceptsIdenticalDuplicates(t *testing.T) {
	records := []Record{
		Put("a", 3, []byte("v3")),
		Put("a", 3, []byte("v3")),
		Put("a", 1, []byte("v1")),
	}
	got, err := Compact(records, []Snapshot{1, 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Version != 3 || got[1].Version != 1 {
		t.Fatalf("got %#v", got)
	}
}

// TestExhaustiveSmallVersions checks minimality against every subset of every
// record set with up to four distinct versions. Snapshots, tombstones, values,
// and record-presence combinations are all enumerated.
func TestExhaustiveSmallVersions(t *testing.T) {
	versionPool := []Version{1, 2, 3, 4}
	snapshotPool := []Snapshot{0, 1, 2, 3, 4, 5}

	for versionMask := 0; versionMask < 1<<len(versionPool); versionMask++ {
		versions := make([]Version, 0, len(versionPool))
		for bit, version := range versionPool {
			if versionMask&(1<<bit) != 0 {
				versions = append(versions, version)
			}
		}
		// Records must be in descending version order.
		slices.Reverse(versions)
		recordCount := len(versions)

		colorCount := 1
		for range recordCount {
			colorCount *= 3
		}
		for colorCode := 0; colorCode < colorCount; colorCode++ {
			records := make([]Record, recordCount)
			code := colorCode
			for index, version := range versions {
				switch code % 3 {
				case 0:
					records[index] = Put("k", version, []byte("A"))
				case 1:
					records[index] = Put("k", version, []byte("B"))
				default:
					records[index] = Delete("k", version)
				}
				code /= 3
			}

			for snapshotMask := 0; snapshotMask < 1<<len(snapshotPool); snapshotMask++ {
				snapshots := make([]Snapshot, 0, len(snapshotPool))
				for bit, snapshot := range snapshotPool {
					if snapshotMask&(1<<bit) != 0 {
						snapshots = append(snapshots, snapshot)
					}
				}

				wantSize, wantPreferred := bruteMinimum(records, snapshots)
				got, err := KeepIndices(records, snapshots)
				if err != nil {
					t.Fatalf("versions=%v colors=%v snapshots=%v: %v", versions, records, snapshots, err)
				}
				if len(got) != wantSize {
					t.Fatalf("versions=%v colors=%v snapshots=%v: retained %v (%d), minimum is %v (%d)",
						versions, records, snapshots, got, len(got), wantPreferred, wantSize)
				}
				if !slices.Equal(got, wantPreferred) {
					t.Fatalf("versions=%v colors=%v snapshots=%v: retained %v, tie-break wants %v",
						versions, records, snapshots, got, wantPreferred)
				}
				if !preserves(records, got, snapshots) {
					t.Fatalf("versions=%v colors=%v snapshots=%v: result is not preserved by %v",
						versions, records, snapshots, got)
				}
			}
		}
	}
}

// bruteMinimum returns the minimum subset size and the lexicographically
// smallest sorted index list among all minimum-size preserving subsets. Smaller
// indices are newer records, which implements the newest-witness tie-break.
func bruteMinimum(records []Record, snapshots []Snapshot) (int, []int) {
	bestSize := len(records) + 1
	var best []int
	for mask := 0; mask < 1<<len(records); mask++ {
		indices := make([]int, 0, len(records))
		for index := range records {
			if mask&(1<<index) != 0 {
				indices = append(indices, index)
			}
		}
		if !preserves(records, indices, snapshots) {
			continue
		}
		if len(indices) < bestSize || (len(indices) == bestSize && slices.Compare(indices, best) < 0) {
			bestSize = len(indices)
			best = indices
		}
	}
	return bestSize, best
}

type readResult struct {
	absent bool
	value  string
}

func preserves(records []Record, indices []int, snapshots []Snapshot) bool {
	want := answers(records, snapshots, func(index int) bool { return true })
	got := answers(records, snapshots, func(index int) bool {
		return slices.Contains(indices, index)
	})
	return slices.Equal(want, got)
}

func answers(records []Record, snapshots []Snapshot, included func(int) bool) []readResult {
	results := make([]readResult, len(snapshots))
	for snapshotIndex, snapshot := range snapshots {
		result := readResult{absent: true}
		for recordIndex, record := range records {
			if !included(recordIndex) || record.Version > snapshot {
				continue
			}
			if !record.Tombstone {
				result = readResult{value: string(record.Value)}
			}
			break
		}
		results[snapshotIndex] = result
	}
	return results
}
