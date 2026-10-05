// Package synclog implements an append-only log that assigns consecutive
// sequence numbers and lets callers wait until records are durably synced.
package synclog

import (
	"context"
	"errors"
	"sync"
)

// ErrShortWrite is reported when a Writer syncs fewer bytes than the record
// length without returning an error of its own.
var ErrShortWrite = errors.New("synclog: short write")

// Writer durably persists a single record. It must be safe for concurrent
// use; calls may complete out of order.
type Writer interface {
	WriteSync(record []byte) (int, error)
}

// Log assigns consecutive sequence numbers to appended records and tracks
// the contiguous prefix of records known to be durable.
type Log struct {
	w Writer

	mu      sync.Mutex
	next    uint64          // last assigned sequence number
	prefix  uint64          // contiguous durable prefix
	done    map[uint64]bool // synced records beyond prefix
	failSeq uint64          // first failed sequence number, 0 if none
	err     error           // error from the first failed record
	ch      chan struct{}   // closed and replaced on every state change
}

// New returns a Log that persists records through w.
func New(w Writer) *Log {
	return &Log{
		w:    w,
		done: make(map[uint64]bool),
		ch:   make(chan struct{}),
	}
}

// Append assigns the next consecutive sequence number to record and
// schedules its sync. The sync proceeds independently of any Flush waiter;
// canceling a wait never cancels the write.
func (l *Log) Append(record []byte) uint64 {
	l.mu.Lock()
	l.next++
	seq := l.next
	l.mu.Unlock()

	rec := make([]byte, len(record))
	copy(rec, record)
	go l.writeOne(seq, rec)
	return seq
}

func (l *Log) writeOne(seq uint64, rec []byte) {
	n, err := l.w.WriteSync(rec)
	if err == nil && n != len(rec) {
		err = ErrShortWrite
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if err != nil {
		if l.err == nil {
			l.err = err
			l.failSeq = seq
		}
	} else {
		l.done[seq] = true
		for l.done[l.prefix+1] {
			delete(l.done, l.prefix+1)
			l.prefix++
		}
	}
	l.broadcastLocked()
}

func (l *Log) broadcastLocked() {
	close(l.ch)
	l.ch = make(chan struct{})
}

// Prefix returns the contiguous durable prefix: every record with a
// sequence number <= Prefix has been synced.
func (l *Log) Prefix() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.prefix
}

// Flush blocks until every record with a sequence number <= n is synced.
// It returns the write error if a record <= n failed (including short
// writes). If ctx is canceled first, Flush returns ctx.Err(); the pending
// writes are unaffected.
func (l *Log) Flush(ctx context.Context, n uint64) error {
	for {
		l.mu.Lock()
		if l.prefix >= n {
			l.mu.Unlock()
			return nil
		}
		if l.failSeq != 0 && l.failSeq <= n {
			err := l.err
			l.mu.Unlock()
			return err
		}
		ch := l.ch
		l.mu.Unlock()

		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
