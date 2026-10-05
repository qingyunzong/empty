package raftsim

import (
	"fmt"
	"strings"
	"testing"
)

// undirected links of the 3-node cluster; a history entry is a bitmask over
// these links (bit set = link cut for that phase).
var links = [][2]string{{"n1", "n2"}, {"n1", "n3"}, {"n2", "n3"}}

func applyMask(s *Sim, mask int) {
	s.HealAll()
	for i, l := range links {
		if mask&(1<<i) != 0 {
			s.CutBoth(l[0], l[1])
		}
	}
}

// mostUpToDate returns the node whose log is lexicographically largest by
// (lastTerm, lastIndex); ties break by id order for determinism.
func mostUpToDate(s *Sim) string {
	best, bestTerm, bestIdx := "", -1, -1
	for _, id := range s.ids {
		n := s.nodes[id]
		if n.lastTerm() > bestTerm || (n.lastTerm() == bestTerm && n.lastIndex() > bestIdx) {
			best, bestTerm, bestIdx = id, n.lastTerm(), n.lastIndex()
		}
	}
	return best
}

// runHistory executes one partition history and returns a failure reason
// ("" on success). Safety invariants are checked by the Sim after every
// single step; here we additionally assert eventual convergence.
func runHistory(initialLeader string, masks []int) (string, *Sim) {
	s := NewSim("n1", "n2", "n3")

	// Setup: a committed entry before any partition.
	s.StartElection(initialLeader)
	if !s.RunUntilIdle(idleCap) {
		return "setup election never quiesced", s
	}
	s.Propose(initialLeader, "init")
	if !s.RunUntilIdle(idleCap) {
		return "setup replication never quiesced", s
	}

	// One phase per mask: apply the partition, let one rotating challenger
	// campaign, then let every node that still believes it is leader
	// (including a partitioned old leader) try to replicate a write.
	for phase, mask := range masks {
		applyMask(s, mask)
		challenger := s.ids[(phase+1)%len(s.ids)]
		s.StartElection(challenger)
		if !s.RunUntilIdle(idleCap) {
			return fmt.Sprintf("phase %d: election never quiesced", phase), s
		}
		for _, id := range s.ids {
			if s.Node(id).Role() == Leader {
				s.Propose(id, fmt.Sprintf("p%d-%s", phase, id))
				if !s.RunUntilIdle(idleCap) {
					return fmt.Sprintf("phase %d: replication never quiesced", phase), s
				}
			}
		}
	}

	// Heal everything; a correct protocol must converge to one log with
	// the committed prefix intact.
	s.HealAll()
	converged := false
	for try := 0; try < 50 && !converged; try++ {
		best := mostUpToDate(s)
		s.StartElection(best)
		if !s.RunUntilIdle(idleCap) {
			return "final election never quiesced", s
		}
		if s.Node(best).Role() != Leader {
			continue // outbid by a higher term elsewhere; retry
		}
		s.Propose(best, "final")
		if !s.RunUntilIdle(idleCap) {
			return "final replication never quiesced", s
		}
		n := s.Node(best)
		converged = n.Role() == Leader && n.CommitIndex() == len(n.Log())
	}
	if !converged {
		return "no stable leader with fully committed log after healing", s
	}

	ref := FormatLog(s.Node(mostUpToDate(s)).Log())
	for _, id := range s.ids {
		n := s.Node(id)
		if got := FormatLog(n.Log()); got != ref {
			return fmt.Sprintf("logs diverged after healing: %s=%s want %s", id, got, ref), s
		}
		if n.CommitIndex() != len(n.Log()) {
			return fmt.Sprintf("%s commitIndex=%d but log len=%d after healing", id, n.CommitIndex(), len(n.Log())), s
		}
	}
	if v := s.Violations(); len(v) > 0 {
		return "safety violations: " + strings.Join(v, "; "), s
	}
	return "", s
}

// TestEnumerateShortPartitionHistories exhaustively enumerates every
// partition history of length 1..4 over the 3 undirected links (8 possible
// cut masks per phase), for each choice of initial leader: 3 x (8 + 64 +
// 512 + 4096) = 14040 histories. Every message step of every history is
// checked against the safety invariants (monotonic terms, immutable
// committed prefix), and each history must converge after healing.
func TestEnumerateShortPartitionHistories(t *testing.T) {
	const maxLen = 4
	total, truncHistories, commits := 0, 0, 0
	for _, leader := range []string{"n1", "n2", "n3"} {
		for length := 1; length <= maxLen; length++ {
			masks := make([]int, length)
			var rec func(pos int)
			rec = func(pos int) {
				if pos == length {
					total++
					fail, s := runHistory(leader, masks)
					if fail != "" {
						for _, line := range s.Trace {
							t.Log(line)
						}
						t.Fatalf("leader=%s masks=%v: %s", leader, masks, fail)
					}
					if s.Truncations > 0 {
						truncHistories++
					}
					commits += len(s.Evidence)
					return
				}
				for m := 0; m < (1 << len(links)); m++ {
					masks[pos] = m
					rec(pos + 1)
				}
			}
			rec(0)
		}
	}
	t.Logf("enumerated %d partition histories (3 initial leaders, lengths 1..%d, %d masks/phase)",
		total, maxLen, 1<<len(links))
	t.Logf("histories exercising uncommitted-conflict truncation: %d", truncHistories)
	t.Logf("total majority-backed commits witnessed: %d", commits)
	if truncHistories == 0 {
		t.Fatal("enumeration never exercised old-leader conflict truncation")
	}
}
