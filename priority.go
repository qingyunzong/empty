package dataeng

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// Errors returned by the sampler. Callers can use errors.Is with these values.
var (
	// ErrInvalidWeight is returned when a record weight is NaN or not positive.
	ErrInvalidWeight = errors.New("weight must be positive")
	// ErrInvalidK is returned when a reservoir capacity is not positive.
	ErrInvalidK = errors.New("reservoir size must be positive")
	// ErrConflictingWeight is returned when an existing record id is replayed
	// with a different weight. Keeping the first weight makes replay idempotent.
	ErrConflictingWeight = errors.New("record id already exists with a different weight")
	// ErrIncompatibleK is returned when reservoirs with different capacities are
	// merged without an explicit output capacity.
	ErrIncompatibleK = errors.New("reservoirs have different capacities")
	// ErrInsufficientShardK is returned when a shard retained fewer than the
	// requested global capacity, so the merge could not be lossless.
	ErrInsufficientShardK = errors.New("shard capacity is smaller than merge capacity")
	// ErrNilReservoir is returned when a nil reservoir is passed to a merge.
	ErrNilReservoir = errors.New("nil reservoir")
	// ErrNoReservoirs is returned when a merge has no inputs.
	ErrNoReservoirs = errors.New("no reservoirs to merge")
	// ErrInvalidState is returned when persisted reservoir state is malformed.
	ErrInvalidState = errors.New("invalid reservoir state")
	// ErrTooManyValues is returned when Add receives more than one value.
	ErrTooManyValues = errors.New("too many values")
)

const (
	// priorityDomain separates this sampler's hash stream from other users of
	// the same record ids.
	priorityDomain = "example.org/dataeng/q0133/priority/v1\x00"

	// unitScale is 2^53. Using 53 random bits yields a float64 that is strictly
	// inside (0, 1), avoiding log(0) and pow(1, ...) boundary cases.
	unitScale = float64(uint64(1) << 53)
)

// ValidateWeight reports whether weight can be used by the sampler.
//
// A weight must be positive and must not be NaN. Positive infinity is allowed;
// it is treated as an infinitely heavy record.
func ValidateWeight(weight float64) error {
	if math.IsNaN(weight) || weight <= 0 {
		return fmt.Errorf("%w: %v", ErrInvalidWeight, weight)
	}
	return nil
}

// StableHash returns a deterministic 64-bit hash for id. The hash is stable
// across processes, machines, insertion orders, and reservoir instances.
func StableHash(id string) uint64 {
	sum := sha256.Sum256([]byte(priorityDomain + id))
	return binary.BigEndian.Uint64(sum[:8])
}

// Priority returns the weighted reservoir priority for id and weight.
//
// The value is the Efraimidis-Spirakis key U^(1/weight), where U is a stable
// uniform value in (0, 1) derived from id. Larger priorities are better and are
// retained first. Because U depends only on the id, every shard computes the
// same priority for the same record, which makes independent shard samples
// exactly mergeable.
//
// The weight must be positive and not NaN.
func Priority(id string, weight float64) (float64, error) {
	if err := ValidateWeight(weight); err != nil {
		return 0, err
	}
	u := (float64(StableHash(id)>>11) + 0.5) / unitScale
	return math.Pow(u, 1/weight), nil
}

// WeightedPriority is an alias for Priority.
func WeightedPriority(id string, weight float64) (float64, error) {
	return Priority(id, weight)
}
