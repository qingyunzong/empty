package resub

import (
	"fmt"
	"strings"
	"sync"
)

// Ack is one confirmed entry in the ledger.
type Ack struct {
	Seq uint64
	ID  string
	Gen uint64
}

// Ledger is the confirmation ledger: an append-only, contiguous record of
// confirmed sequence numbers. The last entry is the resume point used when
// reconnecting.
type Ledger struct {
	mu   sync.Mutex
	acks []Ack
}

func (l *Ledger) append(a Ack) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.acks = append(l.acks, a)
}

// Last returns the last confirmed sequence number (0 if none).
func (l *Ledger) Last() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.acks) == 0 {
		return 0
	}
	return l.acks[len(l.acks)-1].Seq
}

// Entries returns a snapshot of all confirmations in order.
func (l *Ledger) Entries() []Ack {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Ack, len(l.acks))
	copy(out, l.acks)
	return out
}

// Verify checks that the confirmations form a contiguous chain starting at
// start, with no gaps and no duplicates.
func (l *Ledger) Verify(start uint64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	want := start
	for i, a := range l.acks {
		if a.Seq != want {
			return fmt.Errorf("resub: ledger broken at entry %d: want seq %d, got %d", i, want, a.Seq)
		}
		want++
	}
	return nil
}

func (l *Ledger) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var b strings.Builder
	for i, a := range l.acks {
		if i > 0 {
			b.WriteString(" ")
		}
		fmt.Fprintf(&b, "#%d:%s(g%d)", a.Seq, a.ID, a.Gen)
	}
	return b.String()
}
