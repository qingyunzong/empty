package main

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

// buildChain fills in Parent digests for a template chain by simulating with
// the serial interpreter, returning packages ready to apply in order.
func buildChain(t *testing.T, m *Manifest, tmpl []*Package) []*Package {
	t.Helper()
	state := stateFromManifest(m)
	digest := Digest(state)
	out := make([]*Package, len(tmpl))
	for i, p := range tmpl {
		cp := &Package{Parent: digest, Blocks: p.Blocks, Ops: p.Ops}
		if err := applyPackage(state, cp, i); err != nil {
			t.Fatalf("building chain: %v", err)
		}
		digest = Digest(state)
		out[i] = cp
	}
	return out
}

func baseManifest() *Manifest {
	return &Manifest{
		Blocks: map[string]string{"b0": "zero", "b1": "one"},
		Objects: map[string]Object{
			"alpha": {Version: 1, Blocks: []string{"b0"}},
			"beta":  {Version: 1, Blocks: []string{"b1"}},
		},
	}
}

func chainTemplates() []*Package {
	return []*Package{
		{Blocks: map[string]string{"b2": "two"}, Ops: []Op{
			{Op: "put", Object: "alpha", Version: 2, Blocks: []string{"b2"}},
		}},
		{Ops: []Op{
			{Op: "delete", Object: "beta"},
		}},
		{Blocks: map[string]string{"b3": "three"}, Ops: []Op{
			{Op: "put", Object: "gamma", Version: 1, Blocks: []string{"b3", "b0"}},
			{Op: "put", Object: "alpha", Version: 3, Blocks: []string{"b0", "b3"}},
		}},
	}
}

func TestReorderedInputMatchesSerialInterpreter(t *testing.T) {
	m := baseManifest()
	chain := buildChain(t, m, chainTemplates())

	wantState, wantDigest, err := RestoreSerial(m, chain)
	if err != nil {
		t.Fatalf("serial restore: %v", err)
	}

	// Exhaustively check every permutation of the package input.
	perm := []int{0, 1, 2}
	for p := make([]int, len(perm)); ; {
		copy(p, perm)
		shuffled := []*Package{chain[p[0]], chain[p[1]], chain[p[2]]}
		gotState, gotDigest, err := Restore(m, shuffled)
		if err != nil {
			t.Fatalf("restore of permutation %v: %v", p, err)
		}
		if gotDigest != wantDigest {
			t.Fatalf("permutation %v: digest %s != serial %s", p, gotDigest, wantDigest)
		}
		if !reflect.DeepEqual(gotState, wantState) {
			t.Fatalf("permutation %v: state %+v != serial %+v", p, gotState, wantState)
		}
		if !nextPermutation(perm) {
			break
		}
	}
}

func TestRandomShufflesMatchSerialInterpreter(t *testing.T) {
	m := baseManifest()
	chain := buildChain(t, m, chainTemplates())
	_, wantDigest, err := RestoreSerial(m, chain)
	if err != nil {
		t.Fatalf("serial restore: %v", err)
	}
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 200; trial++ {
		shuffled := append([]*Package(nil), chain...)
		rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
		_, gotDigest, err := Restore(m, shuffled)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if gotDigest != wantDigest {
			t.Fatalf("trial %d: digest %s != %s", trial, gotDigest, wantDigest)
		}
	}
}

func TestMissingParentGivesEarliestEdge(t *testing.T) {
	m := baseManifest()
	chain := buildChain(t, m, chainTemplates())
	// Drop the middle package: the chain breaks at edge 1.
	_, _, err := Restore(m, []*Package{chain[0], chain[2]})
	var inv *Invalidation
	if !errors.As(err, &inv) {
		t.Fatalf("expected Invalidation, got %v", err)
	}
	if inv.Kind != KindMissingParent || inv.Edge != 1 {
		t.Fatalf("want missing-parent at edge 1, got %v", inv)
	}
}

func TestVersionConflictGivesEarliestEdge(t *testing.T) {
	m := baseManifest()
	chain := buildChain(t, m, chainTemplates())
	// Second package re-puts alpha version 2 with different content.
	bad := &Package{Parent: chain[1].Parent, Ops: []Op{
		{Op: "put", Object: "alpha", Version: 2, Blocks: []string{"b1"}},
	}}
	state, _, err := Restore(m, []*Package{chain[0], bad})
	if state != nil {
		t.Fatalf("partial state must not be returned on failure")
	}
	var inv *Invalidation
	if !errors.As(err, &inv) {
		t.Fatalf("expected Invalidation, got %v", err)
	}
	if inv.Kind != KindVersionConflict || inv.Edge != 1 || inv.Op != 0 {
		t.Fatalf("want version-conflict at edge 1 op 0, got %v", inv)
	}
}

func TestMissingBlocksGivesEarliestEdge(t *testing.T) {
	m := baseManifest()
	chain := buildChain(t, m, chainTemplates())
	bad := &Package{Parent: chain[0].Parent, Ops: []Op{
		{Op: "put", Object: "delta", Version: 1, Blocks: []string{"b0", "nope"}},
	}}
	state, _, err := Restore(m, []*Package{bad})
	if state != nil {
		t.Fatalf("partial state must not be returned on failure")
	}
	var inv *Invalidation
	if !errors.As(err, &inv) {
		t.Fatalf("expected Invalidation, got %v", err)
	}
	if inv.Kind != KindMissingBlocks || inv.Edge != 0 || inv.Op != 0 {
		t.Fatalf("want missing-blocks at edge 0 op 0, got %v", inv)
	}
}

func TestIdempotentReputAndStaleVersion(t *testing.T) {
	m := baseManifest()
	tmpl := []*Package{
		{Blocks: map[string]string{"b2": "two"}, Ops: []Op{
			{Op: "put", Object: "alpha", Version: 2, Blocks: []string{"b2"}},
			{Op: "put", Object: "alpha", Version: 2, Blocks: []string{"b2"}}, // same content: no-op
			{Op: "put", Object: "alpha", Version: 1, Blocks: []string{"b0"}}, // stale: no-op
			{Op: "delete", Object: "ghost"},                                  // delete of absent object: no-op
		}},
	}
	chain := buildChain(t, m, tmpl)
	state, _, err := Restore(m, chain)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if got := state.Objects["alpha"]; got.Version != 2 || !reflect.DeepEqual(got.Blocks, []string{"b2"}) {
		t.Fatalf("alpha = %+v, want version 2 blocks [b2]", got)
	}
}

func TestSerialInterpreterRejectsBrokenOrder(t *testing.T) {
	m := baseManifest()
	chain := buildChain(t, m, chainTemplates())
	// Serial interpreter must reject out-of-order input at the earliest edge.
	_, _, err := RestoreSerial(m, []*Package{chain[1], chain[0], chain[2]})
	var inv *Invalidation
	if !errors.As(err, &inv) {
		t.Fatalf("expected Invalidation, got %v", err)
	}
	if inv.Kind != KindMissingParent || inv.Edge != 0 {
		t.Fatalf("want missing-parent at edge 0, got %v", inv)
	}
}

func nextPermutation(p []int) bool {
	i := len(p) - 2
	for i >= 0 && p[i] >= p[i+1] {
		i--
	}
	if i < 0 {
		return false
	}
	j := len(p) - 1
	for p[j] <= p[i] {
		j--
	}
	p[i], p[j] = p[j], p[i]
	for l, r := i+1, len(p)-1; l < r; l, r = l+1, r-1 {
		p[l], p[r] = p[r], p[l]
	}
	return true
}
