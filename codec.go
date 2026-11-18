package formal

import (
	"bytes"
	"errors"
	"fmt"
)

var (
	// ErrInvalidConfig reports an invalid data/parity shard count.
	ErrInvalidConfig = errors.New("formal: invalid codec configuration")
	// ErrInvalidDataSize reports data that cannot be split into equal shards.
	ErrInvalidDataSize = errors.New("formal: data size is not a multiple of the data shard count")
	// ErrInvalidShardCount reports a shard slice of the wrong length.
	ErrInvalidShardCount = errors.New("formal: invalid shard count")
	// ErrInvalidShardSize reports shards with inconsistent lengths.
	ErrInvalidShardSize = errors.New("formal: inconsistent shard size")
	// ErrTooFewShards reports an erasure pattern with fewer than k shards.
	ErrTooFewShards = errors.New("formal: too few shards to reconstruct")
	// ErrInvalidDataLen reports a negative or impossible original data length.
	ErrInvalidDataLen = errors.New("formal: invalid original data length")
)

// Codec is a systematic Reed-Solomon erasure code over GF(2^8).  A stripe is
// split into DataShards data shards and ParityShards parity shards.  Any
// DataShards shards, in any combination of data and parity positions, are
// sufficient to reconstruct the complete stripe.
type Codec struct {
	dataShards         int
	parityShards       int
	totalShards        int
	parityCoefficients [][]byte
}

// New constructs a systematic (dataShards, parityShards) Reed-Solomon codec.
//
// Both counts must be positive and their sum must not exceed 256, the number
// of non-zero/non-repeating positions available in GF(2^8).
func New(dataShards, parityShards int) (*Codec, error) {
	if dataShards < 1 {
		return nil, fmt.Errorf("%w: data shards must be at least 1", ErrInvalidConfig)
	}
	if parityShards < 1 {
		return nil, fmt.Errorf("%w: parity shards must be at least 1", ErrInvalidConfig)
	}
	total := dataShards + parityShards
	if total > 256 {
		return nil, fmt.Errorf("%w: %d+%d shards exceeds the GF(2^8) limit of 256", ErrInvalidConfig, dataShards, parityShards)
	}
	return &Codec{
		dataShards:         dataShards,
		parityShards:       parityShards,
		totalShards:        total,
		parityCoefficients: cauchyCoefficients(dataShards, parityShards),
	}, nil
}

// NewCodec is an alias for New.
func NewCodec(dataShards, parityShards int) (*Codec, error) {
	return New(dataShards, parityShards)
}

// DataShards returns k.
func (c *Codec) DataShards() int { return c.dataShards }

// ParityShards returns m.
func (c *Codec) ParityShards() int { return c.parityShards }

// TotalShards returns k+m.
func (c *Codec) TotalShards() int { return c.totalShards }

// ShardSize returns the number of bytes in every shard for an object of
// dataLen bytes.  The final data shard is zero padded when dataLen is not a
// multiple of DataShards.
func (c *Codec) ShardSize(dataLen int) int {
	if dataLen <= 0 {
		return 0
	}
	return (dataLen + c.dataShards - 1) / c.dataShards
}

// Encode splits data into DataShards contiguous shards and computes
// ParityShards parity shards.  len(data) must be a multiple of DataShards;
// use EncodePadded for arbitrary object sizes.  The returned shards do not
// alias data.
func (c *Codec) Encode(data []byte) ([][]byte, error) {
	if len(data)%c.dataShards != 0 {
		return nil, fmt.Errorf("%w: %d bytes for %d data shards", ErrInvalidDataSize, len(data), c.dataShards)
	}
	return c.EncodePadded(data)
}

// EncodePadded splits data into DataShards contiguous shards, zero pads the
// final shard when necessary, and computes the parity shards.  Every returned
// shard has length ShardSize(len(data)).
func (c *Codec) EncodePadded(data []byte) ([][]byte, error) {
	shardSize := c.ShardSize(len(data))
	shards := make([][]byte, c.totalShards)
	for i := range shards {
		shards[i] = make([]byte, shardSize)
	}

	for j := 0; j < c.dataShards; j++ {
		start := j * shardSize
		if start >= len(data) {
			break
		}
		end := start + shardSize
		if end > len(data) {
			end = len(data)
		}
		copy(shards[j], data[start:end])
	}

	c.encodeParity(shards)
	return shards, nil
}

func (c *Codec) encodeParity(shards [][]byte) {
	for i := 0; i < c.parityShards; i++ {
		out := shards[c.dataShards+i]
		for j := 0; j < c.dataShards; j++ {
			gfMulAdd(out, shards[j], c.parityCoefficients[i][j])
		}
	}
}

// Reconstruct fills every missing shard in place.  A nil shard is missing; a
// non-nil zero-length slice is only meaningful for an empty stripe.  At least
// DataShards shards must be present, and all present shards must have the same
// length.
//
// Reconstruct trusts the present shards.  It repairs erasures, not
// corruption; use Verify when shards may have been damaged.
func (c *Codec) Reconstruct(shards [][]byte) error {
	if len(shards) != c.totalShards {
		return fmt.Errorf("%w: got %d, want %d", ErrInvalidShardCount, len(shards), c.totalShards)
	}

	present := make([]int, 0, c.totalShards)
	shardSize := -1
	emptyShards := 0
	for i, shard := range shards {
		if shard == nil {
			continue
		}
		if len(shard) == 0 {
			emptyShards++
			continue
		}
		if shardSize < 0 {
			shardSize = len(shard)
		} else if len(shard) != shardSize {
			return fmt.Errorf("%w: shard %d has %d bytes, want %d", ErrInvalidShardSize, i, len(shard), shardSize)
		}
		present = append(present, i)
	}

	// A zero-length stripe is only valid when every position is a present,
	// non-nil empty shard.
	if shardSize < 0 {
		if emptyShards == c.totalShards {
			return nil
		}
		return fmt.Errorf("%w: empty stripe and %d missing positions", ErrTooFewShards, c.totalShards-emptyShards)
	}
	if len(present) < c.dataShards {
		return fmt.Errorf("%w: have %d of %d required", ErrTooFewShards, len(present), c.dataShards)
	}
	if len(present) == c.totalShards {
		return nil
	}

	// Build the k x k submatrix formed by the rows that are present.
	submatrix := make([][]byte, c.dataShards)
	for r := 0; r < c.dataShards; r++ {
		submatrix[r] = c.generatorRow(present[r])
	}
	inverse, err := invertMatrix(submatrix)
	if err != nil {
		return fmt.Errorf("formal: cannot invert reconstruction matrix: %w", err)
	}

	// Recover the original data shards from the selected rows.
	recoveredData := make([][]byte, c.dataShards)
	for j := 0; j < c.dataShards; j++ {
		out := make([]byte, shardSize)
		for r := 0; r < c.dataShards; r++ {
			gfMulAdd(out, shards[present[r]], inverse[j][r])
		}
		recoveredData[j] = out
	}

	for j := 0; j < c.dataShards; j++ {
		if len(shards[j]) == 0 {
			shards[j] = recoveredData[j]
		}
	}

	// Any missing parity shard is recomputed from the now-complete data.
	for i := 0; i < c.parityShards; i++ {
		index := c.dataShards + i
		if len(shards[index]) != 0 {
			continue
		}
		out := make([]byte, shardSize)
		for j := 0; j < c.dataShards; j++ {
			gfMulAdd(out, shards[j], c.parityCoefficients[i][j])
		}
		shards[index] = out
	}

	return nil
}

// ReconstructData reconstructs the stripe and returns exactly dataLen bytes of
// original object data.  This removes the zero padding introduced by
// EncodePadded.  shards are modified in place just like Reconstruct.
func (c *Codec) ReconstructData(shards [][]byte, dataLen int) ([]byte, error) {
	if dataLen < 0 {
		return nil, fmt.Errorf("%w: %d", ErrInvalidDataLen, dataLen)
	}
	if len(shards) != c.totalShards {
		return nil, fmt.Errorf("%w: got %d, want %d", ErrInvalidShardCount, len(shards), c.totalShards)
	}
	if dataLen == 0 {
		return []byte{}, nil
	}

	expected := c.ShardSize(dataLen)
	for i, shard := range shards {
		if len(shard) == 0 {
			continue
		}
		if len(shard) != expected {
			return nil, fmt.Errorf("%w: shard %d has %d bytes, want %d", ErrInvalidShardSize, i, len(shard), expected)
		}
	}
	if err := c.Reconstruct(shards); err != nil {
		return nil, err
	}
	for j := 0; j < c.dataShards; j++ {
		if len(shards[j]) != expected {
			return nil, fmt.Errorf("%w: reconstructed data shard %d has %d bytes, want %d",
				ErrInvalidShardSize, j, len(shards[j]), expected)
		}
	}

	out := make([]byte, 0, c.dataShards*expected)
	for j := 0; j < c.dataShards; j++ {
		out = append(out, shards[j]...)
	}
	return out[:dataLen], nil
}

// Decode reconstructs any missing shards and returns the concatenated data
// shards.  When the object was encoded with EncodePadded, the returned slice
// still contains the zero padding; use ReconstructData to recover the exact
// object bytes.
func (c *Codec) Decode(shards [][]byte) ([]byte, error) {
	if err := c.Reconstruct(shards); err != nil {
		return nil, err
	}
	if len(shards[0]) == 0 {
		return []byte{}, nil
	}
	out := make([]byte, 0, c.dataShards*len(shards[0]))
	for j := 0; j < c.dataShards; j++ {
		out = append(out, shards[j]...)
	}
	return out, nil
}

// Verify recomputes every parity shard and compares it with the stored parity.
// It requires all n shards to be present.  A false result with a nil error
// means the stripe is internally inconsistent.
func (c *Codec) Verify(shards [][]byte) (bool, error) {
	if len(shards) != c.totalShards {
		return false, fmt.Errorf("%w: got %d, want %d", ErrInvalidShardCount, len(shards), c.totalShards)
	}

	if len(shards[0]) == 0 {
		for i, shard := range shards {
			if shard == nil {
				return false, fmt.Errorf("%w: shard %d is missing", ErrTooFewShards, i)
			}
			if len(shard) != 0 {
				return false, fmt.Errorf("%w: shard %d is empty but others are not", ErrInvalidShardSize, i)
			}
		}
		return true, nil
	}

	size := len(shards[0])
	for i, shard := range shards {
		if len(shard) == 0 {
			return false, fmt.Errorf("%w: shard %d is missing", ErrTooFewShards, i)
		}
		if len(shard) != size {
			return false, fmt.Errorf("%w: shard %d has %d bytes, want %d", ErrInvalidShardSize, i, len(shard), size)
		}
	}

	expected := make([]byte, size)
	for i := 0; i < c.parityShards; i++ {
		for x := range expected {
			expected[x] = 0
		}
		for j := 0; j < c.dataShards; j++ {
			gfMulAdd(expected, shards[j], c.parityCoefficients[i][j])
		}
		if !bytes.Equal(expected, shards[c.dataShards+i]) {
			return false, nil
		}
	}
	return true, nil
}
