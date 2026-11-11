package nameconstraints

import "crypto/x509"

// ConstraintsFromCertificate extracts the DNS and IP name constraints from
// a CA certificate. Email and URI constraints are unsupported and ignored.
func ConstraintsFromCertificate(cert *x509.Certificate) (permitted, excluded []Constraint, err error) {
	if cert == nil {
		return nil, nil, errNilCertificate
	}

	for _, dns := range cert.PermittedDNSDomains {
		c, parseErr := NewDNSConstraint(dns)
		if parseErr != nil {
			return nil, nil, parseErr
		}
		permitted = append(permitted, c)
	}
	for _, network := range cert.PermittedIPRanges {
		c, parseErr := ConstraintFromIPNet(network)
		if parseErr != nil {
			return nil, nil, parseErr
		}
		permitted = append(permitted, c)
	}
	for _, dns := range cert.ExcludedDNSDomains {
		c, parseErr := NewDNSConstraint(dns)
		if parseErr != nil {
			return nil, nil, parseErr
		}
		excluded = append(excluded, c)
	}
	for _, network := range cert.ExcludedIPRanges {
		c, parseErr := ConstraintFromIPNet(network)
		if parseErr != nil {
			return nil, nil, parseErr
		}
		excluded = append(excluded, c)
	}
	return permitted, excluded, nil
}

// NamesFromCertificate extracts the supported SANs from a certificate.
// DNS names are normalized and wildcard names are rejected; only DNS and
// IP SANs are returned.
func NamesFromCertificate(cert *x509.Certificate) ([]Name, error) {
	if cert == nil {
		return nil, errNilCertificate
	}
	names := make([]Name, 0, len(cert.DNSNames)+len(cert.IPAddresses))
	for _, dns := range cert.DNSNames {
		name, err := NewDNSName(dns)
		if err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	for _, ip := range cert.IPAddresses {
		name, err := NameFromIP(ip)
		if err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, nil
}
