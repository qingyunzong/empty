package rulecheck

import (
	"strings"
	"testing"
)

func diagRules() []Rule {
	return []Rule{
		{ID: "cover", Include: "x/*/**"},                               // (1 lit, 3 seg)
		{ID: "shadowed", Include: "x/*"},                               // covered by cover
		{ID: "partial", Include: "a/**"},                               // reachable
		{ID: "selfempty", Include: "s/**", Excludes: []string{"s/**"}}, // empty by itself
		{ID: "base", Include: "**"},                                    // reachable via short paths
	}
}

func findDiag(diags []Diagnosis, id string) Diagnosis {
	for _, d := range diags {
		if d.RuleID == id {
			return d
		}
	}
	return Diagnosis{RuleID: id}
}

func TestDiagnose(t *testing.T) {
	rules := diagRules()
	lib, err := NewLibrary(rules)
	if err != nil {
		t.Fatalf("NewLibrary: %v", err)
	}
	diags := lib.Diagnose()
	if len(diags) != len(rules) {
		t.Fatalf("expected %d diagnoses, got %d", len(rules), len(diags))
	}

	// cover: no higher-priority rules, reachable; shortest path is 2 segments.
	d := findDiag(diags, "cover")
	if !d.Reachable || len(d.Witness) != 2 || d.Witness[0] != "x" {
		t.Errorf("cover: %+v", d)
	}

	// shadowed: x/* is fully covered by x/*/**.
	d = findDiag(diags, "shadowed")
	if d.Reachable {
		t.Errorf("shadowed should be unreachable, witness=%v", d.Witness)
	}
	if d.Cert == nil || d.Cert.SelfEmpty {
		t.Errorf("shadowed: bad cert %+v", d.Cert)
	}
	if len(d.Cert.ShadowedBy) != 1 || d.Cert.ShadowedBy[0] != "cover" {
		t.Errorf("shadowed: ShadowedBy=%v, want [cover]", d.Cert.ShadowedBy)
	}
	if d.Cert.Explored <= 0 {
		t.Errorf("shadowed: certificate should record explored states")
	}
	if !d.Cert.Verify(lib) {
		t.Errorf("shadowed: certificate does not verify")
	}

	// selfempty: include minus excludes is already empty.
	d = findDiag(diags, "selfempty")
	if d.Reachable || d.Cert == nil || !d.Cert.SelfEmpty {
		t.Errorf("selfempty: %+v", d)
	}
	if !d.Cert.Verify(lib) {
		t.Errorf("selfempty: certificate does not verify")
	}

	// partial: shortest winning path is ["a"].
	d = findDiag(diags, "partial")
	if !d.Reachable || len(d.Witness) != 1 || d.Witness[0] != "a" {
		t.Errorf("partial: %+v", d)
	}

	// base (**): the empty path matches no higher rule, so witness is empty.
	d = findDiag(diags, "base")
	if !d.Reachable || len(d.Witness) != 0 {
		t.Errorf("base: %+v", d)
	}
}

// TestWitnessAgainstEnumeration cross-checks diagnoses with brute force:
// a rule is reachable iff some short path selects it, and the witness length
// equals the shortest such path found by enumeration.
func TestWitnessAgainstEnumeration(t *testing.T) {
	rules := diagRules()
	lib, err := NewLibrary(rules)
	if err != nil {
		t.Fatalf("NewLibrary: %v", err)
	}
	m := lib.Matcher()
	diags := lib.Diagnose()

	shortest := map[string]int{}
	found := map[string]bool{}
	for _, segs := range enumeratePaths([]string{"x", "a", "s", "zz"}, 4) {
		d, err := m.MatchNoCache(pathString(segs))
		if err != nil {
			t.Fatal(err)
		}
		if !d.Matched {
			continue
		}
		if !found[d.RuleID] {
			found[d.RuleID] = true
			shortest[d.RuleID] = len(segs)
		}
	}

	for _, diag := range diags {
		if diag.Reachable != found[diag.RuleID] {
			t.Errorf("rule %s: diagnosis reachable=%v, enumeration found=%v",
				diag.RuleID, diag.Reachable, found[diag.RuleID])
			continue
		}
		if !diag.Reachable {
			continue
		}
		if len(diag.Witness) != shortest[diag.RuleID] {
			t.Errorf("rule %s: witness length %d, enumeration shortest %d",
				diag.RuleID, len(diag.Witness), shortest[diag.RuleID])
		}
		// The witness itself must select this rule.
		d, err := m.MatchNoCache(strings.Join(diag.Witness, "/"))
		if err != nil {
			t.Fatal(err)
		}
		if d.RuleID != diag.RuleID {
			t.Errorf("rule %s: witness %v selects %q instead", diag.RuleID, diag.Witness, d.RuleID)
		}
	}
}

func TestCertificateRejectsForgery(t *testing.T) {
	rules := diagRules()
	lib, err := NewLibrary(rules)
	if err != nil {
		t.Fatalf("NewLibrary: %v", err)
	}
	// partial is reachable: an emptiness certificate for it must not verify.
	forged := &EmptyCertificate{RuleID: "partial", ShadowedBy: []string{"cover"}}
	if forged.Verify(lib) {
		t.Error("forged certificate for reachable rule verified")
	}
	// Incomplete cover: shadowed minus nothing is not empty.
	incomplete := &EmptyCertificate{RuleID: "shadowed"}
	if incomplete.Verify(lib) {
		t.Error("certificate with missing shadower verified")
	}
	// A shadower that is not more specific must be rejected.
	bad := &EmptyCertificate{RuleID: "cover", ShadowedBy: []string{"shadowed"}}
	if bad.Verify(lib) {
		t.Error("certificate listing a lower-priority shadower verified")
	}
	// Unknown rule.
	if (&EmptyCertificate{RuleID: "nope"}).Verify(lib) {
		t.Error("certificate for unknown rule verified")
	}
}
