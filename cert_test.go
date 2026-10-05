package licchk

import (
	"testing"
)

// certFixture builds a solved problem plus its valid certificate.
func certFixture(t *testing.T) (Problem, *Certificate) {
	t.Helper()
	p := Problem{
		Packages: map[string]Expr{
			"app":  mustExpr(t, "MIT"),
			"liba": mustExpr(t, "MIT OR Apache-2.0"),
			"libb": mustExpr(t, "BSD-3-Clause"),
			"bad":  mustExpr(t, "GPL-3.0"),
			"evil": mustExpr(t, "GPL-3.0"), // unreachable
		},
		Graph: Graph{
			"app":  {"liba", "libb", "bad"},
			"liba": {"libb"},
			"libb": {"app"}, // cycle back to the entry
		},
		Entry:  "app",
		Policy: Policy{Forbidden: []string{"GPL-3.0"}},
	}
	cert, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if err := cert.Verify(p); err != nil {
		t.Fatalf("baseline Verify: %v", err)
	}
	return p, cert
}

func cloneCert(c *Certificate) *Certificate {
	out := &Certificate{
		Entry:      c.Entry,
		Reachable:  append([]string(nil), c.Reachable...),
		Choices:    map[string]int{},
		Selected:   map[string]Option{},
		Exceptions: append([]string(nil), c.Exceptions...),
	}
	for k, v := range c.Choices {
		out.Choices[k] = v
	}
	for k, v := range c.Selected {
		out.Selected[k] = append(Option(nil), v...)
	}
	return out
}

func TestCertificateValid(t *testing.T) {
	p, cert := certFixture(t)
	if cert.NumExceptions() != 1 || cert.Exceptions[0] != "bad" {
		t.Fatalf("exceptions = %v, want [bad]", cert.Exceptions)
	}
	if err := cert.Verify(p); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestCertificateRejectsTampering(t *testing.T) {
	p, good := certFixture(t)

	cases := map[string]func(*Certificate){
		"wrong entry": func(c *Certificate) { c.Entry = "other" },
		"extra reachable": func(c *Certificate) {
			c.Reachable = append(c.Reachable, "evil")
		},
		"missing reachable": func(c *Certificate) {
			c.Reachable = c.Reachable[1:]
		},
		"drop exception": func(c *Certificate) {
			c.Exceptions = c.Exceptions[:0]
		},
		"exception also chosen": func(c *Certificate) {
			c.Choices["bad"] = 0
			c.Selected["bad"] = Option{"GPL-3.0"}
		},
		"choice index out of range": func(c *Certificate) {
			c.Choices["liba"] = 99
		},
		"selected mismatch": func(c *Certificate) {
			c.Selected["liba"] = Option{"GPL-3.0"}
		},
		"selected missing": func(c *Certificate) {
			delete(c.Selected, "liba")
		},
		"selected extra": func(c *Certificate) {
			c.Selected["bad"] = Option{"GPL-3.0"}
		},
		"unreachable package chosen": func(c *Certificate) {
			c.Choices["evil"] = 0
			c.Selected["evil"] = Option{"GPL-3.0"}
		},
		"unsorted exceptions": func(c *Certificate) {
			c.Exceptions = append(c.Exceptions, "aaa")
			// keep unsorted: "aaa" after "bad" is unsorted
		},
		"duplicate exception": func(c *Certificate) {
			c.Exceptions = append(c.Exceptions, "bad")
		},
	}
	for name, mutate := range cases {
		c := cloneCert(good)
		mutate(c)
		if err := c.Verify(p); err == nil {
			t.Errorf("%s: expected Verify to fail, got nil", name)
		}
	}
}

func TestCertificateRejectsViolatingChoice(t *testing.T) {
	// Forge a certificate that picks a forbidden branch and check that
	// Verify catches the policy violation.
	p := Problem{
		Packages: map[string]Expr{
			"app": mustExpr(t, "MIT OR GPL-3.0"),
		},
		Graph:  Graph{"app": {}},
		Entry:  "app",
		Policy: Policy{Forbidden: []string{"GPL-3.0"}},
	}
	forged := &Certificate{
		Entry:      "app",
		Reachable:  []string{"app"},
		Choices:    map[string]int{"app": 1}, // the GPL-3.0 branch
		Selected:   map[string]Option{"app": {"GPL-3.0"}},
		Exceptions: nil,
	}
	if err := forged.Verify(p); err == nil {
		t.Fatalf("expected Verify to reject forbidden license choice")
	}
}

func TestCertificateRejectsIncompatiblePair(t *testing.T) {
	p := Problem{
		Packages: map[string]Expr{
			"a": mustExpr(t, "MIT"),
			"b": mustExpr(t, "GPL-2.0"),
		},
		Graph:  Graph{"a": {"b"}},
		Entry:  "a",
		Policy: Policy{Incompatible: [][2]string{{"MIT", "GPL-2.0"}}},
	}
	forged := &Certificate{
		Entry:      "a",
		Reachable:  []string{"a", "b"},
		Choices:    map[string]int{"a": 0, "b": 0},
		Selected:   map[string]Option{"a": {"MIT"}, "b": {"GPL-2.0"}},
		Exceptions: nil,
	}
	if err := forged.Verify(p); err == nil {
		t.Fatalf("expected Verify to reject incompatible pair")
	}
}
