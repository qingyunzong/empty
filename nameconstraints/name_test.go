package nameconstraints

import (
	"errors"
	"net"
	"testing"
)

func TestNormalizeDNS(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "Example.TEST", want: "example.test"},
		{in: "a.Example.test.", want: "a.example.test"},
		{in: "example.test..", wantErr: true},
		{in: "*.example.test", wantErr: true},
		{in: "*.example", wantErr: true},
		{in: "exämple.test", wantErr: true},
		{in: ".example.test", wantErr: true},
		{in: ".example.test.", wantErr: true},
		{in: "", wantErr: true},
		{in: "a..b.test", wantErr: true},
	}
	for _, tc := range cases {
		name, err := NewDNSName(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("NewDNSName(%q) = %q, want error", tc.in, name.dns)
			}
			continue
		}
		if err != nil {
			t.Fatalf("NewDNSName(%q) unexpected error: %v", tc.in, err)
		}
		if name.dns != tc.want {
			t.Fatalf("NewDNSName(%q) = %q, want %q", tc.in, name.dns, tc.want)
		}
	}
}

func TestDNSConstraintLeadingDotBoundary(t *testing.T) {
	plain := mustDNSConstraint(t, "example.test")
	leading := mustDNSConstraint(t, ".example.test")

	cases := []struct {
		name  string
		plain bool
		dot   bool
	}{
		{"example.test", true, false},
		{"a.example.test", true, true},
		{"a.b.example.test", true, true},
		{"notexample.test", false, false},
		{"evil-example.test", false, false},
	}
	for _, tc := range cases {
		n := mustDNSName(t, tc.name)
		if got := plain.matches(n); got != tc.plain {
			t.Errorf("plain constraint matches %q = %v, want %v", tc.name, got, tc.plain)
		}
		if got := leading.matches(n); got != tc.dot {
			t.Errorf("leading-dot constraint matches %q = %v, want %v", tc.name, got, tc.dot)
		}
	}
}

func TestTrailingDotEquivalence(t *testing.T) {
	c := mustDNSConstraint(t, "example.test.")
	for _, raw := range []string{"example.test", "example.test.", "EXAMPLE.TEST."} {
		n, err := NewDNSName(raw)
		if err != nil {
			t.Fatalf("NewDNSName(%q): %v", raw, err)
		}
		if !c.matches(n) {
			t.Errorf("constraint %q did not match SAN %q", c.String(), raw)
		}
	}
}

func TestIPConstraintFamilies(t *testing.T) {
	v4 := mustIPConstraint(t, "10.0.0.0/8")
	v6 := mustIPConstraint(t, "2001:db8::/32")

	cases := []struct {
		address string
		v4      bool
		v6      bool
	}{
		{"10.255.255.255", true, false},
		{"11.0.0.1", false, false},
		{"2001:db8:dead::1", false, true},
		{"2001:db9::1", false, false},
		// ::ffff:0a00:0001 must behave as IPv4 and not match the v6 prefix.
		{"::ffff:10.0.0.1", true, false},
	}
	for _, tc := range cases {
		n, err := NewIPName(tc.address)
		if err != nil {
			t.Fatalf("NewIPName(%q): %v", tc.address, err)
		}
		if got := v4.matches(n); got != tc.v4 {
			t.Errorf("v4 constraint matches %q = %v, want %v", tc.address, got, tc.v4)
		}
		if got := v6.matches(n); got != tc.v6 {
			t.Errorf("v6 constraint matches %q = %v, want %v", tc.address, got, tc.v6)
		}
	}
}

func TestArbitraryPrefixAndNonContiguousMask(t *testing.T) {
	c := mustIPConstraint(t, "192.168.1.128/25")
	n := mustIPName(t, "192.168.1.200")
	if !c.matches(n) {
		t.Fatalf("/25 prefix should contain 192.168.1.200")
	}
	if c.matches(mustIPName(t, "192.168.1.100")) {
		t.Fatalf("/25 prefix must not contain 192.168.1.100")
	}

	// /0 constrains every address of its family but not the other family.
	anyV4 := mustIPConstraint(t, "0.0.0.0/0")
	if !anyV4.matches(mustIPName(t, "8.8.8.8")) {
		t.Fatalf("0.0.0.0/0 must contain every IPv4 address")
	}
	if anyV4.matches(mustIPName(t, "2001:db8::1")) {
		t.Fatalf("IPv4 /0 must not match IPv6")
	}

	if _, err := ConstraintFromIPNet(&net.IPNet{
		IP:   net.IPv4(10, 0, 0, 0),
		Mask: net.IPv4Mask(255, 0, 255, 0),
	}); err == nil {
		t.Fatal("non-contiguous mask must be rejected")
	}
}

func TestNameTypeMismatch(t *testing.T) {
	c := mustDNSConstraint(t, "example.test")
	if c.matches(mustIPName(t, "10.0.0.1")) {
		t.Fatal("DNS constraint cannot match an IP name")
	}
	// Only CAs listing DNS as permitted restrict DNS; the IP type stays
	// unconstrained and passes even though a DNS constraint exists.
	set := NewSet()
	set.AddCA([]Constraint{c}, nil)
	if err := set.CheckNames([]Name{mustIPName(t, "10.0.0.1")}); err != nil {
		t.Fatalf("unlisted IP type must be unconstrained: %v", err)
	}

	// A DNS SAN under the same set still fails and yields a NameError.
	err := set.CheckNames([]Name{mustDNSName(t, "other.test")})
	var nameErr *NameError
	if !errors.As(err, &nameErr) {
		t.Fatalf("expected *NameError, got %v", err)
	}
}

func mustDNSName(t *testing.T, s string) Name {
	t.Helper()
	n, err := NewDNSName(s)
	if err != nil {
		t.Fatalf("NewDNSName(%q): %v", s, err)
	}
	return n
}

func mustIPName(t *testing.T, s string) Name {
	t.Helper()
	n, err := NewIPName(s)
	if err != nil {
		t.Fatalf("NewIPName(%q): %v", s, err)
	}
	return n
}

func mustDNSConstraint(t *testing.T, s string) Constraint {
	t.Helper()
	c, err := NewDNSConstraint(s)
	if err != nil {
		t.Fatalf("NewDNSConstraint(%q): %v", s, err)
	}
	return c
}

func mustIPConstraint(t *testing.T, s string) Constraint {
	t.Helper()
	c, err := NewIPConstraint(s)
	if err != nil {
		t.Fatalf("NewIPConstraint(%q): %v", s, err)
	}
	return c
}
