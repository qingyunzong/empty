package netsim

import "testing"

func packetByID(ps []*Packet, id int) *Packet {
	for _, p := range ps {
		if p.ID == id {
			return p
		}
	}
	return nil
}

func TestNoFaultAllDelivered(t *testing.T) {
	s := NewSim(&Link{Name: "l", Latency: 2, Rate: 1})
	s.Release(0, 1, 100)
	s.Release(1, 2, 100)
	s.Release(2, 3, 100)
	s.Run()

	wantFinish := map[int]int{1: 2, 2: 3, 3: 4}
	for _, p := range s.Packets() {
		if p.State != StateDelivered {
			t.Fatalf("pkt %d: state=%s, want delivered", p.ID, p.State)
		}
		if p.FinishAt != wantFinish[p.ID] {
			t.Fatalf("pkt %d: finish=%d, want %d", p.ID, p.FinishAt, wantFinish[p.ID])
		}
	}
}

func TestPauseFaultFreezesInTransit(t *testing.T) {
	// latency 3: p1 in flight since 0 (deliver 3), p2 since 1 (deliver 4).
	// Pause fault at 2, recover at 5. Remaining time survives the pause.
	// p3 released at 3 must stay queued (unsent) until recovery.
	s := NewSim(&Link{Name: "l", Latency: 3, Rate: 1})
	s.Release(0, 1, 100)
	s.Release(1, 2, 100)
	s.Fault(2, PolicyPause, 0)
	s.Release(3, 3, 100)
	s.Recover(5)
	s.Run()

	want := map[int]struct {
		state  State
		sent   int
		finish int
	}{
		1: {StateDelivered, 0, 6}, // remaining 1: 5+1
		2: {StateDelivered, 1, 7}, // remaining 2: 5+2
		3: {StateDelivered, 5, 8}, // unsent during fault, sent at recovery
	}
	for _, p := range s.Packets() {
		w := want[p.ID]
		if p.State != w.state || p.SentAt != w.sent || p.FinishAt != w.finish {
			t.Fatalf("pkt %d: got (%s sent=%d finish=%d), want (%s sent=%d finish=%d)",
				p.ID, p.State, p.SentAt, p.FinishAt, w.state, w.sent, w.finish)
		}
	}
}

func TestDropFaultKillsInTransitOnly(t *testing.T) {
	// Drop at 2 destroys only in-transit p1/p2. p3 released during the
	// fault is unsent, survives and goes out after recovery.
	s := NewSim(&Link{Name: "l", Latency: 3, Rate: 1})
	s.Release(0, 1, 100)
	s.Release(1, 2, 100)
	s.Fault(2, PolicyDrop, 0)
	s.Release(3, 3, 100)
	s.Recover(4)
	s.Run()

	p1 := packetByID(s.Packets(), 1)
	p2 := packetByID(s.Packets(), 2)
	p3 := packetByID(s.Packets(), 3)
	if p1.State != StateDropped || p1.FinishAt != 2 {
		t.Fatalf("p1: got (%s finish=%d), want dropped@2", p1.State, p1.FinishAt)
	}
	if p2.State != StateDropped || p2.FinishAt != 2 {
		t.Fatalf("p2: got (%s finish=%d), want dropped@2", p2.State, p2.FinishAt)
	}
	if p3.State != StateDelivered || p3.SentAt != 4 || p3.FinishAt != 7 {
		t.Fatalf("p3: got (%s sent=%d finish=%d), want delivered sent=4 finish=7",
			p3.State, p3.SentAt, p3.FinishAt)
	}
}

func TestDroppedPacketsAreNotResurrected(t *testing.T) {
	s := NewSim(&Link{Name: "l", Latency: 3, Rate: 1})
	s.Release(0, 1, 100)
	s.Fault(2, PolicyDrop, 0)
	s.Recover(4)
	s.Recover(5) // extra recovery must not change anything
	s.Run()

	p := s.Packets()[0]
	if p.State != StateDropped {
		t.Fatalf("pkt 1: state=%s, want dropped", p.State)
	}
	if p.FinishAt != 2 {
		t.Fatalf("pkt 1: finish=%d, want 2", p.FinishAt)
	}
}

func TestDelayFaultAddsFixedDelay(t *testing.T) {
	// p1 would arrive at 3 and p2 at 4; a +3 delay fault at 2 moves
	// arrivals to 6 and 7. p3, still unsent during the fault, is unaffected.
	s := NewSim(&Link{Name: "l", Latency: 3, Rate: 1})
	s.Release(0, 1, 100)
	s.Release(1, 2, 100)
	s.Fault(2, PolicyDelay, 3)
	s.Release(3, 3, 100)
	s.Recover(4)
	s.Run()

	want := map[int]int{1: 6, 2: 7, 3: 7}
	for _, p := range s.Packets() {
		if p.State != StateDelivered {
			t.Fatalf("pkt %d: state=%s, want delivered", p.ID, p.State)
		}
		if p.FinishAt != want[p.ID] {
			t.Fatalf("pkt %d: finish=%d, want %d", p.ID, p.FinishAt, want[p.ID])
		}
	}
}

func TestDuplicateFaultKeepsFirstPolicy(t *testing.T) {
	// First fault is pause at 2; a second "drop" fault at 3 while the
	// fault is active must be ignored. The packet stays frozen and
	// delivers after recovery, proving the policy was fixed at start.
	s := NewSim(&Link{Name: "l", Latency: 10, Rate: 1})
	s.Release(0, 1, 100)
	s.Fault(2, PolicyPause, 0)
	s.Fault(3, PolicyDrop, 0) // idempotent duplicate, must not override
	s.Recover(5)
	s.Run()

	p := s.Packets()[0]
	if p.State != StateDelivered {
		t.Fatalf("pkt 1: state=%s, want delivered", p.State)
	}
	if p.FinishAt != 13 { // paused at 2 with 8 ticks remaining, 5+8
		t.Fatalf("pkt 1: finish=%d, want 13", p.FinishAt)
	}
}

func TestNewFaultAfterRecoveryIsAllowed(t *testing.T) {
	// A fault after recovery is a fresh event, not a duplicate.
	s := NewSim(&Link{Name: "l", Latency: 2, Rate: 1})
	s.Release(0, 1, 100) // delivered at 2
	s.Release(3, 2, 100) // sent at 3
	s.Fault(1, PolicyPause, 0)
	s.Recover(2)
	s.Fault(4, PolicyDrop, 0) // new fault drops p2 in transit
	s.Recover(6)
	s.Run()

	if p := s.Packets()[0]; p.State != StateDelivered || p.FinishAt != 3 {
		t.Fatalf("p1: got (%s finish=%d), want delivered@3", p.State, p.FinishAt)
	}
	if p := s.Packets()[1]; p.State != StateDropped || p.FinishAt != 4 {
		t.Fatalf("p2: got (%s finish=%d), want dropped@4", p.State, p.FinishAt)
	}
}

func TestRecoveryWithoutFaultIsNoOp(t *testing.T) {
	s := NewSim(&Link{Name: "l", Latency: 2, Rate: 1})
	s.Recover(0) // nothing to recover; must not panic or block sends
	s.Release(0, 1, 100)
	s.Run()

	p := s.Packets()[0]
	if p.State != StateDelivered || p.FinishAt != 2 {
		t.Fatalf("p1: got (%s finish=%d), want delivered@2", p.State, p.FinishAt)
	}
}

func TestUnrecoveredFaultLeavesNonTerminalStates(t *testing.T) {
	// Fault never recovers: p1 stays frozen on the wire, p2 stays queued.
	// In-transit and unsent packets must remain distinguishable.
	s := NewSim(&Link{Name: "l", Latency: 5, Rate: 1})
	s.Release(0, 1, 100)
	s.Fault(2, PolicyPause, 0)
	s.Release(3, 2, 100)
	s.Run()

	p1 := s.Packets()[0]
	p2 := s.Packets()[1]
	if p1.State != StatePaused {
		t.Fatalf("p1: state=%s, want paused (in transit)", p1.State)
	}
	if p2.State != StateQueued || p2.SentAt != -1 {
		t.Fatalf("p2: state=%s sent=%d, want queued/unsent", p2.State, p2.SentAt)
	}
}

func TestRateTwo(t *testing.T) {
	s := NewSim(&Link{Name: "l", Latency: 1, Rate: 2})
	s.Release(0, 1, 100)
	s.Release(0, 2, 100)
	s.Release(0, 3, 100)
	s.Run()

	wantFinish := map[int]int{1: 1, 2: 1, 3: 2}
	for _, p := range s.Packets() {
		if p.State != StateDelivered || p.FinishAt != wantFinish[p.ID] {
			t.Fatalf("pkt %d: got (%s finish=%d), want delivered@%d",
				p.ID, p.State, p.FinishAt, wantFinish[p.ID])
		}
	}
}
