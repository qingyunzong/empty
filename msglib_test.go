package msglib

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

func msg(id, node string, clock map[string]uint64, payload string) Message {
	return Message{ID: id, Node: node, Clock: clock, Payload: []byte(payload)}
}

// causalEdges derives happens-before edges from a set of messages: each
// message depends on its origin node's previous event and on the latest
// event of every other node recorded in its vector clock.
func causalEdges(msgs []Message) [][2]string {
	byNodeSeq := make(map[string]map[uint64]string)
	for _, m := range msgs {
		if byNodeSeq[m.Node] == nil {
			byNodeSeq[m.Node] = make(map[uint64]string)
		}
		byNodeSeq[m.Node][m.Clock[m.Node]] = m.ID
	}
	var edges [][2]string
	for _, m := range msgs {
		if prev, ok := byNodeSeq[m.Node][m.Clock[m.Node]-1]; ok && m.Clock[m.Node] > 1 {
			edges = append(edges, [2]string{prev, m.ID})
		}
		for node, seq := range m.Clock {
			if node == m.Node || seq == 0 {
				continue
			}
			if dep, ok := byNodeSeq[node][seq]; ok {
				edges = append(edges, [2]string{dep, m.ID})
			}
		}
	}
	return edges
}

// assertLinearExtension fails the test unless order contains exactly the
// given IDs and respects every causal edge.
func assertLinearExtension(t *testing.T, order []Message, msgs []Message) {
	t.Helper()
	pos := make(map[string]int, len(order))
	for i, m := range order {
		if _, dup := pos[m.ID]; dup {
			t.Fatalf("message %q delivered twice", m.ID)
		}
		pos[m.ID] = i
	}
	if len(pos) != len(msgs) {
		t.Fatalf("delivered %d messages, want %d", len(pos), len(msgs))
	}
	for _, m := range msgs {
		if _, ok := pos[m.ID]; !ok {
			t.Fatalf("message %q never delivered", m.ID)
		}
	}
	for _, e := range causalEdges(msgs) {
		if pos[e[0]] >= pos[e[1]] {
			t.Fatalf("causality violated: %q (pos %d) must precede %q (pos %d)",
				e[0], pos[e[0]], e[1], pos[e[1]])
		}
	}
}

func permutations(msgs []Message, emit func([]Message)) {
	var rec func(int)
	rec = func(i int) {
		if i == len(msgs) {
			emit(msgs)
			return
		}
		for j := i; j < len(msgs); j++ {
			msgs[i], msgs[j] = msgs[j], msgs[i]
			rec(i + 1)
			msgs[i], msgs[j] = msgs[j], msgs[i]
		}
	}
	rec(0)
}

// twoNodeEvents builds a small causal DAG on nodes A and B:
//
//	A1 -> A2 -> B2
//	B1 -> B2
func twoNodeEvents() []Message {
	return []Message{
		msg("A1", "A", map[string]uint64{"A": 1}, "a1"),
		msg("A2", "A", map[string]uint64{"A": 2}, "a2"),
		msg("B1", "B", map[string]uint64{"B": 1}, "b1"),
		msg("B2", "B", map[string]uint64{"A": 2, "B": 2}, "b2"),
	}
}

func TestOutOfOrderReplay(t *testing.T) {
	msgs := twoNodeEvents()
	// Reverse arrival: every message arrives before its dependencies.
	arrival := []Message{msgs[3], msgs[2], msgs[1], msgs[0]}

	lib := New()
	for _, m := range arrival {
		if err := lib.Deliver(m); err != nil {
			t.Fatalf("Deliver(%s): %v", m.ID, err)
		}
	}
	order := lib.Order()
	assertLinearExtension(t, order, msgs)
	if got := lib.Buffered(); got != 0 {
		t.Fatalf("buffer not drained: %d messages left", got)
	}
	// B1 has no prerequisites and is delivered on arrival; B2 and A2 wait
	// in the buffer and are released in causal order once A1 arrives.
	want := []string{"B1", "A1", "A2", "B2"}
	got := make([]string, len(order))
	for i, m := range order {
		got[i] = m.ID
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("delivery order = %v, want %v", got, want)
	}
}

func TestNoEarlyDeliveryWhileWaiting(t *testing.T) {
	lib := New()
	if err := lib.Deliver(msg("A2", "A", map[string]uint64{"A": 2}, "a2")); err != nil {
		t.Fatal(err)
	}
	if got := len(lib.Order()); got != 0 {
		t.Fatalf("delivered %d messages with unmet dependency, want 0", got)
	}
	if got := lib.Buffered(); got != 1 {
		t.Fatalf("buffered = %d, want 1", got)
	}
	if err := lib.Deliver(msg("A1", "A", map[string]uint64{"A": 1}, "a1")); err != nil {
		t.Fatal(err)
	}
	if got := len(lib.Order()); got != 2 {
		t.Fatalf("delivered = %d after prerequisite arrived, want 2", got)
	}
}

func TestDuplicateID(t *testing.T) {
	lib := New()
	m := msg("A1", "A", map[string]uint64{"A": 1}, "a1")
	if err := lib.Deliver(m); err != nil {
		t.Fatal(err)
	}
	// Identical redelivery is an idempotent no-op.
	if err := lib.Deliver(m); err != nil {
		t.Fatalf("identical redelivery: %v", err)
	}
	if got := len(lib.Order()); got != 1 {
		t.Fatalf("delivered = %d, want 1", got)
	}
	// Same ID, different payload: reject.
	err := lib.Deliver(msg("A1", "A", map[string]uint64{"A": 1}, "tampered"))
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting payload: err = %v, want ErrConflict", err)
	}
	// Same ID, different clock: reject.
	err = lib.Deliver(msg("A1", "A", map[string]uint64{"A": 2}, "a1"))
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting clock: err = %v, want ErrConflict", err)
	}
	// Conflict must also be detected while the message is still buffered.
	if err := lib.Deliver(msg("B2", "B", map[string]uint64{"B": 2}, "b2")); err != nil {
		t.Fatal(err)
	}
	err = lib.Deliver(msg("B2", "B", map[string]uint64{"B": 2}, "forged"))
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting buffered message: err = %v, want ErrConflict", err)
	}
	if err := lib.Deliver(msg("B2", "B", map[string]uint64{"B": 2}, "b2")); err != nil {
		t.Fatalf("identical buffered redelivery: %v", err)
	}
}

func TestCloseReportsUnmetDependencies(t *testing.T) {
	lib := New()
	// A3 needs A2 (and A1); B2 needs B1 and A2. Neither is satisfiable.
	if err := lib.Deliver(msg("A3", "A", map[string]uint64{"A": 3}, "a3")); err != nil {
		t.Fatal(err)
	}
	if err := lib.Deliver(msg("B2", "B", map[string]uint64{"A": 2, "B": 2}, "b2")); err != nil {
		t.Fatal(err)
	}
	pending := lib.Close()
	if len(pending) != 2 {
		t.Fatalf("pending = %d, want 2", len(pending))
	}
	byID := make(map[string]Pending)
	for _, p := range pending {
		byID[p.Message.ID] = p
	}
	if got := byID["A3"].Missing["A"]; got != 1 {
		t.Fatalf("A3 missing A seq = %d, want 1", got)
	}
	if got := byID["B2"].Missing["A"]; got != 1 {
		t.Fatalf("B2 missing A seq = %d, want 1", got)
	}
	if got := byID["B2"].Missing["B"]; got != 1 {
		t.Fatalf("B2 missing B seq = %d, want 1", got)
	}
	if err := lib.Deliver(msg("A1", "A", map[string]uint64{"A": 1}, "a1")); !errors.Is(err, ErrClosed) {
		t.Fatalf("deliver after close: err = %v, want ErrClosed", err)
	}
}

func TestAllArrivalOrdersRespectCausality(t *testing.T) {
	msgs := twoNodeEvents()
	runs := 0
	permutations(msgs, func(arrival []Message) {
		runs++
		lib := New()
		for _, m := range arrival {
			if err := lib.Deliver(m); err != nil {
				t.Fatalf("arrival %v: Deliver(%s): %v", ids(arrival), m.ID, err)
			}
		}
		assertLinearExtension(t, lib.Order(), msgs)
		if got := lib.Buffered(); got != 0 {
			t.Fatalf("arrival %v: %d messages left buffered", ids(arrival), got)
		}
	})
	if runs != 24 {
		t.Fatalf("enumerated %d permutations, want 24", runs)
	}
}

func TestRandomShufflesLargerGraph(t *testing.T) {
	// Three nodes with a cross-node dependency chain:
	// A1 -> A2 -> B2 -> C2, plus independent chains on B and C.
	msgs := []Message{
		msg("A1", "A", map[string]uint64{"A": 1}, "a1"),
		msg("A2", "A", map[string]uint64{"A": 2}, "a2"),
		msg("A3", "A", map[string]uint64{"A": 3, "C": 2}, "a3"),
		msg("B1", "B", map[string]uint64{"B": 1}, "b1"),
		msg("B2", "B", map[string]uint64{"A": 2, "B": 2}, "b2"),
		msg("B3", "B", map[string]uint64{"A": 2, "B": 3}, "b3"),
		msg("C1", "C", map[string]uint64{"C": 1}, "c1"),
		msg("C2", "C", map[string]uint64{"B": 2, "C": 2}, "c2"),
	}
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 200; trial++ {
		arrival := make([]Message, len(msgs))
		copy(arrival, msgs)
		rng.Shuffle(len(arrival), func(i, j int) {
			arrival[i], arrival[j] = arrival[j], arrival[i]
		})
		lib := New()
		for _, m := range arrival {
			if err := lib.Deliver(m); err != nil {
				t.Fatalf("trial %d: Deliver(%s): %v", trial, m.ID, err)
			}
		}
		assertLinearExtension(t, lib.Order(), msgs)
		if got := lib.Buffered(); got != 0 {
			t.Fatalf("trial %d: %d messages left buffered", trial, got)
		}
	}
}

func ids(msgs []Message) []string {
	out := make([]string, len(msgs))
	for i, m := range msgs {
		out[i] = m.ID
	}
	return out
}
