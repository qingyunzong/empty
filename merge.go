package dataeng

import "fmt"

// Merge combines independently sampled reservoirs into one reservoir with the
// same capacity. Because every record's priority depends only on its ID and
// weight, the merged result is exactly the same as sampling the union centrally.
// All inputs must have the same capacity.
func Merge(reservoirs ...*Reservoir) (*Reservoir, error) {
	if len(reservoirs) == 0 {
		return nil, ErrNoReservoirs
	}

	k := -1
	for _, shard := range reservoirs {
		if shard == nil {
			return nil, ErrNilReservoir
		}
		shardK := shard.K()
		if shardK <= 0 {
			return nil, fmt.Errorf("%w: %d", ErrInvalidK, shardK)
		}
		if k == -1 {
			k = shardK
			continue
		}
		if shardK != k {
			return nil, fmt.Errorf("%w: %d and %d", ErrIncompatibleK, k, shardK)
		}
	}

	return MergeK(k, reservoirs...)
}

// MergeReservoirs is an alias for Merge.
func MergeReservoirs(reservoirs ...*Reservoir) (*Reservoir, error) {
	return Merge(reservoirs...)
}

// MergeK merges reservoirs into an output reservoir of capacity k.
//
// Each input must have retained at least k records' worth of capacity (that is,
// its K must be at least k). Otherwise the input may already have discarded a
// record that belongs in the global top K, so MergeK returns
// ErrInsufficientShardK instead of silently producing a biased result.
func MergeK(k int, reservoirs ...*Reservoir) (*Reservoir, error) {
	if k <= 0 {
		return nil, fmt.Errorf("%w: %d", ErrInvalidK, k)
	}
	if len(reservoirs) == 0 {
		return nil, ErrNoReservoirs
	}
	for _, shard := range reservoirs {
		if shard == nil {
			return nil, ErrNilReservoir
		}
		if shard.K() < k {
			return nil, fmt.Errorf("%w: shard %d, merge %d", ErrInsufficientShardK, shard.K(), k)
		}
	}

	out := New(k)
	for _, shard := range reservoirs {
		for _, rec := range shard.TopK() {
			if err := out.AddRecord(rec); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

// MergeWithCapacity is an alias for MergeK.
func MergeWithCapacity(k int, reservoirs ...*Reservoir) (*Reservoir, error) {
	return MergeK(k, reservoirs...)
}

// MergeRecords merges reservoirs and returns the resulting top records.
func MergeRecords(reservoirs ...*Reservoir) ([]Record, error) {
	merged, err := Merge(reservoirs...)
	if err != nil {
		return nil, err
	}
	return merged.TopK(), nil
}

// Select performs one centralized weighted sample of records and returns the
// top k. Existing Priority fields are ignored and recomputed.
func Select(k int, records []Record) ([]Record, error) {
	r, err := NewChecked(k)
	if err != nil {
		return nil, err
	}
	if err := r.AddAll(records); err != nil {
		return nil, err
	}
	return r.TopK(), nil
}

// Sample is an alias for Select.
func Sample(k int, records []Record) ([]Record, error) {
	return Select(k, records)
}

// TopK is an alias for Select.
func TopK(k int, records []Record) ([]Record, error) {
	return Select(k, records)
}

// SampleShards samples each shard independently, then merges the shard
// reservoirs. It is equivalent to Select on the concatenation of all shards.
func SampleShards(k int, shards [][]Record) ([]Record, error) {
	if k <= 0 {
		return nil, fmt.Errorf("%w: %d", ErrInvalidK, k)
	}
	reservoirs := make([]*Reservoir, 0, len(shards))
	for _, shard := range shards {
		r, err := NewChecked(k)
		if err != nil {
			return nil, err
		}
		if err := r.AddAll(shard); err != nil {
			return nil, err
		}
		reservoirs = append(reservoirs, r)
	}
	if len(reservoirs) == 0 {
		return []Record{}, nil
	}
	merged, err := MergeK(k, reservoirs...)
	if err != nil {
		return nil, err
	}
	return merged.TopK(), nil
}
