package nameconstraints

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// Constraint is a single permitted or excluded name constraint.
type Constraint struct {
	// Type is DNS or IP; only these SAN types are supported.
	Type NameType
	// dns is the normalized constraint domain. For DNS a leading dot means
	// "subdomains only" and is retained in this field.
	dns string
	// subdomainOnly mirrors whether dns started with ".".
	subdomainOnly bool
	// ip is the CIDR used for IP prefix matching.
	ip *net.IPNet
}

// NewDNSConstraint parses a DNS constraint. A plain domain such as
// "example.test" matches the domain itself and every subdomain; a leading
// dot such as ".example.test" matches subdomains only. The same ASCII,
// lowercase and single-trailing-dot normalization as for SANs applies.
func NewDNSConstraint(domain string) (Constraint, error) {
	if domain == "" {
		return Constraint{}, errors.New("nameconstraints: empty DNS constraint")
	}
	if strings.ContainsRune(domain, '*') {
		return Constraint{}, fmt.Errorf("nameconstraints: wildcard DNS constraint %q is not allowed", domain)
	}

	subdomainOnly := strings.HasPrefix(domain, ".")
	if subdomainOnly {
		domain = domain[1:]
	}
	normalized, err := normalizeDNS(domain, true)
	if err != nil {
		return Constraint{}, err
	}
	c := Constraint{Type: DNS, dns: normalized, subdomainOnly: subdomainOnly}
	if subdomainOnly {
		c.dns = "." + normalized
	}
	return c, nil
}

// NewIPConstraint parses a CIDR constraint with a contiguous mask, for
// example "10.0.0.0/8" or "2001:db8::/32".
func NewIPConstraint(cidr string) (Constraint, error) {
	ip, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return Constraint{}, fmt.Errorf("nameconstraints: invalid IP constraint %q: %w", cidr, err)
	}
	if !contiguousMask(network.Mask) {
		return Constraint{}, fmt.Errorf("nameconstraints: non-contiguous mask in IP constraint %q", cidr)
	}
	if canonical := canonicalIP(ip); canonical != nil {
		network.IP = canonical
	}
	return Constraint{Type: IP, ip: network}, nil
}

// ConstraintFromIPNet wraps an already parsed CIDR. Non-contiguous masks are
// rejected.
func ConstraintFromIPNet(network *net.IPNet) (Constraint, error) {
	if network == nil {
		return Constraint{}, errors.New("nameconstraints: nil IP constraint")
	}
	if !contiguousMask(network.Mask) {
		return Constraint{}, errors.New("nameconstraints: non-contiguous mask in IP constraint")
	}
	copied := &net.IPNet{IP: canonicalIP(network.IP), Mask: network.Mask}
	if copied.IP == nil {
		return Constraint{}, errors.New("nameconstraints: invalid IP constraint")
	}
	return Constraint{Type: IP, ip: copied}, nil
}

// matches reports whether the name satisfies this constraint.
func (c Constraint) matches(name Name) bool {
	if c.Type != name.Type {
		return false
	}
	switch c.Type {
	case DNS:
		return matchDNS(c, name.dns)
	case IP:
		return matchIP(c.ip, name.ip)
	default:
		return false
	}
}

func matchDNS(c Constraint, name string) bool {
	base := strings.TrimPrefix(c.dns, ".")
	if c.subdomainOnly {
		return strings.HasSuffix(name, "."+base)
	}
	if name == base {
		return true
	}
	return strings.HasSuffix(name, "."+base)
}

func matchIP(network *net.IPNet, ip net.IP) bool {
	// net.IPNet.Contains assumes matching families; make that explicit so a
	// 4-byte address can never match an IPv6 prefix or vice versa.
	// Use length rather than To4 so an IPv4-mapped IPv6 address stays in
	// the IPv6 family instead of collapsing onto the 4-byte form.
	v4Network := len(network.IP) == net.IPv4len
	v4Name := len(ip) == net.IPv4len
	if v4Network != v4Name {
		return false
	}
	return network.Contains(ip)
}

// String renders the constraint for diagnostics.
func (c Constraint) String() string {
	switch c.Type {
	case DNS:
		return c.dns
	case IP:
		return c.ip.String()
	default:
		return "<unsupported>"
	}
}

// contiguousMask reports whether every mask bit after the first zero is zero.
func contiguousMask(mask net.IPMask) bool {
	seenZero := false
	for _, b := range mask {
		for bit := 7; bit >= 0; bit-- {
			if b&(1<<bit) != 0 {
				if seenZero {
					return false
				}
			} else {
				seenZero = true
			}
		}
	}
	return true
}
