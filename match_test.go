package statcorr

import (
	"fmt"
	"math/big"
	"math/rand"
	"sort"
	"testing"
)

func pt(id string, tnum, tden, v int64) Point {
	return Point{ID: id, T: big.NewRat(tnum, tden), V: big.NewInt(v)}
}

func pairIDs(m Matching) []string {
	out := make([]string, len(m.Pairs))
	for i, p := range m.Pairs {
		out[i] = p.A.ID + "|" + p.B.ID
	}
	return out
}

// bruteMatch independently enumerates every allowed one-to-one matching and
// picks the best by (max pairs, min total diff, lexicographic IDs).
func bruteMatch(a, b []Point, gap *big.Rat) Matching {
	as, _ := sortByTime(a)
	bs, _ := sortByTime(b)
	var best Matching
	first := true
	used := make([]bool, len(bs))
	var rec func(i int, cost *big.Rat, pairs []Pair)
	rec = func(i int, cost *big.Rat, pairs []Pair) {
		if i == len(as) {
			cand := Matching{
				Total: new(big.Rat).Set(cost),
				Pairs: append([]Pair(nil), pairs...),
			}
			sort.Slice(cand.Pairs, func(x, y int) bool {
				if cand.Pairs[x].A.ID != cand.Pairs[y].A.ID {
					return cand.Pairs[x].A.ID < cand.Pairs[y].A.ID
				}
				return cand.Pairs[x].B.ID < cand.Pairs[y].B.ID
			})
			if first || betterMatching(cand, best) {
				best = cand
				first = false
			}
			return
		}
		rec(i+1, cost, pairs) // leave as[i] unmatched
		for j := range bs {
			if used[j] {
				continue
			}
			d := new(big.Rat).Sub(as[i].T, bs[j].T)
			d.Abs(d)
			if d.Cmp(gap) > 0 {
				continue
			}
			used[j] = true
			rec(i+1, new(big.Rat).Add(cost, d), append(pairs, Pair{A: as[i], B: bs[j], Diff: d}))
			used[j] = false
		}
	}
	rec(0, new(big.Rat), nil)
	return best
}

// betterMatching reports whether x beats y by (max pairs, min total diff,
// lexicographically smallest sorted (A.ID, B.ID) pair list).
func betterMatching(x, y Matching) bool {
	if len(x.Pairs) != len(y.Pairs) {
		return len(x.Pairs) > len(y.Pairs)
	}
	if c := x.Total.Cmp(y.Total); c != 0 {
		return c < 0
	}
	for i := range x.Pairs {
		if x.Pairs[i].A.ID != y.Pairs[i].A.ID {
			return x.Pairs[i].A.ID < y.Pairs[i].A.ID
		}
		if x.Pairs[i].B.ID != y.Pairs[i].B.ID {
			return x.Pairs[i].B.ID < y.Pairs[i].B.ID
		}
	}
	return false
}

func TestMatchBasic(t *testing.T) {
	m, err := Match(
		[]Point{pt("a1", 0, 1, 1), pt("a2", 10, 1, 2)},
		[]Point{pt("b1", 1, 1, 3), pt("b2", 9, 1, 4)},
		big.NewRat(2, 1),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a1|b1", "a2|b2"}
	got := pairIDs(m)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("pairs = %v, want %v", got, want)
	}
	if m.Total.Cmp(big.NewRat(2, 1)) != 0 {
		t.Fatalf("total = %s, want 2", m.Total)
	}
}

func TestMatchRespectsGap(t *testing.T) {
	m, err := Match(
		[]Point{pt("a1", 0, 1, 1)},
		[]Point{pt("b1", 5, 1, 1)},
		big.NewRat(2, 1),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Pairs) != 0 {
		t.Fatalf("expected no pairs beyond gap, got %v", pairIDs(m))
	}
}

func TestMatchTieBreakByID(t *testing.T) {
	// Both candidates have diff 1; the smaller B ID must win.
	m, err := Match(
		[]Point{pt("a1", 0, 1, 1)},
		[]Point{pt("b2", 1, 1, 1), pt("b1", -1, 1, 1)},
		big.NewRat(3, 1),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Pairs) != 1 || m.Pairs[0].B.ID != "b1" {
		t.Fatalf("tie not broken by ID: %v", pairIDs(m))
	}
}

func TestMatchRationalGapBoundary(t *testing.T) {
	// diff = 3/2 exactly equals the gap: allowed.
	m, err := Match(
		[]Point{pt("a1", 0, 1, 1)},
		[]Point{pt("b1", 3, 2, 1)},
		big.NewRat(3, 2),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Pairs) != 1 || m.Pairs[0].Diff.Cmp(big.NewRat(3, 2)) != 0 {
		t.Fatalf("boundary pair missing: %v", m.Certificate())
	}
}

func TestMatchNoEqualTimeSimplification(t *testing.T) {
	// An equal-timestamp join would only pair a1~b1; the optimal matching
	// also pairs a2~b2 (diff 1 <= gap), so the result must have 2 pairs.
	m, err := Match(
		[]Point{pt("a1", 0, 1, 1), pt("a2", 10, 1, 2)},
		[]Point{pt("b1", 0, 1, 3), pt("b2", 9, 1, 4)},
		big.NewRat(5, 1),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Pairs) != 2 {
		t.Fatalf("matcher degenerated to equal-time join: %v", pairIDs(m))
	}
}

func TestMatchTooManyPoints(t *testing.T) {
	var a []Point
	for i := 0; i < MaxPoints+1; i++ {
		a = append(a, pt(fmt.Sprintf("a%d", i), int64(i), 1, 1))
	}
	if _, err := Match(a, nil, big.NewRat(1, 1)); err != ErrTooManyPoints {
		t.Fatalf("err = %v, want ErrTooManyPoints", err)
	}
}

func TestMatchAgainstBruteForce(t *testing.T) {
	r := rand.New(rand.NewSource(20261006))
	for iter := 0; iter < 1000; iter++ {
		n, m := r.Intn(8), r.Intn(8)
		a := randPoints(r, "a", n)
		b := randPoints(r, "b", m)
		gap := big.NewRat(int64(r.Intn(6)), int64(1+r.Intn(3)))
		got, err := Match(a, b, gap)
		if err != nil {
			t.Fatal(err)
		}
		want := bruteMatch(a, b, gap)
		if got.Total.Cmp(want.Total) != 0 ||
			fmt.Sprint(pairIDs(got)) != fmt.Sprint(pairIDs(want)) {
			t.Fatalf("iter %d mismatch\ngot:  %swant: %s",
				iter, got.Certificate(), want.Certificate())
		}
	}
}

func randPoints(r *rand.Rand, prefix string, n int) []Point {
	pts := make([]Point, n)
	for i := range pts {
		pts[i] = Point{
			ID: fmt.Sprintf("%s%d", prefix, i),
			T:  big.NewRat(int64(r.Intn(21)-10), int64(1+r.Intn(4))),
			V:  big.NewInt(int64(r.Intn(21) - 10)),
		}
	}
	return pts
}
