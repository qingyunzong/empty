package delivery

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sort"
)

// Commit durably stores the delivery payload and then produces the accepted
// outcome.
//
// The CommitFn runs at most once per tag: if the record is already Committed
// (for example after a redelivery), the callback is skipped. A nil failure
// means the data is safely on disk, which is the precondition for emitting
// accepted; the returned Record therefore has Committed == true and
// OutcomeAccepted but stays unsettled until the peer acknowledges it, so a
// crash before settlement still shows up in Reconcile.
//
// Deliveries enlisted in a transaction must be committed via DischargeTxn.
func (t *Tracker) Commit(ctx context.Context, tag Tag, commit CommitFn) (Record, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, err := t.store.Get(ctx, tag)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Record{}, ErrUnknownDelivery
		}
		return Record{}, err
	}
	if rec.TxnID != "" {
		return Record{}, ErrInvalidState
	}
	if !rec.Committed {
		if err := commit(ctx, rec); err != nil {
			return Record{}, err
		}
		rec.Committed = true
	}
	if rec.Outcome == OutcomeNone {
		rec.Outcome = OutcomeAccepted
	}
	rec.UpdatedAt = t.now()
	if err := t.store.Update(ctx, rec); err != nil {
		return Record{}, err
	}
	return rec, nil
}

// Disposition applies an inbound disposition to a delivery.
//
// epoch must equal the tracker's active generation: a disposition whose epoch
// is retired is rejected with ErrStaleGeneration and changes nothing, so late
// dispositions from a dead link cannot affect the new generation. Settled
// terminal dispositions are rejected once a delivery is already settled.
// Unsettled dispositions only refresh the outcome and remain in the unsettled
// map until a settled one arrives.
func (t *Tracker) Disposition(ctx context.Context, epoch Epoch, tag Tag, outcome Outcome, settled bool) (Record, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if epoch != t.current {
		return Record{}, ErrStaleGeneration
	}
	rec, err := t.store.Get(ctx, tag)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Record{}, ErrUnknownDelivery
		}
		return Record{}, err
	}
	if rec.Settled {
		return Record{}, ErrAlreadySettled
	}
	rec.Outcome = outcome
	rec.Settled = settled
	rec.UpdatedAt = t.now()
	if err := t.store.Update(ctx, rec); err != nil {
		return Record{}, err
	}
	return rec, nil
}

// Reconcile returns the durable unsettled records, ordered by epoch then tag.
// After reconnect the connector iterates them to rebuild the unsettled map and
// re-issue dispositions or resume the link with each delivery's tag.
func (t *Tracker) Reconcile(ctx context.Context) ([]Record, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.store.ListUnsettled(ctx)
}

// Enlist marks a delivery as part of a transaction. The transaction id may be
// supplied by the caller; a fresh random id is generated when txnID is empty.
// No outcome is produced while the transaction is open.
func (t *Tracker) Enlist(ctx context.Context, tag Tag, txnID string) (string, Record, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, err := t.store.Get(ctx, tag)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return "", Record{}, ErrUnknownDelivery
		}
		return "", Record{}, err
	}
	if rec.Settled {
		return "", Record{}, ErrAlreadySettled
	}
	if txnID == "" {
		txnID, err = newTxnID()
		if err != nil {
			return "", Record{}, err
		}
	}
	rec.TxnID = txnID
	rec.UpdatedAt = t.now()
	if err := t.store.Update(ctx, rec); err != nil {
		return "", Record{}, err
	}
	tags := t.txns[txnID]
	if tags == nil {
		tags = make(map[Tag]struct{})
		t.txns[txnID] = tags
	}
	tags[tag] = struct{}{}
	return txnID, rec, nil
}

// DischargeTxn commits or rolls back an open transaction.
//
// On commit, commit runs once per enlisted delivery that is not already
// committed; every delivery then carries OutcomeAccepted and remains unsettled
// pending peer disposition. On rollback the transaction reference and any
// provisional outcome are cleared and the deliveries return to the plain
// unsettled map so they can be redelivered.
func (t *Tracker) DischargeTxn(ctx context.Context, txnID string, commit bool, fn CommitFn) ([]Record, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	tags, ok := t.txns[txnID]
	if !ok {
		return nil, ErrUnknownTransaction
	}
	ordered := make([]Tag, 0, len(tags))
	for tag := range tags {
		ordered = append(ordered, tag)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })

	out := make([]Record, 0, len(ordered))
	for _, tag := range ordered {
		rec, err := t.store.Get(ctx, tag)
		if err != nil {
			return nil, err
		}
		switch {
		case commit:
			if !rec.Committed {
				if err := fn(ctx, rec); err != nil {
					return nil, err
				}
				rec.Committed = true
			}
			rec.Outcome = OutcomeAccepted
		default:
			rec.TxnID = ""
			rec.Outcome = OutcomeNone
		}
		rec.UpdatedAt = t.now()
		if err := t.store.Update(ctx, rec); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if !commit {
		delete(t.txns, txnID)
	}
	return out, nil
}

// ReleaseTxn drops the tracker's bookkeeping for a transaction. It is used
// after every enlisted delivery has been settled following a committed
// discharge, or when abandoning a transaction whose records were reclaimed by
// Reconcile after a restart. Records themselves are untouched.
func (t *Tracker) ReleaseTxn(txnID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.txns, txnID)
}

func newTxnID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
