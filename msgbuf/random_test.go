package msgbuf

import (
	"errors"
	"fmt"
	"math/rand"
	"sort"
	"testing"
)

// model is a full causal reference model with no budget limit. It tracks
// every accepted message and computes the delivered set as the causal
// closure of the accepted set, plus the exact number of payload bytes that
// must be held by blocked (accepted but undelivered) messages.
type model struct {
	accepted  map[Key]Message // received and not rejected
	delivered map[string]uint64
	log       []Message // delivery order, mirrored from the buffer
}

func newModel() *model {
	return &model{accepted: make(map[Key]Message), delivered: make(map[string]uint64)}
}

func (m *model) missing(msg Message) map[Key]bool {
	out := make(map[Key]bool)
	for s := m.delivered[msg.From] + 1; s < msg.Seq; s++ {
		out[Key{msg.From, s}] = true
	}
	for from, seq := range msg.Deps {
		for s := m.delivered[from] + 1; s <= seq; s++ {
			out[Key{from, s}] = true
		}
	}
	return out
}

// close delivers every accepted message whose dependencies are satisfied,
// appending to the delivery log, until a fixpoint is reached.
func (m *model) close() {
	for {
		progressed := false
		var keys []Key
		for k := range m.accepted {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			if keys[i].From != keys[j].From {
				return keys[i].From < keys[j].From
			}
			return keys[i].Seq < keys[j].Seq
		})
		for _, k := range keys {
			msg := m.accepted[k]
			if msg.Seq <= m.delivered[msg.From] {
				continue
			}
			if len(m.missing(msg)) == 0 {
				m.delivered[msg.From] = msg.Seq
				m.log = append(m.log, msg)
				progressed = true
			}
		}
		if !progressed {
			return
		}
	}
}

// blockedBytes is the exact number of payload bytes that must currently be
// held: every accepted message that has not been delivered.
func (m *model) blockedBytes() int64 {
	var total int64
	for k, msg := range m.accepted {
		if k.Seq > m.delivered[k.From] {
			total += msg.Size()
		}
	}
	return total
}

func (m *model) blockedCount() int {
	n := 0
	for k := range m.accepted {
		if k.Seq > m.delivered[k.From] {
			n++
		}
	}
	return n
}

// chain recomputes, independently, the full missing-dependency chain of msg.
func (m *model) chain(msg Message) map[Key]bool {
	seen := make(map[Key]bool)
	queue := make([]Key, 0)
	for k := range m.missing(msg) {
		queue = append(queue, k)
	}
	for len(queue) > 0 {
		k := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if seen[k] {
			continue
		}
		seen[k] = true
		if pm, ok := m.accepted[k]; ok && k.Seq > m.delivered[k.From] {
			for d := range m.missing(pm) {
				queue = append(queue, d)
			}
		}
	}
	return seen
}

// genTraffic builds a causally consistent message set: each sender emits
// seq 1..n and every Deps entry references only messages generated earlier.
func genTraffic(rng *rand.Rand, senders []string, perSender, maxPayload int) []Message {
	var all []Message
	generated := make(map[string]uint64)
	for _, s := range senders {
		for i := uint64(1); i <= uint64(perSender); i++ {
			deps := make(map[string]uint64)
			for _, other := range senders {
				if other == s || generated[other] == 0 || rng.Intn(2) == 0 {
					continue
				}
				deps[other] = uint64(rng.Intn(int(generated[other])) + 1)
			}
			all = append(all, Message{
				From:    s,
				Seq:     i,
				Deps:    deps,
				Payload: make([]byte, rng.Intn(maxPayload+1)),
			})
		}
		generated[s] = uint64(perSender)
	}
	return all
}

func checkInvariants(t *testing.T, b *Buffer, m *model, budget int64, step string) {
	t.Helper()
	// Budget conservation: accounted bytes == exact bytes of blocked messages.
	wantBytes := m.blockedBytes()
	if b.Used() != wantBytes {
		t.Fatalf("%s: budget not conserved: used=%d, model blocked bytes=%d", step, b.Used(), wantBytes)
	}
	if budget >= 0 && b.Used() > budget {
		t.Fatalf("%s: budget exceeded: used=%d > budget=%d", step, b.Used(), budget)
	}
	if b.Pending() != m.blockedCount() {
		t.Fatalf("%s: pending=%d, model blocked=%d", step, b.Pending(), m.blockedCount())
	}
	// Receive vector matches the model's delivered set.
	vec := b.Vector()
	for from, seq := range m.delivered {
		if vec[from] != seq {
			t.Fatalf("%s: vector[%s]=%d, model=%d", step, from, vec[from], seq)
		}
	}
	for from, seq := range vec {
		if m.delivered[from] != seq {
			t.Fatalf("%s: vector[%s]=%d, model=%d", step, from, seq, m.delivered[from])
		}
	}
}

func checkChain(t *testing.T, m *model, msg Message, got []Key, step string) {
	t.Helper()
	want := m.chain(msg)
	if len(got) != len(want) {
		t.Fatalf("%s: chain len=%d (%v), model=%d (%v)", step, len(got), got, len(want), want)
	}
	for _, k := range got {
		if !want[k] {
			t.Fatalf("%s: chain contains unexpected %s (full=%v want=%v)", step, k, got, want)
		}
		if k.Seq <= m.delivered[k.From] {
			t.Fatalf("%s: chain contains already-delivered %s", step, k)
		}
	}
}

func checkDeliveryLog(t *testing.T, log []Message, step string) {
	t.Helper()
	vec := make(map[string]uint64)
	for i, msg := range log {
		if msg.Seq != vec[msg.From]+1 {
			t.Fatalf("%s: log[%d]=%s breaks per-sender order (vector=%v)", step, i, msg.ID(), vec)
		}
		for from, seq := range msg.Deps {
			if vec[from] < seq {
				t.Fatalf("%s: log[%d]=%s delivered before dep %s#%d", step, i, msg.ID(), from, seq)
			}
		}
		vec[msg.From] = msg.Seq
	}
}

func runRandomWorkload(t *testing.T, seed int64, budget int64) {
	t.Helper()
	rng := rand.New(rand.NewSource(seed))
	senders := []string{"a", "b", "c", "d"}
	const perSender = 25
	const maxPayload = 64
	all := genTraffic(rng, senders, perSender, maxPayload)

	if budget >= 0 && budget < maxPayload {
		budget = maxPayload // a single message must always fit
	}
	b := New(budget)
	m := newModel()

	// Receive queue: every message once, shuffled. Rejected messages are
	// re-queued at a random position.
	queue := make([]Message, len(all))
	copy(queue, all)
	rng.Shuffle(len(queue), func(i, j int) { queue[i], queue[j] = queue[j], queue[i] })

	var seen []Message // accepted or duplicate candidates for re-receive
	steps := 0
	const maxSteps = 5_000_000
	for len(queue) > 0 {
		steps++
		if steps > maxSteps {
			t.Fatalf("seed=%d: did not terminate after %d steps (pending=%d used=%d)",
				seed, steps, b.Pending(), b.Used())
		}
		step := fmt.Sprintf("seed=%d step=%d", seed, steps)

		// Occasionally re-receive an old message: must be a Duplicate no-op.
		if len(seen) > 0 && rng.Intn(6) == 0 {
			dup := seen[rng.Intn(len(seen))]
			vecBefore, usedBefore, pendingBefore := b.Vector(), b.Used(), b.Pending()
			rep, err := b.Receive(dup)
			if err != nil || rep.Outcome != Duplicate {
				t.Fatalf("%s: re-receive of %s: outcome=%v err=%v, want Duplicate", step, dup.ID(), rep.Outcome, err)
			}
			if b.Used() != usedBefore || b.Pending() != pendingBefore {
				t.Fatalf("%s: duplicate changed memory state", step)
			}
			if len(b.Vector()) != len(vecBefore) {
				t.Fatalf("%s: duplicate changed vector", step)
			}
			continue
		}

		i := rng.Intn(len(queue))
		msg := queue[i]
		queue = append(queue[:i], queue[i+1:]...)

		vecBefore := b.Vector()
		usedBefore := b.Used()
		rep, err := b.Receive(msg)

		var be *BudgetError
		switch {
		case errors.As(err, &be):
			// Rejection: nothing may change, chain must be complete.
			if b.Used() != usedBefore {
				t.Fatalf("%s: rejection changed used %d -> %d", step, usedBefore, b.Used())
			}
			if len(b.Vector()) != len(vecBefore) {
				t.Fatalf("%s: rejection changed vector", step)
			}
			for from, seq := range vecBefore {
				if b.Vector()[from] != seq {
					t.Fatalf("%s: rejection advanced vector[%s]", step, from)
				}
			}
			checkChain(t, m, msg, be.Missing, step+" (reject)")
			checkChain(t, m, msg, rep.Missing, step+" (reject report)")
			// Re-queue for a later retry.
			j := rng.Intn(len(queue) + 1)
			queue = append(queue, Message{})
			copy(queue[j+1:], queue[j:])
			queue[j] = msg
		case err != nil:
			t.Fatalf("%s: unexpected error: %v", step, err)
		default:
			m.accepted[msg.ID()] = msg
			m.close()
			seen = append(seen, msg)
			if rep.Outcome == Blocked {
				checkChain(t, m, msg, rep.Missing, step+" (blocked)")
			}
			// The buffer's deliveries this call must match the model's
			// new deliveries, as a set.
			if len(rep.Now) > 0 {
				got := make(map[Key]bool)
				for _, d := range rep.Now {
					got[d.ID()] = true
				}
				for _, dm := range m.log[len(m.log)-len(rep.Now):] {
					if !got[dm.ID()] {
						t.Fatalf("%s: buffer delivered %s not in model closure", step, dm.ID())
					}
				}
			}
		}
		checkInvariants(t, b, m, budget, step)
	}

	// Final state: full causal closure delivered, budget fully released.
	checkInvariants(t, b, m, budget, "final")
	if b.Used() != 0 || b.Pending() != 0 {
		t.Fatalf("seed=%d: final used=%d pending=%d, want 0/0", seed, b.Used(), b.Pending())
	}
	for _, msg := range all {
		if b.Vector()[msg.From] < msg.Seq {
			t.Fatalf("seed=%d: %s never delivered (vector=%v)", seed, msg.ID(), b.Vector())
		}
	}
	checkDeliveryLog(t, m.log, "final")
	t.Logf("seed=%d budget=%d: %d messages delivered in %d steps", seed, budget, len(all), steps)
}

func TestRandomBudgetConservation(t *testing.T) {
	// Deterministic subtests across seeds and budget shapes.
	for _, budget := range []int64{64, 512, -1} {
		for seed := int64(1); seed <= 4; seed++ {
			name := fmt.Sprintf("budget=%d/seed=%d", budget, seed)
			b := budget
			s := seed
			t.Run(name, func(t *testing.T) { runRandomWorkload(t, s, b) })
		}
	}
}
