package evidencecheck

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sync"
)

// Signer is the signature adapter. Implementations sign and verify the
// canonical receipt payload for a (signerID, trustVersion) pair.
type Signer interface {
	Sign(signerID string, trustVersion int, payload []byte) ([]byte, error)
	Verify(signerID string, trustVersion int, payload, sig []byte) bool
}

// KeyedAdapter is a controllable HMAC-SHA256 Signer for tests and local
// deployments. Keys are registered per (signerID, trustVersion); tests can
// add, rotate or remove keys to drive every verification path.
type KeyedAdapter struct {
	mu   sync.RWMutex
	keys map[string][]byte
}

func NewKeyedAdapter() *KeyedAdapter {
	return &KeyedAdapter{keys: make(map[string][]byte)}
}

func adapterKey(signerID string, trustVersion int) string {
	return fmt.Sprintf("%s@%d", signerID, trustVersion)
}

// SetKey registers (or rotates) the key for a signer trust version.
func (a *KeyedAdapter) SetKey(signerID string, trustVersion int, key []byte) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.keys[adapterKey(signerID, trustVersion)] = append([]byte(nil), key...)
}

// RemoveKey deletes the key, simulating an unknown or retired trust version.
func (a *KeyedAdapter) RemoveKey(signerID string, trustVersion int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.keys, adapterKey(signerID, trustVersion))
}

func (a *KeyedAdapter) Sign(signerID string, trustVersion int, payload []byte) ([]byte, error) {
	a.mu.RLock()
	key, ok := a.keys[adapterKey(signerID, trustVersion)]
	a.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("no key for signer %q trust version %d", signerID, trustVersion)
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(payload)
	return mac.Sum(nil), nil
}

func (a *KeyedAdapter) Verify(signerID string, trustVersion int, payload, sig []byte) bool {
	want, err := a.Sign(signerID, trustVersion, payload)
	if err != nil {
		return false
	}
	return hmac.Equal(want, sig)
}

// receiptPayload is the canonical signed bytes of a receipt.
func receiptPayload(problemID string, version int, evidenceHash string, signedAtUnix int64) []byte {
	buf := make([]byte, 0, len(problemID)+len(evidenceHash)+16)
	buf = append(buf, problemID...)
	buf = append(buf, '|')
	var tmp [8]byte
	binary.BigEndian.PutUint64(tmp[:], uint64(version))
	buf = append(buf, tmp[:]...)
	buf = append(buf, evidenceHash...)
	binary.BigEndian.PutUint64(tmp[:], uint64(signedAtUnix))
	buf = append(buf, tmp[:]...)
	return buf
}
