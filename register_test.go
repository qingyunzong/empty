package mvregister

import (
	"fmt"
	"reflect"
	"testing"
)

// sameState reports whether two registers hold identical versions
// (replica, value and causal clock), order-insensitively.
func sameState(a, b *Register) bool {
	key := func(r *Register) []string {
		var out []string
		for _, v := range r.Versions() {
			out = append(out, fmt.Sprintf("%s=%s@%v", v.Replica, v.Value, v.Clock))
		}
		return out
	}
	return reflect.DeepEqual(key(a), key(b))
}

func valuesOf(r *Register) []string { return r.Values() }

// Causal-later writes overwrite the writes they observed.
func TestCausalWriteOverwrites(t *testing.T) {
	a := New()
	a.Write("A", "a1")

	b := a.Copy() // b replicates a's state
	b.Write("B", "b1")

	a.Merge(b)
	if got := valuesOf(a); !reflect.DeepEqual(got, []string{"b1"}) {
		t.Fatalf("causal overwrite: got %v, want [b1]", got)
	}
	if Compare(a.Versions()[0].Clock, VectorClock{"A": 1}) != After {
		t.Fatalf("new write must causally follow the observed write")
	}
}

// Concurrent writes are all preserved and displayed ordered by replica ID.
func TestConcurrentWritesPreservedAndSortedByID(t *testing.T) {
	a, b, c := New(), New(), New()
	a.Write("A", "alpha")
	b.Write("B", "bravo")
	c.Write("C", "charlie")

	m := a.Copy()
	m.Merge(b)
	m.Merge(c)

	if got := valuesOf(m); !reflect.DeepEqual(got, []string{"alpha", "bravo", "charlie"}) {
		t.Fatalf("concurrent writes: got %v", got)
	}
	ids := []string{}
	for _, v := range m.Versions() {
		ids = append(ids, v.Replica)
	}
	if !reflect.DeepEqual(ids, []string{"A", "B", "C"}) {
		t.Fatalf("versions not displayed by ID: %v", ids)
	}
}

// A write that resolves a conflict must observe all current versions.
func TestResolvingWriteObservesAllVersions(t *testing.T) {
	a, b := New(), New()
	a.Write("A", "a1")
	b.Write("B", "b1")

	r := a.Copy()
	r.Merge(b) // conflict: {A:1}, {B:1}
	r.Write("C", "resolved")

	vs := r.Versions()
	if len(vs) != 1 || vs[0].Value != "resolved" {
		t.Fatalf("resolving write should leave a single version, got %v", vs)
	}
	for _, observed := range []VectorClock{{"A": 1}, {"B": 1}} {
		if Compare(vs[0].Clock, observed) != After {
			t.Fatalf("resolving write did not observe %v: clock %v", observed, vs[0].Clock)
		}
	}
}

// Build three registers with pairwise concurrent writes.
func concurrentTrio() (x, y, z *Register) {
	x, y, z = New(), New(), New()
	x.Write("X", "x")
	y.Write("Y", "y")
	z.Write("Z", "z")
	return
}

func TestMergeCommutative(t *testing.T) {
	x, y, _ := concurrentTrio()
	xy := x.Copy()
	xy.Merge(y)
	yx := y.Copy()
	yx.Merge(x)
	if !sameState(xy, yx) {
		t.Fatalf("merge not commutative")
	}
}

func TestMergeAssociative(t *testing.T) {
	x, y, z := concurrentTrio()
	left := x.Copy()
	left.Merge(y)
	left.Merge(z)
	right := y.Copy()
	right.Merge(z)
	x2 := x.Copy()
	x2.Merge(right)
	if !sameState(left, x2) {
		t.Fatalf("merge not associative")
	}
}

func TestMergeIdempotent(t *testing.T) {
	x, y, _ := concurrentTrio()
	m := x.Copy()
	m.Merge(y)
	once := m.Copy()
	m.Merge(y) // re-merge same source
	m.Merge(m) // self-merge
	m.Merge(x) // re-merge subset
	if !sameState(once, m) {
		t.Fatalf("merge not idempotent")
	}
}

// Every permutation of merge order converges and never loses concurrent writes.
func TestMergeOrdersConvergeAndKeepConcurrentWrites(t *testing.T) {
	orders := [][]string{
		{"X", "Y", "Z"}, {"X", "Z", "Y"},
		{"Y", "X", "Z"}, {"Y", "Z", "X"},
		{"Z", "X", "Y"}, {"Z", "Y", "X"},
	}
	want := []string{"x", "y", "z"}
	var reference *Register
	for _, order := range orders {
		regs := map[string]*Register{"X": New(), "Y": New(), "Z": New()}
		regs["X"].Write("X", "x")
		regs["Y"].Write("Y", "y")
		regs["Z"].Write("Z", "z")
		m := New()
		for _, id := range order {
			m.Merge(regs[id])
		}
		if got := valuesOf(m); !reflect.DeepEqual(got, want) {
			t.Fatalf("order %v lost concurrent writes: got %v, want %v", order, got, want)
		}
		if reference == nil {
			reference = m
		} else if !sameState(reference, m) {
			t.Fatalf("order %v diverged from order %v", order, orders[0])
		}
	}
}

// A mixed scenario: concurrent writes survive merges, then a resolving write
// on one replica converges everywhere regardless of merge order.
func TestConvergenceAfterResolution(t *testing.T) {
	a, b := New(), New()
	a.Write("A", "a1")
	b.Write("B", "b1")

	resolver := a.Copy()
	resolver.Merge(b)
	resolver.Write("A", "final")

	// Merge the three divergent states in different orders.
	first := a.Copy()
	first.Merge(b)
	first.Merge(resolver)
	second := resolver.Copy()
	second.Merge(a)
	second.Merge(b)
	if !sameState(first, second) {
		t.Fatalf("merge orders diverged after resolution")
	}
	if got := valuesOf(first); !reflect.DeepEqual(got, []string{"final"}) {
		t.Fatalf("resolved value should win everywhere, got %v", got)
	}
}
