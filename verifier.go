package sigverify

import (
	"errors"
	"fmt"
	"time"
)

var (
	// ErrKeyNotYetValid indicates use before the key's NotBefore.
	ErrKeyNotYetValid = errors.New("sigverify: key not yet valid")
	// ErrKeyExpired indicates use at or after the key's NotAfter.
	ErrKeyExpired = errors.New("sigverify: key expired")
	// ErrKeyRevoked indicates use at or after the key's revocation time.
	ErrKeyRevoked = errors.New("sigverify: key revoked")
	// ErrSignatureInvalid indicates the signature does not match.
	ErrSignatureInvalid = errors.New("sigverify: invalid signature")
	// ErrSignedInFuture indicates SignedAt is beyond the allowed clock skew.
	ErrSignedInFuture = errors.New("sigverify: signing time is in the future")
	// ErrRequestTooOld indicates the request exceeded the maximum age.
	ErrRequestTooOld = errors.New("sigverify: request too old")
)

// Request is a signed request to verify.
type Request struct {
	KeyID     string
	Payload   []byte
	Signature []byte
	SignedAt  time.Time
}

// Verifier checks requests against a key store and a signature adapter.
type Verifier struct {
	Store   *KeyStore
	Adapter Adapter

	// MaxAge is the maximum allowed delay between SignedAt and the
	// receive time. Zero disables the age check.
	MaxAge time.Duration
	// MaxClockSkew is how far SignedAt may lie in the future relative
	// to the receive time. Zero requires SignedAt <= receive time.
	MaxClockSkew time.Duration
}

// Verify checks req at receive time receivedAt. Both the request's
// signing time and the receive time must fall inside the key's
// half-open validity window and before any revocation. An unknown
// key ID is never valid.
func (v *Verifier) Verify(req Request, receivedAt time.Time) error {
	key, ok := v.Store.Lookup(req.KeyID)
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownKey, req.KeyID)
	}
	if err := checkInstant(key, req.SignedAt, "signed at"); err != nil {
		return err
	}
	if err := checkInstant(key, receivedAt, "received at"); err != nil {
		return err
	}
	if req.SignedAt.After(receivedAt.Add(v.MaxClockSkew)) {
		return ErrSignedInFuture
	}
	if v.MaxAge > 0 && receivedAt.Sub(req.SignedAt) > v.MaxAge {
		return ErrRequestTooOld
	}
	if !v.Adapter.Verify(key.Material, req.Payload, req.Signature) {
		return ErrSignatureInvalid
	}
	return nil
}

// checkInstant validates a single timestamp against the key's window.
func checkInstant(k *Key, t time.Time, what string) error {
	switch {
	case t.Before(k.NotBefore):
		return fmt.Errorf("%w (%s %s, key valid from %s)", ErrKeyNotYetValid, what, t, k.NotBefore)
	case !t.Before(k.NotAfter):
		return fmt.Errorf("%w (%s %s, key expired at %s)", ErrKeyExpired, what, t, k.NotAfter)
	case k.RevokedAt != nil && !t.Before(*k.RevokedAt):
		return fmt.Errorf("%w (%s %s, revoked at %s)", ErrKeyRevoked, what, t, *k.RevokedAt)
	}
	return nil
}
