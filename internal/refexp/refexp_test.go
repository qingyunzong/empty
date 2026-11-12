package refexp_test

import (
	"errors"
	"math/big"
	"testing"

	de "example.org/dataeng/q0298"
	"example.org/dataeng/q0298/internal/refexp"
)

func desc(t *testing.T, f, x, y int) de.Descriptor {
	t.Helper()
	d, err := de.NewDescriptor(f, x, y)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func element(t *testing.T, name string) de.ElementDef {
	t.Helper()
	def, err := de.NewElementDef(name, 8, 0, big.NewInt(0))
	if err != nil {
		t.Fatal(err)
	}
	return def
}

func TestReferenceNestedDelayedExpansion(t *testing.T) {
	elements := de.ElementTable{
		{X: 1, Y: 1}: element(t, "A"),
	}
	root := []de.Descriptor{
		desc(t, 1, 3, 0),
		desc(t, 0, 31, 1),
		desc(t, 1, 1, 0),
		desc(t, 0, 31, 2),
		desc(t, 0, 1, 1),
	}
	var widths []int
	counts := []uint64{2, 3, 3}
	next := 0
	leaves, err := refexp.Expand(root, elements, nil, refexp.Options{
		MaxLeaves: 6,
		MaxDepth:  2,
		Factor: func(width int) (uint64, error) {
			widths = append(widths, width)
			v := counts[next]
			next++
			return v, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(leaves) != 6 {
		t.Fatalf("got %d leaves, want 6", len(leaves))
	}
	wantWidths := []int{8, 16, 16}
	if len(widths) != len(wantWidths) {
		t.Fatalf("factor widths=%v, want %v", widths, wantWidths)
	}
	for i := range widths {
		if widths[i] != wantWidths[i] {
			t.Fatalf("factor widths=%v, want %v", widths, wantWidths)
		}
	}
	for i, leaf := range leaves {
		outer, inner := i/3+1, i%3+1
		if leaf.Path[0].Iteration != outer || leaf.Path[1].Iteration != inner {
			t.Fatalf("leaf %d path=%#v, want iterations %d/%d", i, leaf.Path, outer, inner)
		}
	}
}

func TestReferenceCountsRawPositions(t *testing.T) {
	elements := de.ElementTable{
		{X: 1, Y: 1}: element(t, "A"),
		{X: 1, Y: 2}: element(t, "B"),
		{X: 2, Y: 1}: element(t, "C"),
	}
	seqs := de.SequenceTable{
		{X: 1, Y: 1}: {
			desc(t, 0, 1, 1),
			desc(t, 0, 1, 2),
		},
	}
	root := []de.Descriptor{
		desc(t, 1, 2, 2),
		desc(t, 3, 1, 1),
		desc(t, 0, 2, 1),
	}
	leaves, err := refexp.Expand(root, elements, seqs, refexp.Options{
		MaxLeaves: 6,
		MaxDepth:  -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(leaves) != 6 {
		t.Fatalf("got %d leaves, want 6", len(leaves))
	}
	for i, leaf := range leaves {
		iteration := i/3 + 1
		if leaf.Path[0].Iteration != iteration {
			t.Fatalf("leaf %d path=%#v, want iteration %d", i, leaf.Path, iteration)
		}
		if i%3 < 2 {
			if len(leaf.Path) != 2 || leaf.Path[1].Kind != de.PathSequence {
				t.Fatalf("leaf %d sequence path=%#v", i, leaf.Path)
			}
		} else if len(leaf.Path) != 1 {
			t.Fatalf("leaf %d direct path=%#v", i, leaf.Path)
		}
	}
}

func TestReferenceRejectsCycleInsideZeroCopy(t *testing.T) {
	elements := de.ElementTable{
		{X: 1, Y: 1}: element(t, "A"),
	}
	seqs := de.SequenceTable{
		{X: 1, Y: 1}: {
			desc(t, 1, 1, 0),
			desc(t, 0, 31, 1),
			desc(t, 3, 1, 1),
		},
	}
	_, err := refexp.Expand([]de.Descriptor{desc(t, 3, 1, 1)}, elements, seqs, refexp.Options{
		MaxLeaves: 1,
		MaxDepth:  -1,
	})
	if err == nil || !errors.Is(err, refexp.ErrCycle) {
		t.Fatalf("err=%v, want cycle", err)
	}
}
