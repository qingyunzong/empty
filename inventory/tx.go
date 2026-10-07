package inventory

import "fmt"

// OpType identifies the kind of a transaction operation.
type OpType string

const (
	OpCreateBox OpType = "create_box"
	OpRemoveBox OpType = "remove_box"
	OpPut       OpType = "put"
	OpMove      OpType = "move"
	OpRemove    OpType = "remove"
)

// Op is a single inventory mutation. Ops are the serializable units of
// the replayable history.
type Op struct {
	Type OpType `json:"type"`
	// Box is the target box for create_box, remove_box and put.
	Box BoxID `json:"box,omitempty"`
	// Dst is the destination box for move.
	Dst BoxID `json:"dst,omitempty"`
	// Item is the full item for put.
	Item Item `json:"item,omitempty"`
	// ItemID is the item reference for move and remove.
	ItemID ItemID `json:"item_id,omitempty"`
}

// Tx is a committed transaction: an ordered list of ops applied
// atomically, tagged with a monotonically increasing sequence number.
type Tx struct {
	Seq int  `json:"seq"`
	Ops []Op `json:"ops"`
}

// TxBuilder accumulates operations for one atomic transaction.
type TxBuilder struct {
	inv *Inventory
	ops []Op
}

// CreateBox adds an empty box. Fails at commit if the box exists.
func (t *TxBuilder) CreateBox(box BoxID) {
	t.ops = append(t.ops, Op{Type: OpCreateBox, Box: box})
}

// RemoveBox deletes a box. Fails at commit unless the box exists and is
// empty; empty boxes are otherwise retained by default.
func (t *TxBuilder) RemoveBox(box BoxID) {
	t.ops = append(t.ops, Op{Type: OpRemoveBox, Box: box})
}

// Put introduces a new item into a box. Fails at commit if the item ID
// is already present anywhere or the placement violates the rules.
func (t *TxBuilder) Put(item Item, box BoxID) {
	t.ops = append(t.ops, Op{Type: OpPut, Box: box, Item: item})
}

// Move relocates an item to another box. Fails at commit if the item or
// destination box does not exist or the placement violates the rules.
func (t *TxBuilder) Move(id ItemID, dst BoxID) {
	t.ops = append(t.ops, Op{Type: OpMove, Dst: dst, ItemID: id})
}

// Remove takes an item out of the inventory entirely.
func (t *TxBuilder) Remove(id ItemID) {
	t.ops = append(t.ops, Op{Type: OpRemove, ItemID: id})
}

// Len reports how many operations are buffered.
func (t *TxBuilder) Len() int { return len(t.ops) }

// Commit validates and applies all buffered ops against a private copy
// of the state. On any error the inventory is left completely
// unchanged; on success the new state is swapped in and the transaction
// is appended to the history.
func (t *TxBuilder) Commit() error {
	if len(t.ops) == 0 {
		return ErrEmptyTx
	}
	work := t.inv.st.clone()
	for i, op := range t.ops {
		if err := applyOp(work, t.inv.rules, op); err != nil {
			return fmt.Errorf("op %d (%s): %w", i, op.Type, err)
		}
	}
	t.inv.st = work
	t.inv.history = append(t.inv.history, Tx{Seq: t.inv.nextSeq, Ops: append([]Op(nil), t.ops...)})
	t.inv.nextSeq++
	return nil
}

// applyOp validates and applies a single op to st.
func applyOp(st *state, rules Rules, op Op) error {
	switch op.Type {
	case OpCreateBox:
		if _, ok := st.boxes[op.Box]; ok {
			return fmt.Errorf("%w: %q", ErrBoxExists, op.Box)
		}
		st.boxes[op.Box] = make(map[ItemID]Item)

	case OpRemoveBox:
		contents, ok := st.boxes[op.Box]
		if !ok {
			return fmt.Errorf("%w: %q", ErrBoxNotFound, op.Box)
		}
		if len(contents) > 0 {
			return fmt.Errorf("%w: %q holds %d items", ErrBoxNotEmpty, op.Box, len(contents))
		}
		delete(st.boxes, op.Box)

	case OpPut:
		if _, ok := st.boxes[op.Box]; !ok {
			return fmt.Errorf("%w: %q", ErrBoxNotFound, op.Box)
		}
		if _, ok := st.items[op.Item.ID]; ok {
			return fmt.Errorf("%w: %q", ErrItemExists, op.Item.ID)
		}
		if err := st.checkPlacement(rules, op.Box, op.Item); err != nil {
			return err
		}
		st.boxes[op.Box][op.Item.ID] = op.Item
		st.items[op.Item.ID] = op.Box

	case OpMove:
		from, ok := st.items[op.ItemID]
		if !ok {
			return fmt.Errorf("%w: %q", ErrItemNotFound, op.ItemID)
		}
		if _, ok := st.boxes[op.Dst]; !ok {
			return fmt.Errorf("%w: %q", ErrBoxNotFound, op.Dst)
		}
		item := st.boxes[from][op.ItemID]
		if from == op.Dst {
			return nil // no-op
		}
		if err := st.checkPlacement(rules, op.Dst, item); err != nil {
			return err
		}
		delete(st.boxes[from], op.ItemID)
		st.boxes[op.Dst][op.ItemID] = item
		st.items[op.ItemID] = op.Dst

	case OpRemove:
		from, ok := st.items[op.ItemID]
		if !ok {
			return fmt.Errorf("%w: %q", ErrItemNotFound, op.ItemID)
		}
		delete(st.boxes[from], op.ItemID)
		delete(st.items, op.ItemID)

	default:
		return fmt.Errorf("unknown op type %q", op.Type)
	}
	return nil
}
