package inventory

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func testRules() Rules {
	return Rules{
		Capacity: 10,
		NoMix:    []KindPair{{A: "food", B: "chem"}},
	}
}

func mustCreate(t *testing.T, inv *Inventory, boxes ...BoxID) {
	t.Helper()
	for _, b := range boxes {
		if err := inv.CreateBox(b); err != nil {
			t.Fatalf("CreateBox(%s): %v", b, err)
		}
	}
}

func TestSplitMergeExchange(t *testing.T) {
	inv := New(testRules())
	mustCreate(t, inv, "A", "B")
	if err := inv.Put("A",
		Item{ID: "i1", Kind: "food", Size: 2},
		Item{ID: "i2", Kind: "food", Size: 3},
		Item{ID: "i3", Kind: "food", Size: 1},
	); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := inv.Split("A", "C", []ItemID{"i2", "i3"}); err != nil {
		t.Fatalf("Split: %v", err)
	}
	if err := inv.Merge("C", "B"); err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if err := inv.Exchange([]Move{{Item: "i1", To: "B"}, {Item: "i2", To: "A"}}); err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	want := map[ItemID]BoxID{"i1": "B", "i2": "A", "i3": "B"}
	if got := inv.Ownership(); !reflect.DeepEqual(got, want) {
		t.Fatalf("ownership = %v, want %v", got, want)
	}
}

func TestPutRejectsNoMix(t *testing.T) {
	inv := New(testRules())
	mustCreate(t, inv, "A")
	err := inv.Put("A",
		Item{ID: "i1", Kind: "food", Size: 2},
		Item{ID: "i2", Kind: "chem", Size: 1},
	)
	if err == nil {
		t.Fatal("expected no-mix error")
	}
	if _, ok := inv.Locate("i1"); ok {
		t.Fatal("failed Put must not register any item")
	}
	if got := len(inv.History()); got != 1 { // only create_box
		t.Fatalf("history len = %d, want 1", got)
	}
}

func TestSplitAndOwnership(t *testing.T) {
	inv := New(testRules())
	mustCreate(t, inv, "A")
	if err := inv.Put("A",
		Item{ID: "i1", Kind: "food", Size: 2},
		Item{ID: "i2", Kind: "food", Size: 3},
		Item{ID: "i3", Kind: "food", Size: 1},
	); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := inv.Split("A", "B", []ItemID{"i2", "i3"}); err != nil {
		t.Fatalf("Split: %v", err)
	}
	if b, _ := inv.Locate("i2"); b != "B" {
		t.Fatalf("i2 in %s, want B", b)
	}
	ids, _ := inv.Contents("A")
	if !reflect.DeepEqual(ids, []ItemID{"i1"}) {
		t.Fatalf("A contents = %v", ids)
	}
	// Split failure: item not in source -> no change at all.
	before := inv.String()
	if err := inv.Split("A", "C", []ItemID{"i2"}); err == nil {
		t.Fatal("expected ErrWrongBox")
	}
	if inv.String() != before {
		t.Fatal("failed Split mutated state")
	}
	if _, ok := inv.Contents("C"); ok {
		t.Fatal("failed Split created box C")
	}
}

func TestMergeAtomicity(t *testing.T) {
	inv := New(testRules())
	mustCreate(t, inv, "A", "B")
	if err := inv.Put("A", Item{ID: "i1", Kind: "food", Size: 6}); err != nil {
		t.Fatal(err)
	}
	if err := inv.Put("B", Item{ID: "i2", Kind: "food", Size: 6}); err != nil {
		t.Fatal(err)
	}
	before := inv.String()
	if err := inv.Merge("A", "B"); err == nil {
		t.Fatal("expected capacity error")
	}
	if inv.String() != before {
		t.Fatal("failed Merge mutated state")
	}
	// Successful merge keeps the source as an empty box.
	mustCreate(t, inv, "C")
	if err := inv.Merge("A", "C"); err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if ids, _ := inv.Contents("A"); len(ids) != 0 {
		t.Fatal("source box should be empty but retained")
	}
	if _, ok := inv.Contents("A"); !ok {
		t.Fatal("empty source box must be retained")
	}
}

func TestExchangeAtomicity(t *testing.T) {
	inv := New(testRules())
	mustCreate(t, inv, "A", "B")
	if err := inv.Put("A",
		Item{ID: "i1", Kind: "food", Size: 4},
		Item{ID: "i2", Kind: "chem", Size: 4},
	); err == nil {
		t.Fatal("setup put should fail: food+chem")
	}
	if err := inv.Put("A", Item{ID: "i1", Kind: "food", Size: 4}); err != nil {
		t.Fatal(err)
	}
	if err := inv.Put("B", Item{ID: "i2", Kind: "chem", Size: 4}); err != nil {
		t.Fatal(err)
	}
	// Swap food and chem: each intermediate box would mix, but the final
	// state is valid, so the transaction must succeed atomically.
	if err := inv.Exchange([]Move{{Item: "i1", To: "B"}, {Item: "i2", To: "A"}}); err != nil {
		t.Fatalf("Exchange swap: %v", err)
	}
	if b, _ := inv.Locate("i1"); b != "B" {
		t.Fatalf("i1 in %s, want B", b)
	}
	// Swap back, then an invalid exchange must revert completely.
	if err := inv.Exchange([]Move{{Item: "i1", To: "A"}, {Item: "i2", To: "B"}}); err != nil {
		t.Fatalf("valid reverse swap should succeed: %v", err)
	}
	before := inv.String()
	err := inv.Exchange([]Move{{Item: "i1", To: "B"}})
	if err == nil {
		t.Fatal("expected no-mix error")
	}
	if inv.String() != before {
		t.Fatal("failed Exchange mutated state")
	}
}

func TestReplay(t *testing.T) {
	inv := New(testRules())
	mustCreate(t, inv, "A", "B")
	if err := inv.Put("A",
		Item{ID: "i1", Kind: "food", Size: 2},
		Item{ID: "i2", Kind: "food", Size: 3},
	); err != nil {
		t.Fatal(err)
	}
	if err := inv.Split("A", "C", []ItemID{"i2"}); err != nil {
		t.Fatal(err)
	}
	if err := inv.Exchange([]Move{{Item: "i2", To: "B"}}); err != nil {
		t.Fatal(err)
	}
	if err := inv.Merge("C", "A"); err != nil {
		t.Fatal(err)
	}
	replayed, err := Replay(testRules(), inv.History())
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if replayed.String() != inv.String() {
		t.Fatalf("replay mismatch:\n%s\nvs\n%s", replayed.String(), inv.String())
	}
	if !reflect.DeepEqual(replayed.Ownership(), inv.Ownership()) {
		t.Fatal("ownership tables differ after replay")
	}
}

// TestRandomAgainstReference drives random operations and checks, after
// every step, that the ownership table matches a reference map, that every
// item lives in exactly one box, that rules hold, and that replaying the
// history reproduces the exact same state.
func TestRandomAgainstReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20261008))
	rules := Rules{
		Capacity: 12,
		NoMix:    []KindPair{{A: "food", B: "chem"}, {A: "chem", B: "tool"}},
	}
	kinds := []string{"food", "chem", "tool"}
	inv := New(rules)
	ref := map[ItemID]BoxID{} // reference ownership table
	boxSeq, itemSeq := 0, 0

	check := func(step int) {
		t.Helper()
		// Reference table matches library ownership.
		own := inv.Ownership()
		if !reflect.DeepEqual(own, ref) {
			t.Fatalf("step %d: ownership mismatch: got %v want %v", step, own, ref)
		}
		// Each item appears in exactly one box; rules hold per box.
		seen := map[ItemID]int{}
		for _, b := range inv.Boxes() {
			ids, _ := inv.Contents(b)
			total := 0
			for _, id := range ids {
				seen[id]++
				total += inv.items[id].Size
			}
			if rules.Capacity > 0 && total > rules.Capacity {
				t.Fatalf("step %d: box %s over capacity", step, b)
			}
			for i := 0; i < len(ids); i++ {
				for j := i + 1; j < len(ids); j++ {
					if rules.forbidden(inv.items[ids[i]].Kind, inv.items[ids[j]].Kind) {
						t.Fatalf("step %d: box %s mixes forbidden kinds", step, b)
					}
				}
			}
		}
		for id, n := range seen {
			if n != 1 {
				t.Fatalf("step %d: item %s in %d boxes", step, id, n)
			}
		}
		if len(seen) != len(ref) {
			t.Fatalf("step %d: %d items in boxes, %d in reference", step, len(seen), len(ref))
		}
		// History replays to the identical state.
		replayed, err := Replay(rules, inv.History())
		if err != nil {
			t.Fatalf("step %d: replay failed: %v", step, err)
		}
		if replayed.String() != inv.String() {
			t.Fatalf("step %d: replay state mismatch", step)
		}
	}

	randKind := func() string { return kinds[rng.Intn(len(kinds))] }
	randBox := func() BoxID {
		boxes := inv.Boxes()
		return boxes[rng.Intn(len(boxes))]
	}
	randItem := func() (ItemID, bool) {
		if len(ref) == 0 {
			return "", false
		}
		ids := make([]ItemID, 0, len(ref))
		for id := range ref {
			ids = append(ids, id)
		}
		return ids[rng.Intn(len(ids))], true
	}

	for step := 0; step < 2000; step++ {
		before := inv.String()
		var err error
		applyRef := func() {} // mutated only on success
		switch rng.Intn(5) {
		case 0: // create box
			b := BoxID(fmt.Sprintf("box%d", boxSeq))
			boxSeq++
			err = inv.CreateBox(b)
		case 1: // put new items
			if len(inv.Boxes()) == 0 {
				continue
			}
			b := randBox()
			n := 1 + rng.Intn(3)
			items := make([]Item, n)
			for i := range items {
				items[i] = Item{ID: ItemID(fmt.Sprintf("item%d", itemSeq)), Kind: randKind(), Size: 1 + rng.Intn(6)}
				itemSeq++
			}
			err = inv.Put(b, items...)
			applyRef = func() {
				for _, it := range items {
					ref[it.ID] = b
				}
			}
		case 2: // split
			if len(ref) == 0 {
				continue
			}
			src := randBox()
			ids, _ := inv.Contents(src)
			if len(ids) == 0 {
				continue
			}
			rng.Shuffle(len(ids), func(i, j int) { ids[i], ids[j] = ids[j], ids[i] })
			pick := ids[:rng.Intn(len(ids))]
			dst := BoxID(fmt.Sprintf("box%d", boxSeq))
			boxSeq++
			err = inv.Split(src, dst, pick)
			applyRef = func() {
				for _, id := range pick {
					ref[id] = dst
				}
			}
		case 3: // merge
			if len(inv.Boxes()) < 2 {
				continue
			}
			src, dst := randBox(), randBox()
			if src == dst {
				continue
			}
			moved, _ := inv.Contents(src)
			err = inv.Merge(src, dst)
			applyRef = func() {
				for _, id := range moved {
					ref[id] = dst
				}
			}
		case 4: // exchange
			if len(ref) == 0 || len(inv.Boxes()) == 0 {
				continue
			}
			n := 1 + rng.Intn(3)
			moves := make([]Move, 0, n)
			for i := 0; i < n; i++ {
				id, ok := randItem()
				if !ok {
					break
				}
				moves = append(moves, Move{Item: id, To: randBox()})
			}
			if len(moves) == 0 {
				continue
			}
			err = inv.Exchange(moves)
			applyRef = func() {
				for _, m := range moves {
					ref[m.Item] = m.To
				}
			}
		}
		if err != nil {
			// Failure must leave the inventory completely unchanged.
			if inv.String() != before {
				t.Fatalf("step %d: failed op mutated state\nbefore:\n%s\nafter:\n%s", step, before, inv.String())
			}
		} else {
			applyRef()
		}
		check(step)
	}
	t.Logf("final: %d boxes, %d items, %d events", len(inv.Boxes()), len(ref), len(inv.History()))
}
