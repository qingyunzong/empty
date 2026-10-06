package evidence

import (
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"sync"
)

// ErrBadSignature is returned when a signature does not verify.
var ErrBadSignature = errors.New("evidence: invalid signature")

// Adapter is the signature adapter: integrations plug in their own
// signing/verification backend (HSM, KMS, ed25519, ...).
type Adapter interface {
	Sign(signer string, payload []byte) ([]byte, error)
	Verify(signer string, payload, signature []byte) error
}

// HMACAdapter is a symmetric Adapter keyed per signer.
type HMACAdapter struct {
	keys map[string][]byte
}

func NewHMACAdapter(keys map[string][]byte) *HMACAdapter {
	return &HMACAdapter{keys: keys}
}

func (a *HMACAdapter) Sign(signer string, payload []byte) ([]byte, error) {
	key, ok := a.keys[signer]
	if !ok {
		return nil, errors.New("evidence: unknown signer " + signer)
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(payload)
	return mac.Sum(nil), nil
}

func (a *HMACAdapter) Verify(signer string, payload, signature []byte) error {
	want, err := a.Sign(signer, payload)
	if err != nil {
		return err
	}
	if !hmac.Equal(want, signature) {
		return ErrBadSignature
	}
	return nil
}

// ControlledAdapter is a programmable adapter for tests and for integrations
// that need deterministic control over signing outcomes (including latency
// and forced failures).
type ControlledAdapter struct {
	mu          sync.Mutex
	SignFn      func(signer string, payload []byte) ([]byte, error)
	VerifyFn    func(signer string, payload, signature []byte) error
	SignCalls   int
	VerifyCalls int
}

func (c *ControlledAdapter) Sign(signer string, payload []byte) ([]byte, error) {
	c.mu.Lock()
	c.SignCalls++
	fn := c.SignFn
	c.mu.Unlock()
	if fn == nil {
		return append([]byte(nil), payload...), nil
	}
	return fn(signer, payload)
}

func (c *ControlledAdapter) Verify(signer string, payload, signature []byte) error {
	c.mu.Lock()
	c.VerifyCalls++
	fn := c.VerifyFn
	c.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(signer, payload, signature)
}

// Calls returns the recorded call counts, safe for concurrent use.
func (c *ControlledAdapter) Calls() (sign, verify int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.SignCalls, c.VerifyCalls
}
