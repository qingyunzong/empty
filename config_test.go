package logparse

import (
	"errors"
	"testing"
)

func TestAliasChainResolvesToFinalKey(t *testing.T) {
	c := NewConfig()
	mustAlias(t, c, "host", "server")
	mustAlias(t, c, "server", "srv")
	for in, want := range map[string]string{
		"host":   "srv",
		"server": "srv",
		"srv":    "srv",
		"other":  "other",
	} {
		if got := c.Canonical(in); got != want {
			t.Fatalf("Canonical(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAliasCycleRejected(t *testing.T) {
	c := NewConfig()
	mustAlias(t, c, "a", "b")
	mustAlias(t, c, "b", "c")
	if err := c.SetAlias("c", "a"); !errors.Is(err, ErrAliasCycle) {
		t.Fatalf("SetAlias(c,a) err = %v, want ErrAliasCycle", err)
	}
	if err := c.SetAlias("x", "x"); !errors.Is(err, ErrAliasCycle) {
		t.Fatalf("self alias err = %v, want ErrAliasCycle", err)
	}
	// Longer cycle through an intermediate chain.
	mustAlias(t, c, "d", "a")
	if err := c.SetAlias("c", "d"); !errors.Is(err, ErrAliasCycle) {
		t.Fatalf("SetAlias(c,d) err = %v, want ErrAliasCycle", err)
	}
}

func TestAliasRepointAndRemove(t *testing.T) {
	c := NewConfig()
	mustAlias(t, c, "a", "b")
	mustAlias(t, c, "a", "c") // re-point allowed
	if got := c.Canonical("a"); got != "c" {
		t.Fatalf("Canonical(a) = %q, want c", got)
	}
	c.RemoveAlias("a")
	if got := c.Canonical("a"); got != "a" {
		t.Fatalf("after RemoveAlias Canonical(a) = %q, want a", got)
	}
	if err := c.SetAlias("", "x"); !errors.Is(err, ErrEmptyAlias) {
		t.Fatalf("empty from err = %v, want ErrEmptyAlias", err)
	}
	if err := c.SetAlias("x", ""); !errors.Is(err, ErrEmptyAlias) {
		t.Fatalf("empty to err = %v, want ErrEmptyAlias", err)
	}
}

func TestCloneIsIndependent(t *testing.T) {
	c := NewConfig()
	mustAlias(t, c, "a", "b")
	n := c.Clone()
	mustAlias(t, n, "b", "c")
	if got := c.Canonical("a"); got != "b" {
		t.Fatalf("original mutated by clone: Canonical(a) = %q, want b", got)
	}
	if got := n.Canonical("a"); got != "c" {
		t.Fatalf("clone Canonical(a) = %q, want c", got)
	}
}

func TestDuplicatePolicyUsesCanonicalKey(t *testing.T) {
	c := NewConfig()
	mustAlias(t, c, "host", "server")
	p := NewParser(c)
	p.Feed([]byte("host=1 server=2 HOSTX=3 host=3\n"))
	p.Close()
	vals := p.Values()
	got := vals["server"]
	want := []string{"1", "2", "3"}
	if len(got) != len(want) {
		t.Fatalf("Values()[server] = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Values()[server] = %v, want %v", got, want)
		}
	}
	if _, ok := vals["host"]; ok {
		t.Fatalf("alias key should not appear in Values(): %v", vals)
	}
}

func mustAlias(t *testing.T, c *Config, from, to string) {
	t.Helper()
	if err := c.SetAlias(from, to); err != nil {
		t.Fatalf("SetAlias(%q,%q): %v", from, to, err)
	}
}
