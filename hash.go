package dataeng

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash"
)

// HashFunc is the host-supplied deterministic mapping for one identifier.
//
// It must return exactly k indices, where k is len(seeds), and every index
// must be in [0, cells). The k indices must be distinct for the same ID. The
// returned check value is the 64-bit check for that ID. A nil function, a
// wrong index count, duplicate indices, or out-of-range indices rejects the
// operation rather than being repaired or ignored.
//
// The seeds slice is owned by the package and must not be modified by the
// function. The same SchemeID is the host's assertion that two tables use the
// same mapping contract.
type HashFunc func(id uint64, seeds []uint64, cells int) (indices []int, check uint64)

// Config identifies one IBLT summary layout.
//
// Cells must be positive. Seeds must contain between 1 and Cells distinct
// values. SchemeID identifies the host hash mapping. Config comparison for
// subtraction and resumption covers Cells, the ordered seed list, and
// SchemeID.
type Config struct {
	Cells    int
	Seeds    []uint64
	SchemeID string
	Hash     HashFunc
}

// Validate checks the configuration and its host hash function presence.
func (c Config) Validate() error {
	if c.Cells <= 0 {
		return fmt.Errorf("%w: cells must be positive, got %d", ErrInvalidConfig, c.Cells)
	}
	if len(c.Seeds) == 0 {
		return fmt.Errorf("%w: seeds must not be empty", ErrInvalidConfig)
	}
	if len(c.Seeds) > c.Cells {
		return fmt.Errorf("%w: %d seeds exceed %d cells", ErrInvalidConfig, len(c.Seeds), c.Cells)
	}

	seen := make(map[uint64]struct{}, len(c.Seeds))
	for i, seed := range c.Seeds {
		if _, ok := seen[seed]; ok {
			return fmt.Errorf("%w: seed %d is repeated at position %d", ErrInvalidConfig, seed, i)
		}
		seen[seed] = struct{}{}
	}
	if c.SchemeID == "" {
		return fmt.Errorf("%w: scheme ID must not be empty", ErrInvalidConfig)
	}
	if c.Hash == nil {
		return fmt.Errorf("%w: host hash function is nil", ErrInvalidConfig)
	}
	return nil
}

// Fingerprint returns a stable SHA-256 fingerprint of the identifying
// configuration: cell count, ordered seeds, and scheme ID.
func (c Config) Fingerprint() [32]byte {
	return fingerprintConfig(c)
}

func (c Config) sameIdentity(other Config) bool {
	if c.Cells != other.Cells || c.SchemeID != other.SchemeID || len(c.Seeds) != len(other.Seeds) {
		return false
	}
	for i := range c.Seeds {
		if c.Seeds[i] != other.Seeds[i] {
			return false
		}
	}
	return true
}

func cloneConfig(c Config) Config {
	out := c
	out.Seeds = append([]uint64(nil), c.Seeds...)
	return out
}

func (c Config) mapID(id uint64) ([]int, uint64, error) {
	if c.Hash == nil {
		return nil, 0, fmt.Errorf("%w: host hash function is nil", ErrInvalidConfig)
	}
	indices, check := c.Hash(id, c.Seeds, c.Cells)
	if len(indices) != len(c.Seeds) {
		return nil, 0, fmt.Errorf("%w: ID %d returned %d indices, want %d",
			ErrInvalidHashOutput, id, len(indices), len(c.Seeds))
	}

	out := make([]int, len(indices))
	seen := make(map[int]struct{}, len(indices))
	for i, index := range indices {
		if index < 0 || index >= c.Cells {
			return nil, 0, fmt.Errorf("%w: ID %d returned index %d outside [0,%d)",
				ErrInvalidHashOutput, id, index, c.Cells)
		}
		if _, ok := seen[index]; ok {
			return nil, 0, fmt.Errorf("%w: ID %d returned duplicate index %d",
				ErrInvalidHashOutput, id, index)
		}
		seen[index] = struct{}{}
		out[i] = index
	}
	return out, check, nil
}

func fingerprintConfig(c Config) [32]byte {
	h := sha256.New()
	writeBytes(h, []byte("dataeng-iblt-config/v1"))
	writeUint64(h, uint64(c.Cells))
	writeUint64(h, uint64(len(c.Seeds)))
	for _, seed := range c.Seeds {
		writeUint64(h, seed)
	}
	writeBytes(h, []byte(c.SchemeID))
	return sum32(h)
}

func writeUint64(h hash.Hash, value uint64) {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], value)
	_, _ = h.Write(buf[:])
}

func writeBytes(h hash.Hash, value []byte) {
	writeUint64(h, uint64(len(value)))
	_, _ = h.Write(value)
}

func sum32(h hash.Hash) [32]byte {
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}
