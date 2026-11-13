package dataeng_test

import (
	"errors"
	"slices"
	"testing"

	"example.org/dataeng13/q0010"
)

// oracle is deliberately independent from the package under test. It stores
// one cell per covered byte and derives ranges, holes, and completeness by
// scanning positions, rather than by using the package's interval algebra.
type oracle struct {
	total      int64
	totalKnown bool
	cells      map[int64]oracleCell
	conflicts  []conflictView
	pending    []suffixView
}

type oracleCell struct {
	value   byte
	sources map[string]struct{}
}

func newOracle() *oracle {
	return &oracle{cells: make(map[int64]oracleCell)}
}

func (o *oracle) addSegment(start, end int64, data, source string) bool {
	var conflicts []conflictView
	runStart := int64(-1)
	runEnd := int64(-1)
	runSources := map[string]struct{}{}
	flush := func() {
		if runStart < 0 {
			return
		}
		sources := make([]string, 0, len(runSources))
		for s := range runSources {
			sources = append(sources, s)
		}
		slices.Sort(sources)
		conflicts = append(conflicts, conflictView{
			Start: runStart, End: runEnd, ExistingSources: sources, Incoming: source,
		})
		runStart = -1
		runSources = map[string]struct{}{}
	}

	for pos := start; pos < end; pos++ {
		cell, covered := o.cells[pos]
		if covered && cell.value != data[pos-start] {
			if runStart < 0 {
				runStart = pos
			}
			runEnd = pos + 1
			for s := range cell.sources {
				runSources[s] = struct{}{}
			}
			continue
		}
		flush()
	}
	flush()

	if len(conflicts) > 0 {
		o.conflicts = append(o.conflicts, conflicts...)
		return false
	}
	for pos := start; pos < end; pos++ {
		cell, covered := o.cells[pos]
		if covered {
			cell.sources[source] = struct{}{}
			o.cells[pos] = cell
			continue
		}
		o.cells[pos] = oracleCell{
			value:   data[pos-start],
			sources: map[string]struct{}{source: {}},
		}
	}
	return true
}

func (o *oracle) addSuffix(length int64, data, source string) {
	if !o.totalKnown {
		o.pending = append(o.pending, suffixView{
			Length: length, Data: data, Source: source,
		})
		return
	}
	if length > o.total {
		panic("oracle test used an oversized suffix")
	}
	o.addSegment(o.total-length, o.total, data, source)
}

func (o *oracle) setTotal(total int64) error {
	if o.totalKnown || total < 0 {
		return errors.New("oracle: invalid total")
	}
	if o.maxEnd() > total {
		return errors.New("oracle: total conflicts with covered content")
	}
	for _, p := range o.pending {
		if p.Length > total {
			return errors.New("oracle: suffix exceeds total")
		}
	}
	o.total = total
	o.totalKnown = true
	pending := o.pending
	o.pending = nil
	for _, p := range pending {
		o.addSegment(total-p.Length, total, p.Data, p.Source)
	}
	return nil
}

func (o *oracle) maxEnd() int64 {
	var maxEnd int64
	for pos := range o.cells {
		if pos+1 > maxEnd {
			maxEnd = pos + 1
		}
	}
	return maxEnd
}

func (o *oracle) snapshot() snapshotView {
	var out snapshotView
	out.Total = o.total
	out.Known = o.totalKnown
	out.Conflicts = append([]conflictView(nil), o.conflicts...)
	out.Pending = append([]suffixView(nil), o.pending...)

	positions := make([]int64, 0, len(o.cells))
	for pos := range o.cells {
		positions = append(positions, pos)
	}
	slices.Sort(positions)
	for i := 0; i < len(positions); {
		start := positions[i]
		sourceSet := map[string]struct{}{}
		for s := range o.cells[start].sources {
			sourceSet[s] = struct{}{}
		}
		i++
		for i < len(positions) && positions[i] == positions[i-1]+1 {
			for s := range o.cells[positions[i]].sources {
				sourceSet[s] = struct{}{}
			}
			i++
		}
		sources := make([]string, 0, len(sourceSet))
		for s := range sourceSet {
			sources = append(sources, s)
		}
		slices.Sort(sources)
		out.Ranges = append(out.Ranges, rangeView{
			Start: start, End: positions[i-1] + 1,
			Sources: sources,
		})
	}

	// Rebuild each range's bytes from the per-position cells. This keeps the
	// interval derivation independent from the package's merged byte buffers.
	for i := range out.Ranges {
		var data []byte
		for pos := out.Ranges[i].Start; pos < out.Ranges[i].End; pos++ {
			data = append(data, o.cells[pos].value)
		}
		out.Ranges[i].Data = string(data)
	}

	domainEnd := int64(0)
	if o.totalKnown {
		domainEnd = o.total
	} else {
		domainEnd = o.maxEnd()
	}
	holeStart := int64(-1)
	for pos := int64(0); pos < domainEnd; pos++ {
		_, covered := o.cells[pos]
		if !covered && holeStart < 0 {
			holeStart = pos
		}
		if covered && holeStart >= 0 {
			out.Holes = append(out.Holes, spanView{Start: holeStart, End: pos})
			holeStart = -1
		}
	}
	if holeStart >= 0 {
		out.Holes = append(out.Holes, spanView{Start: holeStart, End: domainEnd})
	}

	out.Complete = o.totalKnown && len(o.conflicts) == 0
	if out.Complete {
		for pos := int64(0); pos < o.total; pos++ {
			if _, covered := o.cells[pos]; !covered {
				out.Complete = false
				break
			}
		}
	}
	return out
}

func checkAgainstOracle(t *testing.T, l *dataeng.Ledger, o *oracle) {
	t.Helper()
	checkSnapshot(t, l.Snapshot(), o.snapshot())
}

func TestOracleSuffixMergeAndLateConflict(t *testing.T) {
	l := dataeng.NewLedger()
	o := newOracle()

	if out := addSuffix(t, l, 2, "yz", "tail"); !out.Pending {
		t.Fatalf("expected pending suffix, got %#v", out)
	}
	o.addSuffix(2, "yz", "tail")
	checkAgainstOracle(t, l, o)

	addSegment(t, l, 0, 4, "abcd", "head")
	o.addSegment(0, 4, "abcd", "head")
	checkAgainstOracle(t, l, o)

	addSegment(t, l, 4, 6, "ef", "middle")
	o.addSegment(4, 6, "ef", "middle")
	checkAgainstOracle(t, l, o)

	addSegment(t, l, 2, 6, "cdef", "overlap")
	o.addSegment(2, 6, "cdef", "overlap")
	checkAgainstOracle(t, l, o)

	if err := l.SetTotalSize(8); err != nil {
		t.Fatal(err)
	}
	if err := o.setTotal(8); err != nil {
		t.Fatal(err)
	}
	checkAgainstOracle(t, l, o)

	// A conflict after the ledger became complete must reject the incoming
	// segment and permanently leave Complete false.
	addSegment(t, l, 0, 3, "ABC", "late")
	o.addSegment(0, 3, "ABC", "late")
	checkAgainstOracle(t, l, o)
	if l.Snapshot().Complete {
		t.Fatal("ledger with a recorded conflict must not be complete")
	}
}

func TestOracleUnknownTotalHoles(t *testing.T) {
	l := dataeng.NewLedger()
	o := newOracle()

	addSegment(t, l, 2, 5, "cde", "left")
	o.addSegment(2, 5, "cde", "left")
	checkAgainstOracle(t, l, o)

	addSegment(t, l, 8, 10, "ij", "right")
	o.addSegment(8, 10, "ij", "right")
	checkAgainstOracle(t, l, o)

	addSegment(t, l, 5, 8, "fgh", "center")
	o.addSegment(5, 8, "fgh", "center")
	checkAgainstOracle(t, l, o)

	if err := l.SetTotalSize(12); err != nil {
		t.Fatal(err)
	}
	if err := o.setTotal(12); err != nil {
		t.Fatal(err)
	}
	checkAgainstOracle(t, l, o)

	addSegment(t, l, 0, 2, "ab", "left")
	o.addSegment(0, 2, "ab", "left")
	checkAgainstOracle(t, l, o)

	addSegment(t, l, 10, 11, "k", "final")
	o.addSegment(10, 11, "k", "final")
	checkAgainstOracle(t, l, o)

	addSegment(t, l, 11, 12, "l", "final")
	o.addSegment(11, 12, "l", "final")
	checkAgainstOracle(t, l, o)
	if l.Snapshot().Complete != o.snapshot().Complete {
		t.Fatal("completeness differs from oracle")
	}
}

func TestOracleConflictWithinSuffix(t *testing.T) {
	l := dataeng.NewLedger()
	o := newOracle()

	addSegment(t, l, 4, 10, "ghijkl", "existing")
	o.addSegment(4, 10, "ghijkl", "existing")
	checkAgainstOracle(t, l, o)

	addSuffix(t, l, 4, "wxyz", "suffix")
	o.addSuffix(4, "wxyz", "suffix")
	checkAgainstOracle(t, l, o)

	if err := l.SetTotalSize(10); err != nil {
		t.Fatal(err)
	}
	if err := o.setTotal(10); err != nil {
		t.Fatal(err)
	}
	checkAgainstOracle(t, l, o)

	addSegment(t, l, 0, 4, "abcd", "head")
	o.addSegment(0, 4, "abcd", "head")
	checkAgainstOracle(t, l, o)

	addSegment(t, l, 0, 4, "abXd", "retry")
	o.addSegment(0, 4, "abXd", "retry")
	checkAgainstOracle(t, l, o)
}
