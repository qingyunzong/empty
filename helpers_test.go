package dedup

import (
	"errors"
	"fmt"
	"slices"
	"testing"
)

// errCrash is the panic value used to simulate a power loss.
var errCrash = errors.New("simulated power loss")

// testEffect is the deterministic effect function used across tests;
// the effect encodes the message identity so the journal can be
// checked for exactly-once delivery.
func testEffect(m Message) []byte { return []byte(testEffectString(m)) }

func testEffectString(m Message) string { return fmt.Sprintf("%s/%d", m.Producer, m.Seq) }

// refModel is the reference implementation: a full set of all seen
// sequence numbers per producer. It accepts a message iff it was never
// committed before, and records one effect per accepted message.
type refModel struct {
	t       *testing.T
	seenSet map[string]map[uint64]bool
	journal []string
}

func newRefModel(t *testing.T) *refModel {
	return &refModel{t: t, seenSet: make(map[string]map[uint64]bool)}
}

func (r *refModel) seen(producer string, seq uint64) bool {
	return r.seenSet[producer][seq]
}

func (r *refModel) commit(m Message) {
	r.t.Helper()
	if r.seen(m.Producer, m.Seq) {
		r.t.Fatalf("reference: double commit of %v", m)
	}
	if r.seenSet[m.Producer] == nil {
		r.seenSet[m.Producer] = make(map[uint64]bool)
	}
	r.seenSet[m.Producer][m.Seq] = true
	r.journal = append(r.journal, testEffectString(m))
}

// runReference computes the expected journal for a crash-free script
// using a full set of seen sequence numbers per producer (no bitmap,
// no truncation) plus the window's too-old rule: a sequence number at
// or below high-windowSize is rejected as too old.
func runReference(script []Message, windowSize int) []string {
	seen := make(map[string]map[uint64]bool)
	high := make(map[string]uint64)
	has := make(map[string]bool)
	var journal []string
	for _, m := range script {
		if seen[m.Producer] == nil {
			seen[m.Producer] = make(map[uint64]bool)
		}
		accept := false
		switch {
		case !has[m.Producer] || m.Seq > high[m.Producer]:
			accept = true
		case high[m.Producer]-m.Seq > uint64(windowSize):
			accept = false // too old
		default:
			accept = !seen[m.Producer][m.Seq]
		}
		if !has[m.Producer] || m.Seq > high[m.Producer] {
			high[m.Producer] = m.Seq
			has[m.Producer] = true
		}
		if accept {
			seen[m.Producer][m.Seq] = true
			journal = append(journal, testEffectString(m))
		}
	}
	return journal
}

func journalStrings(c *Consumer) []string {
	raw := c.Journal()
	out := make([]string, len(raw))
	for i, e := range raw {
		out[i] = string(e)
	}
	return out
}

func assertJournalEqual(t *testing.T, got, want []string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("journal mismatch:\n got: %q\nwant: %q", got, want)
	}
	uniq := make(map[string]struct{}, len(got))
	for _, e := range got {
		if _, dup := uniq[e]; dup {
			t.Fatalf("duplicate effect in journal: %q", e)
		}
		uniq[e] = struct{}{}
	}
}

// reopenConsumer simulates a reboot: drops unflushed state and recovers
// a fresh Consumer from the same (durable) volume.
func reopenConsumer(t *testing.T, fv *FaultVolume, windowSize int) *Consumer {
	t.Helper()
	if err := fv.Crash(); err != nil {
		t.Fatalf("crash: %v", err)
	}
	c, err := OpenConsumer(fv, windowSize, testEffect)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	return c
}

// tryHandle runs Handle, converting a simulated power loss into
// crashed=true.
func tryHandle(c *Consumer, m Message) (d Decision, crashed bool) {
	defer func() {
		if r := recover(); r != nil {
			if r != errCrash {
				panic(r)
			}
			crashed = true
		}
	}()
	d, _ = c.Handle(m)
	return d, false
}

// tryCompact runs Compact, converting a simulated power loss into
// crashed=true.
func tryCompact(c *Consumer) (crashed bool) {
	defer func() {
		if r := recover(); r != nil {
			if r != errCrash {
				panic(r)
			}
			crashed = true
		}
	}()
	_ = c.Compact()
	return false
}
