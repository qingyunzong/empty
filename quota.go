// Package quota implements an in-memory quota ledger with atomic
// multi-account transfers, idempotency keys, and an auditable history.
package quota

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

var (
	ErrInsufficientFunds = errors.New("quota: insufficient funds")
	ErrConflict          = errors.New("quota: idempotency key reused with different parameters")
	ErrAccountExists     = errors.New("quota: account already exists")
	ErrUnknownAccount    = errors.New("quota: unknown account")
	ErrInvalidAmount     = errors.New("quota: amount must be positive")
	ErrSelfTransfer      = errors.New("quota: from and to accounts must differ")
	ErrEmptyBatch        = errors.New("quota: batch must contain at least one transfer")
)

// Transfer moves Amount of quota from account From to account To.
type Transfer struct {
	From   string
	To     string
	Amount int64
}

// Receipt is the durable result of one applied transfer.
type Receipt struct {
	Seq     uint64
	From    string
	To      string
	Amount  int64
	FromBal int64
	ToBal   int64
}

// Entry is one committed record in the ledger history.
type Entry struct {
	Seq     uint64
	Key     string
	From    string
	To      string
	Amount  int64
	FromBal int64
	ToBal   int64
}

type idemRecord struct {
	fingerprint string
	receipts    []Receipt
}

// Ledger holds account balances, idempotency records, and history.
// All methods are safe for concurrent use.
type Ledger struct {
	mu       sync.Mutex
	balances map[string]int64
	idem     map[string]idemRecord
	history  []Entry
	seq      uint64
}

func NewLedger() *Ledger {
	return &Ledger{
		balances: make(map[string]int64),
		idem:     make(map[string]idemRecord),
	}
}

// Open creates an account with the given initial balance.
func (l *Ledger) Open(account string, balance int64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.balances[account]; ok {
		return ErrAccountExists
	}
	l.balances[account] = balance
	return nil
}

// Balance reports the current balance of an account.
func (l *Ledger) Balance(account string) (int64, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.balances[account]
	return b, ok
}

// Total returns the sum of all account balances.
func (l *Ledger) Total() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	var total int64
	for _, b := range l.balances {
		total += b
	}
	return total
}

// History returns a copy of the committed transfer log, in order.
func (l *Ledger) History() []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Entry, len(l.history))
	copy(out, l.history)
	return out
}

// fingerprint binds an idempotency key to the full parameter set.
func fingerprint(ops []Transfer) string {
	var sb strings.Builder
	for _, op := range ops {
		fmt.Fprintf(&sb, "%s|%s|%d;", op.From, op.To, op.Amount)
	}
	return sb.String()
}

// TransferBatch atomically applies ops under idempotency key key.
//
// Every debit is validated against the current balances before any
// change is made: if any account cannot cover its outgoing transfers,
// the whole batch fails and no balance, history, or idempotency state
// changes. A key replayed with identical parameters returns the stored
// receipts; a key replayed with different parameters fails with
// ErrConflict.
func (l *Ledger) TransferBatch(key string, ops []Transfer) ([]Receipt, error) {
	if len(ops) == 0 {
		return nil, ErrEmptyBatch
	}
	fp := fingerprint(ops)

	l.mu.Lock()
	defer l.mu.Unlock()

	if rec, ok := l.idem[key]; ok {
		if rec.fingerprint != fp {
			return nil, ErrConflict
		}
		out := make([]Receipt, len(rec.receipts))
		copy(out, rec.receipts)
		return out, nil
	}

	debits := make(map[string]int64)
	for _, op := range ops {
		if op.Amount <= 0 {
			return nil, ErrInvalidAmount
		}
		if op.From == op.To {
			return nil, ErrSelfTransfer
		}
		if _, ok := l.balances[op.From]; !ok {
			return nil, fmt.Errorf("%w: %s", ErrUnknownAccount, op.From)
		}
		if _, ok := l.balances[op.To]; !ok {
			return nil, fmt.Errorf("%w: %s", ErrUnknownAccount, op.To)
		}
		debits[op.From] += op.Amount
	}
	for account, out := range debits {
		if l.balances[account] < out {
			return nil, fmt.Errorf("%w: %s", ErrInsufficientFunds, account)
		}
	}

	receipts := make([]Receipt, 0, len(ops))
	for _, op := range ops {
		l.balances[op.From] -= op.Amount
		l.balances[op.To] += op.Amount
		l.seq++
		entry := Entry{
			Seq:     l.seq,
			Key:     key,
			From:    op.From,
			To:      op.To,
			Amount:  op.Amount,
			FromBal: l.balances[op.From],
			ToBal:   l.balances[op.To],
		}
		l.history = append(l.history, entry)
		receipts = append(receipts, Receipt{
			Seq:     entry.Seq,
			From:    op.From,
			To:      op.To,
			Amount:  op.Amount,
			FromBal: entry.FromBal,
			ToBal:   entry.ToBal,
		})
	}
	l.idem[key] = idemRecord{fingerprint: fp, receipts: receipts}

	out := make([]Receipt, len(receipts))
	copy(out, receipts)
	return out, nil
}

// Transfer is the single-transfer convenience form of TransferBatch.
func (l *Ledger) Transfer(key, from, to string, amount int64) (Receipt, error) {
	receipts, err := l.TransferBatch(key, []Transfer{{From: from, To: to, Amount: amount}})
	if err != nil {
		return Receipt{}, err
	}
	return receipts[0], nil
}
