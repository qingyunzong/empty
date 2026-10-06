package ranges

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func TestValidateAcceptsNestedAndDisjoint(t *testing.T) {
	rs := []Range{
		{Start: 0, End: 10, Handler: "outer"},
		{Start: 2, End: 5, Handler: "inner"},
		{Start: 2, End: 5, Handler: "inner-dup"},
		{Start: 6, End: 8, Handler: "sibling"},
		{Start: 12, End: 14, Handler: "disjoint"},
	}
	if err := Validate(rs); err != nil {
		t.Fatalf("expected valid, got %v", err)
	}
}

func TestValidateRejectsCrossing(t *testing.T) {
	rs := []Range{
		{Start: 0, End: 6, Handler: "a"},
		{Start: 4, End: 10, Handler: "b"},
	}
	if err := Validate(rs); err == nil {
		t.Fatal("expected crossing ranges to be rejected")
	}
}

func TestValidateRejectsDegenerate(t *testing.T) {
	cases := [][]Range{
		{{Start: 3, End: 3, Handler: "empty"}},
		{{Start: 5, End: 2, Handler: "inverted"}},
		{{Start: -1, End: 4, Handler: "negative"}},
	}
	for i, rs := range cases {
		if err := Validate(rs); err == nil {
			t.Fatalf("case %d: expected rejection", i)
		}
	}
}

func TestChainAtInnerFirstThenDeclarationOrder(t *testing.T) {
	rs := WithOrder([]Range{
		{Start: 0, End: 10, Handler: "outer"},
		{Start: 2, End: 6, Handler: "mid"},
		{Start: 3, End: 5, Handler: "inner-a"},
		{Start: 3, End: 5, Handler: "inner-b"}, // same span, declared later
		{Start: 20, End: 30, Handler: "elsewhere"},
	})
	tab, err := NewTable(rs)
	if err != nil {
		t.Fatal(err)
	}
	got := handlerNames(tab.ChainAt(4))
	want := []string{"inner-a", "inner-b", "mid", "outer"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("chain at 4 = %v, want %v", got, want)
	}
	if got := tab.ChainAt(8); len(got) != 1 || got[0].Handler != "outer" {
		t.Fatalf("chain at 8 = %v, want [outer]", got)
	}
	if got := tab.ChainAt(15); len(got) != 0 {
		t.Fatalf("chain at 15 = %v, want empty", got)
	}
}

func TestRemapEndpoints(t *testing.T) {
	rs := WithOrder([]Range{
		{Start: 0, End: 10, Handler: "straddling"},
		{Start: 8, End: 12, Handler: "after-start"},
		{Start: 0, End: 4, Handler: "before-end"},
	})
	got := Remap(rs, 4, 3)
	// Insertion strictly inside [0,10): start stays, end shifts.
	if got[0].Start != 0 || got[0].End != 13 {
		t.Fatalf("straddling range remapped to [%d,%d), want [0,13)", got[0].Start, got[0].End)
	}
	// Insertion at/before start: whole range shifts.
	if got[1].Start != 11 || got[1].End != 15 {
		t.Fatalf("after-start range remapped to [%d,%d), want [11,15)", got[1].Start, got[1].End)
	}
	// Insertion at end boundary: range untouched, new slots outside.
	if got[2].Start != 0 || got[2].End != 4 {
		t.Fatalf("before-end range remapped to [%d,%d), want [0,4)", got[2].Start, got[2].End)
	}
}

// randomLaminar builds a random set of mutually non-crossing ranges.
func randomLaminar(rng *rand.Rand, n, hi int) []Range {
	var rs []Range
	for len(rs) < n {
		a := rng.Intn(hi)
		b := rng.Intn(hi)
		if a > b {
			a, b = b, a
		}
		if a == b {
			continue
		}
		cand := Range{Start: a, End: b, Handler: fmt.Sprintf("h%d", len(rs))}
		ok := true
		for _, e := range rs {
			if overlaps(cand, e) && !cand.containsRange(e) && !e.containsRange(cand) {
				ok = false
				break
			}
		}
		if ok {
			rs = append(rs, cand)
		}
	}
	return WithOrder(rs)
}

func handlerNames(chain []Range) []string {
	names := make([]string, len(chain))
	for i, r := range chain {
		names[i] = r.Handler
	}
	return names
}

func TestChainAtMatchesReferenceScan(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 200; trial++ {
		rs := randomLaminar(rng, rng.Intn(12), 40)
		tab, err := NewTable(rs)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		for pc := 0; pc < 45; pc++ {
			got := handlerNames(tab.ChainAt(pc))
			want := handlerNames(ReferenceChainAt(rs, pc))
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("trial %d pc %d: table chain %v != reference %v", trial, pc, got, want)
			}
		}
	}
}

func TestRemapPreservesChains(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	for trial := 0; trial < 200; trial++ {
		const hi = 40
		rs := randomLaminar(rng, rng.Intn(10), hi)
		at := rng.Intn(hi + 1)
		count := rng.Intn(5)
		remapped := Remap(rs, at, count)
		if err := Validate(remapped); err != nil {
			t.Fatalf("trial %d: remapped ranges invalid: %v", trial, err)
		}
		before, err := NewTable(rs)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		after, err := NewTable(remapped)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		for pc := 0; pc < hi; pc++ {
			mapped := pc
			if pc >= at {
				mapped += count
			}
			got := handlerNames(after.ChainAt(mapped))
			want := handlerNames(before.ChainAt(pc))
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("trial %d: pc %d -> %d chain %v, want %v", trial, pc, mapped, got, want)
			}
		}
	}
}
