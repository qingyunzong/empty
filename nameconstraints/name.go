// Package nameconstraints applies RFC 5280 style name constraints to the
// DNS and IP SANs of an already signature-verified certificate chain.
//
// Only DNS and IP names are supported. Every SAN in the leaf certificate
// must be accepted by the accumulated constraints; unsupported SAN types
// are ignored.
package nameconstraints

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// NameType identifies a supported SAN type.
type NameType int

const (
	// DNS is an RFC 1035 DNS domain name.
	DNS NameType = iota + 1
	// IP is an IPv4 or IPv6 address.
	IP
)

// familyKey refines the public NameType so IPv4 and IPv6 participate in
// constraint intersection/union independently.
type familyKey int

const (
	dnsKey familyKey = iota + 1
	ipv4Key
	ipv6Key
)

// key maps a name to its internal constraint bucket.
func (n Name) key() familyKey {
	switch n.Type {
	case DNS:
		return dnsKey
	case IP:
		if len(n.ip) == net.IPv4len {
			return ipv4Key
		}
		return ipv6Key
	default:
		return 0
	}
}

// constraintKey maps a constraint to its internal constraint bucket.
func (c Constraint) constraintKey() familyKey {
	switch c.Type {
	case DNS:
		return dnsKey
	case IP:
		if len(c.ip.Mask) == net.IPv4len {
			return ipv4Key
		}
		return ipv6Key
	default:
		return 0
	}
}

// Name is a leaf SAN that can be checked against a constraint set.
type Name struct {
	// Type is either DNS or IP.
	Type NameType
	// dns is the normalized lowercase, single-trailing-dot-stripped name.
	dns string
	// ip is the canonical 4- or 16-byte address.
	ip net.IP
}

// NewDNSName parses a DNS SAN. The name must be ASCII, must not contain a
// wildcard ("*") or a leading dot, and a single trailing dot is stripped;
// the result is lowercased.
func NewDNSName(name string) (Name, error) {
	normalized, err := normalizeDNS(name, false)
	if err != nil {
		return Name{}, err
	}
	return Name{Type: DNS, dns: normalized}, nil
}

// NewIPName parses an IPv4 or IPv6 address. Unparseable input is rejected.
func NewIPName(address string) (Name, error) {
	parsed := net.ParseIP(address)
	if parsed == nil {
		return Name{}, fmt.Errorf("nameconstraints: %q is not a valid IP address", address)
	}
	return Name{Type: IP, ip: canonicalIP(parsed)}, nil
}

// NameFromIP converts an already parsed net.IP into a Name. nil and
// zero-length addresses are rejected.
func NameFromIP(address net.IP) (Name, error) {
	canonical := canonicalIP(address)
	if canonical == nil {
		return Name{}, errors.New("nameconstraints: invalid IP address")
	}
	return Name{Type: IP, ip: canonical}, nil
}

// DNS returns the normalized DNS name and true, or empty and false for an IP.
func (n Name) DNS() (string, bool) {
	if n.Type != DNS {
		return "", false
	}
	return n.dns, true
}

// IP returns the canonical address and true, or nil and false for a DNS name.
func (n Name) IP() (net.IP, bool) {
	if n.Type != IP {
		return nil, false
	}
	return n.ip, true
}

// String renders the name for diagnostics.
func (n Name) String() string {
	switch n.Type {
	case DNS:
		return n.dns
	case IP:
		return n.ip.String()
	default:
		return "<unsupported>"
	}
}

// normalizeDNS implements the required DNS preprocessing: ASCII only, no
// wildcards, lowercase, strip a single trailing dot. When allowLeadingDot
// is true a leading dot is retained as the RFC 5280 "subdomains only"
// constraint marker; SAN parsing always passes false.
func normalizeDNS(name string, allowLeadingDot bool) (string, error) {
	if name == "" {
		return "", errors.New("nameconstraints: empty DNS name")
	}
	if strings.ContainsRune(name, '*') {
		return "", fmt.Errorf("%w: %q", ErrWildcardSAN, name)
	}
	// ASCII check first so non-LDH UTF-8 cannot slip through label checks.
	for _, r := range name {
		if r > 0x7F {
			return "", fmt.Errorf("nameconstraints: non-ASCII DNS name %q is not allowed", name)
		}
	}

	out := strings.ToLower(name)
	leadingDot := false
	if strings.HasPrefix(out, ".") {
		if !allowLeadingDot {
			return "", fmt.Errorf("nameconstraints: DNS name %q must not have a leading dot", name)
		}
		leadingDot = true
		out = out[1:]
	}
	if strings.HasSuffix(out, ".") {
		// Exactly one trailing dot is accepted; more than one leaves an
		// empty final label and must fail.
		stripped := strings.TrimSuffix(out, ".")
		if strings.HasSuffix(stripped, ".") {
			return "", fmt.Errorf("nameconstraints: invalid DNS name %q", name)
		}
		out = stripped
	}

	labels := strings.Split(out, ".")
	for _, label := range labels {
		if label == "" {
			return "", fmt.Errorf("nameconstraints: empty label in DNS name %q", name)
		}
		if len(label) > 63 {
			return "", fmt.Errorf("nameconstraints: label too long in DNS name %q", name)
		}
	}
	if len(out) > 253 {
		return "", fmt.Errorf("nameconstraints: DNS name %q is too long", name)
	}
	if leadingDot {
		out = "." + out
	}
	return out, nil
}

// canonicalIP returns the 4-byte representation for IPv4 addresses and the
// 16-byte representation for IPv6, or nil for invalid input.
func canonicalIP(ip net.IP) net.IP {
	if ip == nil {
		return nil
	}
	if v4 := ip.To4(); v4 != nil {
		return v4
	}
	if len(ip) == net.IPv6len {
		return ip.To16()
	}
	return nil
}
