// Package quota implements a concurrency-safe quota ledger that moves
// credit between accounts atomically, with idempotency-key support and
// an append-only history for serial verification.
package quota

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
)

var (
	ErrInsufficientFunds   = errors.New("quota: insufficient funds")
	ErrIdempotencyConflict = errors.New("quota: idempotency key reused with different parameters")
	ErrInvalidAmount       = errors.New("quota: amount must be positive")
	ErrUnknownAccount      = errors.New("quota: unknown account")
	ErrEmptyBatch          = errors.New("quota: empty batch")
	ErrEmptyKey            = errors.New("quota: empty idempotency key")
	ErrSelfTransfer        = errors.New("quota: self transfer")
	ErrNegativeBalance     = errors.New("quota: negative initial balance")
)

// Op is a single transfer of Amount quota from account From to account To.
type Op struct {
	From   string
	To     string
	Amount int64
}

// TransferResult describes the outcome of one applied Op.
type TransferResult struct {
	Seq         int64 // sequence number of the batch that applied this op
	From        string
	To          string
	Amount      int64
	FromBalance int64 // balance of From immediately after the op
	ToBalance   int64 // balance of To immediately after the op
	Replayed    bool  // true when returned from the idempotency cache
}

// HistoryEntry is one applied batch, in application order.
type HistoryEntry struct {
	Seq     int64
	Key     string
	Ops     []Op
	Results []TransferResult
}

type idemRecord struct {
	fingerprint string
	results     []TransferResult
}

// Ledger is a concurrency-safe quota ledger. The zero value is not usable;
// construct one with NewLedger.
type Ledger struct {
	mu       sync.Mutex
	balances map[string]int64
	idem     map[string]idemRecord
	history  []HistoryEntry
	seq      int64
}

// NewLedger creates a Ledger with the given initial balances.
func NewLedger(initial map[string]int64) (*Ledger, error) {
	balances := make(map[string]int64, len(initial))
	for acct, bal := range initial {
		if bal < 0 {
			return nil, fmt.Errorf("%w: %s", ErrNegativeBalance, acct)
		}
		balances[acct] = bal
	}
	return &Ledger{
		balances: balances,
		idem:     make(map[string]idemRecord),
	}, nil
}

// Transfer atomically moves amount quota from one account to another.
func (l *Ledger) Transfer(key, from, to string, amount int64) (TransferResult, error) {
	results, err := l.BatchTransfer(key, []Op{{From: from, To: to, Amount: amount}})
	if err != nil {
		return TransferResult{}, err
	}
	return results[0], nil
}

// BatchTransfer atomically applies a batch of ops (e.g. spanning three
// accounts). Every op is validated against the projected balances first;
// if any op fails validation, no balance changes, no history entry, and no
// idempotency record are produced.
//
// The idempotency key is bound to the full parameter set: repeating a key
// with identical parameters replays the stored results, while repeating it
// with different parameters returns ErrIdempotencyConflict.
func (l *Ledger) BatchTransfer(key string, ops []Op) ([]TransferResult, error) {
	if key == "" {
		return nil, ErrEmptyKey
	}
	if len(ops) == 0 {
		return nil, ErrEmptyBatch
	}
	fingerprint, err := fingerprintOps(ops)
	if err != nil {
		return nil, err
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if rec, ok := l.idem[key]; ok {
		if rec.fingerprint != fingerprint {
			return nil, ErrIdempotencyConflict
		}
		replayed := make([]TransferResult, len(rec.results))
		copy(replayed, rec.results)
		for i := range replayed {
			replayed[i].Replayed = true
		}
		return replayed, nil
	}

	// Validate every op against projected balances before mutating anything.
	projected := make(map[string]int64, len(ops)*2)
	project := func(acct string) (int64, bool) {
		if bal, ok := projected[acct]; ok {
			return bal, true
		}
		bal, ok := l.balances[acct]
		if ok {
			projected[acct] = bal
		}
		return bal, ok
	}
	for _, op := range ops {
		if op.Amount <= 0 {
			return nil, fmt.Errorf("%w: %d", ErrInvalidAmount, op.Amount)
		}
		if op.From == op.To {
			return nil, fmt.Errorf("%w: %s", ErrSelfTransfer, op.From)
		}
		fromBal, ok := project(op.From)
		if !ok {
			return nil, fmt.Errorf("%w: %s", ErrUnknownAccount, op.From)
		}
		if _, ok := project(op.To); !ok {
			return nil, fmt.Errorf("%w: %s", ErrUnknownAccount, op.To)
		}
		if fromBal < op.Amount {
			return nil, fmt.Errorf("%w: %s has %d, needs %d", ErrInsufficientFunds, op.From, fromBal, op.Amount)
		}
		projected[op.From] = fromBal - op.Amount
		projected[op.To] += op.Amount
	}

	// All ops validated: apply the batch as one atomic step.
	l.seq++
	entry := HistoryEntry{Seq: l.seq, Key: key, Ops: append([]Op(nil), ops...)}
	results := make([]TransferResult, len(ops))
	for i, op := range ops {
		l.balances[op.From] -= op.Amount
		l.balances[op.To] += op.Amount
		results[i] = TransferResult{
			Seq:         l.seq,
			From:        op.From,
			To:          op.To,
			Amount:      op.Amount,
			FromBalance: l.balances[op.From],
			ToBalance:   l.balances[op.To],
		}
	}
	entry.Results = append([]TransferResult(nil), results...)
	l.history = append(l.history, entry)
	l.idem[key] = idemRecord{fingerprint: fingerprint, results: append([]TransferResult(nil), results...)}
	return results, nil
}

// Balance returns the current balance of an account.
func (l *Ledger) Balance(acct string) (int64, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	bal, ok := l.balances[acct]
	return bal, ok
}

// Total returns the sum of all account balances.
func (l *Ledger) Total() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	var sum int64
	for _, bal := range l.balances {
		sum += bal
	}
	return sum
}

// History returns a copy of the append-only batch history, in order.
func (l *Ledger) History() []HistoryEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]HistoryEntry, len(l.history))
	for i, entry := range l.history {
		out[i] = HistoryEntry{
			Seq:     entry.Seq,
			Key:     entry.Key,
			Ops:     append([]Op(nil), entry.Ops...),
			Results: append([]TransferResult(nil), entry.Results...),
		}
	}
	return out
}

// fingerprintOps binds an idempotency key to the complete parameter set.
func fingerprintOps(ops []Op) (string, error) {
	data, err := json.Marshal(ops)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
