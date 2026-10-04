// Package loglib implements an append-only record log that assigns
// consecutive sequence numbers and lets callers wait for durability
// barriers with Flush.
package loglib

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
)

// ErrClosed is returned by Append after Close has been called.
var ErrClosed = errors.New("loglib: log is closed")

// Writer is the durable sink used by Log. Write stores one record and
// Sync makes previously written records durable. A Write that reports
// fewer bytes than len(p) without an error is treated as io.ErrShortWrite.
type Writer interface {
	Write(p []byte) (int, error)
	Sync() error
}

// Log assigns consecutive sequence numbers to appended records and tracks
// the confirmed prefix: the longest prefix of records known to be durable.
//
// Persistence runs in the background and may complete out of order; the
// confirmed prefix only advances across fully synced contiguous records.
type Log struct {
	w Writer

	mu      sync.Mutex
	nextSeq uint64          // next sequence number to assign
	acked   uint64          // confirmed prefix: every record <= acked is synced
	done    map[uint64]bool // records whose persistence finished successfully
	failSeq uint64          // lowest failed sequence number; 0 means none
	failErr error          // failure attached to failSeq
	changed chan struct{}   // closed and replaced on every state change
	closed  bool
}

// New returns a Log that persists records to w.
func New(w Writer) *Log {
	return &Log{
		w:       w,
		done:    make(map[uint64]bool),
		changed: make(chan struct{}),
	}
}

// Append assigns the next consecutive sequence number to data and starts
// persisting it in the background. The write is not canceled by the
// cancellation of any Flush waiter.
func (l *Log) Append(data []byte) (uint64, error) {
	buf := make([]byte, len(data))
	copy(buf, data)

	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return 0, ErrClosed
	}
	l.nextSeq++
	seq := l.nextSeq
	l.mu.Unlock()

	go l.persist(seq, buf)
	return seq, nil
}

func (l *Log) persist(seq uint64, data []byte) {
	n, err := l.w.Write(data)
	if err == nil && n < len(data) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = l.w.Sync()
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if err != nil {
		if l.failSeq == 0 || seq < l.failSeq {
			l.failSeq = seq
			l.failErr = fmt.Errorf("loglib: record %d: %w", seq, err)
		}
	} else {
		l.done[seq] = true
		for l.done[l.acked+1] {
			delete(l.done, l.acked+1)
			l.acked++
		}
	}
	l.broadcastLocked()
}

func (l *Log) broadcastLocked() {
	close(l.changed)
	l.changed = make(chan struct{})
}

// Flush blocks until every record with a sequence number not greater than
// n has been synced, and returns nil at that point. If any record in
// [1, n] has failed (including via short write), Flush returns the
// recorded failure immediately.
//
// If ctx is canceled while waiting, Flush returns ctx.Err(); the
// underlying writes are unaffected and a later Flush can still observe
// them succeeding.
func (l *Log) Flush(ctx context.Context, n uint64) error {
	l.mu.Lock()
	for {
		if l.failSeq != 0 && l.failSeq <= n {
			err := l.failErr
			l.mu.Unlock()
			return err
		}
		if l.acked >= n {
			l.mu.Unlock()
			return nil
		}
		ch := l.changed
		l.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ch:
		}
		l.mu.Lock()
	}
}

// Acked returns the confirmed prefix: the largest sequence number such
// that every record less than or equal to it has been synced.
func (l *Log) Acked() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.acked
}

// Close marks the log closed; subsequent Append calls fail with
// ErrClosed. In-flight writes and Flush waiters are unaffected.
func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	return nil
}
