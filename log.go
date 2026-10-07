package logcompact

import (
	"errors"
	"sync"
)

var (
	ErrUnknownTxn   = errors.New("logcompact: unknown transaction")
	ErrTxnNotActive = errors.New("logcompact: transaction is not active")
)

type txnStatus uint8

const (
	txnActive txnStatus = iota + 1
	txnCommitted
	txnAborted
)

// Log is an append-only transaction log supporting compaction to a
// chosen commit version. It is safe for concurrent use.
type Log struct {
	mu       sync.Mutex
	records  []Record
	nextLSN  uint64
	nextTxn  uint64
	last     map[uint64]uint64 // txn -> LSN of its latest record
	status   map[uint64]txnStatus
	commitAt map[uint64]uint64 // txn -> commit record LSN
	abortAt  map[uint64]uint64 // txn -> abort record LSN
	commits  []uint64          // all commit versions (LSNs), ascending
	horizon  uint64            // last compaction horizon
}

// New returns an empty log.
func New() *Log {
	return &Log{
		nextLSN:  1,
		nextTxn:  1,
		last:     map[uint64]uint64{},
		status:   map[uint64]txnStatus{},
		commitAt: map[uint64]uint64{},
		abortAt:  map[uint64]uint64{},
	}
}

func (l *Log) appendLocked(txn uint64, typ RecordType, key, value string) Record {
	rec := Record{
		LSN:     l.nextLSN,
		TxnID:   txn,
		Type:    typ,
		Key:     key,
		Value:   value,
		PrevLSN: l.last[txn],
	}
	l.nextLSN++
	l.records = append(l.records, rec)
	l.last[txn] = rec.LSN
	return rec
}

func (l *Log) checkActiveLocked(txn uint64) error {
	st, ok := l.status[txn]
	if !ok {
		return ErrUnknownTxn
	}
	if st != txnActive {
		return ErrTxnNotActive
	}
	return nil
}

// Begin starts a new transaction and returns its ID and Begin record.
func (l *Log) Begin() (uint64, Record) {
	l.mu.Lock()
	defer l.mu.Unlock()
	id := l.nextTxn
	l.nextTxn++
	l.status[id] = txnActive
	return id, l.appendLocked(id, BeginRecord, "", "")
}

// Update appends an update record for an active transaction.
func (l *Log) Update(txn uint64, key, value string) (Record, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.checkActiveLocked(txn); err != nil {
		return Record{}, err
	}
	return l.appendLocked(txn, UpdateRecord, key, value), nil
}

// Commit commits an active transaction. The returned record's LSN is the
// commit version, usable as a compaction horizon.
func (l *Log) Commit(txn uint64) (Record, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.checkActiveLocked(txn); err != nil {
		return Record{}, err
	}
	rec := l.appendLocked(txn, CommitRecord, "", "")
	l.status[txn] = txnCommitted
	l.commitAt[txn] = rec.LSN
	l.commits = append(l.commits, rec.LSN)
	return rec, nil
}

// Abort aborts an active transaction.
func (l *Log) Abort(txn uint64) (Record, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.checkActiveLocked(txn); err != nil {
		return Record{}, err
	}
	rec := l.appendLocked(txn, AbortRecord, "", "")
	l.status[txn] = txnAborted
	l.abortAt[txn] = rec.LSN
	return rec, nil
}

// Records returns a copy of the currently retained records, in LSN order.
func (l *Log) Records() []Record {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Record, len(l.records))
	copy(out, l.records)
	return out
}

// LastLSN returns the largest LSN ever assigned (0 for an empty log).
func (l *Log) LastLSN() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.nextLSN - 1
}

// Commits returns all commit versions ever produced, ascending.
func (l *Log) Commits() []uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]uint64, len(l.commits))
	copy(out, l.commits)
	return out
}

// MaxCommit returns the latest commit version, or 0 if none exists.
func (l *Log) MaxCommit() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.commits) == 0 {
		return 0
	}
	return l.commits[len(l.commits)-1]
}

// Horizon returns the horizon of the most recent compaction (0 if none).
func (l *Log) Horizon() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.horizon
}
