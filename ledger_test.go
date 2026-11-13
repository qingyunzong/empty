package dataeng_test

import (
	"errors"
	"reflect"
	"testing"

	"example.org/dataeng13/q0010"
)

type rangeView struct {
	Start   int64
	End     int64
	Data    string
	Sources []string
}

type spanView struct {
	Start int64
	End   int64
}

type conflictView struct {
	Start           int64
	End             int64
	ExistingSources []string
	Incoming        string
}

type suffixView struct {
	Length int64
	Data   string
	Source string
}

type snapshotView struct {
	Total     int64
	Known     bool
	Ranges    []rangeView
	Holes     []spanView
	Conflicts []conflictView
	Pending   []suffixView
	Complete  bool
}

func viewOf(s dataeng.Snapshot) snapshotView {
	var v snapshotView
	v.Total = s.TotalSize
	v.Known = s.TotalKnown
	v.Complete = s.Complete
	for _, r := range s.Ranges {
		v.Ranges = append(v.Ranges, rangeView{
			Start:   r.Start,
			End:     r.End,
			Data:    string(r.Data),
			Sources: append([]string(nil), r.Sources...),
		})
	}
	for _, h := range s.Holes {
		v.Holes = append(v.Holes, spanView{Start: h.Start, End: h.End})
	}
	for _, c := range s.Conflicts {
		v.Conflicts = append(v.Conflicts, conflictView{
			Start:           c.Start,
			End:             c.End,
			ExistingSources: append([]string(nil), c.ExistingSources...),
			Incoming:        c.IncomingSource,
		})
	}
	for _, p := range s.PendingSuffixes {
		v.Pending = append(v.Pending, suffixView{
			Length: p.Length,
			Data:   string(p.Data),
			Source: p.Source,
		})
	}
	return v
}

func checkSnapshot(t *testing.T, got dataeng.Snapshot, want snapshotView) {
	t.Helper()
	if diff := viewOf(got); !reflect.DeepEqual(diff, want) {
		t.Fatalf("snapshot mismatch\n got: %#v\nwant: %#v", diff, want)
	}
}

func addSegment(t *testing.T, l *dataeng.Ledger, start, end int64, data, source string) dataeng.Outcome {
	t.Helper()
	out, err := l.AddSegment(dataeng.Segment{
		Start: start, End: end, Data: []byte(data), Source: source,
	})
	if err != nil {
		t.Fatalf("AddSegment [%d,%d) %q: %v", start, end, data, err)
	}
	return out
}

func addSuffix(t *testing.T, l *dataeng.Ledger, length int64, data, source string) dataeng.Outcome {
	t.Helper()
	out, err := l.AddSuffix(dataeng.Suffix{
		Length: length, Data: []byte(data), Source: source,
	})
	if err != nil {
		t.Fatalf("AddSuffix length %d %q: %v", length, data, err)
	}
	return out
}

func TestAdjacentAndIdenticalOverlapsMerge(t *testing.T) {
	l := dataeng.NewLedger()
	addSegment(t, l, 0, 4, "abcd", "first")
	addSegment(t, l, 4, 8, "efgh", "second")
	addSegment(t, l, 2, 6, "cdef", "third")

	checkSnapshot(t, l.Snapshot(), snapshotView{
		Ranges: []rangeView{{
			Start: 0, End: 8, Data: "abcdefgh",
			Sources: []string{"first", "second", "third"},
		}},
	})

	if err := l.SetTotalSize(8); err != nil {
		t.Fatal(err)
	}
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Total: 8, Known: true, Complete: true,
		Ranges: []rangeView{{
			Start: 0, End: 8, Data: "abcdefgh",
			Sources: []string{"first", "second", "third"},
		}},
	})
}

func TestConflictRejectsWholeSegmentAndRetainsSources(t *testing.T) {
	l := dataeng.NewLedger()
	addSegment(t, l, 0, 8, "abcdefgh", "base")

	out := addSegment(t, l, 4, 10, "efXXij", "incoming")
	if out.Accepted {
		t.Fatal("conflicting segment was accepted")
	}
	if len(out.Conflicts) != 1 {
		t.Fatalf("got %d conflicts, want 1", len(out.Conflicts))
	}
	if c := out.Conflicts[0]; c.Start != 6 || c.End != 8 ||
		!reflect.DeepEqual(c.ExistingSources, []string{"base"}) || c.IncomingSource != "incoming" {
		t.Fatalf("unexpected conflict: %#v", c)
	}

	// The non-overlapping tail of the rejected segment must not be installed.
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Ranges: []rangeView{{
			Start: 0, End: 8, Data: "abcdefgh", Sources: []string{"base"},
		}},
		Conflicts: []conflictView{{
			Start: 6, End: 8, ExistingSources: []string{"base"}, Incoming: "incoming",
		}},
	})

	addSegment(t, l, 8, 10, "ij", "tail")
	if err := l.SetTotalSize(10); err != nil {
		t.Fatal(err)
	}
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Total: 10, Known: true,
		Ranges: []rangeView{{
			Start: 0, End: 10, Data: "abcdefghij",
			Sources: []string{"base", "tail"},
		}},
		Conflicts: []conflictView{{
			Start: 6, End: 8, ExistingSources: []string{"base"}, Incoming: "incoming",
		}},
	})
}

func TestMiddleHoleIsNotZeroFilled(t *testing.T) {
	l := dataeng.NewLedger()
	addSegment(t, l, 0, 4, "abcd", "head")
	addSegment(t, l, 8, 12, "ijkl", "tail")

	checkSnapshot(t, l.Snapshot(), snapshotView{
		Ranges: []rangeView{
			{Start: 0, End: 4, Data: "abcd", Sources: []string{"head"}},
			{Start: 8, End: 12, Data: "ijkl", Sources: []string{"tail"}},
		},
		Holes: []spanView{{Start: 4, End: 8}},
	})

	if err := l.SetTotalSize(12); err != nil {
		t.Fatal(err)
	}
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Total: 12, Known: true,
		Ranges: []rangeView{
			{Start: 0, End: 4, Data: "abcd", Sources: []string{"head"}},
			{Start: 8, End: 12, Data: "ijkl", Sources: []string{"tail"}},
		},
		Holes: []spanView{{Start: 4, End: 8}},
	})

	addSegment(t, l, 4, 8, "efgh", "middle")
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Total: 12, Known: true, Complete: true,
		Ranges: []rangeView{{
			Start: 0, End: 12, Data: "abcdefghijkl",
			Sources: []string{"head", "middle", "tail"},
		}},
	})
}

func TestSuffixWaitsForKnownTotal(t *testing.T) {
	l := dataeng.NewLedger()
	out := addSuffix(t, l, 4, "wxyz", "tail")
	if !out.Accepted || !out.Pending {
		t.Fatalf("unexpected suffix outcome: %#v", out)
	}
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Pending: []suffixView{{Length: 4, Data: "wxyz", Source: "tail"}},
	})

	if err := l.SetTotalSize(10); err != nil {
		t.Fatal(err)
	}
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Total: 10, Known: true,
		Ranges: []rangeView{{Start: 6, End: 10, Data: "wxyz", Sources: []string{"tail"}}},
		Holes:  []spanView{{Start: 0, End: 6}},
	})

	addSegment(t, l, 0, 6, "abcdef", "head")
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Total: 10, Known: true, Complete: true,
		Ranges: []rangeView{{
			Start: 0, End: 10, Data: "abcdefwxyz",
			Sources: []string{"head", "tail"},
		}},
	})
}

func TestPendingSuffixConflictIsRecorded(t *testing.T) {
	l := dataeng.NewLedger()
	addSegment(t, l, 6, 10, "GHIJ", "existing")
	addSuffix(t, l, 4, "wxyz", "suffix")

	if err := l.SetTotalSize(10); err != nil {
		t.Fatal(err)
	}
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Total: 10, Known: true,
		Ranges: []rangeView{{Start: 6, End: 10, Data: "GHIJ", Sources: []string{"existing"}}},
		Holes:  []spanView{{Start: 0, End: 6}},
		Conflicts: []conflictView{{
			Start: 6, End: 10, ExistingSources: []string{"existing"}, Incoming: "suffix",
		}},
	})

	addSegment(t, l, 0, 6, "abcdef", "head")
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Total: 10, Known: true,
		Ranges: []rangeView{{
			Start: 0, End: 10, Data: "abcdefGHIJ",
			Sources: []string{"existing", "head"},
		}},
		Conflicts: []conflictView{{
			Start: 6, End: 10, ExistingSources: []string{"existing"}, Incoming: "suffix",
		}},
	})
}

func TestSetTotalRejectsCoveredTailContradiction(t *testing.T) {
	l := dataeng.NewLedger()
	addSegment(t, l, 0, 10, "0123456789", "all")

	err := l.SetTotalSize(8)
	if !errors.Is(err, dataeng.ErrTotalConflict) {
		t.Fatalf("got error %v, want ErrTotalConflict", err)
	}
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Ranges: []rangeView{{
			Start: 0, End: 10, Data: "0123456789", Sources: []string{"all"},
		}},
	})

	if err := l.SetTotalSize(10); err != nil {
		t.Fatal(err)
	}
	if !l.Snapshot().Complete {
		t.Fatal("expected complete ledger")
	}
}

func TestSetTotalRejectsPendingSuffixLongerThanTotal(t *testing.T) {
	l := dataeng.NewLedger()
	addSuffix(t, l, 5, "abcde", "suffix")

	err := l.SetTotalSize(3)
	if !errors.Is(err, dataeng.ErrSuffixExceedsTotal) {
		t.Fatalf("got error %v, want ErrSuffixExceedsTotal", err)
	}
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Pending: []suffixView{{Length: 5, Data: "abcde", Source: "suffix"}},
	})

	if err := l.SetTotalSize(5); err != nil {
		t.Fatal(err)
	}
	if snap := l.Snapshot(); !snap.Complete || len(snap.Ranges) != 1 ||
		snap.Ranges[0].Start != 0 || snap.Ranges[0].End != 5 {
		t.Fatalf("unexpected snapshot after valid total: %#v", snap)
	}
}

func TestSuffixWithKnownTotal(t *testing.T) {
	l := dataeng.NewLedger()
	if err := l.SetTotalSize(10); err != nil {
		t.Fatal(err)
	}
	addSuffix(t, l, 2, "yz", "suffix")
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Total: 10, Known: true,
		Ranges: []rangeView{{Start: 8, End: 10, Data: "yz", Sources: []string{"suffix"}}},
		Holes:  []spanView{{Start: 0, End: 8}},
	})

	_, err := l.AddSuffix(dataeng.Suffix{Length: 11, Data: []byte("0123456789x"), Source: "too-long"})
	if !errors.Is(err, dataeng.ErrSuffixExceedsTotal) {
		t.Fatalf("got error %v, want ErrSuffixExceedsTotal", err)
	}
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Total: 10, Known: true,
		Ranges: []rangeView{{Start: 8, End: 10, Data: "yz", Sources: []string{"suffix"}}},
		Holes:  []spanView{{Start: 0, End: 8}},
	})
}

func TestTotalSizeCanOnlyBeSetOnce(t *testing.T) {
	l := dataeng.NewLedger()
	if err := l.SetTotalSize(4); err != nil {
		t.Fatal(err)
	}
	if err := l.SetTotalSize(4); err != nil {
		t.Fatalf("re-setting same total: %v", err)
	}
	if err := l.SetTotalSize(5); !errors.Is(err, dataeng.ErrTotalAlreadyKnown) {
		t.Fatalf("got error %v, want ErrTotalAlreadyKnown", err)
	}
}

func TestRangeBeyondKnownTotalIsRejected(t *testing.T) {
	l := dataeng.NewLedger()
	if err := l.SetTotalSize(4); err != nil {
		t.Fatal(err)
	}

	_, err := l.AddSegment(dataeng.Segment{Start: 0, End: 6, Data: []byte("abcdef"), Source: "x"})
	if !errors.Is(err, dataeng.ErrRangeBeyondTotal) {
		t.Fatalf("got error %v, want ErrRangeBeyondTotal", err)
	}
	checkSnapshot(t, l.Snapshot(), snapshotView{
		Total: 4, Known: true,
		Holes: []spanView{{Start: 0, End: 4}},
	})

	addSegment(t, l, 0, 4, "abcd", "x")
	if !l.Snapshot().Complete {
		t.Fatal("expected complete ledger")
	}
}

func TestEmptyContentIsComplete(t *testing.T) {
	l := dataeng.NewLedger()
	if err := l.SetTotalSize(0); err != nil {
		t.Fatal(err)
	}
	if !l.Snapshot().Complete {
		t.Fatal("zero-length known content should be complete")
	}
}

func TestInvalidInputs(t *testing.T) {
	l := dataeng.NewLedger()
	tests := []struct {
		name string
		call func() error
		want error
	}{
		{
			name: "negative start",
			call: func() error {
				_, err := l.AddSegment(dataeng.Segment{Start: -1, End: 2, Data: []byte("abc")})
				return err
			},
			want: dataeng.ErrInvalidSegment,
		},
		{
			name: "reversed segment",
			call: func() error {
				_, err := l.AddSegment(dataeng.Segment{Start: 4, End: 2, Data: nil})
				return err
			},
			want: dataeng.ErrInvalidSegment,
		},
		{
			name: "segment length mismatch",
			call: func() error {
				_, err := l.AddSegment(dataeng.Segment{Start: 0, End: 3, Data: []byte("ab")})
				return err
			},
			want: dataeng.ErrInvalidSegment,
		},
		{
			name: "negative suffix",
			call: func() error {
				_, err := l.AddSuffix(dataeng.Suffix{Length: -1})
				return err
			},
			want: dataeng.ErrInvalidSuffix,
		},
		{
			name: "suffix length mismatch",
			call: func() error {
				_, err := l.AddSuffix(dataeng.Suffix{Length: 3, Data: []byte("ab")})
				return err
			},
			want: dataeng.ErrInvalidSuffix,
		},
		{
			name: "negative total",
			call: func() error {
				return l.SetTotalSize(-1)
			},
			want: dataeng.ErrInvalidTotal,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.call(); !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
	if snap := l.Snapshot(); len(snap.Ranges) != 0 || len(snap.Conflicts) != 0 {
		t.Fatalf("invalid input changed ledger: %#v", snap)
	}
}

func TestSnapshotAndInputAreCopied(t *testing.T) {
	l := dataeng.NewLedger()
	data := []byte("abcd")
	addSegment(t, l, 0, 4, string(data), "src")
	data[0] = 'X'

	snap := l.Snapshot()
	if string(snap.Ranges[0].Data) != "abcd" {
		t.Fatalf("ledger retained caller input: %q", snap.Ranges[0].Data)
	}
	snap.Ranges[0].Data[0] = 'Y'
	snap.Ranges[0].Sources[0] = "mutated"

	again := l.Snapshot()
	if string(again.Ranges[0].Data) != "abcd" || again.Ranges[0].Sources[0] != "src" {
		t.Fatalf("snapshot mutated ledger: %#v", again)
	}
}

func TestDuplicateRangeIsIdempotent(t *testing.T) {
	l := dataeng.NewLedger()
	addSegment(t, l, 0, 4, "abcd", "src")
	addSegment(t, l, 0, 4, "abcd", "src")
	addSegment(t, l, 0, 4, "abcd", "other")

	checkSnapshot(t, l.Snapshot(), snapshotView{
		Ranges: []rangeView{{
			Start: 0, End: 4, Data: "abcd", Sources: []string{"other", "src"},
		}},
	})
}
