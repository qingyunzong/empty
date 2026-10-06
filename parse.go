package hdrclient

import (
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
)

// HostPort is a parsed chain element: an IP address with an optional port.
type HostPort struct {
	Addr    netip.Addr
	Port    uint16
	HasPort bool
}

func (hp HostPort) String() string {
	if hp.HasPort {
		if hp.Addr.Is4() {
			return fmt.Sprintf("%s:%d", hp.Addr, hp.Port)
		}
		return fmt.Sprintf("[%s]:%d", hp.Addr, hp.Port)
	}
	return hp.Addr.String()
}

// parseHostPort parses one chain element. Accepted forms:
//
//	1.2.3.4          IPv4
//	1.2.3.4:8080     IPv4 with port
//	::1              bare IPv6 (no port)
//	[::1]            bracketed IPv6
//	[::1]:8080       bracketed IPv6 with port
//
// Anything else, including zoned addresses, is rejected.
func parseHostPort(raw string) (HostPort, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return HostPort{}, errors.New("empty address")
	}
	if s[0] == '[' {
		end := strings.IndexByte(s, ']')
		if end < 0 {
			return HostPort{}, fmt.Errorf("missing ']' in %q", raw)
		}
		addr, err := parseIP(s[1:end])
		if err != nil {
			return HostPort{}, err
		}
		if !addr.Is6() {
			return HostPort{}, fmt.Errorf("bracketed address %q must be IPv6", s[1:end])
		}
		rest := s[end+1:]
		if rest == "" {
			return HostPort{Addr: addr}, nil
		}
		if !strings.HasPrefix(rest, ":") {
			return HostPort{}, fmt.Errorf("unexpected %q after ']'", rest)
		}
		port, err := parsePort(rest[1:])
		if err != nil {
			return HostPort{}, err
		}
		return HostPort{Addr: addr, Port: port, HasPort: true}, nil
	}
	switch strings.Count(s, ":") {
	case 0:
		addr, err := parseIP(s)
		if err != nil {
			return HostPort{}, err
		}
		return HostPort{Addr: addr}, nil
	case 1:
		host, portStr, _ := strings.Cut(s, ":")
		if addr, err := parseIP(host); err == nil && addr.Is4() {
			port, err := parsePort(portStr)
			if err != nil {
				return HostPort{}, err
			}
			return HostPort{Addr: addr, Port: port, HasPort: true}, nil
		}
		// Not IPv4:port; a single-colon token may still be a bare IPv6
		// address such as "ffff:1".
		addr, err := parseIP(s)
		if err != nil {
			return HostPort{}, fmt.Errorf("invalid address %q", raw)
		}
		return HostPort{Addr: addr}, nil
	default:
		addr, err := parseIP(s)
		if err != nil {
			return HostPort{}, err
		}
		return HostPort{Addr: addr}, nil
	}
}

func parseIP(s string) (netip.Addr, error) {
	addr, err := netip.ParseAddr(s)
	if err != nil {
		return addr, fmt.Errorf("invalid address %q", s)
	}
	if addr.Zone() != "" {
		return addr, fmt.Errorf("zoned address %q not allowed", s)
	}
	return addr, nil
}

func parsePort(s string) (uint16, error) {
	if s == "" {
		return 0, errors.New("empty port")
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("invalid port %q", s)
		}
	}
	n, err := strconv.ParseUint(s, 10, 16)
	if err != nil {
		return 0, fmt.Errorf("invalid port %q", s)
	}
	return uint16(n), nil
}
