package raftsim

import (
	"strings"
	"testing"
)

const idleCap = 10000

func dumpTrace(t *testing.T, s *Sim) {
	t.Helper()
	for _, line := range s.Trace {
		t.Log(line)
	}
}

func checkNoViolations(t *testing.T, s *Sim) {
	t.Helper()
	if v := s.Violations(); len(v) > 0 {
		dumpTrace(t, s)
		t.Fatalf("safety violations: %s", strings.Join(v, "; "))
	}
}

// TestBasicElectionAndCommit: n1 is elected, one client value is replicated
// to a majority and committed; every node observes the commit.
func TestBasicElectionAndCommit(t *testing.T) {
	s := NewSim("n1", "n2", "n3")
	s.StartElection("n1")
	if !s.RunUntilIdle(idleCap) {
		t.Fatal("election did not quiesce")
	}
	if s.Node("n1").Role() != Leader {
		t.Fatalf("n1 should be leader, got %s", s.Node("n1").Role())
	}
	s.Propose("n1", "x")
	if !s.RunUntilIdle(idleCap) {
		t.Fatal("replication did not quiesce")
	}
	for _, id := range []string{"n1", "n2", "n3"} {
		n := s.Node(id)
		if n.CommitIndex() != 1 {
			t.Fatalf("%s commitIndex=%d, want 1", id, n.CommitIndex())
		}
		want := []Entry{{Term: 1, Value: "x"}}
		if got := n.Log(); got[0] != want[0] || len(got) != 1 {
			t.Fatalf("%s log=%v, want %v", id, got, want)
		}
	}
	if len(s.Evidence) != 1 {
		t.Fatalf("want exactly 1 commit evidence, got %d", len(s.Evidence))
	}
	ev := s.Evidence[0]
	if ev.Index != 1 || ev.Leader != "n1" || len(ev.ReplicatedOn) < 2 {
		t.Fatalf("bad evidence: %s", ev)
	}
	t.Logf("commit evidence: %s", ev)
	dumpTrace(t, s)
	checkNoViolations(t, s)
}

// TestOldLeaderRecoveryTruncatesUncommitted is the core scenario:
//
//  1. n1 (leader, term 1) commits "A" at index 1 on all nodes.
//  2. n1 is partitioned away; it appends uncommitted "B" at index 2.
//  3. n2 wins term 2 and commits "C" at index 2 on {n2, n3}.
//  4. The partition heals; n1's stale AppendEntries are rejected, n1 steps
//     down, and n2's AppendEntries force n1 to TRUNCATE the uncommitted "B"
//     and accept "C". The committed prefix ("A") is never touched.
func TestOldLeaderRecoveryTruncatesUncommitted(t *testing.T) {
	s := NewSim("n1", "n2", "n3")

	// Phase 1: n1 leads term 1, "A" committed everywhere.
	s.StartElection("n1")
	s.RunUntilIdle(idleCap)
	s.Propose("n1", "A")
	s.RunUntilIdle(idleCap)
	if s.Node("n3").CommitIndex() != 1 {
		t.Fatalf("setup: n3 commitIndex=%d, want 1", s.Node("n3").CommitIndex())
	}

	// Phase 2: partition n1 away; it keeps serving a (doomed) client write.
	s.CutBoth("n1", "n2")
	s.CutBoth("n1", "n3")
	s.Propose("n1", "B")
	s.RunUntilIdle(idleCap)
	if got := s.Node("n1").Log(); len(got) != 2 || got[1].Value != "B" {
		t.Fatalf("n1 should hold uncommitted B, log=%v", FormatLog(got))
	}
	if s.Node("n1").CommitIndex() != 1 {
		t.Fatalf("n1 must not commit B without a majority")
	}

	// Phase 3: n2 wins term 2 with n3's vote and commits "C" at index 2.
	s.StartElection("n2")
	s.RunUntilIdle(idleCap)
	if s.Node("n2").Role() != Leader {
		t.Fatalf("n2 should be leader of term 2")
	}
	s.Propose("n2", "C")
	s.RunUntilIdle(idleCap)
	if s.Node("n2").CommitIndex() != 2 || s.Node("n3").CommitIndex() != 2 {
		t.Fatalf("C should be committed on n2,n3")
	}

	// Phase 4: heal. The old leader's stale term-1 traffic is rejected;
	// n2's AppendEntries bring n1 back into line.
	s.HealAll()
	s.Propose("n1", "D") // n1 still thinks it leads term 1; must fail to commit.
	s.RunUntilIdle(idleCap)
	if s.Node("n1").Role() == Leader {
		t.Fatalf("n1 should have stepped down after seeing term 2")
	}
	s.Propose("n2", "E")
	s.RunUntilIdle(idleCap)

	n1, n2 := s.Node("n1"), s.Node("n2")
	if got, want := FormatLog(n1.Log()), FormatLog(n2.Log()); got != want {
		t.Fatalf("n1 log %s != n2 log %s", got, want)
	}
	for _, e := range n1.Log() {
		if e.Value == "B" || e.Value == "D" {
			t.Fatalf("uncommitted conflicting entry %q survived on n1: %s", e.Value, FormatLog(n1.Log()))
		}
	}
	if n1.Log()[0] != (Entry{Term: 1, Value: "A"}) {
		t.Fatalf("committed prefix was modified on n1: %s", FormatLog(n1.Log()))
	}
	if n1.Log()[1] != (Entry{Term: 2, Value: "C"}) {
		t.Fatalf("n1 index 2 = %v, want committed C", n1.Log()[1])
	}
	if n1.CommitIndex() != 3 {
		t.Fatalf("n1 commitIndex=%d, want 3 (A,C,E)", n1.CommitIndex())
	}

	// Commit evidence must show A, C, E each backed by a majority.
	if len(s.Evidence) != 3 {
		t.Fatalf("want 3 commit evidences, got %d", len(s.Evidence))
	}
	for _, ev := range s.Evidence {
		if len(ev.ReplicatedOn) < 2 {
			t.Fatalf("commit without majority: %s", ev)
		}
		t.Logf("commit evidence: %s", ev)
	}
	dumpTrace(t, s)
	checkNoViolations(t, s)
}

// TestStaleLeaderMessagesRejected: an isolated leader's AppendEntries and
// votes from an older term must never disturb a newer-term node.
func TestStaleLeaderMessagesRejected(t *testing.T) {
	s := NewSim("n1", "n2", "n3")
	s.StartElection("n1")
	s.RunUntilIdle(idleCap)
	s.Propose("n1", "A")
	s.RunUntilIdle(idleCap)

	s.CutBoth("n1", "n2")
	s.CutBoth("n1", "n3")
	s.StartElection("n2")
	s.RunUntilIdle(idleCap)
	s.Propose("n2", "C")
	s.RunUntilIdle(idleCap)

	// n1 keeps its term-1 leadership illusions; heal and let its stale
	// AppendEntries hit n2/n3, which are now in term 2.
	s.HealAll()
	s.Propose("n1", "stale")
	s.RunUntilIdle(idleCap)

	for _, id := range []string{"n2", "n3"} {
		for _, e := range s.Node(id).Log() {
			if e.Value == "stale" {
				t.Fatalf("%s accepted entry from stale term-1 leader: %s", id, FormatLog(s.Node(id).Log()))
			}
		}
	}
	if s.Node("n1").Term() != 2 {
		t.Fatalf("n1 should have caught up to term 2, got %d", s.Node("n1").Term())
	}
	dumpTrace(t, s)
	checkNoViolations(t, s)
}
