package q214

import (
	"errors"
	"sync"
	"sync/atomic"
)

// minKeyBytes is the minimum accepted HMAC key length. A key shorter than
// the HMAC-SHA256 output size does not provide a meaningful security margin.
const minKeyBytes = 32

// KeyVersion is one entry of a versioned, kid-addressed key set.
type KeyVersion struct {
	// Kid identifies the key and must match the JWT header "kid" claim.
	Kid string

	// Key is the HMAC-SHA256 shared secret, at least 32 bytes.
	Key []byte
}

type keySnapshot struct {
	byKid map[string][]byte
	order []string
}

// KeySet is a concurrency-safe, atomically replaceable collection of key
// versions. A single verification always observes one snapshot: a rotation
// that happens while Verify is running never changes the key version used.
type KeySet struct {
	current atomic.Pointer[keySnapshot]

	mu sync.Mutex
}

// NewKeySet validates the initial versions and stores them atomically.
// Every kid must be non-empty and unique and every key must be at least
// 32 bytes; otherwise the call fails and no state is changed.
func NewKeySet(versions []KeyVersion) (*KeySet, error) {
	snap, err := buildSnapshot(versions)
	if err != nil {
		return nil, err
	}
	ks := &KeySet{}
	ks.current.Store(snap)
	return ks, nil
}

// Replace atomically swaps the whole key set. Removing a kid therefore takes
// effect for every verification that starts after the swap, while verifications
// already in flight keep using the previous snapshot. The call fails and leaves
// the previous set untouched when the new set is empty or invalid.
func (ks *KeySet) Replace(versions []KeyVersion) error {
	snap, err := buildSnapshot(versions)
	if err != nil {
		return err
	}
	ks.current.Store(snap)
	return nil
}

// snapshot returns the immutable key set visible at this instant. The returned
// pointer is never mutated after publication, so callers may read it without
// holding any lock for the whole duration of a verification.
func (ks *KeySet) snapshot() *keySnapshot {
	snap := ks.current.Load()
	if snap == nil {
		return &keySnapshot{byKid: map[string][]byte{}}
	}
	return snap
}

func buildSnapshot(versions []KeyVersion) (*keySnapshot, error) {
	if len(versions) == 0 {
		return nil, errors.New("q214: key set must contain at least one version")
	}
	byKid := make(map[string][]byte, len(versions))
	order := make([]string, 0, len(versions))
	for _, v := range versions {
		if v.Kid == "" {
			return nil, errors.New("q214: key version with empty kid")
		}
		if len(v.Key) < minKeyBytes {
			return nil, errors.New("q214: key for kid " + v.Kid + " is shorter than 32 bytes")
		}
		if _, exists := byKid[v.Kid]; exists {
			return nil, errors.New("q214: duplicate kid " + v.Kid)
		}
		secret := make([]byte, len(v.Key))
		copy(secret, v.Key)
		byKid[v.Kid] = secret
		order = append(order, v.Kid)
	}
	return &keySnapshot{byKid: byKid, order: order}, nil
}
