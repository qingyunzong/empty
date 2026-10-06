package hdrclient

import (
	"net/netip"
	"testing"
)

func TestParseHostPortValid(t *testing.T) {
	cases := []struct {
		in      string
		addr    string
		port    uint16
		hasPort bool
	}{
		{"1.2.3.4", "1.2.3.4", 0, false},
		{"1.2.3.4:8080", "1.2.3.4", 8080, true},
		{" 1.2.3.4:0 ", "1.2.3.4", 0, true},
		{"::1", "::1", 0, false},
		{"2001:db8::ff00:42", "2001:db8::ff00:42", 0, false},
		{"[::1]", "::1", 0, false},
		{"[2001:db8::1]:443", "2001:db8::1", 443, true},
		{"::ffff:1.2.3.4", "::ffff:1.2.3.4", 0, false},
		{"[::ffff:1.2.3.4]:8443", "::ffff:1.2.3.4", 8443, true},
	}
	for _, c := range cases {
		hp, err := parseHostPort(c.in)
		if err != nil {
			t.Errorf("parseHostPort(%q) error: %v", c.in, err)
			continue
		}
		if hp.Addr != netip.MustParseAddr(c.addr) || hp.Port != c.port || hp.HasPort != c.hasPort {
			t.Errorf("parseHostPort(%q) = %v, want %s:%d(hasPort=%v)", c.in, hp, c.addr, c.port, c.hasPort)
		}
	}
}

func TestParseHostPortInvalid(t *testing.T) {
	for _, in := range []string{
		"",
		"   ",
		"not-an-ip",
		"1.2.3.4:",
		"1.2.3.4:abc",
		"1.2.3.4:65536",
		"1.2.3.4:-1",
		"1.2.3.4:+80",
		"1.2.3.4:80x",
		"[::1",
		"[::1]x",
		"[::1]x:80",
		"[]",
		"[1.2.3.4]", // bracketed IPv4 not accepted
		"fe80::1%eth0",
		"1.2.3.4:80:90",
		"::1:",
		"ffff:1",
	} {
		if hp, err := parseHostPort(in); err == nil {
			t.Errorf("parseHostPort(%q) = %v, want error", in, hp)
		}
	}
}
