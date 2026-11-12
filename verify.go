package dataeng

import (
	"fmt"
	"slices"
)

// VerificationStatus is the outcome of checking a peel result against
// complete set snapshots.
type VerificationStatus string

const (
	// VerificationStatusVerified means the emitted positive and negative
	// keys exactly equal A-B and B-A from the supplied complete snapshots.
	VerificationStatusVerified VerificationStatus = "verified"

	// VerificationStatusMismatch means at least one emitted key differs from
	// the real set difference, or the output contains a duplicate key.
	VerificationStatusMismatch VerificationStatus = "mismatch"
)

// VerificationResult records the exact expected and emitted differences.
// All identifier lists are sorted in ascending order. Missing lists contain
// expected identifiers not emitted; Unexpected lists contain emitted
// identifiers not present in the real difference.
type VerificationResult struct {
	Status             VerificationStatus
	ExpectedPositive   []uint64
	ExpectedNegative   []uint64
	OutputPositive     []uint64
	OutputNegative     []uint64
	MissingPositive    []uint64
	MissingNegative    []uint64
	UnexpectedPositive []uint64
	UnexpectedNegative []uint64
}

// IsVerified reports whether the output exactly matched the complete
// snapshots.
func (v VerificationResult) IsVerified() bool {
	return v.Status == VerificationStatusVerified
}

// VerifySets checks a peel result against complete snapshots of both input
// sets. Inputs must not contain duplicate identifiers. Verification succeeds
// only when the emitted positive keys are exactly A-B and the emitted
// negative keys are exactly B-A. A "peeled" digest alone never implies this
// result because finite checks and XOR accumulators can collide.
func VerifySets(result *PeelResult, a, b []uint64) (*VerificationResult, error) {
	if result == nil {
		return nil, fmt.Errorf("%w: nil peel result", ErrInternalState)
	}

	aSet, err := setSnapshot("A", a)
	if err != nil {
		return nil, err
	}
	bSet, err := setSnapshot("B", b)
	if err != nil {
		return nil, err
	}

	expectedPositive := make([]uint64, 0, len(aSet))
	for id := range aSet {
		if _, alsoInB := bSet[id]; !alsoInB {
			expectedPositive = append(expectedPositive, id)
		}
	}
	expectedNegative := make([]uint64, 0, len(bSet))
	for id := range bSet {
		if _, alsoInA := aSet[id]; !alsoInA {
			expectedNegative = append(expectedNegative, id)
		}
	}
	slices.Sort(expectedPositive)
	slices.Sort(expectedNegative)

	outputByKey := make(map[uint64]Direction, len(result.Keys))
	duplicateOutput := false
	for _, record := range result.Keys {
		if record.Direction != DirectionPositive && record.Direction != DirectionNegative {
			duplicateOutput = true
			continue
		}
		if _, exists := outputByKey[record.Key]; exists {
			duplicateOutput = true
			continue
		}
		outputByKey[record.Key] = record.Direction
	}

	outputPositive := make([]uint64, 0, len(outputByKey))
	outputNegative := make([]uint64, 0, len(outputByKey))
	for id, direction := range outputByKey {
		if direction == DirectionPositive {
			outputPositive = append(outputPositive, id)
		} else {
			outputNegative = append(outputNegative, id)
		}
	}
	slices.Sort(outputPositive)
	slices.Sort(outputNegative)

	expectedPositiveSet := uint64Set(expectedPositive)
	expectedNegativeSet := uint64Set(expectedNegative)
	outputPositiveSet := uint64Set(outputPositive)
	outputNegativeSet := uint64Set(outputNegative)

	missingPositive := setDifference(expectedPositive, outputPositiveSet)
	missingNegative := setDifference(expectedNegative, outputNegativeSet)
	unexpectedPositive := setDifference(outputPositive, expectedPositiveSet)
	unexpectedNegative := setDifference(outputNegative, expectedNegativeSet)

	status := VerificationStatusVerified
	if duplicateOutput ||
		!slices.Equal(expectedPositive, outputPositive) ||
		!slices.Equal(expectedNegative, outputNegative) {
		status = VerificationStatusMismatch
	}

	return &VerificationResult{
		Status:             status,
		ExpectedPositive:   expectedPositive,
		ExpectedNegative:   expectedNegative,
		OutputPositive:     outputPositive,
		OutputNegative:     outputNegative,
		MissingPositive:    missingPositive,
		MissingNegative:    missingNegative,
		UnexpectedPositive: unexpectedPositive,
		UnexpectedNegative: unexpectedNegative,
	}, nil
}

// Verify checks this result against complete snapshots of both input sets.
func (r *PeelResult) Verify(a, b []uint64) (*VerificationResult, error) {
	return VerifySets(r, a, b)
}

func setSnapshot(name string, ids []uint64) (map[uint64]struct{}, error) {
	out := make(map[uint64]struct{}, len(ids))
	for _, id := range ids {
		if _, exists := out[id]; exists {
			return nil, fmt.Errorf("%w: set %s contains repeated ID %d", ErrDuplicateID, name, id)
		}
		out[id] = struct{}{}
	}
	return out, nil
}

func uint64Set(ids []uint64) map[uint64]struct{} {
	out := make(map[uint64]struct{}, len(ids))
	for _, id := range ids {
		out[id] = struct{}{}
	}
	return out
}

func setDifference(ids []uint64, exclude map[uint64]struct{}) []uint64 {
	out := make([]uint64, 0, len(ids))
	for _, id := range ids {
		if _, found := exclude[id]; !found {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	return out
}
