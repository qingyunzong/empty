package chainsim

import (
	"fmt"
	"math/rand"
	"testing"
)

// checker asserts the safety invariants after every single event:
//   - Committed is always a contiguous prefix of the log
//   - committed values always equal the client-accepted writes
//   - Committed never regresses (confirmed writes are never lost)
type checker struct {
	t            *testing.T
	maxCommitted map[int]int
	ever         int
}

func newChecker(t *testing.T) *checker {
	t.Helper()
	return &checker{t: t, maxCommitted: make(map[int]int)}
}

func (c *checker) hook(s *Sim) {
	c.t.Helper()
	for id, n := range s.nodes {
		for seq := 1; seq <= n.Committed; seq++ {
			v, ok := n.Log[seq]
			if !ok {
				c.t.Fatalf("node %d: committed prefix not contiguous, missing seq %d (committed=%d)", id, seq, n.Committed)
			}
			if want := s.writes[seq]; v != want {
				c.t.Fatalf("node %d: committed seq %d = %q, want client write %q", id, seq, v, want)
			}
		}
		if n.Committed < c.maxCommitted[id] {
			c.t.Fatalf("node %d: committed regressed %d -> %d", id, c.maxCommitted[id], n.Committed)
		}
		if n.Committed > c.maxCommitted[id] {
			c.maxCommitted[id] = n.Committed
		}
		if n.Committed > c.ever {
			c.ever = n.Committed
		}
	}
}

func submitAll(t *testing.T, s *Sim, from, to int, prefix string) {
	t.Helper()
	for i := from; i <= to; i++ {
		if _, ok := s.SubmitWrite(fmt.Sprintf("%s-%d", prefix, i)); !ok {
			t.Fatalf("write %d rejected by head", i)
		}
	}
}

func TestWritePropagationFromHead(t *testing.T) {
	s := NewSim(1)
	for i := 0; i < 4; i++ {
		s.AddNode(i)
	}
	s.SetChain(0, 1, 2, 3)
	c := newChecker(t)
	s.AfterEach = c.hook

	const total = 25
	submitAll(t, s, 1, total, "val")
	s.Run()

	if s.Pending() != 0 {
		t.Fatalf("event queue not drained: %d pending", s.Pending())
	}
	for id := 0; id < 4; id++ {
		n := s.Node(id)
		if n.Committed != total {
			t.Errorf("node %d committed %d, want %d", id, n.Committed, total)
		}
		if len(n.Log) != total {
			t.Errorf("node %d log has %d entries, want %d", id, len(n.Log), total)
		}
	}
	if c.ever != total {
		t.Fatalf("max committed prefix ever observed = %d, want %d", c.ever, total)
	}
}

func TestRestartFillsHolesFromLog(t *testing.T) {
	s := NewSim(7)
	for i := 0; i < 4; i++ {
		s.AddNode(i)
	}
	s.SetChain(0, 1, 2, 3)
	c := newChecker(t)
	s.AfterEach = c.hook

	submitAll(t, s, 1, 10, "a")
	for i := 0; i < 30; i++ {
		s.Step()
	}

	s.Crash(1)
	submitAll(t, s, 11, 20, "b")
	s.Run()

	if got := len(s.Node(1).Log); got >= 20 {
		t.Fatalf("node 1 was down but holds %d entries, expected gaps", got)
	}
	committedBefore := c.ever

	s.Restart(1)
	s.Run()

	for id := 0; id < 4; id++ {
		n := s.Node(id)
		if n.Committed != 20 {
			t.Errorf("node %d committed %d, want 20", id, n.Committed)
		}
		if len(n.Log) != 20 {
			t.Errorf("node %d log has %d entries, want 20", id, len(n.Log))
		}
	}
	if c.ever != 20 {
		t.Fatalf("confirmed writes lost across restart: ever=%d, want 20 (was %d before restart)", c.ever, committedBefore)
	}
}

func TestReconfigurationBindsNewEpoch(t *testing.T) {
	s := NewSim(11)
	for i := 0; i < 4; i++ {
		s.AddNode(i)
	}
	s.SetChain(0, 1, 2)
	c := newChecker(t)
	s.AfterEach = c.hook

	submitAll(t, s, 1, 15, "v")
	for i := 0; i < 20; i++ {
		s.Step()
	}

	oldEpoch := s.Epoch()
	s.SetChain(0, 2, 3)
	if s.Epoch() != oldEpoch+1 {
		t.Fatalf("topology change did not bump epoch: %d -> %d", oldEpoch, s.Epoch())
	}

	// Stale messages from the old epoch, plus a forged ack in the new epoch
	// from a node that is not the successor: all must be ignored.
	s.send(Message{Epoch: oldEpoch, Kind: msgAck, From: 2, To: 0, Seq: 15})
	s.send(Message{Epoch: oldEpoch, Kind: msgWrite, From: 1, To: 2, Seq: 15, Val: "forged"})
	s.send(Message{Epoch: s.Epoch(), Kind: msgAck, From: 1, To: 0, Seq: 15})

	submitAll(t, s, 16, 20, "w")
	s.Run()

	for _, id := range []int{0, 2, 3} {
		n := s.Node(id)
		if n.Committed != 20 {
			t.Errorf("node %d committed %d, want 20", id, n.Committed)
		}
		for seq := 1; seq <= 20; seq++ {
			if n.Log[seq] != s.writes[seq] {
				t.Fatalf("node %d seq %d = %q, want client write %q", id, seq, n.Log[seq], s.writes[seq])
			}
		}
	}
	if s.Node(2).Log[15] == "forged" {
		t.Fatalf("stale-epoch write was applied")
	}
	if c.ever != 20 {
		t.Fatalf("confirmed writes lost across reconfiguration: ever=%d, want 20", c.ever)
	}
}

func TestStaleAndForgedMessagesRejected(t *testing.T) {
	s := NewSim(3)
	for i := 0; i < 3; i++ {
		s.AddNode(i)
	}
	s.SetChain(0, 1, 2)
	submitAll(t, s, 1, 1, "x")
	s.Run()

	n1 := s.Node(1)
	wm := n1.ackWatermark

	s.deliver(Message{Epoch: s.Epoch() + 1, Kind: msgAck, From: 2, To: 1, Seq: 99})
	s.deliver(Message{Epoch: s.Epoch(), Kind: msgAck, From: 0, To: 1, Seq: 99})
	s.deliver(Message{Epoch: s.Epoch(), Kind: msgWrite, From: 2, To: 1, Seq: 50, Val: "evil"})
	s.deliver(Message{Epoch: s.Epoch(), Kind: msgSyncData, From: 9, To: 1, Entries: []Entry{{Seq: 51, Val: "evil"}}})

	if n1.ackWatermark != wm {
		t.Fatalf("ack watermark moved by rejected messages: %d -> %d", wm, n1.ackWatermark)
	}
	if _, ok := n1.Log[50]; ok {
		t.Fatalf("write from non-predecessor was applied")
	}
	if _, ok := n1.Log[51]; ok {
		t.Fatalf("sync data from non-neighbor was applied")
	}
	if n1.Committed != 1 {
		t.Fatalf("committed = %d, want 1", n1.Committed)
	}
}

// TestAcceptanceEventReordering is the acceptance test: under arbitrary
// event reordering, crashes, restarts and epoch-bound reconfigurations,
// confirmed writes are never lost and stale acknowledgements are never
// misused. The per-event checker enforces the contiguous-prefix and
// no-regression invariants throughout every run.
func TestAcceptanceEventReordering(t *testing.T) {
	for seed := int64(0); seed < 40; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			s := NewSim(seed)
			for i := 0; i < 5; i++ {
				s.AddNode(i)
			}
			s.SetChain(0, 1, 2)
			c := newChecker(t)
			s.AfterEach = c.hook

			submitted := 0
			for round := 0; round < 40; round++ {
				switch rng.Intn(12) {
				case 0, 1, 2, 3, 4:
					if _, ok := s.SubmitWrite(fmt.Sprintf("s%d-w%d", seed, submitted+1)); ok {
						submitted++
					}
				case 5, 6:
					ch := s.Chain()
					s.Crash(ch[rng.Intn(len(ch))])
				case 7, 8:
					s.Restart(rng.Intn(5))
				case 9:
					// Reconfigure: keep every current chain member (so all
					// confirmed data stays reachable), permute, and maybe
					// add spare nodes.
					pool := s.Chain()
					for id := 0; id < 5; id++ {
						kept := false
						for _, x := range pool {
							if x == id {
								kept = true
								break
							}
						}
						if !kept && rng.Intn(2) == 0 {
							pool = append(pool, id)
						}
					}
					rng.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
					s.SetChain(pool...)
				}
				for i, steps := 0, rng.Intn(20); i < steps; i++ {
					if !s.Step() {
						break
					}
				}
			}

			for id := 0; id < 5; id++ {
				if !s.Node(id).up {
					s.Restart(id)
				}
			}
			s.Run()

			for _, id := range s.Chain() {
				n := s.Node(id)
				if n.Committed != submitted {
					t.Fatalf("node %d committed %d, want %d: confirmed writes lost", id, n.Committed, submitted)
				}
				if len(n.Log) != submitted {
					t.Fatalf("node %d log has %d entries, want %d", id, len(n.Log), submitted)
				}
				for seq := 1; seq <= submitted; seq++ {
					if n.Log[seq] != s.writes[seq] {
						t.Fatalf("node %d seq %d = %q, want client write %q", id, seq, n.Log[seq], s.writes[seq])
					}
				}
			}
			if c.ever > submitted {
				t.Fatalf("committed prefix %d exceeds submitted writes %d", c.ever, submitted)
			}
		})
	}
}
