package inventory

import (
	"fmt"
	"math/rand"
	"testing"
)

// reference is an independent model of the inventory used to
// cross-check random operation sequences.
type reference struct {
	boxes map[BoxID]bool
	items map[ItemID]Item
	owner map[ItemID]BoxID
}

func newReference() *reference {
	return &reference{
		boxes: make(map[BoxID]bool),
		items: make(map[ItemID]Item),
		owner: make(map[ItemID]BoxID),
	}
}

// apply mirrors a successfully committed op. The library guarantees
// committed ops are valid, so the reference needs no validation.
func (r *reference) apply(op Op) {
	switch op.Type {
	case OpCreateBox:
		r.boxes[op.Box] = true
	case OpRemoveBox:
		delete(r.boxes, op.Box)
	case OpPut:
		r.items[op.Item.ID] = op.Item
		r.owner[op.Item.ID] = op.Box
	case OpMove:
		r.owner[op.ItemID] = op.Dst
	case OpRemove:
		delete(r.items, op.ItemID)
		delete(r.owner, op.ItemID)
	}
}

func checkInvariants(t *testing.T, inv *Inventory, ref *reference) {
	t.Helper()
	snap := inv.Snapshot()

	// Ownership table matches the reference exactly.
	if len(snap.Items) != len(ref.owner) {
		t.Fatalf("item count %d, reference has %d", len(snap.Items), len(ref.owner))
	}
	for id, box := range ref.owner {
		if snap.Items[id] != box {
			t.Fatalf("item %q in box %q, reference says %q", id, snap.Items[id], box)
		}
	}

	// Box set matches the reference.
	if len(snap.Boxes) != len(ref.boxes) {
		t.Fatalf("box count %d, reference has %d", len(snap.Boxes), len(ref.boxes))
	}
	for box := range ref.boxes {
		if _, ok := snap.Boxes[box]; !ok {
			t.Fatalf("box %q missing from inventory", box)
		}
	}

	// Each item sits in exactly one box, boxes respect capacity and
	// no-mixing rules.
	rules := inv.Rules()
	seen := make(map[ItemID]BoxID)
	for box, items := range snap.Boxes {
		if rules.Capacity > 0 && len(items) > rules.Capacity {
			t.Fatalf("box %q holds %d items, capacity %d", box, len(items), rules.Capacity)
		}
		for i, item := range items {
			if prev, dup := seen[item.ID]; dup {
				t.Fatalf("item %q in both %q and %q", item.ID, prev, box)
			}
			seen[item.ID] = box
			if snap.Items[item.ID] != box {
				t.Fatalf("item %q listed in %q but owned by %q", item.ID, box, snap.Items[item.ID])
			}
			for j := i + 1; j < len(items); j++ {
				if !rules.compatible(item.Group, items[j].Group) {
					t.Fatalf("box %q mixes groups %q and %q", box, item.Group, items[j].Group)
				}
			}
		}
	}
	if len(seen) != len(snap.Items) {
		t.Fatalf("%d items placed in boxes but ownership table has %d", len(seen), len(snap.Items))
	}
}

func TestRandomOperations(t *testing.T) {
	groups := []Group{"food", "chemical", "tool", "cloth"}
	rules := Rules{
		Capacity: 4,
		IncompatibleGroups: [][2]Group{
			{"food", "chemical"},
			{"food", "tool"},
		},
	}

	for seed := int64(1); seed <= 20; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			inv := New(rules)
			ref := newReference()
			nextItem := 0

			pickBox := func() BoxID {
				if len(ref.boxes) == 0 {
					return ""
				}
				boxes := make([]BoxID, 0, len(ref.boxes))
				for b := range ref.boxes {
					boxes = append(boxes, b)
				}
				return boxes[rng.Intn(len(boxes))]
			}
			pickItem := func() ItemID {
				if len(ref.items) == 0 {
					return ""
				}
				ids := make([]ItemID, 0, len(ref.items))
				for id := range ref.items {
					ids = append(ids, id)
				}
				return ids[rng.Intn(len(ids))]
			}

			for step := 0; step < 400; step++ {
				before := inv.Snapshot()
				tx := inv.Begin()
				var ops []Op

				numOps := 1 + rng.Intn(3)
				for k := 0; k < numOps; k++ {
					var op Op
					switch rng.Intn(6) {
					case 0: // create box
						box := BoxID(fmt.Sprintf("box-%d", rng.Intn(12)))
						tx.CreateBox(box)
						op = Op{Type: OpCreateBox, Box: box}
					case 1: // remove box
						box := pickBox()
						if box == "" {
							continue
						}
						tx.RemoveBox(box)
						op = Op{Type: OpRemoveBox, Box: box}
					case 2: // put new item
						box := pickBox()
						if box == "" {
							continue
						}
						item := Item{
							ID:    ItemID(fmt.Sprintf("item-%d", nextItem)),
							Group: groups[rng.Intn(len(groups))],
						}
						nextItem++
						tx.Put(item, box)
						op = Op{Type: OpPut, Box: box, Item: item}
					case 3: // move item
						id, dst := pickItem(), pickBox()
						if id == "" || dst == "" {
							continue
						}
						tx.Move(id, dst)
						op = Op{Type: OpMove, ItemID: id, Dst: dst}
					case 4: // remove item
						id := pickItem()
						if id == "" {
							continue
						}
						tx.Remove(id)
						op = Op{Type: OpRemove, ItemID: id}
					case 5: // move a possibly-unknown item (often fails)
						id := ItemID(fmt.Sprintf("item-%d", rng.Intn(nextItem+4)))
						dst := pickBox()
						if dst == "" {
							continue
						}
						tx.Move(id, dst)
						op = Op{Type: OpMove, ItemID: id, Dst: dst}
					}
					ops = append(ops, op)
				}

				err := tx.Commit()
				if err != nil {
					// Failure must leave the inventory untouched.
					if !inv.Snapshot().Equal(before) {
						t.Fatalf("step %d: failed tx (%v) mutated state", step, err)
					}
					continue
				}
				for _, op := range ops {
					ref.apply(op)
				}
				checkInvariants(t, inv, ref)
			}

			// The recorded history must replay to the identical state,
			// including after a JSON round-trip.
			replayed, err := Replay(rules, inv.History())
			if err != nil {
				t.Fatalf("replay: %v", err)
			}
			if !inv.Snapshot().Equal(replayed.Snapshot()) {
				t.Fatal("replayed state differs")
			}
			data, err := inv.MarshalHistory()
			if err != nil {
				t.Fatal(err)
			}
			replayedJSON, err := ReplayJSON(rules, data)
			if err != nil {
				t.Fatalf("replay JSON: %v", err)
			}
			if !inv.Snapshot().Equal(replayedJSON.Snapshot()) {
				t.Fatal("JSON-replayed state differs")
			}
		})
	}
}
