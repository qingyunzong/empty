// Package inventory implements a box-based inventory library.
//
// Items carry stable IDs and each item belongs to exactly one box.
// Boxes have a capacity and group-based no-mixing rules, both supplied
// as inputs via Rules. All mutations happen inside transactions that
// are applied atomically: any validation failure leaves the inventory
// completely unchanged. Committed transactions are recorded as a
// replayable history.
package inventory

import (
	"errors"
	"fmt"
	"sort"
)

// ItemID is the stable identity of an item.
type ItemID string

// BoxID is the stable identity of a box.
type BoxID string

// Group classifies items for no-mixing rules.
type Group string

// Item is an item with a stable ID and a group used by no-mixing rules.
type Item struct {
	ID    ItemID `json:"id"`
	Group Group  `json:"group"`
}

// Rules are the capacity and no-mixing inputs of an Inventory.
type Rules struct {
	// Capacity is the maximum number of items per box. Zero means unlimited.
	Capacity int
	// IncompatibleGroups lists unordered pairs of groups that may not
	// share a box.
	IncompatibleGroups [][2]Group
}

// compatible reports whether two groups may coexist in one box.
func (r Rules) compatible(a, b Group) bool {
	for _, pair := range r.IncompatibleGroups {
		if (pair[0] == a && pair[1] == b) || (pair[0] == b && pair[1] == a) {
			return false
		}
	}
	return true
}

// Sentinel errors returned by transaction commits.
var (
	ErrBoxExists       = errors.New("box already exists")
	ErrBoxNotFound     = errors.New("box not found")
	ErrBoxNotEmpty     = errors.New("box is not empty")
	ErrItemExists      = errors.New("item already exists")
	ErrItemNotFound    = errors.New("item not found")
	ErrCapacity        = errors.New("box capacity exceeded")
	ErrIncompatibleMix = errors.New("incompatible item groups in box")
	ErrEmptyTx         = errors.New("transaction has no operations")
)

// state is the mutable content of an Inventory. Transactions operate on
// a clone so a failed commit leaves the original untouched.
type state struct {
	boxes map[BoxID]map[ItemID]Item
	items map[ItemID]BoxID
}

func newState() *state {
	return &state{
		boxes: make(map[BoxID]map[ItemID]Item),
		items: make(map[ItemID]BoxID),
	}
}

func (s *state) clone() *state {
	c := newState()
	for box, contents := range s.boxes {
		dup := make(map[ItemID]Item, len(contents))
		for id, item := range contents {
			dup[id] = item
		}
		c.boxes[box] = dup
	}
	for id, box := range s.items {
		c.items[id] = box
	}
	return c
}

// checkPlacement validates that item may be added to box, ignoring the
// item itself when it already sits in that box (same-box move).
func (s *state) checkPlacement(rules Rules, box BoxID, item Item) error {
	contents := s.boxes[box]
	if rules.Capacity > 0 {
		count := len(contents)
		if _, ok := contents[item.ID]; ok {
			count--
		}
		if count+1 > rules.Capacity {
			return fmt.Errorf("%w: box %q holds %d/%d items", ErrCapacity, box, count, rules.Capacity)
		}
	}
	for id, other := range contents {
		if id == item.ID {
			continue
		}
		if !rules.compatible(item.Group, other.Group) {
			return fmt.Errorf("%w: groups %q and %q in box %q", ErrIncompatibleMix, item.Group, other.Group, box)
		}
	}
	return nil
}

// Inventory is a set of boxes governed by Rules, mutated only through
// atomic transactions.
type Inventory struct {
	rules   Rules
	st      *state
	history []Tx
	nextSeq int
}

// New creates an empty Inventory governed by rules.
func New(rules Rules) *Inventory {
	return &Inventory{rules: rules, st: newState(), nextSeq: 1}
}

// Rules returns the rules the inventory was created with.
func (inv *Inventory) Rules() Rules { return inv.rules }

// Begin starts a new transaction. Operations are buffered and applied
// atomically by Commit.
func (inv *Inventory) Begin() *TxBuilder {
	return &TxBuilder{inv: inv}
}

// Split moves the given items from src into a new box dst. It is a
// convenience wrapper around a transaction; on failure nothing changes.
func (inv *Inventory) Split(src, dst BoxID, ids []ItemID) error {
	tx := inv.Begin()
	tx.CreateBox(dst)
	for _, id := range ids {
		tx.Move(id, dst)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("split %q into %q: %w", src, dst, err)
	}
	return nil
}

// Merge moves every item from src into dst. The emptied src box is
// retained. It is a convenience wrapper around a transaction; on
// failure nothing changes.
func (inv *Inventory) Merge(src, dst BoxID) error {
	contents, ok := inv.st.boxes[src]
	if !ok {
		return fmt.Errorf("merge %q into %q: %w: %q", src, dst, ErrBoxNotFound, src)
	}
	tx := inv.Begin()
	for id := range contents {
		tx.Move(id, dst)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("merge %q into %q: %w", src, dst, err)
	}
	return nil
}

// BoxContents returns the items of a box in stable (ID-sorted) order.
func (inv *Inventory) BoxContents(box BoxID) ([]Item, bool) {
	contents, ok := inv.st.boxes[box]
	if !ok {
		return nil, false
	}
	items := make([]Item, 0, len(contents))
	for _, item := range contents {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items, true
}

// BoxOf returns the box currently holding the item.
func (inv *Inventory) BoxOf(id ItemID) (BoxID, bool) {
	box, ok := inv.st.items[id]
	return box, ok
}

// Boxes lists all box IDs, including empty ones, in sorted order.
func (inv *Inventory) Boxes() []BoxID {
	boxes := make([]BoxID, 0, len(inv.st.boxes))
	for box := range inv.st.boxes {
		boxes = append(boxes, box)
	}
	sort.Slice(boxes, func(i, j int) bool { return boxes[i] < boxes[j] })
	return boxes
}

// Snapshot is a comparable view of the full inventory state.
type Snapshot struct {
	// Boxes maps each box to its items sorted by item ID.
	Boxes map[BoxID][]Item `json:"boxes"`
	// Items maps each item ID to its owning box.
	Items map[ItemID]BoxID `json:"items"`
}

// Snapshot captures the current inventory state.
func (inv *Inventory) Snapshot() Snapshot {
	snap := Snapshot{
		Boxes: make(map[BoxID][]Item, len(inv.st.boxes)),
		Items: make(map[ItemID]BoxID, len(inv.st.items)),
	}
	for box := range inv.st.boxes {
		items, _ := inv.BoxContents(box)
		snap.Boxes[box] = items
	}
	for id, box := range inv.st.items {
		snap.Items[id] = box
	}
	return snap
}

// Equal reports whether two snapshots describe the same state.
func (s Snapshot) Equal(other Snapshot) bool {
	if len(s.Boxes) != len(other.Boxes) || len(s.Items) != len(other.Items) {
		return false
	}
	for box, items := range s.Boxes {
		otherItems, ok := other.Boxes[box]
		if !ok || len(items) != len(otherItems) {
			return false
		}
		for i, item := range items {
			if item != otherItems[i] {
				return false
			}
		}
	}
	for id, box := range s.Items {
		if other.Items[id] != box {
			return false
		}
	}
	return true
}
