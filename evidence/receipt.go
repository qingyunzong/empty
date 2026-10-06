package evidence

import "time"

// Receipt is a signature receipt binding a signer (at a specific trust
// version) to a manifest digest.
type Receipt struct {
	ManifestID   string
	Version      int
	Digest       string
	Signer       string
	TrustVersion int
	SignedAt     time.Time
	Signature    []byte
}

// Payload is the byte string that is signed/verified.
func (r *Receipt) Payload() []byte { return []byte(r.Digest) }
