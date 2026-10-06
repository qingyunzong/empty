package hdrclient

import (
	"fmt"
	"net/netip"
	"strings"
)

// parseToken parses one chain entry: an IPv4 or IPv6 address with an
// optional port. Accepted forms include "1.2.3.4", "1.2.3.4:8080",
// "2001:db8::1", "[2001:db8::1]" and "[2001:db8::1]:443".
func parseToken(raw string) (netip.Addr, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return netip.Addr{}, fmt.Errorf("empty address token")
	}
	if addr, err := netip.ParseAddr(s); err == nil {
		return addr, nil
	}
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.Addr(), nil
	}
	if len(s) >= 2 && s[0] == '[' && s[len(s)-1] == ']' {
		if addr, err := netip.ParseAddr(s[1 : len(s)-1]); err == nil {
			return addr, nil
		}
	}
	return netip.Addr{}, fmt.Errorf("invalid address token %q", raw)
}
