package hdrclient

import "testing"

func TestParseTokenValid(t *testing.T) {
	cases := map[string]string{
		"1.2.3.4":             "1.2.3.4",
		"1.2.3.4:8080":        "1.2.3.4",
		"  10.0.0.1  ":        "10.0.0.1",
		"::1":                 "::1",
		"2001:db8::1":         "2001:db8::1",
		"[2001:db8::1]":       "2001:db8::1",
		"[2001:db8::1]:443":   "2001:db8::1",
		"::ffff:1.2.3.4":      "::ffff:1.2.3.4",
		"[::ffff:1.2.3.4]:80": "::ffff:1.2.3.4",
		"2001:db8::1%eth0":    "2001:db8::1%eth0",
	}
	for in, want := range cases {
		got, err := parseToken(in)
		if err != nil {
			t.Errorf("parseToken(%q) error: %v", in, err)
			continue
		}
		if got.String() != want {
			t.Errorf("parseToken(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestParseTokenInvalid(t *testing.T) {
	for _, in := range []string{
		"", "   ", "not-an-ip", "1.2.3.4:abc", "1.2.3.4:99999",
		"1.2.3.4:", "1.2.3.4:80:90", "[::1", "::1]", "[::1]:",
		"[]", "1.2.3.256", "example.com",
	} {
		if _, err := parseToken(in); err == nil {
			t.Errorf("parseToken(%q) unexpectedly succeeded", in)
		}
	}
}
