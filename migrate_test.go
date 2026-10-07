package boolcov

import (
	"context"
	"testing"
)

func astV1() *Node {
	// root = x && (y || true)
	return &Node{ID: "root", Kind: KindAnd,
		Left: &Node{ID: "a", Kind: KindVar, Name: "x"},
		Right: &Node{ID: "b", Kind: KindOr,
			Left:  &Node{ID: "c", Kind: KindVar, Name: "y"},
			Right: &Node{ID: "d", Kind: KindConst, Value: true},
		},
	}
}

func TestFreezeVersions(t *testing.T) {
	t1 := Freeze(astV1())
	t2 := Freeze(astV1())
	if t1.Version() != t2.Version() {
		t.Fatal("identical sources must freeze to the same version")
	}
	changed := astV1()
	changed.Right.Left.Name = "z"
	if Freeze(changed).Version() == t1.Version() {
		t.Fatal("structural change must produce a new version")
	}
	// Reassigning IDs alone is not a structural change.
	reid := astV1()
	reid.Left.ID = "renamed"
	if Freeze(reid).Version() != t1.Version() {
		t.Fatal("ID reassignment must not change the source version")
	}
}

func TestMigrateCarriesUnchangedZeroesChanged(t *testing.T) {
	v1 := astV1()
	tab := Freeze(v1)
	ex := NewExecutor(tab)
	read := newReadSpy(map[string]bool{"x": true, "y": false}).read
	const runs = 7
	for i := 0; i < runs; i++ {
		if _, err := ex.Eval(context.Background(), v1, read); err != nil {
			t.Fatal(err)
		}
	}
	// x=true, y=false => d reached every run.
	for id, want := range map[string]uint64{"root": runs, "a": runs, "b": runs, "c": runs, "d": runs} {
		if got := tab.Count(id); got != want {
			t.Fatalf("pre-migration count[%s]=%d, want %d", id, got, want)
		}
	}

	// Rewrite: keep root/a/b structure, rename var c (structure change),
	// flip const d (structure change), add new node e.
	v2 := &Node{ID: "root", Kind: KindAnd,
		Left: &Node{ID: "a", Kind: KindVar, Name: "x"},
		Right: &Node{ID: "b", Kind: KindOr,
			Left:  &Node{ID: "c", Kind: KindVar, Name: "z"},      // same ID, changed structure
			Right: &Node{ID: "d", Kind: KindConst, Value: false}, // same ID, changed structure
		},
	}
	v2.Right.Right = &Node{ID: "e", Kind: KindNot, Left: v2.Right.Right}

	next := tab.Migrate(v2)
	if next.Version() == tab.Version() {
		t.Fatal("migration to changed source must freeze a new version")
	}
	if got := next.Count("root"); got != runs {
		t.Fatalf("unchanged root count=%d, want migrated %d", got, runs)
	}
	if got := next.Count("a"); got != runs {
		t.Fatalf("unchanged a count=%d, want migrated %d", got, runs)
	}
	if got := next.Count("b"); got != runs {
		t.Fatalf("unchanged b count=%d, want migrated %d", got, runs)
	}
	for _, id := range []string{"c", "d", "e"} {
		if got := next.Count(id); got != 0 {
			t.Fatalf("changed/new node %s count=%d, want 0", id, got)
		}
	}
	// Old table stays frozen and untouched.
	if got := tab.Count("c"); got != runs {
		t.Fatalf("old table mutated: count[c]=%d, want %d", got, runs)
	}
}

func TestMigrateKindChangeZeroesNode(t *testing.T) {
	v1 := &Node{ID: "root", Kind: KindAnd,
		Left:  &Node{ID: "l", Kind: KindConst, Value: true},
		Right: &Node{ID: "r", Kind: KindConst, Value: true},
	}
	tab := Freeze(v1)
	ex := NewExecutor(tab)
	if _, err := ex.Eval(context.Background(), v1, nil); err != nil {
		t.Fatal(err)
	}
	// Same IDs, but And becomes Or: the node's own structure changed.
	v2 := &Node{ID: "root", Kind: KindOr,
		Left:  &Node{ID: "l", Kind: KindConst, Value: true},
		Right: &Node{ID: "r", Kind: KindConst, Value: true},
	}
	next := tab.Migrate(v2)
	if got := next.Count("root"); got != 0 {
		t.Fatalf("kind-changed root count=%d, want 0", got)
	}
	if got := next.Count("l"); got != 1 {
		t.Fatalf("unchanged leaf count=%d, want migrated 1", got)
	}
}
