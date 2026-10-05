package dirdiff

import (
	"fmt"
	"math/rand"
	"testing"
)

// permutations calls fn for every permutation of indices [0,n).
func permutations(n int, fn func(perm []int)) {
	perm := make([]int, n)
	for i := range perm {
		perm[i] = i
	}
	var rec func(k int)
	rec = func(k int) {
		if k == n {
			out := make([]int, n)
			copy(out, perm)
			fn(out)
			return
		}
		for i := k; i < n; i++ {
			perm[k], perm[i] = perm[i], perm[k]
			rec(k + 1)
			perm[k], perm[i] = perm[i], perm[k]
		}
	}
	rec(0)
}

func permManifests(n int, perm []int) (old, new Manifest) {
	for i := 0; i < n; i++ {
		e := Entry{ID: fmt.Sprintf("id-%d", i), Path: fmt.Sprintf("dir/p-%d", i), Version: i + 1}
		old.Entries = append(old.Entries, e)
	}
	for i := 0; i < n; i++ {
		e := old.Entries[i]
		e.Path = fmt.Sprintf("dir/p-%d", perm[i])
		new.Entries = append(new.Entries, e)
	}
	return old, new
}

// checkPlan verifies the temp-path constraint, executes the plan, and checks
// that the inverse restores the original manifest.
func checkPlan(t *testing.T, old, new Manifest) {
	t.Helper()
	ops, err := Diff(old, new)
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	finalNames := map[string]bool{}
	finalOf := map[string]string{}
	for _, e := range new.Entries {
		finalNames[e.Path] = true
		finalOf[e.ID] = e.Path
	}
	for _, op := range ops {
		if op.Kind != OpMove {
			continue
		}
		if op.To != finalOf[op.ID] {
			if !IsTempPath(op.To) {
				t.Fatalf("move to non-final, non-temp path %q", op.To)
			}
			if finalNames[op.To] {
				t.Fatalf("temp path %q occupies a final name", op.To)
			}
		}
	}
	got, err := Apply(old, ops)
	if err != nil {
		t.Fatalf("plan not executable: %v\nops: %v", err, ops)
	}
	if !got.Equal(new) {
		t.Fatalf("forward: got %+v want %+v", got, new)
	}
	back, err := Apply(got, Invert(ops))
	if err != nil {
		t.Fatalf("inverse not executable: %v", err)
	}
	if !back.Equal(old) {
		t.Fatalf("inverse did not restore original: got %+v want %+v", back, old)
	}
}

// TestPermutationsExhaustive enumerates every path permutation for n=1..6
// and checks plan executability plus exact restoration of the original.
func TestPermutationsExhaustive(t *testing.T) {
	for n := 1; n <= 6; n++ {
		n := n
		t.Run(fmt.Sprintf("n=%d", n), func(t *testing.T) {
			count := 0
			permutations(n, func(perm []int) {
				old, new := permManifests(n, perm)
				checkPlan(t, old, new)
				count++
			})
			t.Logf("checked %d permutations", count)
		})
	}
}

// TestPermutationsMaxEntries samples random permutations at the 12-entry
// limit with a fixed seed.
func TestPermutationsMaxEntries(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 300; trial++ {
		perm := rng.Perm(MaxEntries)
		old, new := permManifests(MaxEntries, perm)
		checkPlan(t, old, new)
	}
}

// TestPermutationsOnDisk runs the acceptance round trip against a real
// directory tree: materialize, apply plan, snapshot, apply inverse, snapshot.
func TestPermutationsOnDisk(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	cases := [][]int{{1, 0}, {2, 0, 1}, {3, 1, 2, 0}}
	for i := 0; i < 3; i++ {
		cases = append(cases, rng.Perm(8))
	}
	for _, perm := range cases {
		old, new := permManifests(len(perm), perm)
		root := t.TempDir()
		if err := Materialize(root, old); err != nil {
			t.Fatalf("Materialize: %v", err)
		}
		ops, err := Diff(old, new)
		if err != nil {
			t.Fatalf("Diff: %v", err)
		}
		if err := ApplyFS(root, ops); err != nil {
			t.Fatalf("ApplyFS forward: %v", err)
		}
		snap, err := Snapshot(root)
		if err != nil {
			t.Fatalf("Snapshot: %v", err)
		}
		if !snap.Equal(new) {
			t.Fatalf("on-disk forward: got %+v want %+v", snap, new)
		}
		if err := ApplyFS(root, Invert(ops)); err != nil {
			t.Fatalf("ApplyFS inverse: %v", err)
		}
		snap, err = Snapshot(root)
		if err != nil {
			t.Fatalf("Snapshot: %v", err)
		}
		if !snap.Equal(old) {
			t.Fatalf("on-disk inverse: got %+v want %+v", snap, old)
		}
	}
}

// TestMixedChangesPermuted combines moves, deletes, and creates.
func TestMixedChangesPermuted(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	for trial := 0; trial < 200; trial++ {
		n := 1 + rng.Intn(MaxEntries-2) // keep room for additions
		perm := rng.Perm(n)
		old, new := permManifests(n, perm)
		// Drop some entries from the target, add some fresh ones.
		keep := new.Entries[:0]
		for _, e := range new.Entries {
			if rng.Intn(4) > 0 {
				keep = append(keep, e)
			}
		}
		new.Entries = keep
		for len(new.Entries) < n {
			id := fmt.Sprintf("fresh-%d-%d", trial, len(new.Entries))
			new.Entries = append(new.Entries, Entry{ID: id, Path: fmt.Sprintf("dir/n-%s", id), Version: 1})
		}
		checkPlan(t, old, new)
	}
}
