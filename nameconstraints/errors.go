package nameconstraints

import "errors"

var errNilCertificate = errors.New("nameconstraints: nil certificate")

// ErrWildcardSAN is returned when a leaf carries a wildcard DNS SAN.
// Wildcard SANs are never accepted by this component.
var ErrWildcardSAN = errors.New("nameconstraints: wildcard DNS SAN is not allowed")

// ErrNoVerifiedChain is returned by the TLS adapter when the peer offered no
// signature-verified chain. The adapter never builds chains itself.
var ErrNoVerifiedChain = errors.New("nameconstraints: no signature-verified certificate chain")

// NameError explains why one leaf SAN failed the accumulated constraints.
type NameError struct {
	// Name is the rejected SAN.
	Name Name
	// Reason describes whether an exclusion matched or no permission did.
	Reason string
}

func (e *NameError) Error() string {
	return "nameconstraints: " + e.Reason
}
