// Package inventory implements a box-based inventory library.
//
// Items have stable IDs and each item belongs to exactly one box at any
// time. Boxes can be split, merged, and have their contents exchanged via
// atomic transactions. Capacity and no-mixing rules are supplied by the
// caller. A failed operation leaves the inventory completely unchanged.
// Empty boxes are retained. Every committed operation is appended to a
// history that can be replayed to reconstruct the exact same state.
package inventory

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// ItemID is the stable identity of an item.
type ItemID string

// BoxID is the stable identity of a box.
type BoxID string

// Item is a storable object. Kind is the category used by no-mixing rules.
type Item struct {
	ID   ItemID
	Kind string
	Size int
}

// KindPair is an unordered pair of kinds that must not share a box.
type KindPair struct{ A, B string }

// Rules constrains box contents. Capacity <= 0 means unlimited.
type Rules struct {
	Capacity int
	NoMix    []KindPair
}

func (r Rules) forbidden(a, b string) bool {
	for _, p := range r.NoMix {
		if (p.A == a && p.B == b) || (p.A == b && p.B == a) {
			return true
		}
	}
	return false
}

// Move relocates one item to a target box inside an Exchange transaction.
type Move struct {
	Item ItemID
	To   BoxID
}

// OpType identifies the kind of a history event.
type OpType string

const (
	OpCreateBox OpType = "create_box"
	OpPut       OpType = "put"
	OpSplit     OpType = "split"
	OpMerge     OpType = "merge"
	OpExchange  OpType = "exchange"
)

// Event is one committed operation; the full history replays the state.
type Event struct {
	Op    OpType
	Box   BoxID    // create_box
	Items []Item   // put
	Src   BoxID    // split, merge
	Dst   BoxID    // split, merge
	IDs   []ItemID // split
	Moves []Move   // exchange
}

// Inventory holds boxes, items, and the committed operation history.
type Inventory struct {
	rules   Rules
	boxes   map[BoxID]map[ItemID]struct{}
	items   map[ItemID]Item
	loc     map[ItemID]BoxID
	history []Event
}

// New creates an empty inventory governed by rules.
func New(rules Rules) *Inventory {
	return &Inventory{
		rules: rules,
		boxes: map[BoxID]map[ItemID]struct{}{},
		items: map[ItemID]Item{},
		loc:   map[ItemID]BoxID{},
	}
}

// Rules returns the rules the inventory was created with.
func (inv *Inventory) Rules() Rules { return inv.rules }

// History returns a copy of the committed event log.
func (inv *Inventory) History() []Event {
	out := make([]Event, len(inv.history))
	copy(out, inv.history)
	return out
}

// Locate reports which box currently holds the item.
func (inv *Inventory) Locate(id ItemID) (BoxID, bool) {
	b, ok := inv.loc[id]
	return b, ok
}

// Ownership returns a snapshot of the item -> box assignment table.
func (inv *Inventory) Ownership() map[ItemID]BoxID {
	out := make(map[ItemID]BoxID, len(inv.loc))
	for id, b := range inv.loc {
		out[id] = b
	}
	return out
}

// Contents returns the sorted item IDs of a box.
func (inv *Inventory) Contents(box BoxID) ([]ItemID, bool) {
	set, ok := inv.boxes[box]
	if !ok {
		return nil, false
	}
	out := make([]ItemID, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, true
}

// Boxes returns the sorted IDs of all boxes, including empty ones.
func (inv *Inventory) Boxes() []BoxID {
	out := make([]BoxID, 0, len(inv.boxes))
	for b := range inv.boxes {
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

var (
	ErrBoxExists  = errors.New("inventory: box already exists")
	ErrNoSuchBox  = errors.New("inventory: no such box")
	ErrItemExists = errors.New("inventory: item already exists")
	ErrNoSuchItem = errors.New("inventory: no such item")
	ErrBadSize    = errors.New("inventory: item size must be positive")
	ErrCapacity   = errors.New("inventory: box capacity exceeded")
	ErrNoMix      = errors.New("inventory: forbidden kind mixture")
	ErrWrongBox   = errors.New("inventory: item not in source box")
	ErrDupMove    = errors.New("inventory: item moved twice in one transaction")
)

// checkContents validates capacity and no-mixing for one box's contents.
func (inv *Inventory) checkContents(contents map[ItemID]struct{}) error {
	if inv.rules.Capacity > 0 {
		total := 0
		for id := range contents {
			total += inv.items[id].Size
		}
		if total > inv.rules.Capacity {
			return fmt.Errorf("%w: %d > %d", ErrCapacity, total, inv.rules.Capacity)
		}
	}
	ids := make([]ItemID, 0, len(contents))
	for id := range contents {
		ids = append(ids, id)
	}
	for i := 0; i < len(ids); i++ {
		for j := i + 1; j < len(ids); j++ {
			ka, kb := inv.items[ids[i]].Kind, inv.items[ids[j]].Kind
			if inv.rules.forbidden(ka, kb) {
				return fmt.Errorf("%w: %q with %q", ErrNoMix, ka, kb)
			}
		}
	}
	return nil
}

// CreateBox adds a new empty box. Empty boxes are retained forever.
func (inv *Inventory) CreateBox(box BoxID) error {
	if _, ok := inv.boxes[box]; ok {
		return ErrBoxExists
	}
	inv.boxes[box] = map[ItemID]struct{}{}
	inv.history = append(inv.history, Event{Op: OpCreateBox, Box: box})
	return nil
}

// Put registers new items and places them into an existing box.
func (inv *Inventory) Put(box BoxID, items ...Item) error {
	set, ok := inv.boxes[box]
	if !ok {
		return ErrNoSuchBox
	}
	for _, it := range items {
		if it.Size <= 0 {
			return fmt.Errorf("%w: %q", ErrBadSize, it.ID)
		}
		if _, dup := inv.items[it.ID]; dup {
			return fmt.Errorf("%w: %q", ErrItemExists, it.ID)
		}
	}
	// Validate against the would-be contents before mutating anything.
	proposed := make(map[ItemID]struct{}, len(set)+len(items))
	for id := range set {
		proposed[id] = struct{}{}
	}
	for _, it := range items {
		proposed[it.ID] = struct{}{}
	}
	saved := inv.items
	inv.items = make(map[ItemID]Item, len(saved)+len(items))
	for id, it := range saved {
		inv.items[id] = it
	}
	for _, it := range items {
		inv.items[it.ID] = it
	}
	err := inv.checkContents(proposed)
	if err != nil {
		inv.items = saved
		return err
	}
	for _, it := range items {
		set[it.ID] = struct{}{}
		inv.loc[it.ID] = box
	}
	inv.history = append(inv.history, Event{Op: OpPut, Box: box, Items: append([]Item(nil), items...)})
	return nil
}

// Split moves the given items from src into a brand-new box dst.
func (inv *Inventory) Split(src, dst BoxID, ids []ItemID) error {
	srcSet, ok := inv.boxes[src]
	if !ok {
		return ErrNoSuchBox
	}
	if _, ok := inv.boxes[dst]; ok {
		return ErrBoxExists
	}
	seen := map[ItemID]struct{}{}
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			return fmt.Errorf("%w: %q", ErrDupMove, id)
		}
		seen[id] = struct{}{}
		if _, ok := srcSet[id]; !ok {
			return fmt.Errorf("%w: %q not in %q", ErrWrongBox, id, src)
		}
	}
	dstSet := map[ItemID]struct{}{}
	for _, id := range ids {
		dstSet[id] = struct{}{}
	}
	if err := inv.checkContents(dstSet); err != nil {
		return err
	}
	for _, id := range ids {
		delete(srcSet, id)
		dstSet[id] = struct{}{}
		inv.loc[id] = dst
	}
	inv.boxes[dst] = dstSet
	inv.history = append(inv.history, Event{Op: OpSplit, Src: src, Dst: dst, IDs: append([]ItemID(nil), ids...)})
	return nil
}

// Merge moves every item from src into dst. src is kept as an empty box.
func (inv *Inventory) Merge(src, dst BoxID) error {
	srcSet, ok := inv.boxes[src]
	if !ok {
		return ErrNoSuchBox
	}
	dstSet, ok := inv.boxes[dst]
	if !ok {
		return ErrNoSuchBox
	}
	if src == dst {
		return nil // no-op; nothing to record
	}
	proposed := make(map[ItemID]struct{}, len(dstSet)+len(srcSet))
	for id := range dstSet {
		proposed[id] = struct{}{}
	}
	for id := range srcSet {
		proposed[id] = struct{}{}
	}
	if err := inv.checkContents(proposed); err != nil {
		return err
	}
	for id := range srcSet {
		dstSet[id] = struct{}{}
		inv.loc[id] = dst
	}
	inv.boxes[src] = map[ItemID]struct{}{}
	inv.history = append(inv.history, Event{Op: OpMerge, Src: src, Dst: dst})
	return nil
}

// Exchange atomically relocates items between existing boxes. If any move
// is invalid or any resulting box violates the rules, nothing changes.
func (inv *Inventory) Exchange(moves []Move) error {
	moved := map[ItemID]BoxID{}
	for _, m := range moves {
		if _, ok := inv.items[m.Item]; !ok {
			return fmt.Errorf("%w: %q", ErrNoSuchItem, m.Item)
		}
		if _, ok := inv.boxes[m.To]; !ok {
			return fmt.Errorf("%w: %q", ErrNoSuchBox, m.To)
		}
		if _, dup := moved[m.Item]; dup {
			return fmt.Errorf("%w: %q", ErrDupMove, m.Item)
		}
		moved[m.Item] = m.To
	}
	// Compute the would-be contents of every affected box, validate all,
	// and only then commit.
	affected := map[BoxID]map[ItemID]struct{}{}
	clone := func(b BoxID) map[ItemID]struct{} {
		if c, ok := affected[b]; ok {
			return c
		}
		c := make(map[ItemID]struct{}, len(inv.boxes[b]))
		for id := range inv.boxes[b] {
			c[id] = struct{}{}
		}
		affected[b] = c
		return c
	}
	for _, m := range moves {
		from := inv.loc[m.Item]
		if from == m.To {
			continue
		}
		delete(clone(from), m.Item)
		clone(m.To)[m.Item] = struct{}{}
	}
	for box, contents := range affected {
		if err := inv.checkContents(contents); err != nil {
			return fmt.Errorf("box %q: %w", box, err)
		}
	}
	for box, contents := range affected {
		inv.boxes[box] = contents
	}
	for id, to := range moved {
		inv.loc[id] = to
	}
	inv.history = append(inv.history, Event{Op: OpExchange, Moves: append([]Move(nil), moves...)})
	return nil
}

// Replay rebuilds an inventory from scratch by applying events in order.
// It returns an error if any event is invalid under the given rules.
func Replay(rules Rules, events []Event) (*Inventory, error) {
	inv := New(rules)
	for i, ev := range events {
		var err error
		switch ev.Op {
		case OpCreateBox:
			err = inv.CreateBox(ev.Box)
		case OpPut:
			err = inv.Put(ev.Box, ev.Items...)
		case OpSplit:
			err = inv.Split(ev.Src, ev.Dst, ev.IDs)
		case OpMerge:
			err = inv.Merge(ev.Src, ev.Dst)
		case OpExchange:
			err = inv.Exchange(ev.Moves)
		default:
			err = fmt.Errorf("inventory: unknown op %q", ev.Op)
		}
		if err != nil {
			return nil, fmt.Errorf("replay event %d (%s): %w", i, ev.Op, err)
		}
	}
	return inv, nil
}

// String renders a canonical, deterministic view of the full state,
// suitable for equality checks between inventories.
func (inv *Inventory) String() string {
	var sb strings.Builder
	for _, b := range inv.Boxes() {
		ids, _ := inv.Contents(b)
		parts := make([]string, len(ids))
		for i, id := range ids {
			parts[i] = string(id)
		}
		fmt.Fprintf(&sb, "%s:[%s]\n", b, strings.Join(parts, ","))
	}
	return sb.String()
}
