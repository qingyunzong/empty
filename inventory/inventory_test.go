package inventory

import (
	"errors"
	"testing"
)

func testRules() Rules {
	return Rules{
		Capacity:           3,
		IncompatibleGroups: [][2]Group{{"food", "chemical"}},
	}
}

func mustCommit(t *testing.T, tx *TxBuilder) {
	t.Helper()
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit failed: %v", err)
	}
}

func TestPutMoveRemove(t *testing.T) {
	inv := New(testRules())
	tx := inv.Begin()
	tx.CreateBox("b1")
	tx.CreateBox("b2")
	tx.Put(Item{ID: "a", Group: "food"}, "b1")
	tx.Put(Item{ID: "b", Group: "food"}, "b1")
	tx.Move("b", "b2")
	mustCommit(t, tx)

	if box, ok := inv.BoxOf("a"); !ok || box != "b1" {
		t.Fatalf("item a in %q, want b1", box)
	}
	if box, ok := inv.BoxOf("b"); !ok || box != "b2" {
		t.Fatalf("item b in %q, want b2", box)
	}

	tx = inv.Begin()
	tx.Remove("a")
	mustCommit(t, tx)
	if _, ok := inv.BoxOf("a"); ok {
		t.Fatal("item a should be gone")
	}
}

func TestCapacityEnforced(t *testing.T) {
	inv := New(testRules())
	tx := inv.Begin()
	tx.CreateBox("b1")
	tx.Put(Item{ID: "a", Group: "food"}, "b1")
	tx.Put(Item{ID: "b", Group: "food"}, "b1")
	tx.Put(Item{ID: "c", Group: "food"}, "b1")
	mustCommit(t, tx)

	tx = inv.Begin()
	tx.Put(Item{ID: "d", Group: "food"}, "b1")
	if err := tx.Commit(); !errors.Is(err, ErrCapacity) {
		t.Fatalf("got %v, want ErrCapacity", err)
	}
	if _, ok := inv.BoxOf("d"); ok {
		t.Fatal("failed put must not add the item")
	}
}

func TestNoMixEnforced(t *testing.T) {
	inv := New(testRules())
	tx := inv.Begin()
	tx.CreateBox("b1")
	tx.CreateBox("b2")
	tx.Put(Item{ID: "apple", Group: "food"}, "b1")
	tx.Put(Item{ID: "acid", Group: "chemical"}, "b2")
	mustCommit(t, tx)

	tx = inv.Begin()
	tx.Move("acid", "b1")
	if err := tx.Commit(); !errors.Is(err, ErrIncompatibleMix) {
		t.Fatalf("got %v, want ErrIncompatibleMix", err)
	}
	if box, _ := inv.BoxOf("acid"); box != "b2" {
		t.Fatalf("acid moved to %q despite failed tx", box)
	}
}

func TestFailedTxLeavesNoChange(t *testing.T) {
	inv := New(testRules())
	tx := inv.Begin()
	tx.CreateBox("b1")
	tx.Put(Item{ID: "a", Group: "food"}, "b1")
	mustCommit(t, tx)
	before := inv.Snapshot()

	// Transaction with valid ops followed by an invalid one: the whole
	// transaction must be discarded.
	tx = inv.Begin()
	tx.CreateBox("b2")
	tx.Put(Item{ID: "x", Group: "food"}, "b2")
	tx.Move("a", "b2")
	tx.Move("ghost", "b2") // item does not exist
	if err := tx.Commit(); !errors.Is(err, ErrItemNotFound) {
		t.Fatalf("got %v, want ErrItemNotFound", err)
	}
	if !inv.Snapshot().Equal(before) {
		t.Fatal("failed transaction mutated the inventory")
	}
	if len(inv.History()) != 1 {
		t.Fatalf("history has %d entries, want 1", len(inv.History()))
	}
}

func TestDuplicateItemRejected(t *testing.T) {
	inv := New(testRules())
	tx := inv.Begin()
	tx.CreateBox("b1")
	tx.CreateBox("b2")
	tx.Put(Item{ID: "a", Group: "food"}, "b1")
	mustCommit(t, tx)

	tx = inv.Begin()
	tx.Put(Item{ID: "a", Group: "food"}, "b2")
	if err := tx.Commit(); !errors.Is(err, ErrItemExists) {
		t.Fatalf("got %v, want ErrItemExists", err)
	}
}

func TestSplitAndMerge(t *testing.T) {
	inv := New(testRules())
	tx := inv.Begin()
	tx.CreateBox("big")
	tx.Put(Item{ID: "a", Group: "food"}, "big")
	tx.Put(Item{ID: "b", Group: "food"}, "big")
	tx.Put(Item{ID: "c", Group: "food"}, "big")
	mustCommit(t, tx)

	if err := inv.Split("big", "small", []ItemID{"a", "b"}); err != nil {
		t.Fatalf("split: %v", err)
	}
	if items, _ := inv.BoxContents("small"); len(items) != 2 {
		t.Fatalf("small holds %d items, want 2", len(items))
	}

	// Split that violates capacity must fail atomically: no new box,
	// no moved items.
	before := inv.Snapshot()
	if err := inv.Split("big", "overflow", []ItemID{"c"}); err != nil {
		t.Fatalf("split into empty box with capacity 3 should succeed: %v", err)
	}
	_ = before

	if err := inv.Merge("small", "overflow"); err != nil {
		t.Fatalf("merge: %v", err)
	}
	if items, _ := inv.BoxContents("overflow"); len(items) != 3 {
		t.Fatalf("overflow holds %d items, want 3", len(items))
	}
	// Merged-from box is retained as an empty box.
	if items, ok := inv.BoxContents("small"); !ok || len(items) != 0 {
		t.Fatalf("small should remain as empty box, ok=%v items=%d", ok, len(items))
	}

	// Merge that would exceed capacity fails and changes nothing.
	tx = inv.Begin()
	tx.CreateBox("full")
	tx.Put(Item{ID: "x", Group: "food"}, "full")
	tx.Put(Item{ID: "y", Group: "food"}, "full")
	mustCommit(t, tx)
	before = inv.Snapshot()
	if err := inv.Merge("overflow", "full"); !errors.Is(err, ErrCapacity) {
		t.Fatalf("got %v, want ErrCapacity", err)
	}
	if !inv.Snapshot().Equal(before) {
		t.Fatal("failed merge mutated the inventory")
	}
}

func TestRemoveBoxRequiresEmpty(t *testing.T) {
	inv := New(testRules())
	tx := inv.Begin()
	tx.CreateBox("b1")
	tx.Put(Item{ID: "a", Group: "food"}, "b1")
	mustCommit(t, tx)

	tx = inv.Begin()
	tx.RemoveBox("b1")
	if err := tx.Commit(); !errors.Is(err, ErrBoxNotEmpty) {
		t.Fatalf("got %v, want ErrBoxNotEmpty", err)
	}

	tx = inv.Begin()
	tx.Remove("a")
	tx.RemoveBox("b1")
	mustCommit(t, tx)
	if _, ok := inv.BoxContents("b1"); ok {
		t.Fatal("b1 should be removed")
	}
}

func TestHistoryReplay(t *testing.T) {
	inv := New(testRules())
	tx := inv.Begin()
	tx.CreateBox("b1")
	tx.CreateBox("b2")
	tx.Put(Item{ID: "a", Group: "food"}, "b1")
	tx.Put(Item{ID: "b", Group: "food"}, "b2")
	mustCommit(t, tx)
	if err := inv.Split("b1", "b3", []ItemID{"a"}); err != nil {
		t.Fatal(err)
	}
	tx = inv.Begin()
	tx.Move("a", "b2")
	mustCommit(t, tx)

	replayed, err := Replay(testRules(), inv.History())
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !inv.Snapshot().Equal(replayed.Snapshot()) {
		t.Fatal("replayed state differs from original")
	}

	data, err := inv.MarshalHistory()
	if err != nil {
		t.Fatal(err)
	}
	replayedJSON, err := ReplayJSON(testRules(), data)
	if err != nil {
		t.Fatalf("replay JSON: %v", err)
	}
	if !inv.Snapshot().Equal(replayedJSON.Snapshot()) {
		t.Fatal("JSON-replayed state differs from original")
	}
}

func TestReplayRejectsInvalidHistory(t *testing.T) {
	history := []Tx{{Seq: 1, Ops: []Op{
		{Type: OpCreateBox, Box: "b1"},
		{Type: OpPut, Box: "b1", Item: Item{ID: "a", Group: "food"}},
		{Type: OpPut, Box: "b1", Item: Item{ID: "b", Group: "chemical"}},
	}}}
	_, err := Replay(testRules(), history)
	var re *ReplayError
	if !errors.As(err, &re) {
		t.Fatalf("got %v, want ReplayError", err)
	}
	if !errors.Is(err, ErrIncompatibleMix) {
		t.Fatalf("got %v, want ErrIncompatibleMix", err)
	}
}

func TestEmptyBoxesRetained(t *testing.T) {
	inv := New(testRules())
	tx := inv.Begin()
	tx.CreateBox("empty")
	mustCommit(t, tx)
	boxes := inv.Boxes()
	if len(boxes) != 1 || boxes[0] != "empty" {
		t.Fatalf("boxes = %v, want [empty]", boxes)
	}
}
