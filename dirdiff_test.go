package dirdiff

import (
	"strings"
	"testing"
)

func mustDiff(t *testing.T, old, new Manifest) []Op {
	t.Helper()
	ops, err := Diff(old, new)
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	return ops
}

func TestMoveNotDeleteCreate(t *testing.T) {
	old := Manifest{Entries: []Entry{{ID: "a", Path: "x", Version: 1}}}
	new := Manifest{Entries: []Entry{{ID: "a", Path: "y", Version: 1}}}
	ops := mustDiff(t, old, new)
	if len(ops) != 1 || ops[0].Kind != OpMove {
		t.Fatalf("want single move, got %v", ops)
	}
	if ops[0].From != "x" || ops[0].To != "y" {
		t.Fatalf("bad move: %v", ops[0])
	}
}

func TestDeleteAndCreateForNewIDs(t *testing.T) {
	old := Manifest{Entries: []Entry{{ID: "a", Path: "same", Version: 1}}}
	new := Manifest{Entries: []Entry{{ID: "b", Path: "same", Version: 5}}}
	ops := mustDiff(t, old, new)
	if len(ops) != 2 || ops[0].Kind != OpDelete || ops[1].Kind != OpCreate {
		t.Fatalf("want delete then create, got %v", ops)
	}
	got, err := Apply(old, ops)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !got.Equal(new) {
		t.Fatalf("got %+v want %+v", got, new)
	}
}

func TestSwapUsesTempPathOutsideFinalNames(t *testing.T) {
	old := Manifest{Entries: []Entry{
		{ID: "a", Path: "p1", Version: 1},
		{ID: "b", Path: "p2", Version: 2},
	}}
	new := Manifest{Entries: []Entry{
		{ID: "a", Path: "p2", Version: 1},
		{ID: "b", Path: "p1", Version: 2},
	}}
	ops := mustDiff(t, old, new)
	final := map[string]bool{"p1": true, "p2": true}
	var temps int
	for _, op := range ops {
		if op.Kind == OpMove && IsTempPath(op.To) {
			temps++
			if final[op.To] {
				t.Fatalf("temp path %q occupies a final name", op.To)
			}
		}
	}
	if temps == 0 {
		t.Fatalf("swap of 2 must use a temp path, got %v", ops)
	}
	got, err := Apply(old, ops)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !got.Equal(new) {
		t.Fatalf("got %+v want %+v", got, new)
	}
}

func TestInverseRestoresAndRechecksVersion(t *testing.T) {
	old := Manifest{Entries: []Entry{
		{ID: "a", Path: "d/1", Version: 1},
		{ID: "b", Path: "d/2", Version: 3},
		{ID: "gone", Path: "d/3", Version: 7},
	}}
	new := Manifest{Entries: []Entry{
		{ID: "a", Path: "d/2", Version: 1},
		{ID: "b", Path: "d/1", Version: 4},
		{ID: "fresh", Path: "d/9", Version: 1},
	}}
	ops := mustDiff(t, old, new)
	now, err := Apply(old, ops)
	if err != nil {
		t.Fatalf("Apply forward: %v", err)
	}
	if !now.Equal(new) {
		t.Fatalf("forward: got %+v want %+v", now, new)
	}
	back, err := Apply(now, Invert(ops))
	if err != nil {
		t.Fatalf("Apply inverse: %v", err)
	}
	if !back.Equal(old) {
		t.Fatalf("inverse: got %+v want %+v", back, old)
	}
	// Re-applying the inverse must fail the version/target check.
	if _, err := Apply(back, Invert(ops)); err == nil {
		t.Fatal("second inverse apply should fail version check")
	} else if !strings.Contains(err.Error(), "version mismatch") && !strings.Contains(err.Error(), "no entry") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMaxEntries(t *testing.T) {
	m := Manifest{}
	for i := 0; i <= MaxEntries; i++ {
		m.Entries = append(m.Entries, Entry{ID: strings.Repeat("x", i+1), Path: strings.Repeat("p", i+1)})
	}
	if _, err := Diff(m, Manifest{}); err == nil {
		t.Fatal("want error for >12 entries")
	}
}

func TestVersionChangeOnMove(t *testing.T) {
	old := Manifest{Entries: []Entry{{ID: "a", Path: "x", Version: 1}}}
	new := Manifest{Entries: []Entry{{ID: "a", Path: "y", Version: 2}}}
	ops := mustDiff(t, old, new)
	got, err := Apply(old, ops)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !got.Equal(new) {
		t.Fatalf("got %+v want %+v", got, new)
	}
	back, err := Apply(got, Invert(ops))
	if err != nil {
		t.Fatalf("inverse: %v", err)
	}
	if !back.Equal(old) {
		t.Fatalf("got %+v want %+v", back, old)
	}
}
