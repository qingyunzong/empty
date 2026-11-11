package q204

import "context"

// KeyRef is an opaque reference to a key version held by a KeyStore.
type KeyRef struct {
	ID string `json:"id"`
}

// IsZero reports whether the reference is unset.
func (r KeyRef) IsZero() bool {
	return r.ID == ""
}

// KeyStore supplies the active key and resolves key versions by reference.
//
// Current must return the key version that should be bound to a new batch.
// Load must still be able to resolve any previously returned reference until
// that reference is explicitly revoked. Implementations may rotate Current at
// any time without affecting already resolved references.
type KeyStore interface {
	Current(ctx context.Context) (KeyRef, error)
	Load(ctx context.Context, ref KeyRef) ([]byte, error)
}

// BatchKeyRevoker is the preferred optional interface for invalidating a
// batch's key reference. It is called after the batch has already stopped
// reading the reference locally. A failure is reported to the caller, but the
// batch remains revoked and can never use the key again.
type BatchKeyRevoker interface {
	RevokeBatch(ctx context.Context, batchID string, ref KeyRef) error
}

// KeyRevoker is an optional fallback for stores that revoke references without
// needing a batch identifier.
type KeyRevoker interface {
	RevokeKey(ctx context.Context, ref KeyRef) error
}
