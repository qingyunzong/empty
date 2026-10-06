package raftsim

import (
	"fmt"
	"testing"
)

func dumpTrace(t *testing.T, s *Sim) {
	t.Helper()
	for _, line := range s.Trace {
		t.Log(line)
	}
}

func mustSafe(t *testing.T, s *Sim) {
	t.Helper()
	if err := s.CheckSafety(); err != nil {
		dumpTrace(t, s)
		t.Fatalf("safety violation: %v", err)
	}
}

// TestElectAndReplicateCommit: one election, three client writes, all three
// nodes commit the same prefix; every step and commit evidence is logged.
func TestElectAndReplicateCommit(t *testing.T) {
	s := NewSim(3)
	s.Timeout(0)
	s.Drain()
	mustSafe(t, s)
	if got := s.Leader(); got != 0 {
		t.Fatalf("want leader n0, got n%d", got)
	}
	for _, cmd := range []string{"set x=1", "set y=2", "set z=3"} {
		if !s.ClientWrite(cmd) {
			t.Fatalf("no leader for %q", cmd)
		}
		s.Drain()
		mustSafe(t, s)
	}
	s.Heartbeat() // propagate the final commit index to followers
	s.Drain()
	mustSafe(t, s)
	for _, n := range s.Nodes {
		if n.CommitIdx != 3 {
			t.Fatalf("n%d commit=%d, want 3", n.ID, n.CommitIdx)
		}
		want := []Entry{{1, "set x=1"}, {1, "set y=2"}, {1, "set z=3"}}
		for i, e := range want {
			if n.Log[i] != e {
				t.Fatalf("n%d log[%d]=%v, want %v", n.ID, i, n.Log[i], e)
			}
		}
	}
	if len(s.Evidence) != 3 {
		t.Fatalf("want 3 commit evidences, got %d", len(s.Evidence))
	}
	for _, ev := range s.Evidence {
		if len(ev.Quorum) < 2 {
			t.Fatalf("evidence without majority quorum: %v", ev)
		}
	}
	dumpTrace(t, s)
	t.Logf("commit evidences: %v", s.Evidence)
}

// TestOldLeaderRecoveryTruncatesUncommitted: the classic stale-leader story.
// n0 (term 1) commits "A" everywhere, gets isolated, and accepts "B" alone
// (uncommitted). n1 wins term 2 with n2 and commits "C". After healing, n0's
// uncommitted "B" must be truncated and replaced by the committed "C"; the
// committed prefix "A" must never be overwritten.
func TestOldLeaderRecoveryTruncatesUncommitted(t *testing.T) {
	s := NewSim(3)
	s.Timeout(0)
	s.Drain()
	s.ClientWrite("A")
	s.Drain()
	mustSafe(t, s)

	// Isolate the old leader; it keeps accepting writes it cannot commit.
	s.Partition([]int{0}, []int{1, 2})
	s.ClientWrite("B")
	s.Drain()
	if s.Nodes[0].CommitIdx != 1 {
		t.Fatalf("isolated leader committed alone: commit=%d", s.Nodes[0].CommitIdx)
	}

	// New term on the majority side; "C" is committed there.
	s.Timeout(1)
	s.Drain()
	if got := s.Leader(); got != 1 {
		t.Fatalf("want leader n1, got n%d", got)
	}
	s.ClientWrite("C")
	s.Drain()
	s.Heartbeat()
	s.Drain()
	mustSafe(t, s)
	if s.Nodes[1].CommitIdx != 2 || s.Nodes[2].CommitIdx != 2 {
		t.Fatalf("majority side did not commit C: %d %d",
			s.Nodes[1].CommitIdx, s.Nodes[2].CommitIdx)
	}

	// Heal: n0's conflicting uncommitted "B" must be truncated.
	s.Partition()
	s.ClientWrite("D")
	s.Drain()
	s.Heartbeat()
	s.Drain()
	mustSafe(t, s)

	want := []Entry{{1, "A"}, {2, "C"}, {2, "D"}}
	for _, n := range s.Nodes {
		if n.CommitIdx != 3 {
			t.Fatalf("n%d commit=%d, want 3", n.ID, n.CommitIdx)
		}
		if len(n.Log) != 3 {
			t.Fatalf("n%d log=%v, want len 3", n.ID, n.Log)
		}
		for i, e := range want {
			if n.Log[i] != e {
				t.Fatalf("n%d log[%d]=%v, want %v", n.ID, i, n.Log[i], e)
			}
		}
	}
	for _, ev := range s.Evidence {
		t.Log(ev)
	}
	dumpTrace(t, s)
}

// TestStaleLeaderCannotOverwriteCommitted: a partitioned old leader's stale
// AppendEntries (lower term) must be rejected, so a committed prefix is never
// covered even while the partition lasts.
func TestStaleLeaderCannotOverwriteCommitted(t *testing.T) {
	s := NewSim(3)
	s.Timeout(0)
	s.Drain()
	s.ClientWrite("A")
	s.Drain()

	s.Partition([]int{0}, []int{1, 2})
	s.Timeout(1)
	s.Drain()
	s.ClientWrite("B") // committed on {n1, n2} in term 2
	s.Drain()
	mustSafe(t, s)

	// Old leader n0 (still term 1) tries to replicate a conflicting entry.
	s.Nodes[0].Log = append(s.Nodes[0].Log, Entry{Term: 1, Cmd: "evil"})
	s.send(Msg{Kind: MAppend, From: 0, To: 1, Term: 1,
		PrevLogIndex: 1, PrevLogTerm: 1,
		Entries: []Entry{{Term: 1, Cmd: "evil"}}, LeaderCommit: 2})
	s.Drain()
	mustSafe(t, s)
	if s.Nodes[1].Log[1].Cmd != "B" {
		t.Fatalf("committed entry overwritten: %v", s.Nodes[1].Log)
	}
	dumpTrace(t, s)
}

// TestEnumerateShortPartitionHistories explores, by BFS with dedup, all
// interleavings of: message deliveries, election timeouts, client writes,
// and short partition histories (reconfigurations are only injected near
// the root, so every explored run is a bounded-depth partition history
// followed by protocol message traffic). Safety (term monotonicity, no
// committed truncation, committed-prefix agreement) is checked in every
// visited state, and the run must actually exercise commits.
func TestEnumerateShortPartitionHistories(t *testing.T) {
	const maxDepth = 11
	const maxPartitionDepth = 5 // partition histories stay short
	const maxTimeoutDepth = 8   // elections can also start mid-run
	const maxStates = 2000000

	partitionConfigs := [][][]int{
		{},              // healed
		{{0}, {1, 2}},   // isolate n0
		{{1}, {0, 2}},   // isolate n1
		{{2}, {0, 1}},   // isolate n2
		{{0, 1}, {2}},   // link cut between pairs
		{{0, 2}, {1}},   //
		{{0}, {1}, {2}}, // full split
	}

	type item struct {
		sim   *Sim
		depth int
	}
	root := NewSim(3)
	root.Quiet = true
	seen := map[string]bool{root.Hash(): true}
	queue := []item{{root, 0}}
	explored, commits := 0, 0

	for len(queue) > 0 {
		it := queue[0]
		queue = queue[1:]
		explored++
		commits += len(it.sim.Evidence)
		if it.depth >= maxDepth || explored >= maxStates {
			continue
		}
		expand := func(mutate func(*Sim)) {
			c := it.sim.Clone()
			mutate(c)
			if err := c.CheckSafety(); err != nil {
				t.Fatalf("safety violation at depth %d: %v", it.depth+1, err)
			}
			h := c.Hash()
			if seen[h] {
				return
			}
			seen[h] = true
			queue = append(queue, item{c, it.depth + 1})
		}
		if it.sim.QueueLen() > 0 {
			expand(func(c *Sim) { c.DeliverNext() })
		}
		if it.depth < maxTimeoutDepth {
			for i := range it.sim.Nodes {
				i := i
				expand(func(c *Sim) { c.Timeout(i) })
			}
		}
		if it.depth < maxPartitionDepth {
			for _, pc := range partitionConfigs {
				pc := pc
				expand(func(c *Sim) { c.Partition(pc...) })
			}
		}
		if it.sim.Leader() >= 0 {
			expand(func(c *Sim) { c.ClientWriteSeq() })
		}
	}
	t.Logf("explored %d unique states (depth<=%d), observed %d commit events, no safety violation",
		explored, maxDepth, commits)
	if explored < 1000 {
		t.Fatalf("exploration suspiciously small: %d states", explored)
	}
	if commits == 0 {
		t.Fatal("exploration never reached a commit; increase depth")
	}
}

// TestEvidenceCoversEveryCommit cross-checks that every committed entry on
// every node is backed by a recorded quorum evidence.
func TestEvidenceCoversEveryCommit(t *testing.T) {
	s := NewSim(3)
	s.Timeout(2)
	s.Drain()
	for i := 0; i < 4; i++ {
		s.ClientWrite(fmt.Sprintf("cmd%d", i))
		s.Drain()
	}
	mustSafe(t, s)
	committed := map[int]string{}
	for _, ev := range s.Evidence {
		committed[ev.Index] = ev.Cmd
	}
	for _, n := range s.Nodes {
		for idx := 1; idx <= n.CommitIdx; idx++ {
			if _, ok := committed[idx]; !ok {
				t.Fatalf("n%d committed index %d without evidence", n.ID, idx)
			}
		}
	}
}
