package circcov

// Point-by-point reference model over a tiny angle domain: coverage is
// computed independently for every angular unit, and the maximal segment
// is found by scanning every start unit. The fuzz test cross-checks the
// sweep-line implementation in circcov.go against this model.

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

type modelSector struct {
	full       bool
	start, end Angle // normalized, half-open; start > end crosses zero
}

type pointModel struct {
	n    Angle
	secs map[int]modelSector
}

func normModel(a, n Angle) Angle {
	a %= n
	if a < 0 {
		a += n
	}
	return a
}

func (m *pointModel) covers(s modelSector, u Angle) bool {
	if s.full {
		return true
	}
	if s.start < s.end {
		return s.start <= u && u < s.end
	}
	return u >= s.start || u < s.end
}

func (m *pointModel) coverage(u Angle) int {
	cnt := 0
	for _, s := range m.secs {
		if m.covers(s, u) {
			cnt++
		}
	}
	return cnt
}

func (m *pointModel) maxCovered(k int) (Segment, []int, bool) {
	if k <= 0 {
		seg := Segment{Full: true}
		return seg, m.sources(seg), true
	}
	all := true
	for u := Angle(0); u < m.n; u++ {
		if m.coverage(u) < k {
			all = false
			break
		}
	}
	if all {
		seg := Segment{Full: true}
		return seg, m.sources(seg), true
	}
	bestLen, bestStart := Angle(0), Angle(0)
	for s := Angle(0); s < m.n; s++ {
		l := Angle(0)
		for l < m.n && m.coverage((s+l)%m.n) >= k {
			l++
		}
		if l > bestLen { // strict: keeps the smallest start on ties
			bestLen, bestStart = l, s
		}
	}
	if bestLen == 0 {
		return Segment{}, nil, false
	}
	seg := Segment{Start: bestStart, End: (bestStart + bestLen) % m.n}
	return seg, m.sources(seg), true
}

func (m *pointModel) sources(seg Segment) []int {
	ids := []int{}
	for id, s := range m.secs {
		ok := s.full
		if !seg.Full && !ok {
			ok = true
			for l := Angle(0); l < seg.Len(m.n); l++ {
				if !m.covers(s, (seg.Start+l)%m.n) {
					ok = false
					break
				}
			}
		}
		if seg.Full && !s.full {
			ok = false
		}
		if ok {
			ids = append(ids, id)
		}
	}
	sort.Ints(ids)
	return ids
}

func checkAgainstModel(t *testing.T, c *Cover, m *pointModel, k int) {
	t.Helper()
	seg, src, ok := c.MaxCovered(k)
	mseg, msrc, mok := m.maxCovered(k)
	if ok != mok {
		t.Fatalf("k=%d: ok=%v, model %v", k, ok, mok)
	}
	if !ok {
		return
	}
	if seg != mseg {
		t.Fatalf("k=%d: seg=%+v, model %+v", k, seg, mseg)
	}
	if !reflect.DeepEqual(src, msrc) {
		t.Fatalf("k=%d: sources=%v, model %v", k, src, msrc)
	}
}

func TestFuzzAgainstPointModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 400; trial++ {
		n := Angle(1 + rng.Intn(24)) // tiny angle domain: 1..24 units
		c := New(n)
		m := &pointModel{n: n, secs: make(map[int]modelSector)}
		var ids []int
		for op := 0; op < 60; op++ {
			switch rng.Intn(5) {
			case 0, 1, 2: // add partial sector, possibly out of range angles
				s := Angle(rng.Intn(int(3*n))) - n
				e := Angle(rng.Intn(int(3*n))) - n
				id, err := c.Add(s, e)
				if normModel(s, n) == normModel(e, n) {
					if err == nil {
						t.Fatalf("trial %d: Add(%d,%d) on n=%d: want ErrDegenerate", trial, s, e, n)
					}
					continue
				}
				if err != nil {
					t.Fatalf("trial %d: Add(%d,%d): %v", trial, s, e, err)
				}
				m.secs[id] = modelSector{start: normModel(s, n), end: normModel(e, n)}
				ids = append(ids, id)
			case 3: // add full circle
				id := c.AddFull()
				m.secs[id] = modelSector{full: true}
				ids = append(ids, id)
			default: // remove a random live sector
				if len(ids) == 0 {
					continue
				}
				i := rng.Intn(len(ids))
				id := ids[i]
				ids = append(ids[:i], ids[i+1:]...)
				if !c.Remove(id) {
					t.Fatalf("trial %d: Remove(%d) failed", trial, id)
				}
				delete(m.secs, id)
			}
			for k := 0; k <= len(m.secs)+2; k++ {
				checkAgainstModel(t, c, m, k)
			}
		}
	}
}
