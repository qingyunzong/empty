package faultinj

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// Hit is one accounted injection: which rule fired, in which scope, and
// for which operation. Seq orders hits globally per injector.
type Hit struct {
	Seq   uint64
	Rule  string
	Scope string
	Op    Operation
	When  time.Time
}

// Ledger records the hits that actually fired. It is safe for concurrent
// use; every goroutine sharing an Injector accounts into the same Ledger.
type Ledger struct {
	mu   sync.Mutex
	hits []Hit
}

func (l *Ledger) record(h Hit) {
	l.mu.Lock()
	defer l.mu.Unlock()
	h.Seq = uint64(len(l.hits)) + 1
	h.When = time.Now()
	l.hits = append(l.hits, h)
}

// Hits returns a copy of the recorded hits in firing order.
func (l *Ledger) Hits() []Hit {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Hit, len(l.hits))
	copy(out, l.hits)
	return out
}

// Len reports how many hits have been recorded.
func (l *Ledger) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.hits)
}

// Report renders the hit ledger as one line per hit, e.g.
//
//	#1 scope=worker-0 rule=db-down op=db.read
func (l *Ledger) Report() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var b strings.Builder
	for _, h := range l.hits {
		fmt.Fprintf(&b, "#%d scope=%s rule=%s op=%s\n", h.Seq, h.Scope, h.Rule, h.Op.Name)
	}
	return b.String()
}

func (l *Ledger) String() string { return l.Report() }
