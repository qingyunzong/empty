package repsim

import (
	"fmt"
	"strings"
)

// CommitCertificate is the arbitration proof emitted for every committed
// entry: which configuration arbitrated the commit and which voters
// formed the required majority (both majorities under a joint config).
type CommitCertificate struct {
	Index      int
	Term       int
	Kind       EntryKind
	Membership Membership // configuration used to arbitrate this commit
	Voters     []string   // sorted voters that had replicated the entry
	OldQuorum  []string   // Voters ∩ Old; majority of Old
	NewQuorum  []string   // Voters ∩ New; majority of New, empty unless joint
}

// Verify checks that the certificate's quorums are genuine majorities of
// the arbitrating membership. Under a joint membership both sides must be
// satisfied; an uncommitted new set can never arbitrate on its own.
func (c CommitCertificate) Verify() error {
	m := c.Membership
	if len(m.Old) == 0 {
		return fmt.Errorf("cert #%d: empty old configuration", c.Index)
	}
	if got := countIn(m.Old, c.OldQuorum); got < majority(len(m.Old)) {
		return fmt.Errorf("cert #%d: old quorum %v is not a majority of %v", c.Index, c.OldQuorum, m.Old)
	}
	if m.Joint() {
		if got := countIn(m.New, c.NewQuorum); got < majority(len(m.New)) {
			return fmt.Errorf("cert #%d: new quorum %v is not a majority of joint new set %v", c.Index, c.NewQuorum, m.New)
		}
	} else if len(c.NewQuorum) != 0 {
		return fmt.Errorf("cert #%d: unexpected new quorum under non-joint config", c.Index)
	}
	if !c.Membership.QuorumSatisfied(c.Voters) {
		return fmt.Errorf("cert #%d: voters %v do not satisfy %v", c.Index, c.Voters, m)
	}
	return nil
}

func (c CommitCertificate) String() string {
	m := c.Membership
	if m.Joint() {
		return fmt.Sprintf("cert{idx=%d term=%d kind=%v joint old=%v new=%v oldQuorum=%v newQuorum=%v}",
			c.Index, c.Term, c.Kind, m.Old, m.New, c.OldQuorum, c.NewQuorum)
	}
	return fmt.Sprintf("cert{idx=%d term=%d kind=%v members=%v quorum=%v}",
		c.Index, c.Term, c.Kind, m.Old, c.OldQuorum)
}

// CheckTrace verifies the safety invariants of a commit-certificate trace:
//
//  1. every commit is backed by a valid dual-majority certificate;
//  2. commits are contiguous starting at index 1;
//  3. configuration entries apply in order — joint first, then final —
//     and arbitration switches to the new set alone only after the final
//     configuration entry has committed;
//  4. while a joint configuration is in effect, no entry commits without
//     a majority of both sides (an uncommitted new set cannot advance alone).
func CheckTrace(certs []CommitCertificate, initial Membership) error {
	if initial.Joint() {
		return fmt.Errorf("initial membership must be a single configuration")
	}
	current := Membership{Old: sortedCopy(initial.Old)}
	seenJoint := false
	seenFinal := false
	sameConfig := func(m Membership) bool {
		return keyOf(m.Old) == keyOf(current.Old) && m.Joint() == current.Joint() &&
			(!current.Joint() || keyOf(m.New) == keyOf(current.New))
	}
	for i, c := range certs {
		if c.Index != i+1 {
			return fmt.Errorf("commit trace gap: expected index %d, got %d", i+1, c.Index)
		}
		if err := c.Verify(); err != nil {
			return err
		}
		switch c.Kind {
		case KindJoint:
			// The joint entry is itself arbitrated by the joint
			// configuration it installs (dual majority).
			if seenJoint {
				return fmt.Errorf("cert #%d: duplicate joint configuration committed", c.Index)
			}
			if !c.Membership.Joint() || keyOf(c.Membership.Old) != keyOf(current.Old) {
				return fmt.Errorf("cert #%d: joint config %v does not extend %v", c.Index, c.Membership, current)
			}
			seenJoint = true
			current = c.Membership
		case KindFinal:
			// The final entry is arbitrated by the new set alone and
			// installs it as the single configuration.
			if !seenJoint {
				return fmt.Errorf("cert #%d: final configuration committed before any joint configuration", c.Index)
			}
			if seenFinal {
				return fmt.Errorf("cert #%d: duplicate final configuration committed", c.Index)
			}
			if c.Membership.Joint() || keyOf(c.Membership.Old) != keyOf(current.New) {
				return fmt.Errorf("cert #%d: final config %v does not match joint new set %v", c.Index, c.Membership, current.New)
			}
			seenFinal = true
			current = Membership{Old: sortedCopy(c.Membership.Old)}
		default:
			if !sameConfig(c.Membership) {
				return fmt.Errorf("cert #%d: arbitrated by %v, but configuration in effect is %v",
					c.Index, c.Membership, current)
			}
		}
	}
	return nil
}

// TraceText renders the recorded events and certificates for inspection.
func (s *Sim) TraceText() string {
	var b strings.Builder
	for _, ev := range s.Events {
		fmt.Fprintf(&b, "event#%d %s node=%s index=%d %s\n", ev.Seq, ev.Kind, ev.Node, ev.Index, ev.Detail)
	}
	for _, c := range s.Certs {
		fmt.Fprintf(&b, "%s\n", c)
	}
	return b.String()
}
