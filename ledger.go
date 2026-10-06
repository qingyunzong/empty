package sublib

import (
	"fmt"
	"strings"
	"sync"
)

// LedgerEntry is one acknowledged delivery.
type LedgerEntry struct {
	Seq      uint64
	ResultID string
}

// Ledger is the acknowledgment book: an append-only, gap-free record of
// every confirmed sequence. Because the client acknowledges in order and
// resumes from LastAck+1, the ledger never skips a sequence.
type Ledger struct {
	mu      sync.Mutex
	entries []LedgerEntry
	lastSeq uint64
}

// LastAck returns the highest contiguous acknowledged sequence (0 = none).
func (l *Ledger) LastAck() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastSeq
}

// Acked reports whether seq is already covered by the ledger.
func (l *Ledger) Acked(seq uint64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return seq <= l.lastSeq
}

// Record appends an acknowledgment. seq must be exactly LastAck()+1 so
// the ledger stays gap-free.
func (l *Ledger) Record(seq uint64, resultID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if seq != l.lastSeq+1 {
		return fmt.Errorf("sublib: ledger gap: got seq %d, want %d", seq, l.lastSeq+1)
	}
	l.lastSeq = seq
	l.entries = append(l.entries, LedgerEntry{Seq: seq, ResultID: resultID})
	return nil
}

// Entries returns a copy of the ledger in acknowledgment order.
func (l *Ledger) Entries() []LedgerEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]LedgerEntry, len(l.entries))
	copy(out, l.entries)
	return out
}

// String renders the ledger, one "seq/result" entry per line.
func (l *Ledger) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var b strings.Builder
	fmt.Fprintf(&b, "ack ledger (%d entries, last=%d)\n", len(l.entries), l.lastSeq)
	for _, e := range l.entries {
		fmt.Fprintf(&b, "  seq=%d result=%s\n", e.Seq, e.ResultID)
	}
	return b.String()
}
