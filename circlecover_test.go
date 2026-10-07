package circlecover_test

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"

	"circlecover"
)

// --- Independent point-by-point model -------------------------------------

// model is a brute-force reference: it stores sectors verbatim and answers
// every query by visiting individual units.
type model struct {
	mod   int64
	ids   map[circlecover.ID]bool
	full  map[circlecover.ID]bool
	start map[circlecover.ID]int64
	end   map[circlecover.ID]int64
}

func newModel(mod int64) *model {
	return &model{
		mod:   mod,
		ids:   make(map[circlecover.ID]bool),
		full:  make(map[circlecover.ID]bool),
		start: make(map[circlecover.ID]int64),
		end:   make(map[circlecover.ID]int64),
	}
}

func (m *model) covers(id circlecover.ID, p int64) bool {
	if m.full[id] {
		return true
	}
	s, e := m.start[id], m.end[id]
	if s < e {
		return p >= s && p < e
	}
	return p >= s || p < e
}

func (m *model) coverage(p int64) int {
	n := 0
	for id := range m.ids {
		if m.covers(id, p) {
			n++
		}
	}
	return n
}

// bestSegment enumerates every unit as a candidate start and extends it as
// far as coverage stays >= k, then keeps the longest (ties: smallest start).
func (m *model) bestSegment(k int) (length, start int64, full, ok bool) {
	allQualify := true
	for p := int64(0); p < m.mod; p++ {
		if m.coverage(p) < k {
			allQualify = false
			break
		}
	}
	if allQualify {
		return m.mod, 0, true, true
	}
	bestLen := int64(-1)
	bestStart := int64(0)
	for s := int64(0); s < m.mod; s++ {
		l := int64(0)
		for l < m.mod && m.coverage((s+l)%m.mod) >= k {
			l++
		}
		if l > bestLen {
			bestLen, bestStart = l, s
		}
	}
	if bestLen <= 0 {
		return 0, 0, false, false
	}
	return bestLen, bestStart, false, true
}

// sourcesOf lists IDs covering at least one unit of arc [start, end).
func (m *model) sourcesOf(full bool, start, end int64) []circlecover.ID {
	var ids []circlecover.ID
	for id := range m.ids {
		hit := false
		if full {
			hit = true
		} else {
			for l := int64(0); l < m.mod && !hit; l++ {
				p := (start + l) % m.mod
				inArc := (end - start + m.mod) % m.mod
				if l < inArc && m.covers(id, p) {
					hit = true
				}
			}
		}
		if hit {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// --- Deterministic rule tests ----------------------------------------------

func TestClosedOpenRule(t *testing.T) {
	c, err := circlecover.New(10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Add(3, 6); err != nil {
		t.Fatal(err)
	}
	want := map[int64]int{2: 0, 3: 1, 4: 1, 5: 1, 6: 0}
	for p, w := range want {
		got, err := c.CoverageAt(p)
		if err != nil {
			t.Fatal(err)
		}
		if got != w {
			t.Errorf("CoverageAt(%d) = %d, want %d (arc [3,6) contains 3, excludes 6)", p, got, w)
		}
	}
}

func TestZeroCrossingSplit(t *testing.T) {
	c, _ := circlecover.New(10)
	if _, err := c.Add(8, 2); err != nil {
		t.Fatal(err)
	}
	want := map[int64]int{7: 0, 8: 1, 9: 1, 0: 1, 1: 1, 2: 0}
	for p, w := range want {
		got, _ := c.CoverageAt(p)
		if got != w {
			t.Errorf("CoverageAt(%d) = %d, want %d (arc [8,2) wraps across zero)", p, got, w)
		}
	}
}

func TestFullCircleSeparateEncoding(t *testing.T) {
	c, _ := circlecover.New(4)
	if _, err := c.Add(1, 1); err != circlecover.ErrDegenerate {
		t.Fatalf("Add(1,1) err = %v, want ErrDegenerate", err)
	}
	id := c.AddFull()
	for p := int64(0); p < 4; p++ {
		if got, _ := c.CoverageAt(p); got != 1 {
			t.Fatalf("CoverageAt(%d) = %d, want 1 for full circle", p, got)
		}
	}
	seg, ok := c.MaxSegment(1)
	if !ok || !seg.Full || seg.Length != 4 {
		t.Fatalf("MaxSegment(1) = %+v, %v; want full circle of length 4", seg, ok)
	}
	if !reflect.DeepEqual(seg.Sources, []circlecover.ID{id}) {
		t.Fatalf("Sources = %v, want [%v]", seg.Sources, id)
	}
}

func TestAddRemoveAndValidation(t *testing.T) {
	if _, err := circlecover.New(1); err == nil {
		t.Fatal("New(1) should fail")
	}
	c, _ := circlecover.New(8)
	if _, err := c.Add(-1, 3); err == nil {
		t.Fatal("Add(-1,3) should fail")
	}
	if _, err := c.Add(3, 8); err == nil {
		t.Fatal("Add(3,8) should fail: end out of range")
	}
	id, _ := c.Add(2, 5)
	if c.Len() != 1 {
		t.Fatalf("Len = %d, want 1", c.Len())
	}
	if !c.Remove(id) || c.Remove(id) {
		t.Fatal("Remove should succeed once and then report false")
	}
	if got, _ := c.CoverageAt(3); got != 0 {
		t.Fatalf("CoverageAt(3) = %d after removal, want 0", got)
	}
}

func TestMaxSegmentWrapsAcrossZero(t *testing.T) {
	c, _ := circlecover.New(10)
	a, _ := c.Add(8, 2) // covers 8,9,0,1
	c.Add(4, 6)         // covers 4,5
	seg, ok := c.MaxSegment(1)
	if !ok {
		t.Fatal("MaxSegment(1) not found")
	}
	if seg.Full || seg.Start != 8 || seg.End != 2 || seg.Length != 4 {
		t.Fatalf("segment = %+v, want wrapping [8,2) of length 4", seg)
	}
	if !reflect.DeepEqual(seg.Sources, []circlecover.ID{a}) {
		t.Fatalf("Sources = %v, want [%v]", seg.Sources, a)
	}
}

func TestMaxSegmentAtLeastK(t *testing.T) {
	c, _ := circlecover.New(12)
	x, _ := c.Add(0, 6)
	y, _ := c.Add(3, 9)
	c.Add(10, 11) // isolated, irrelevant
	seg, ok := c.MaxSegment(2)
	if !ok {
		t.Fatal("MaxSegment(2) not found")
	}
	if seg.Start != 3 || seg.End != 6 || seg.Length != 3 {
		t.Fatalf("segment = %+v, want [3,6) of length 3 (overlap of two arcs)", seg)
	}
	if !reflect.DeepEqual(seg.Sources, []circlecover.ID{x, y}) {
		t.Fatalf("Sources = %v, want [%v %v]", seg.Sources, x, y)
	}
	if _, ok := c.MaxSegment(3); ok {
		t.Fatal("MaxSegment(3) should not exist with only 2 overlapping sectors")
	}
	if _, ok := c.MaxSegment(0); ok {
		t.Fatal("MaxSegment(0) should be rejected")
	}
}

func TestMaxSegmentFullViaStackedArcs(t *testing.T) {
	c, _ := circlecover.New(6)
	a, _ := c.Add(0, 4)
	b, _ := c.Add(3, 2) // wraps: 3,4,5,0,1
	seg, ok := c.MaxSegment(1)
	if !ok || !seg.Full || seg.Length != 6 {
		t.Fatalf("segment = %+v, %v; want full circle (arcs jointly cover all units)", seg, ok)
	}
	if !reflect.DeepEqual(seg.Sources, []circlecover.ID{a, b}) {
		t.Fatalf("Sources = %v, want [%v %v]", seg.Sources, a, b)
	}
}

func TestMaxSegmentTieBreakSmallestStart(t *testing.T) {
	c, _ := circlecover.New(10)
	c.Add(1, 3)
	c.Add(5, 7)
	seg, ok := c.MaxSegment(1)
	if !ok || seg.Start != 1 || seg.End != 3 || seg.Length != 2 {
		t.Fatalf("segment = %+v, %v; want the earliest of the two equal-length runs", seg, ok)
	}
}

// --- Randomized cross-check against the point-by-point model ---------------

func TestRandomizedAgainstPointModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	for trial := 0; trial < 300; trial++ {
		mod := int64(2 + rng.Intn(15)) // tiny angular domains: 2..16 units
		c, err := circlecover.New(mod)
		if err != nil {
			t.Fatal(err)
		}
		m := newModel(mod)
		var live []circlecover.ID

		ops := 20 + rng.Intn(30)
		for op := 0; op < ops; op++ {
			switch {
			case len(live) > 0 && rng.Intn(4) == 0: // remove
				i := rng.Intn(len(live))
				id := live[i]
				live = append(live[:i], live[i+1:]...)
				if !c.Remove(id) {
					t.Fatalf("trial %d: Remove(%d) failed", trial, id)
				}
				delete(m.ids, id)
				delete(m.full, id)
				delete(m.start, id)
				delete(m.end, id)
			case rng.Intn(6) == 0: // full circle
				id := c.AddFull()
				live = append(live, id)
				m.ids[id] = true
				m.full[id] = true
			default: // arc
				s := rng.Int63n(mod)
				e := rng.Int63n(mod)
				if e == s {
					e = (e + 1) % mod
				}
				id, err := c.Add(s, e)
				if err != nil {
					t.Fatalf("trial %d: Add(%d,%d): %v", trial, s, e, err)
				}
				live = append(live, id)
				m.ids[id] = true
				m.start[id], m.end[id] = s, e
			}

			// Point-by-point coverage check over the whole tiny domain.
			for p := int64(0); p < mod; p++ {
				got, err := c.CoverageAt(p)
				if err != nil {
					t.Fatalf("trial %d: CoverageAt(%d): %v", trial, p, err)
				}
				if want := m.coverage(p); got != want {
					t.Fatalf("trial %d op %d: CoverageAt(%d) = %d, model says %d", trial, op, p, got, want)
				}
			}

			// MaxSegment check for several k values.
			for k := 1; k <= 4; k++ {
				seg, ok := c.MaxSegment(k)
				wantLen, wantStart, wantFull, wantOK := m.bestSegment(k)
				if ok != wantOK {
					t.Fatalf("trial %d k=%d: ok = %v, model says %v", trial, k, ok, wantOK)
				}
				if !ok {
					continue
				}
				if seg.Full != wantFull || seg.Length != wantLen {
					t.Fatalf("trial %d k=%d: segment = %+v, model wants len=%d full=%v",
						trial, k, seg, wantLen, wantFull)
				}
				if !seg.Full && seg.Start != wantStart {
					t.Fatalf("trial %d k=%d: start = %d, model wants %d", trial, k, seg.Start, wantStart)
				}
				// Segment geometry: length must match the counterclockwise arc.
				if !seg.Full && (seg.End-seg.Start+mod)%mod != seg.Length {
					t.Fatalf("trial %d k=%d: [%d,%d) has length %d, reported %d",
						trial, k, seg.Start, seg.End, (seg.End-seg.Start+mod)%mod, seg.Length)
				}
				// Source set must match the model exactly.
				wantSrc := m.sourcesOf(seg.Full, seg.Start, seg.End)
				if !reflect.DeepEqual(seg.Sources, wantSrc) {
					t.Fatalf("trial %d k=%d: Sources = %v, model wants %v", trial, k, seg.Sources, wantSrc)
				}
				// Every unit of the segment must be covered >= k times.
				for l := int64(0); l < seg.Length; l++ {
					p := (seg.Start + l) % mod
					if cov := m.coverage(p); cov < k {
						t.Fatalf("trial %d k=%d: unit %d of segment covered %d times", trial, k, p, cov)
					}
				}
			}
		}
	}
}
