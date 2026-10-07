package jointsim

import (
	"strings"
	"testing"
)

func TestCheckerRejectsNewSetOnlyCommit(t *testing.T) {
	joint := JointConfig([]string{"A", "B", "C"}, []string{"D", "E", "F"})
	trace := []Event{
		{Kind: EvConfigPropose, Joint: &joint, Target: []string{"D", "E", "F"}},
		// A certificate that only the (uncommitted) new set could produce.
		{Kind: EvCommit, Cert: &Certificate{
			Index:  1,
			Term:   1,
			Config: SimpleConfig([]string{"D", "E", "F"}),
			Voters: []string{"D", "E"},
		}},
	}
	err := CheckTrace(trace, []string{"A", "B", "C"})
	if err == nil || !strings.Contains(err.Error(), "stable config") {
		t.Fatalf("expected rejection of new-set-only commit, got %v", err)
	}
}

func TestCheckerRejectsMissingOldMajority(t *testing.T) {
	joint := JointConfig([]string{"A", "B", "C"}, []string{"D", "E", "F"})
	trace := []Event{
		{Kind: EvConfigPropose, Joint: &joint, Target: []string{"D", "E", "F"}},
		{Kind: EvCommit, Cert: &Certificate{
			Index:  1,
			Term:   1,
			Config: joint,
			Voters: []string{"A", "D", "E", "F"},
		}},
	}
	err := CheckTrace(trace, []string{"A", "B", "C"})
	if err == nil || !strings.Contains(err.Error(), "majority") {
		t.Fatalf("expected rejection for missing old majority, got %v", err)
	}
}

func TestCheckerRejectsJointCertAfterFinal(t *testing.T) {
	joint := JointConfig([]string{"A", "B", "C"}, []string{"A", "D", "E"})
	final := SimpleConfig([]string{"A", "D", "E"})
	trace := []Event{
		{Kind: EvConfigPropose, Joint: &joint, Target: []string{"A", "D", "E"}},
		{Kind: EvCommit, Cert: &Certificate{Index: 1, Term: 1, Config: joint, Voters: []string{"A", "B", "D", "E"}}},
		{Kind: EvConfigCommit, Joint: &joint, Target: []string{"A", "D", "E"}},
		{Kind: EvCommit, Cert: &Certificate{Index: 2, Term: 1, Config: joint, Voters: []string{"A", "B", "D", "E"}}},
		{Kind: EvConfigFinal, Target: []string{"A", "D", "E"}},
		{Kind: EvCommit, Cert: &Certificate{Index: 3, Term: 1, Config: final, Voters: []string{"A", "D"}}},
		// Joint rules must no longer be used once the final config committed.
		{Kind: EvCommit, Cert: &Certificate{Index: 4, Term: 1, Config: joint, Voters: []string{"A", "B", "D", "E"}}},
	}
	err := CheckTrace(trace, []string{"A", "B", "C"})
	if err == nil || !strings.Contains(err.Error(), "new set only") {
		t.Fatalf("expected rejection of joint cert after final, got %v", err)
	}
}

func TestCheckerRejectsNonMemberVoter(t *testing.T) {
	trace := []Event{
		{Kind: EvCommit, Cert: &Certificate{
			Index:  1,
			Term:   1,
			Config: SimpleConfig([]string{"A", "B", "C"}),
			Voters: []string{"A", "B", "ZZZ"},
		}},
	}
	if err := CheckTrace(trace, []string{"A", "B", "C"}); err == nil {
		t.Fatal("expected rejection of non-member voter")
	}
}

func TestCheckerRejectsMissingCertificate(t *testing.T) {
	trace := []Event{{Kind: EvCommit}}
	if err := CheckTrace(trace, []string{"A", "B", "C"}); err == nil {
		t.Fatal("expected rejection of commit without certificate")
	}
}

func TestCheckerRejectsFinalBeforeJoint(t *testing.T) {
	trace := []Event{
		{Kind: EvConfigPropose, Joint: &Config{}, Target: []string{"D", "E", "F"}},
		{Kind: EvConfigFinal, Target: []string{"D", "E", "F"}},
	}
	if err := CheckTrace(trace, []string{"A", "B", "C"}); err == nil {
		t.Fatal("expected rejection of final config before joint commit")
	}
}

func TestCheckerAcceptsValidTrace(t *testing.T) {
	joint := JointConfig([]string{"A", "B", "C"}, []string{"A", "D", "E"})
	final := SimpleConfig([]string{"A", "D", "E"})
	trace := []Event{
		{Kind: EvCommit, Cert: &Certificate{Index: 1, Term: 1, Config: SimpleConfig([]string{"A", "B", "C"}), Voters: []string{"A", "B"}}},
		{Kind: EvConfigPropose, Joint: &joint, Target: []string{"A", "D", "E"}},
		{Kind: EvCommit, Cert: &Certificate{Index: 2, Term: 1, Config: joint, Voters: []string{"A", "B", "D", "E"}}},
		{Kind: EvConfigCommit, Joint: &joint, Target: []string{"A", "D", "E"}},
		{Kind: EvCommit, Cert: &Certificate{Index: 3, Term: 1, Config: joint, Voters: []string{"A", "B", "D", "E"}}},
		{Kind: EvConfigFinal, Target: []string{"A", "D", "E"}},
		{Kind: EvCommit, Cert: &Certificate{Index: 4, Term: 1, Config: final, Voters: []string{"A", "D"}}},
	}
	if err := CheckTrace(trace, []string{"A", "B", "C"}); err != nil {
		t.Fatalf("valid trace rejected: %v", err)
	}
}
