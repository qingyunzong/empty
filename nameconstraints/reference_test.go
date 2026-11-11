package nameconstraints

import (
	"errors"
	"testing"
)

func dnsConstraints(t *testing.T, domains ...string) []Constraint {
	t.Helper()
	out := make([]Constraint, 0, len(domains))
	for _, d := range domains {
		out = append(out, mustDNSConstraint(t, d))
	}
	return out
}

func ipConstraints(t *testing.T, cidrs ...string) []Constraint {
	t.Helper()
	out := make([]Constraint, 0, len(cidrs))
	for _, c := range cidrs {
		out = append(out, mustIPConstraint(t, c))
	}
	return out
}

func TestSameCAUnion(t *testing.T) {
	set := NewSet()
	set.AddCA(dnsConstraints(t, "a.test", "b.test"), nil)

	for _, good := range []string{"a.test", "sub.a.test", "b.test", "x.b.test"} {
		if !set.Permits(mustDNSName(t, good)) {
			t.Errorf("same-CA union should permit %q", good)
		}
	}
	if set.Permits(mustDNSName(t, "c.test")) {
		t.Error("name outside both permitted sets must be rejected")
	}
}

func TestDifferentCAIntersection(t *testing.T) {
	set := NewSet()
	set.AddCA(dnsConstraints(t, "a.test", "b.test"), nil)
	set.AddCA(dnsConstraints(t, "b.test", "c.test"), nil)

	if !set.Permits(mustDNSName(t, "b.test")) {
		t.Error("b.test lies in both CA sets and must pass the intersection")
	}
	for _, bad := range []string{"a.test", "c.test", "sub.a.test"} {
		if set.Permits(mustDNSName(t, bad)) {
			t.Errorf("%q is in only one CA set and must fail the intersection", bad)
		}
	}
}

func TestEmptyIntersection(t *testing.T) {
	set := NewSet()
	set.AddCA(dnsConstraints(t, "a.test"), nil)
	set.AddCA(dnsConstraints(t, "b.test"), nil)

	if set.Permits(mustDNSName(t, "a.test")) {
		t.Error("a.test fails the second CA permitted set")
	}
	if set.Permits(mustDNSName(t, "b.test")) {
		t.Error("b.test fails the first CA permitted set")
	}

	// The same scenario through the reference walk must report the leaf failure.
	chain := []ChainEntry{
		{Permitted: dnsConstraints(t, "a.test")},
		{Permitted: dnsConstraints(t, "b.test")},
		{SANs: []Name{mustDNSName(t, "a.test")}},
	}
	if _, err := EvaluateChain(chain); err == nil {
		t.Fatal("empty intersection must reject the leaf SAN")
	}
}

func TestMultipleSANsAllMustPass(t *testing.T) {
	set := NewSet()
	set.AddCA(
		append(dnsConstraints(t, "example.test"), ipConstraints(t, "10.0.0.0/8")...),
		nil,
	)

	err := set.CheckNames([]Name{
		mustDNSName(t, "api.example.test"),
		mustIPName(t, "10.1.2.3"),
	})
	if err != nil {
		t.Fatalf("all SANs valid: %v", err)
	}

	err = set.CheckNames([]Name{
		mustDNSName(t, "api.example.test"),
		mustIPName(t, "192.0.2.1"),
	})
	if err == nil {
		t.Fatal("one bad SAN must fail the whole leaf")
	}

	// Both violations should be reported together.
	err = set.CheckNames([]Name{
		mustDNSName(t, "api.other.test"),
		mustIPName(t, "192.0.2.1"),
	})
	var joined interface{ Unwrap() []error }
	if !errors.As(err, &joined) || len(joined.Unwrap()) != 2 {
		t.Fatalf("expected two joined failures, got %v", err)
	}
}

func TestMixedAddressFamilies(t *testing.T) {
	permitted := NewSet()
	permitted.AddCA(ipConstraints(t, "10.0.0.0/8", "2001:db8::/32"), nil)

	cases := []struct {
		name string
		want bool
	}{
		{"10.255.0.5", true},
		{"11.0.0.5", false},
		{"2001:db8:1::1", true},
		{"2001:db9:1::1", false},
	}
	for _, tc := range cases {
		got := permitted.Permits(mustIPName(t, tc.name))
		if got != tc.want {
			t.Errorf("Permits(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}

	// Exclusions accumulate by union, including the boundary prefix /16.
	excluded := NewSet()
	excluded.AddCA(ipConstraints(t, "10.0.0.0/8", "2001:db8::/32"), ipConstraints(t, "10.20.0.0/16"))
	if excluded.Permits(mustIPName(t, "10.20.0.5")) {
		t.Error("10.20.0.5 must match the excluded /16")
	}
	if !excluded.Permits(mustIPName(t, "10.10.0.5")) {
		t.Error("10.10.0.5 is outside the excluded /16 and within permitted /8")
	}

	// A CA that constrains only IPv4 must not constrain IPv6.
	onlyV4 := NewSet()
	onlyV4.AddCA(ipConstraints(t, "10.0.0.0/8"), nil)
	if !onlyV4.Permits(mustIPName(t, "2001:db8::1")) {
		t.Fatal("IPv6 must stay unconstrained when only IPv4 is listed")
	}
}

func TestExcludedAccumulatesAcrossCAs(t *testing.T) {
	set := NewSet()
	set.AddCA(dnsConstraints(t, "example.test"), dnsConstraints(t, "bad.example.test"))
	set.AddCA(nil, dnsConstraints(t, "worse.example.test"))

	if !set.Permits(mustDNSName(t, "ok.example.test")) {
		t.Error("unexcluded subdomain must pass")
	}
	for _, bad := range []string{"bad.example.test", "worse.example.test", "deep.worse.example.test"} {
		if set.Permits(mustDNSName(t, bad)) {
			t.Errorf("excluded name %q must be rejected by accumulated union", bad)
		}
	}
}

func TestUnlistedTypeUnconstrained(t *testing.T) {
	set := NewSet()
	set.AddCA(dnsConstraints(t, "example.test"), nil)
	if !set.Permits(mustIPName(t, "8.8.8.8")) {
		t.Error("IP must be unconstrained when only DNS is permitted")
	}
}

func TestIPv4AndIPv6IntersectIndependently(t *testing.T) {
	set := NewSet()
	set.AddCA(ipConstraints(t, "10.0.0.0/8", "2001:db8::/32"), nil)
	set.AddCA(ipConstraints(t, "10.20.0.0/16"), nil)

	// IPv6 is constrained only by the first CA, so its prefix stays open.
	if !set.Permits(mustIPName(t, "2001:db8:abcd::1")) {
		t.Error("IPv6 must pass: the second CA does not list IPv6 constraints")
	}
	// IPv4 takes the intersection of the two CAs, i.e. the /16.
	if !set.Permits(mustIPName(t, "10.20.9.9")) {
		t.Error("10.20.9.9 lies in both IPv4 prefixes")
	}
	if set.Permits(mustIPName(t, "10.21.0.1")) {
		t.Error("10.21.0.1 fails the second CA's /16")
	}
}

func TestSelfIssuedIntermediateSkipsNameCheckButAppliesConstraints(t *testing.T) {
	// Root only permits example.test. The self-issued intermediate carries
	// names that would fail the root constraint and a tighter permitted set
	// of sub.example.test; its name check is skipped but its constraints
	// still apply.
	chain := []ChainEntry{
		{Permitted: dnsConstraints(t, "example.test")},
		{
			Permitted:  dnsConstraints(t, "sub.example.test"),
			SANs:       []Name{mustDNSName(t, "outside.example.test")},
			SelfIssued: true,
		},
		{SANs: []Name{mustDNSName(t, "host.sub.example.test")}},
	}
	set, err := EvaluateChain(chain)
	if err != nil {
		t.Fatalf("self-issued intermediate must skip its own name check: %v", err)
	}
	if set.Permits(mustDNSName(t, "other.example.test")) {
		t.Error("self-issued intermediate constraints must still be applied")
	}
}

func TestSelfIssuedLeafCannotSkip(t *testing.T) {
	chain := []ChainEntry{
		{Permitted: dnsConstraints(t, "example.test")},
		{
			Permitted:  dnsConstraints(t, "example.test"),
			SANs:       []Name{mustDNSName(t, "forbidden.other.test")},
			SelfIssued: true, // must be ignored because this is the leaf
		},
	}
	if _, err := EvaluateChain(chain); err == nil {
		t.Fatal("self-issued leaf must never skip the name check")
	}
}

func TestStepwiseReferenceMatchesOneShot(t *testing.T) {
	leafSANs := []Name{mustDNSName(t, "host.sub.example.test")}
	oneShot, err := EvaluateChain([]ChainEntry{
		{Permitted: dnsConstraints(t, "example.test")},
		{Permitted: dnsConstraints(t, ".example.test"), SANs: leafSANs},
	})
	if err != nil {
		t.Fatalf("one-shot evaluation: %v", err)
	}

	v := NewReferenceValidator()
	if err := v.ApplyCA(ChainEntry{Permitted: dnsConstraints(t, "example.test")}, false); err != nil {
		t.Fatal(err)
	}
	if err := v.ApplyCA(ChainEntry{
		Permitted: dnsConstraints(t, ".example.test"),
		SANs:      leafSANs,
	}, true); err != nil {
		t.Fatalf("stepwise evaluation: %v", err)
	}

	for _, n := range leafSANs {
		if oneShot.Permits(n) != v.Set().Permits(n) {
			t.Errorf("divergent decision for %q", n)
		}
	}
}
