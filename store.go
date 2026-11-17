package formal

import (
	"context"
	"errors"
	"fmt"
)

var (
	// ErrNotFound is returned by Store.Get when the object is not (or is not
	// yet) visible.
	ErrNotFound = errors.New("formal: object not found")
	// ErrAlreadyExists is returned by Store.Put when IfNoneMatch is set and
	// any version of the object already exists.
	ErrAlreadyExists = errors.New("formal: object already exists")
	// ErrPreconditionFailed is returned by Store.Put when IfMatch does not
	// match the latest committed version.
	ErrPreconditionFailed = errors.New("formal: object precondition failed")
)

// Object is a snapshot of a stored object. Data must not be modified by the
// caller.
type Object struct {
	Data    []byte
	Version string
}

// Condition controls the compare-and-swap behaviour of Store.Put.
//
// The zero value performs an unconditional write. IfNoneMatch implements
// create-once semantics; IfMatch implements compare-and-swap against the
// version string returned by a previous Put or Get.
type Condition struct {
	IfNoneMatch bool
	IfMatch     string
}

// Store is the object-store surface required by the commit protocol.
//
// Implementations must make Put atomic and must evaluate conditions against
// the latest committed state (linearizable writes). Get may lag behind a
// successful Put (eventual visibility); callers are expected to retry.
type Store interface {
	Put(ctx context.Context, key string, data []byte, cond Condition) (Object, error)
	Get(ctx context.Context, key string) (Object, error)
}

// ManifestKey is the single manifest location for a checkpoint step. The step
// is zero padded so keys sort in step order.
func ManifestKey(step uint64) string {
	return fmt.Sprintf("checkpoints/step-%020d/manifest.json", step)
}

// ShardKey namespaces a shard by step, commit generation, and rank. Including
// the generation keeps a restarted or stale attempt from clobbering the shard
// chosen by a newer attempt.
func ShardKey(step, generation uint64, rank int) string {
	return fmt.Sprintf("checkpoints/step-%020d/gen-%020d/rank-%06d.shard", step, generation, rank)
}
