// Package dataeng implements a multi-precision HyperLogLog-style distinct
// count sketch whose precision may only be reduced.
//
// A sketch is parameterised by a precision p (4..18) and a host-supplied
// deterministic 64-bit hash function. The top p bits of a hash select a
// register and the position of the first set bit, scanning the remaining
// 64-p bits from most to least significant, is rho (rho equals 65-p when
// those bits are all zero). Registers start at zero and updates keep the
// maximum observed value.
//
// Sketches are not safe for concurrent use. All counts returned by Estimate
// are approximate unless the sketch is empty; an empty sketch returns zero
// exactly.
package dataeng

import (
	"errors"
	"fmt"
	"math"
	"math/bits"
)

const (
	minPrecision = 4
	maxPrecision = 18
)

// Hasher maps an input to a deterministic 64-bit hash. The same input must
// always produce the same hash within a hash scheme identified by HashID.
type Hasher func(value []byte) uint64

// Config configures a new Sketch.
type Config struct {
	// Precision is p in [4, 18]; the sketch holds 2^p registers.
	Precision int
	// HashID identifies the hash scheme. Sketches with different IDs can
	// never be merged.
	HashID string
	// Hasher is the host-supplied deterministic 64-bit hash function.
	Hasher Hasher
	// SparseThreshold is the number of non-zero registers at which the
	// sketch permanently converts from sparse to dense representation. It
	// must be in [1, 2^p].
	SparseThreshold int
}

// Sketch is a multi-precision distinct count sketch. It retains only the
// standard rho register state, never original keys or hash values.
type Sketch struct {
	p         int
	hashID    string
	hasher    Hasher
	threshold int
	dense     bool
	sparse    map[uint32]uint8
	registers []uint8
}

// New validates the configuration and returns an empty sketch.
func New(cfg Config) (*Sketch, error) {
	if cfg.Precision < minPrecision || cfg.Precision > maxPrecision {
		return nil, fmt.Errorf("dataeng: precision %d out of range [%d, %d]", cfg.Precision, minPrecision, maxPrecision)
	}
	if cfg.Hasher == nil {
		return nil, errors.New("dataeng: nil hasher")
	}
	if cfg.HashID == "" {
		return nil, errors.New("dataeng: empty hash scheme id")
	}
	m := 1 << cfg.Precision
	if cfg.SparseThreshold < 1 || cfg.SparseThreshold > m {
		return nil, fmt.Errorf("dataeng: sparse threshold %d out of range [1, %d]", cfg.SparseThreshold, m)
	}
	return &Sketch{
		p:         cfg.Precision,
		hashID:    cfg.HashID,
		hasher:    cfg.Hasher,
		threshold: cfg.SparseThreshold,
		sparse:    make(map[uint32]uint8),
	}, nil
}

// Precision returns p.
func (s *Sketch) Precision() int { return s.p }

// HashID returns the host-supplied hash scheme identifier.
func (s *Sketch) HashID() string { return s.hashID }

// SparseThreshold returns the configured non-zero register conversion
// threshold.
func (s *Sketch) SparseThreshold() int { return s.threshold }

// IsDense reports whether the sketch has converted to dense representation.
func (s *Sketch) IsDense() bool { return s.dense }

// NonZeroCount returns the number of registers currently holding a non-zero
// value.
func (s *Sketch) NonZeroCount() int {
	if s.dense {
		count := 0
		for _, r := range s.registers {
			if r != 0 {
				count++
			}
		}
		return count
	}
	return len(s.sparse)
}

// registerIndex returns the top p bits of h.
func registerIndex(h uint64, p int) uint32 {
	return uint32(h >> (64 - p))
}

// rankAt returns rho computed for precision q: the 1-based position of the
// first set bit among the low 64-q bits of h, scanning from most to least
// significant, or 65-q when all those bits are zero.
func rankAt(h uint64, q int) uint8 {
	const allBits uint64 = 1<<64 - 1
	tail := h & (allBits >> q)
	if tail == 0 {
		return uint8(65 - q)
	}
	return uint8(bits.LeadingZeros64(tail) - q + 1)
}

// Add hashes value and updates the sketch.
func (s *Sketch) Add(value []byte) {
	s.AddHash(s.hasher(value))
}

// AddHash updates the sketch with an already computed hash.
func (s *Sketch) AddHash(h uint64) {
	s.put(registerIndex(h, s.p), rankAt(h, s.p))
}

// put stores rho at idx, keeping the maximum and converting sparse to dense
// once the configured threshold is reached.
func (s *Sketch) put(idx uint32, rho uint8) {
	if s.dense {
		if rho > s.registers[idx] {
			s.registers[idx] = rho
		}
		return
	}
	if current, ok := s.sparse[idx]; ok {
		if rho > current {
			s.sparse[idx] = rho
		}
		return
	}
	if len(s.sparse) >= s.threshold {
		s.toDense()
		s.registers[idx] = rho
		return
	}
	s.sparse[idx] = rho
}

// toDense performs the one-way sparse to dense conversion.
func (s *Sketch) toDense() {
	registers := make([]uint8, 1<<s.p)
	for idx, rho := range s.sparse {
		registers[idx] = rho
	}
	s.registers = registers
	s.dense = true
	s.sparse = nil
}

// Registers returns a copy of the canonical register sequence R[0..2^p-1].
// Sparse and dense representations return identical sequences.
func (s *Sketch) Registers() []uint8 {
	out := make([]uint8, 1<<s.p)
	if s.dense {
		copy(out, s.registers)
		return out
	}
	for idx, rho := range s.sparse {
		out[idx] = rho
	}
	return out
}

// Merge folds other into the receiver without modifying other. The receiver
// precision never changes: other must share the receiver hash scheme and be
// at the same precision, or at a higher precision that can be reduced to the
// receiver's. Use Union for a mixed-precision merge whose result follows the
// smallest precision.
func (s *Sketch) Merge(other *Sketch) error {
	if other == nil {
		return errors.New("dataeng: cannot merge nil sketch")
	}
	if s == other {
		return nil
	}
	if s.hashID != other.hashID {
		return fmt.Errorf("dataeng: hash scheme mismatch: %q vs %q", s.hashID, other.hashID)
	}
	if other.p < s.p {
		return fmt.Errorf("dataeng: cannot raise precision %d from %d; reduce the target first", s.p, other.p)
	}

	source := other.Registers()
	if other.p > s.p {
		source = downcastRegisters(source, other.p, s.p)
	}
	for idx, rho := range source {
		if rho != 0 {
			s.put(uint32(idx), rho)
		}
	}
	return nil
}

// Downcast returns an independent sketch at precision targetP. targetP must
// be in [4, p]; precision is never raised. Every resulting register equals
// the register produced by feeding the same hash stream directly into a
// sketch built at targetP. The receiver is not modified. The new sketch
// follows the receiver threshold, clamped to the target register count.
func (s *Sketch) Downcast(targetP int) (*Sketch, error) {
	if targetP < minPrecision || targetP > s.p {
		return nil, fmt.Errorf("dataeng: target precision %d out of range [%d, %d]", targetP, minPrecision, s.p)
	}
	target, err := New(Config{
		Precision:       targetP,
		HashID:          s.hashID,
		Hasher:          s.hasher,
		SparseThreshold: clampThreshold(s.threshold, targetP),
	})
	if err != nil {
		return nil, err
	}
	reduced := downcastRegisters(s.Registers(), s.p, targetP)
	for idx, rho := range reduced {
		if rho != 0 {
			target.put(uint32(idx), rho)
		}
	}
	return target, nil
}

func clampThreshold(threshold, p int) int {
	m := 1 << p
	if threshold > m {
		return m
	}
	return threshold
}

// downcastRegisters reduces a canonical register sequence from precision
// fromP to precision toP (toP <= fromP) and returns the exact sequence a
// sketch built at toP would hold for the same hash stream.
//
// Let d = fromP-toP be the number of discarded top-index bits. Within a
// target group:
//   - offset 0 means the discarded bits were all zero, so its low-precision
//     rho is the stored rho plus d;
//   - every observed non-zero offset places the first set bit inside the
//     discarded d bits. If bitLen(offset) is k, the first set bit is the
//     (d+1-k)-th bit when scanning those d bits from the top, so its rank is
//     d+1-k. Smaller offsets therefore dominate, and only the smallest
//     observed non-zero offset is needed.
//
// Only the standard rho register array is used; no original key or hash is
// retained.
func downcastRegisters(registers []uint8, fromP, toP int) []uint8 {
	if toP == fromP {
		out := make([]uint8, len(registers))
		copy(out, registers)
		return out
	}
	d := fromP - toP
	groupCount := 1 << toP
	out := make([]uint8, groupCount)
	for group := 0; group < groupCount; group++ {
		base := group << d
		var best uint8
		minNonZero := -1
		for offset := 0; offset < 1<<d; offset++ {
			if registers[base+offset] == 0 {
				continue
			}
			if offset == 0 {
				if candidate := registers[base] + uint8(d); candidate > best {
					best = candidate
				}
				continue
			}
			if minNonZero == -1 || offset < minNonZero {
				minNonZero = offset
			}
		}
		if minNonZero != -1 {
			if candidate := uint8(d + 1 - bits.Len(uint(minNonZero))); candidate > best {
				best = candidate
			}
		}
		out[group] = best
	}
	return out
}

// Union returns a new sketch merging the inputs at the smallest precision
// among them. Inputs must share one hash scheme; none of them is modified.
// The result uses the hasher and threshold of the minimum-precision input,
// clamping the threshold to its register count.
func Union(sketches ...*Sketch) (*Sketch, error) {
	if len(sketches) == 0 {
		return nil, errors.New("dataeng: union requires at least one sketch")
	}
	base := sketches[0]
	for _, sk := range sketches[1:] {
		if sk == nil {
			return nil, errors.New("dataeng: cannot union nil sketch")
		}
		if sk.hashID != base.hashID {
			return nil, fmt.Errorf("dataeng: hash scheme mismatch: %q vs %q", base.hashID, sk.hashID)
		}
		if sk.p < base.p {
			base = sk
		}
	}

	result, err := New(Config{
		Precision:       base.p,
		HashID:          base.hashID,
		Hasher:          base.hasher,
		SparseThreshold: clampThreshold(base.threshold, base.p),
	})
	if err != nil {
		return nil, err
	}
	for _, sk := range sketches {
		if err := result.Merge(sk); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// alpha returns the precision correction constant for m registers.
func alpha(m int) float64 {
	switch m {
	case 16:
		return 0.673
	case 32:
		return 0.697
	case 64:
		return 0.709
	default:
		return 0.7213 / (1 + 1.079/float64(m))
	}
}

// Estimate returns the approximate distinct count. An empty sketch returns
// zero exactly; every other returned value is an approximation. The small
// range linear-counting correction is applied when E <= 2.5m and at least
// one register is empty; no other corrections are performed.
func (s *Sketch) Estimate() float64 {
	m := 1 << s.p
	registers := s.Registers()
	sum := 0.0
	zeros := 0
	for _, r := range registers {
		sum += 1.0 / float64(uint64(1)<<r)
		if r == 0 {
			zeros++
		}
	}
	if zeros == m {
		return 0
	}
	e := alpha(m) * float64(m) * float64(m) / sum
	if e <= 2.5*float64(m) && zeros > 0 {
		return float64(m) * math.Log(float64(m)/float64(zeros))
	}
	return e
}
