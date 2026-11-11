package nameconstraints

import (
	"crypto/tls"
	"crypto/x509"
)

// Verifier is a TLS handshake adapter for crypto/tls. Wire it into a
// tls.Config to enforce DNS/IP name constraints after the peer certificate
// chain has already been signature-verified. A returned error aborts the
// handshake before any application data is exchanged.
//
//	verifier := &nameconstraints.Verifier{}
//	tlsConfig.VerifyConnection = verifier.VerifyConnection
//	tlsConfig.VerifyPeerCertificate = verifier.VerifyPeerCertificate
type Verifier struct{}

// NewVerifier returns a ready-to-use handshake adapter.
func NewVerifier() *Verifier {
	return &Verifier{}
}

// VerifyConnection implements tls.Config.VerifyConnection. It requires the
// connection state to carry at least one signature-verified chain.
func (v *Verifier) VerifyConnection(state tls.ConnectionState) error {
	return VerifyVerifiedChains(state.VerifiedChains)
}

// VerifyPeerCertificate implements tls.Config.VerifyPeerCertificate. It
// ignores the raw unparsed certificates and requires verifiedChains; set
// InsecureSkipVerify when using it without a custom verification callback,
// otherwise crypto/tls performs its own chain verification first.
func (v *Verifier) VerifyPeerCertificate(_ [][]byte, verifiedChains [][]*x509.Certificate) error {
	return VerifyVerifiedChains(verifiedChains)
}

// VerifyVerifiedChains applies the per-CA reference algorithm to every
// signature-verified chain. Chains are ordered leaf-first by crypto/tls;
// each chain is reversed internally so constraints accumulate from the
// root down. The leaf's SAN check is never skipped, even when it is
// self-issued.
func VerifyVerifiedChains(chains [][]*x509.Certificate) error {
	if len(chains) == 0 || len(chains[0]) == 0 {
		return ErrNoVerifiedChain
	}

	var firstErr error
	for _, chain := range chains {
		if err := verifyChain(chain); err != nil {
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

func verifyChain(chain []*x509.Certificate) error {
	validator := NewReferenceValidator()
	last := len(chain) - 1
	for i := last; i >= 0; i-- {
		cert := chain[i]
		permitted, excluded, err := ConstraintsFromCertificate(cert)
		if err != nil {
			return err
		}

		var sans []Name
		if i == 0 {
			// Chain index 0 is the leaf after reversing the walk direction.
			sans, err = NamesFromCertificate(cert)
			if err != nil {
				return err
			}
		}

		entry := ChainEntry{
			Permitted:  permitted,
			Excluded:   excluded,
			SANs:       sans,
			SelfIssued: isSelfIssued(cert),
		}
		leaf := i == 0
		if err := validator.ApplyCA(entry, leaf); err != nil {
			return err
		}
	}
	return nil
}

// isSelfIssued mirrors RFC 5280: the subject and issuer are the same entity.
func isSelfIssued(cert *x509.Certificate) bool {
	return cert.Subject.String() == cert.Issuer.String()
}
