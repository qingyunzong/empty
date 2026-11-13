package dataeng

import (
	"cmp"
	"errors"
	"fmt"
	"math"
	"sort"
)

var (
	// ErrInvalidArgument reports a non-positive partition count, negative row
	// count, negative sample weight, or non-finite input value.
	ErrInvalidArgument = errors.New("dataeng: invalid argument")

	// ErrNoSamples reports a positive total row count with no positive sample
	// weight from which to estimate a distribution.
	ErrNoSamples = errors.New("dataeng: no weighted samples")

	// ErrExhaustiveTooLarge reports a PlanExhaustive request whose number of
	// candidate boundary placements exceeds the diagnostic enumeration limit.
	ErrExhaustiveTooLarge = errors.New("dataeng: too many boundary combinations")
)

// Sample is one weighted observation. Weight is the estimated number of rows
// represented by Key. It may be a raw count or an inverse-sampling-probability
// weight; only relative weights matter until the final row-count scaling.
type Sample[K cmp.Ordered] struct {
	Key    K
	Weight float64
}

// ShardSamples groups samples collected from one input shard. Name is
// descriptive only; samples from all shards are pooled by key.
type ShardSamples[K cmp.Ordered] struct {
	Name    string
	Samples []Sample[K]
}

// Shard is an alias for ShardSamples.
type Shard[K cmp.Ordered] = ShardSamples[K]

// Partition describes one contiguous range in key order. Lower and Upper are
// inclusive bounds of the observed keys assigned to the range. Empty ranges
// are produced only when fewer distinct keys than requested partitions exist;
// their Empty field is true and their bounds are unspecified (they repeat the
// last observed key for convenience).
type Partition[K cmp.Ordered] struct {
	Index int
	Lower K
	Upper K
	Load  float64
	Keys  int
	Empty bool
}

// RangePlan is the result of range-partition planning.
//
// Boundaries contains P-1 inclusive upper bounds, where P is the requested
// partition count. It is empty when no positive-weight key was observed. A
// partitioner should send a key k to the first range i for which k <=
// Boundaries[i], and to the final range when k exceeds every boundary.
// Boundaries are non-decreasing and are strictly increasing whenever two
// adjacent ranges are non-empty.
type RangePlan[K cmp.Ordered] struct {
	Partitions   []Partition[K]
	Boundaries   []K
	MaxLoad      float64
	TotalLoad    float64
	DistinctKeys int
	TotalRows    int64
}

// Plan combines weighted samples from all shards and plans P contiguous key
// ranges. totalRows scales the pooled sample weights to an estimated row count.
//
// The planner minimizes the largest estimated range load. Duplicate
// observations of one key are merged before planning and are never split
// across ranges. Among all plans with the same minimum maximum load, Plan
// chooses the lexicographically smallest sequence of upper boundaries. That
// tie-break is deterministic and independent of sample and shard order.
//
// If there are fewer distinct positive-weight keys than partitions, each key
// becomes a singleton range and the remaining ranges are empty and trailing.
func Plan[K cmp.Ordered](shards []ShardSamples[K], totalRows int64, partitions int) (RangePlan[K], error) {
	return plan(shards, totalRows, partitions, false)
}

// PlanSamples is Plan for a single, ungrouped sample list.
func PlanSamples[K cmp.Ordered](samples []Sample[K], totalRows int64, partitions int) (RangePlan[K], error) {
	return plan([]ShardSamples[K]{{Samples: samples}}, totalRows, partitions, false)
}

// PlanExhaustive computes the same result as PlanSamples by enumerating every
// possible boundary placement. It is intended only for small domains and for
// checking optimality in tests; its running time is exponential in the number
// of distinct keys. Requests with more than ten million candidate placements
// fail with ErrExhaustiveTooLarge.
func PlanExhaustive[K cmp.Ordered](samples []Sample[K], totalRows int64, partitions int) (RangePlan[K], error) {
	return plan([]ShardSamples[K]{{Samples: samples}}, totalRows, partitions, true)
}

func plan[K cmp.Ordered](shards []ShardSamples[K], totalRows int64, partitions int, forceExhaustive bool) (RangePlan[K], error) {
	if partitions < 1 {
		return RangePlan[K]{}, fmt.Errorf("%w: partitions must be at least 1, got %d", ErrInvalidArgument, partitions)
	}
	if totalRows < 0 {
		return RangePlan[K]{}, fmt.Errorf("%w: totalRows must be non-negative, got %d", ErrInvalidArgument, totalRows)
	}

	keys, weights, sampleTotal, err := aggregate(shards)
	if err != nil {
		return RangePlan[K]{}, err
	}
	if len(keys) == 0 {
		if totalRows > 0 {
			return RangePlan[K]{}, fmt.Errorf("%w: totalRows is %d", ErrNoSamples, totalRows)
		}
		return emptyPlan[K](totalRows, partitions), nil
	}
	if forceExhaustive && partitions > 1 && partitions < len(keys) &&
		!combinationsAtMost(len(keys)-1, partitions-1, maxForcedExhaustiveCombinations) {
		return RangePlan[K]{}, fmt.Errorf(
			"%w: %d keys into %d partitions exceeds the enumeration limit",
			ErrExhaustiveTooLarge, len(keys), partitions,
		)
	}

	ends := chooseEnds(weights, partitions, forceExhaustive)
	return assemblePlan(keys, weights, ends, totalRows, sampleTotal, partitions)
}

func aggregate[K cmp.Ordered](shards []ShardSamples[K]) ([]K, []float64, float64, error) {
	byKey := make(map[K]float64)
	var total float64

	for shardIndex, shard := range shards {
		for sampleIndex, sample := range shard.Samples {
			if math.IsNaN(sample.Weight) || math.IsInf(sample.Weight, 0) {
				return nil, nil, 0, fmt.Errorf(
					"%w: shard %d sample %d has non-finite weight %v",
					ErrInvalidArgument, shardIndex, sampleIndex, sample.Weight,
				)
			}
			if sample.Weight < 0 {
				return nil, nil, 0, fmt.Errorf(
					"%w: shard %d sample %d has negative weight %v",
					ErrInvalidArgument, shardIndex, sampleIndex, sample.Weight,
				)
			}
			if keyIsNaN(sample.Key) {
				return nil, nil, 0, fmt.Errorf(
					"%w: shard %d sample %d has NaN key",
					ErrInvalidArgument, shardIndex, sampleIndex,
				)
			}
			if sample.Weight == 0 {
				continue
			}

			next := byKey[sample.Key] + sample.Weight
			if math.IsInf(next, 0) {
				return nil, nil, 0, fmt.Errorf(
					"%w: weight sum for a key overflowed", ErrInvalidArgument,
				)
			}
			byKey[sample.Key] = next

			total += sample.Weight
			if math.IsInf(total, 0) {
				return nil, nil, 0, fmt.Errorf(
					"%w: total sample weight overflowed", ErrInvalidArgument,
				)
			}
		}
	}

	keys := make([]K, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		return keys[i] < keys[j]
	})

	weights := make([]float64, len(keys))
	for i, key := range keys {
		weights[i] = byKey[key]
	}
	return keys, weights, total, nil
}

func keyIsNaN[K cmp.Ordered](key K) bool {
	switch value := any(key).(type) {
	case float32:
		return math.IsNaN(float64(value))
	case float64:
		return math.IsNaN(value)
	default:
		return false
	}
}

func emptyPlan[K cmp.Ordered](totalRows int64, partitions int) RangePlan[K] {
	result := RangePlan[K]{
		Partitions: make([]Partition[K], partitions),
		TotalRows:  totalRows,
	}
	for i := range result.Partitions {
		result.Partitions[i] = Partition[K]{Index: i, Empty: true}
	}
	return result
}

func assemblePlan[K cmp.Ordered](
	keys []K,
	weights []float64,
	ends []int,
	totalRows int64,
	sampleTotal float64,
	partitions int,
) (RangePlan[K], error) {
	scale := 0.0
	if sampleTotal > 0 {
		scale = float64(totalRows) / sampleTotal
	}

	result := RangePlan[K]{
		Partitions:   make([]Partition[K], partitions),
		DistinctKeys: len(keys),
		TotalRows:    totalRows,
	}

	start := 0
	maxLoad := 0.0
	totalLoad := 0.0
	for group, end := range ends {
		rawLoad := 0.0
		for i := start; i < end; i++ {
			rawLoad += weights[i]
		}
		load := rawLoad * scale
		if math.IsNaN(load) || math.IsInf(load, 0) {
			return RangePlan[K]{}, fmt.Errorf(
				"%w: estimated range load is not finite", ErrInvalidArgument,
			)
		}

		result.Partitions[group] = Partition[K]{
			Index: group,
			Lower: keys[start],
			Upper: keys[end-1],
			Load:  load,
			Keys:  end - start,
		}
		if load > maxLoad {
			maxLoad = load
		}
		totalLoad += load
		start = end
	}

	lastKey := keys[len(keys)-1]
	for group := len(ends); group < partitions; group++ {
		result.Partitions[group] = Partition[K]{
			Index: group,
			Lower: lastKey,
			Upper: lastKey,
			Empty: true,
		}
	}

	if partitions > 1 {
		result.Boundaries = make([]K, 0, partitions-1)
		for group := 0; group < partitions-1; group++ {
			if group < len(ends) {
				result.Boundaries = append(result.Boundaries, keys[ends[group]-1])
			} else {
				result.Boundaries = append(result.Boundaries, lastKey)
			}
		}
	}

	result.MaxLoad = maxLoad
	result.TotalLoad = totalLoad
	return result, nil
}
