package dirdiff

import (
	"fmt"
	"strings"
	"testing"
)

// idsAndPaths builds n stable IDs and n distinct (partly nested) paths.
func idsAndPaths(n int) (ids, paths []string) {
	for i := 0; i < n; i++ {
		ids = append(ids, fmt.Sprintf("id-%02d", i))
		paths = append(paths, fmt.Sprintf("dir%d/sub%d/file-%02d", i%3, i%2, i))
	}
	return ids, paths
}

func manifestFor(ids, paths []string, perm []int) Manifest {
	entries := make([]Entry, len(ids))
	for i := range ids {
		entries[i] = Entry{ID: ids[i], Path: paths[perm[i]]}
	}
	m, err := NewManifest(entries)
	if err != nil {
		panic(err)
	}
	return m
}

func factorial(n int) int {
	f := 1
	for ; n > 1; n-- {
		f *= n
	}
	return f
}

// lehmer decodes a permutation of n elements from its Lehmer code.
func lehmer(n, code int) []int {
	avail := make([]int, n)
	for i := range avail {
		avail[i] = i
	}
	perm := make([]int, 0, n)
	for i := 0; i < n; i++ {
		f := factorial(n - 1 - i)
		idx := 0
		if f > 0 {
			idx = code / f
			code %= f
		}
		perm = append(perm, avail[idx])
		avail = append(avail[:idx], avail[idx+1:]...)
	}
	return perm
}

// eachPerm calls fn for permutations of n elements: all n! for n <= 7, and a
// deterministic sample (identity, reverse, rotations, transpositions, and
// evenly spaced Lehmer codes) for larger n.
func eachPerm(n int, fn func(perm []int)) {
	if n <= 7 {
		for code := 0; code < factorial(n); code++ {
			fn(lehmer(n, code))
		}
		return
	}
	seen := make(map[int]bool)
	emit := func(code int) {
		if !seen[code] {
			seen[code] = true
			fn(lehmer(n, code))
		}
	}
	total := factorial(n)
	stride := total / 512
	if stride < 1 {
		stride = 1
	}
	for code := 0; code < total; code += stride {
		emit(code)
	}
	emit(total - 1) // reverse
	// All rotations and all single transpositions.
	for k := 0; k < n; k++ {
		perm := make([]int, n)
		for i := range perm {
			perm[i] = (i + k) % n
		}
		fn(perm)
	}
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			perm := make([]int, n)
			for k := range perm {
				perm[k] = k
			}
			perm[i], perm[j] = perm[j], perm[i]
			fn(perm)
		}
	}
}

// TestPermutationAcceptance is the acceptance plan: for manifests of at most
// 12 entries, enumerate path permutations, verify each diff plan is
// executable and reaches the target, that temp paths never occupy final
// names, and that the inverse plan restores the original manifest.
func TestPermutationAcceptance(t *testing.T) {
	for n := 1; n <= 12; n++ {
		n := n
		t.Run(fmt.Sprintf("n=%d", n), func(t *testing.T) {
			ids, paths := idsAndPaths(n)
			identity := make([]int, n)
			for i := range identity {
				identity[i] = i
			}
			oldM := manifestFor(ids, paths, identity)
			checked := 0
			eachPerm(n, func(perm []int) {
				newM := manifestFor(ids, paths, perm)
				plan := Diff(oldM, newM)
				if plan.FromVersion != oldM.Version() || plan.ToVersion != newM.Version() {
					t.Fatalf("perm %v: plan versions wrong", perm)
				}
				// Temp paths must not occupy final (or source) names.
				for _, op := range plan.Ops {
					for _, p := range []string{op.From, op.To} {
						if p == "" || !strings.HasPrefix(p, tempPrefix) {
							continue
						}
						if _, ok := newM.byPath[p]; ok {
							t.Fatalf("perm %v: temp path %q occupies a final name", perm, p)
						}
						if _, ok := oldM.byPath[p]; ok {
							t.Fatalf("perm %v: temp path %q occupies a source name", perm, p)
						}
					}
				}
				// The plan is executable and reaches the target manifest.
				got, err := plan.Apply(oldM)
				if err != nil {
					t.Fatalf("perm %v: apply failed: %v", perm, err)
				}
				if !got.Equal(newM) {
					t.Fatalf("perm %v: got %v, want %v", perm, got.Entries(), newM.Entries())
				}
				// The inverse plan checks the target version and restores
				// the original manifest.
				inv := plan.Inverse()
				if inv.FromVersion != newM.Version() || inv.ToVersion != oldM.Version() {
					t.Fatalf("perm %v: inverse versions wrong", perm)
				}
				back, err := inv.Apply(got)
				if err != nil {
					t.Fatalf("perm %v: inverse apply failed: %v", perm, err)
				}
				if !back.Equal(oldM) {
					t.Fatalf("perm %v: inverse got %v, want %v", perm, back.Entries(), oldM.Entries())
				}
				checked++
			})
			t.Logf("verified %d permutations", checked)
		})
	}
}

func TestSwapCycleUsesTemp(t *testing.T) {
	oldM := MustManifest(Entry{"a", "x"}, Entry{"b", "y"})
	newM := MustManifest(Entry{"a", "y"}, Entry{"b", "x"})
	plan := Diff(oldM, newM)
	if len(plan.Ops) != 3 {
		t.Fatalf("swap plan has %d ops, want 3: %v", len(plan.Ops), plan.Ops)
	}
	var temps int
	for _, op := range plan.Ops {
		if strings.HasPrefix(op.To, tempPrefix) {
			temps++
			if op.To == "x" || op.To == "y" {
				t.Fatalf("temp path %q occupies a final name", op.To)
			}
		}
	}
	if temps != 1 {
		t.Fatalf("swap plan uses %d temp moves, want 1: %v", temps, plan.Ops)
	}
	got, err := plan.Apply(oldM)
	if err != nil || !got.Equal(newM) {
		t.Fatalf("apply: got %v err %v", got.Entries(), err)
	}
}

func TestChainMoveOrder(t *testing.T) {
	oldM := MustManifest(Entry{"a", "p1"}, Entry{"b", "p2"}, Entry{"c", "p3"})
	newM := MustManifest(Entry{"a", "p2"}, Entry{"b", "p3"}, Entry{"c", "p4"})
	plan := Diff(oldM, newM)
	want := []Op{
		{Kind: OpMove, ID: "c", From: "p3", To: "p4"},
		{Kind: OpMove, ID: "b", From: "p2", To: "p3"},
		{Kind: OpMove, ID: "a", From: "p1", To: "p2"},
	}
	if len(plan.Ops) != len(want) {
		t.Fatalf("got %v, want %v", plan.Ops, want)
	}
	for i := range want {
		if plan.Ops[i] != want[i] {
			t.Fatalf("op %d: got %v, want %v", i, plan.Ops, want)
		}
	}
}

func TestDeleteBeforeCreateOnSamePath(t *testing.T) {
	oldM := MustManifest(Entry{"old", "slot"})
	newM := MustManifest(Entry{"new", "slot"})
	plan := Diff(oldM, newM)
	if len(plan.Ops) != 2 || plan.Ops[0].Kind != OpDelete || plan.Ops[1].Kind != OpCreate {
		t.Fatalf("got %v, want delete then create", plan.Ops)
	}
	if _, err := plan.Apply(oldM); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteDepthOrder(t *testing.T) {
	oldM := MustManifest(Entry{"dir", "a"}, Entry{"file", "a/b"})
	newM := MustManifest()
	plan := Diff(oldM, newM)
	if len(plan.Ops) != 2 || plan.Ops[0].From != "a/b" || plan.Ops[1].From != "a" {
		t.Fatalf("deletes not deepest-first: %v", plan.Ops)
	}
}

func TestInverseChecksTargetVersion(t *testing.T) {
	oldM := MustManifest(Entry{"a", "x"}, Entry{"b", "y"})
	newM := MustManifest(Entry{"a", "y"}, Entry{"b", "x"})
	inv := Diff(oldM, newM).Inverse()
	if _, err := inv.Apply(oldM); err == nil {
		t.Fatal("inverse applied to the source manifest: want version mismatch error")
	} else if !strings.Contains(err.Error(), "version mismatch") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApplyRejectsOccupiedDestination(t *testing.T) {
	m := MustManifest(Entry{"a", "x"}, Entry{"b", "y"})
	bad := Plan{
		Ops:         []Op{{Kind: OpMove, ID: "a", From: "x", To: "y"}},
		FromVersion: m.Version(),
		ToVersion:   m.Version(),
	}
	if _, err := bad.Apply(m); err == nil {
		t.Fatal("move onto an occupied path: want error")
	}
}

func TestEmptyDiff(t *testing.T) {
	m := MustManifest(Entry{"a", "x"})
	plan := Diff(m, m)
	if len(plan.Ops) != 0 {
		t.Fatalf("identical manifests: got %v", plan.Ops)
	}
	got, err := plan.Apply(m)
	if err != nil || !got.Equal(m) {
		t.Fatalf("apply empty plan: %v %v", got.Entries(), err)
	}
}

func TestMoveNotDeleteCreate(t *testing.T) {
	oldM := MustManifest(Entry{"same", "old/name"})
	newM := MustManifest(Entry{"same", "new/name"})
	plan := Diff(oldM, newM)
	if len(plan.Ops) != 1 || plan.Ops[0].Kind != OpMove {
		t.Fatalf("stable ID rename: got %v, want a single move", plan.Ops)
	}
}
