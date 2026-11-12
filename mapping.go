package dataeng

import (
	"fmt"
	"math/big"
)

// Drop marks a source allele index that is removed by the projection.
const Drop = -1

// Transform is a validated projection from SourceAlleles allele indices onto
// TargetAlleles allele indices at a fixed Ploidy.
type Transform struct {
	SourceAlleles int
	TargetAlleles int
	Ploidy        int

	mapping []int
}

// NewTransform validates and builds a Transform. mapping has one entry per
// source index; Drop removes an allele. The rules are:
//   - source index 0 must map to target index 0;
//   - no non-zero source index may map to target index 0;
//   - every retained target must lie in [0, targetAlleles);
//   - the retained targets must cover 0..targetAlleles-1 exactly once as a
//     set (multiple source alleles may merge onto one target).
func NewTransform(sourceAlleles, targetAlleles, ploidy int, mapping []int) (*Transform, error) {
	if err := validateAlleleCount(sourceAlleles); err != nil {
		return nil, err
	}
	if err := validateAlleleCount(targetAlleles); err != nil {
		return nil, err
	}
	if err := validatePloidy(ploidy); err != nil {
		return nil, err
	}
	if len(mapping) != sourceAlleles {
		return nil, fmt.Errorf("%w: mapping length %d does not match source allele count %d", ErrInvalidMapping, len(mapping), sourceAlleles)
	}

	covered := make([]bool, targetAlleles)
	for source, target := range mapping {
		switch {
		case target == Drop:
			if source == 0 {
				return nil, fmt.Errorf("%w: reference allele 0 must map to 0, cannot be dropped", ErrInvalidMapping)
			}
		case target < 0 || target >= targetAlleles:
			return nil, fmt.Errorf("%w: source allele %d maps outside [0,%d): %d", ErrInvalidMapping, source, targetAlleles, target)
		case source == 0 && target != 0:
			return nil, fmt.Errorf("%w: reference allele 0 must map to 0, got %d", ErrInvalidMapping, target)
		case source != 0 && target == 0:
			return nil, fmt.Errorf("%w: non-zero source allele %d cannot map to reference target 0", ErrInvalidMapping, source)
		default:
			covered[target] = true
		}
	}
	for target, ok := range covered {
		if !ok {
			return nil, fmt.Errorf("%w: target allele %d is not covered by any source allele", ErrInvalidMapping, target)
		}
	}

	mappingCopy := append([]int(nil), mapping...)
	return &Transform{
		SourceAlleles: sourceAlleles,
		TargetAlleles: targetAlleles,
		Ploidy:        ploidy,
		mapping:       mappingCopy,
	}, nil
}

// Mapping returns a copy of the source-to-target mapping.
func (t *Transform) Mapping() []int {
	return append([]int(nil), t.mapping...)
}

// MapAllele projects one source allele. The boolean is false when the allele
// is dropped.
func (t *Transform) MapAllele(source int) (target int, retained bool) {
	if source < 0 || source >= len(t.mapping) || t.mapping[source] == Drop {
		return Drop, false
	}
	return t.mapping[source], true
}

// SourceCount returns C(SourceAlleles+Ploidy-1, Ploidy).
func (t *Transform) SourceCount() *big.Int {
	return binomial(t.SourceAlleles+t.Ploidy-1, t.Ploidy)
}

// TargetCount returns C(TargetAlleles+Ploidy-1, Ploidy).
func (t *Transform) TargetCount() *big.Int {
	return binomial(t.TargetAlleles+t.Ploidy-1, t.Ploidy)
}

// RankSource ranks a tuple in the source space and rejects out-of-range alleles.
func (t *Transform) RankSource(tuple []int) (*big.Int, error) {
	rank, err := Rank(tuple, t.Ploidy)
	if err != nil {
		return nil, err
	}
	for i, allele := range tuple {
		if allele >= t.SourceAlleles {
			return nil, fmt.Errorf("%w: allele %d at position %d is outside [0,%d)", ErrInvalidTuple, allele, i, t.SourceAlleles)
		}
	}
	return rank, nil
}

// UnrankSource resolves a rank in the source combination space.
func (t *Transform) UnrankSource(rank *big.Int) ([]int, error) {
	return Unrank(t.SourceAlleles, t.Ploidy, rank)
}

// UnrankTarget resolves a rank in the target combination space.
func (t *Transform) UnrankTarget(rank *big.Int) ([]int, error) {
	return Unrank(t.TargetAlleles, t.Ploidy, rank)
}
