package ledger

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
)

// walRecord is one durable mutation. Every ledger change is reduced to one
// of three primitive ops so recovery is a plain replay.
type walRecord struct {
	Op    string `json:"op"` // "entry" | "lock" | "void"
	Entry *Entry `json:"entry,omitempty"`
	Batch uint64 `json:"batch,omitempty"`
	ID    uint64 `json:"id,omitempty"`
}

// Ledger is an append-only store of fee entries with dual-axis indexes.
// Mutations are appended to a write-ahead log, then a fresh immutable
// Snapshot is built and published atomically; readers never block.
type Ledger struct {
	mu   sync.Mutex
	snap atomic.Pointer[Snapshot]
	wal  *os.File // nil for in-memory ledgers
	enc  *json.Encoder
}

// New returns an in-memory ledger.
func New() *Ledger {
	l := &Ledger{}
	l.snap.Store(&Snapshot{
		entries: map[uint64]Entry{},
		locked:  map[uint64]bool{},
		axes:    [2]*axisIndex{buildAxis(nil, BusinessTime), buildAxis(nil, SubmitTime)},
	})
	return l
}

// Open returns a ledger durable at path, replaying any existing log. After
// replay the full ledger is recomputed on both axes and audited; a mismatch
// between the rebuilt indexes and the item-by-item scan fails the open.
func Open(path string) (*Ledger, error) {
	l := New()
	if _, err := os.Stat(path); err == nil {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		dec := json.NewDecoder(bufio.NewReader(f))
		for {
			var rec walRecord
			if err := dec.Decode(&rec); err == io.EOF {
				break
			} else if err != nil {
				f.Close()
				return nil, fmt.Errorf("ledger: replay %s: %w", path, err)
			}
			if err := l.apply(rec); err != nil {
				f.Close()
				return nil, fmt.Errorf("ledger: replay %s: %w", path, err)
			}
		}
		f.Close()
	}
	wal, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	l.wal = wal
	l.enc = json.NewEncoder(wal)
	if err := l.Snapshot().Audit(); err != nil {
		wal.Close()
		return nil, fmt.Errorf("ledger: recovery audit: %w", err)
	}
	return l, nil
}

// Close flushes and closes the write-ahead log.
func (l *Ledger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.wal == nil {
		return nil
	}
	err := l.wal.Close()
	l.wal = nil
	return err
}

// Snapshot returns the most recently published immutable view.
func (l *Ledger) Snapshot() *Snapshot { return l.snap.Load() }

// Append adds a single entry as its own batch.
func (l *Ledger) Append(e Entry) error { return l.AppendBatch([]Entry{e}) }

// AppendBatch adds a batch of entries. The batch starts unlocked.
func (l *Ledger) AppendBatch(entries []Entry) error {
	for _, e := range entries {
		if err := l.mutate(walRecord{Op: "entry", Entry: &e}); err != nil {
			return err
		}
	}
	return nil
}

// LockBatch seals a batch. Entries in a locked batch can no longer be
// voided in place; they must be offset by a reversal in a new batch.
func (l *Ledger) LockBatch(batch uint64) error {
	return l.mutate(walRecord{Op: "lock", Batch: batch})
}

// Void deactivates an entry of an unlocked batch in place. Because the
// entry is removed from the ordering, prefix positions shift and a
// first-over-budget point caused by this entry can disappear.
func (l *Ledger) Void(id uint64) error {
	return l.mutate(walRecord{Op: "void", ID: id})
}

// Reverse offsets an entry by appending a new reversal entry in a fresh
// batch. The original entry and every original prefix stay untouched; only
// suffixes at or after the reversal's position change. The reversal carries
// the negated fee and is stamped with the supplied business/submit times.
// batch is the ID of the new offsetting batch and must not reuse a locked
// batch ID.
func (l *Ledger) Reverse(id, newID, batch uint64, business, submit int64) error {
	snap := l.Snapshot()
	orig, ok := snap.Entry(id)
	if !ok {
		return ErrNotFound
	}
	if orig.Voided {
		return ErrVoided
	}
	for _, e := range snap.entries {
		if e.Reversal && e.Reverses == id && !e.Voided {
			return ErrReversalOf
		}
	}
	rev := Entry{
		ID:       newID,
		Batch:    batch,
		Business: business,
		Submit:   submit,
		Fee:      -orig.Fee,
		Reversal: true,
		Reverses: id,
	}
	return l.mutate(walRecord{Op: "entry", Entry: &rev})
}

// mutate logs the record, then republishes.
func (l *Ledger) mutate(rec walRecord) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.applyLocked(rec); err != nil {
		return err
	}
	if l.wal != nil {
		if err := l.enc.Encode(rec); err != nil {
			return err
		}
		if err := l.wal.Sync(); err != nil {
			return err
		}
	}
	return nil
}

// apply replays a record during recovery (no WAL write).
func (l *Ledger) apply(rec walRecord) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.applyLocked(rec)
}

func (l *Ledger) applyLocked(rec walRecord) error {
	cur := l.snap.Load()
	entries := make(map[uint64]Entry, len(cur.entries)+1)
	for k, v := range cur.entries {
		entries[k] = v
	}
	locked := make(map[uint64]bool, len(cur.locked)+1)
	for k, v := range cur.locked {
		locked[k] = v
	}
	switch rec.Op {
	case "entry":
		e := *rec.Entry
		if _, dup := entries[e.ID]; dup {
			return ErrDuplicateID
		}
		entries[e.ID] = e
	case "lock":
		locked[rec.Batch] = true
	case "void":
		e, ok := entries[rec.ID]
		if !ok {
			return ErrNotFound
		}
		if locked[e.Batch] {
			return ErrBatchLocked
		}
		e.Voided = true
		entries[rec.ID] = e
	default:
		return fmt.Errorf("ledger: unknown wal op %q", rec.Op)
	}
	active := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if !e.Voided {
			active = append(active, e)
		}
	}
	next := &Snapshot{
		entries: entries,
		locked:  locked,
		seq:     cur.seq + 1,
		axes: [2]*axisIndex{
			buildAxis(active, BusinessTime),
			buildAxis(active, SubmitTime),
		},
	}
	l.snap.Store(next)
	return nil
}
