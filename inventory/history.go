package inventory

import (
	"encoding/json"
	"fmt"
)

// History returns a copy of the committed transactions in order. The
// history fully determines the current state: replaying it against the
// same rules reconstructs an identical inventory.
func (inv *Inventory) History() []Tx {
	out := make([]Tx, len(inv.history))
	for i, tx := range inv.history {
		out[i] = Tx{Seq: tx.Seq, Ops: append([]Op(nil), tx.Ops...)}
	}
	return out
}

// MarshalHistory serializes the committed history as JSON.
func (inv *Inventory) MarshalHistory() ([]byte, error) {
	return json.Marshal(inv.History())
}

// Replay rebuilds an inventory by committing every transaction in
// history against a fresh inventory governed by rules. It fails if any
// recorded transaction is invalid under the given rules.
func Replay(rules Rules, history []Tx) (*Inventory, error) {
	inv := New(rules)
	for i, tx := range history {
		b := inv.Begin()
		b.ops = append(b.ops, tx.Ops...)
		if err := b.Commit(); err != nil {
			return nil, &ReplayError{Index: i, Seq: tx.Seq, Err: err}
		}
	}
	return inv, nil
}

// ReplayJSON is Replay for a history produced by MarshalHistory.
func ReplayJSON(rules Rules, data []byte) (*Inventory, error) {
	var history []Tx
	if err := json.Unmarshal(data, &history); err != nil {
		return nil, err
	}
	return Replay(rules, history)
}

// ReplayError identifies the history entry that failed to replay.
type ReplayError struct {
	Index int
	Seq   int
	Err   error
}

func (e *ReplayError) Error() string {
	return fmt.Sprintf("replay tx %d (seq %d): %v", e.Index, e.Seq, e.Err)
}

func (e *ReplayError) Unwrap() error { return e.Err }
