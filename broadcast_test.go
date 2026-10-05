package broadcast

import (
	"reflect"
	"testing"
)

func runTicks(s *Simulator, n int) {
	for i := 0; i < n; i++ {
		s.Tick()
	}
}

func wantLog(t *testing.T, got []Message, want []Message) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("delivered log = %v, want %v", got, want)
	}
}

func TestOrderedDeliveryWithDuplicatesAndLoss(t *testing.T) {
	s := NewSimulator()
	// Lose the first 6 in-flight packets; retransmission must compensate.
	dropsLeft := 6
	s.Drop = func(packet) bool {
		if dropsLeft > 0 {
			dropsLeft--
			return true
		}
		return false
	}
	for i := 1; i <= 5; i++ {
		s.Submit(i, string(rune('a'+i-1)))
	}
	s.Submit(3, "c") // duplicate proposal, same value: harmless
	runTicks(s, 12)

	want := []Message{{1, "a"}, {2, "b"}, {3, "c"}, {4, "d"}, {5, "e"}}
	for id := 0; id < NumNodes; id++ {
		wantLog(t, s.Delivered(id), want)
	}
	if err := s.CheckNoConflict(); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckPrefixConsistency(); err != nil {
		t.Fatal(err)
	}
	if len(s.Pending()) != 0 {
		t.Fatalf("pending not drained: %v", s.Pending())
	}
}

func TestOutOfOrderProposalWaitsForPrefix(t *testing.T) {
	s := NewSimulator()
	s.Submit(2, "b")
	runTicks(s, 4)
	for id := 0; id < NumNodes; id++ {
		if got := s.Delivered(id); len(got) != 0 {
			t.Fatalf("node %d delivered %v without seq 1", id, got)
		}
	}
	s.Submit(1, "a")
	runTicks(s, 6)
	want := []Message{{1, "a"}, {2, "b"}}
	for id := 0; id < NumNodes; id++ {
		wantLog(t, s.Delivered(id), want)
	}
	if err := s.CheckPrefixConsistency(); err != nil {
		t.Fatal(err)
	}
}

func TestNodeRequiresMajorityAndPrefix(t *testing.T) {
	store := newAckStore()
	n := newNode(0, store)

	// Own ack alone (1 of 3) is not a majority.
	out, conflict := n.handle(packet{from: -1, to: 0, kind: kindMsg, msg: Message{1, "a"}})
	if conflict != "" {
		t.Fatal(conflict)
	}
	if len(out) != NumNodes-1 {
		t.Fatalf("expected %d ack broadcasts, got %d", NumNodes-1, len(out))
	}
	if len(n.log) != 0 {
		t.Fatalf("delivered without majority: %v", n.log)
	}

	// A duplicate of the same message must not count as a second ack.
	n.handle(packet{from: -1, to: 0, kind: kindMsg, msg: Message{1, "a"}})
	if len(n.log) != 0 {
		t.Fatalf("duplicate counted as extra ack: %v", n.log)
	}

	// Majority reached with a second distinct acker.
	n.handle(packet{from: 1, to: 0, kind: kindAck, msg: Message{1, "a"}})
	wantLog(t, n.log, []Message{{1, "a"}})

	// Seq 3 with majority is buffered until seq 2 is delivered.
	n.handle(packet{from: -1, to: 0, kind: kindMsg, msg: Message{3, "c"}})
	n.handle(packet{from: 2, to: 0, kind: kindAck, msg: Message{3, "c"}})
	wantLog(t, n.log, []Message{{1, "a"}})
	n.handle(packet{from: -1, to: 0, kind: kindMsg, msg: Message{2, "b"}})
	n.handle(packet{from: 1, to: 0, kind: kindAck, msg: Message{2, "b"}})
	wantLog(t, n.log, []Message{{1, "a"}, {2, "b"}, {3, "c"}})
}

func TestPendingRetainedUnderTotalLoss(t *testing.T) {
	s := NewSimulator()
	s.Drop = func(packet) bool { return true }
	s.Submit(1, "a")
	s.Submit(2, "b")
	runTicks(s, 3)
	for id := 0; id < NumNodes; id++ {
		if got := s.Delivered(id); len(got) != 0 {
			t.Fatalf("node %d delivered under total loss: %v", id, got)
		}
	}
	if got := s.Pending(); !reflect.DeepEqual(got, map[int]string{1: "a", 2: "b"}) {
		t.Fatalf("pending lost messages: %v", got)
	}
	s.Drop = nil
	runTicks(s, 6)
	want := []Message{{1, "a"}, {2, "b"}}
	for id := 0; id < NumNodes; id++ {
		wantLog(t, s.Delivered(id), want)
	}
}

func TestRestartRecoversAckRecords(t *testing.T) {
	s := NewSimulator()
	s.Submit(1, "a")
	s.Submit(2, "b")
	runTicks(s, 6)

	// Durable ack records exist before the crash.
	if len(s.stores[0].acks) != 2 {
		t.Fatalf("store has %d acks, want 2", len(s.stores[0].acks))
	}

	s.Crash(0)
	s.Submit(3, "c")
	s.Submit(4, "d")
	runTicks(s, 6)
	for _, id := range []int{1, 2} {
		wantLog(t, s.Delivered(id), []Message{{1, "a"}, {2, "b"}, {3, "c"}, {4, "d"}})
	}
	if got := len(s.Delivered(0)); got != 2 {
		t.Fatalf("crashed node delivered %d messages, want frozen at 2", got)
	}

	s.Restart(0)
	// Ack records survive the restart in the durable store.
	if len(s.stores[0].acks) != 2 {
		t.Fatalf("ack records lost on restart: %v", s.stores[0].acks)
	}
	runTicks(s, 6)
	wantLog(t, s.Delivered(0), []Message{{1, "a"}, {2, "b"}, {3, "c"}, {4, "d"}})
	if err := s.CheckNoConflict(); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckPrefixConsistency(); err != nil {
		t.Fatal(err)
	}
}

func TestConflictDetection(t *testing.T) {
	// Conflicting client proposals for the same seq are rejected.
	s := NewSimulator()
	s.Submit(1, "a")
	s.Submit(1, "b")
	if err := s.CheckNoConflict(); err == nil {
		t.Fatal("expected conflict for duplicate seq with different value")
	}

	// A conflicting in-flight message is flagged at the node.
	s2 := NewSimulator()
	s2.Submit(1, "a")
	runTicks(s2, 4)
	s2.queue = append(s2.queue, packet{from: -1, to: 0, kind: kindMsg, msg: Message{1, "x"}})
	s2.Tick()
	if err := s2.CheckNoConflict(); err == nil {
		t.Fatal("expected conflict for forged message")
	}
	// Consistent duplicates raise no conflict.
	s3 := NewSimulator()
	s3.Submit(1, "a")
	s3.Submit(1, "a")
	runTicks(s3, 4)
	if err := s3.CheckNoConflict(); err != nil {
		t.Fatal(err)
	}
}

func TestPrefixConsistencyChecker(t *testing.T) {
	s := NewSimulator()
	s.Submit(1, "a")
	s.Submit(2, "b")
	runTicks(s, 6)
	if err := s.CheckPrefixConsistency(); err != nil {
		t.Fatal(err)
	}

	// A gap in a delivered log must be reported.
	s.nodes[1].log = append(s.nodes[1].log, Message{Seq: 4, Value: "d"})
	if err := s.CheckPrefixConsistency(); err == nil {
		t.Fatal("expected prefix violation to be detected")
	}

	// Diverging values for the same seq must be reported.
	s2 := NewSimulator()
	s2.Submit(1, "a")
	runTicks(s2, 4)
	s2.nodes[2].log[0].Value = "z"
	if err := s2.CheckPrefixConsistency(); err == nil {
		t.Fatal("expected cross-node disagreement to be detected")
	}
}
