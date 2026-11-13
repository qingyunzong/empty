// Package hll implements a HyperLogLog++ cardinality sketch with sparse and
// dense representations, explicit hash seeds, precision reduction and stable
// binary serialization.
//
// The sketch hashes items with XXH64 using a caller-supplied seed. Only
// sketches created with the same seed and precision can be merged. Precision
// can be reduced losslessly via register mapping; increasing precision is
// rejected because it would fabricate information the hash bits no longer
// carry.
package hll

import (
	"errors"
	"fmt"
	"math"
	"math/bits"
)

const (
	// MinPrecision is the smallest supported precision (16 registers).
	MinPrecision = 4
	// MaxPrecision is the largest supported precision (1<<20 registers).
	MaxPrecision = 20
	// sparsePrecision is the precision used to encode sparse values, as in
	// the HLL++ paper. It must stay above MaxPrecision.
	sparsePrecision = 25
)

var (
	// ErrSeedMismatch is returned when merging sketches with different seeds.
	ErrSeedMismatch = errors.New("hll: cannot merge sketches with different seeds")
	// ErrPrecisionMismatch is returned when merging sketches with different
	// precisions. Reduce the higher one with ReducePrecision first.
	ErrPrecisionMismatch = errors.New("hll: cannot merge sketches with different precisions")
	// ErrPrecisionIncrease is returned when asked to raise precision, which
	// would fabricate register information.
	ErrPrecisionIncrease = errors.New("hll: cannot increase precision")
)

// Sketch is a HyperLogLog++ cardinality estimator. It is not safe for
// concurrent use.
type Sketch struct {
	p      uint8
	seed   uint64
	sparse bool
	regs   []uint8     // dense representation, length 1<<p
	tmpSet *sparseList // sparse representation, sorted encoded values
}

// New returns an empty sketch with the given precision and hash seed.
func New(p uint8, seed uint64) (*Sketch, error) {
	if p < MinPrecision || p > MaxPrecision {
		return nil, fmt.Errorf("hll: precision %d out of range [%d, %d]", p, MinPrecision, MaxPrecision)
	}
	return &Sketch{p: p, seed: seed, sparse: true, tmpSet: newSparseList()}, nil
}

// Precision returns the sketch precision p (registers = 1<<p).
func (s *Sketch) Precision() uint8 { return s.p }

// Seed returns the hash seed the sketch was created with.
func (s *Sketch) Seed() uint64 { return s.seed }

// IsSparse reports whether the sketch currently uses the sparse encoding.
func (s *Sketch) IsSparse() bool { return s.sparse }

// Add hashes b with the sketch seed and records it.
func (s *Sketch) Add(b []byte) { s.AddHash(hash64(b, s.seed)) }

// AddHash records a pre-computed 64-bit hash. Callers must only pass hashes
// produced with this sketch's seed, otherwise estimates are meaningless.
func (s *Sketch) AddHash(h uint64) {
	if s.sparse {
		s.tmpSet.add(encodeHash(h, s.p))
		// Convert once the sparse encoding costs more than the dense one.
		if s.tmpSet.len()*4 > 1<<s.p {
			s.toDense()
		}
		return
	}
	idx, rho := densePos(h, s.p)
	if rho > s.regs[idx] {
		s.regs[idx] = rho
	}
}

// densePos computes the register index and rho value for a hash at precision p.
func densePos(h uint64, p uint8) (uint32, uint8) {
	idx := uint32(h >> (64 - p))
	// Sentinel bit guarantees termination for h == 0 patterns.
	rho := uint8(bits.LeadingZeros64((h<<p)|(1<<(p-1))) + 1)
	return idx, rho
}

// toDense converts the sparse representation to dense registers in place.
func (s *Sketch) toDense() {
	regs := make([]uint8, 1<<s.p)
	s.tmpSet.decodeTo(s.p, regs)
	s.regs = regs
	s.tmpSet = nil
	s.sparse = false
}

// Clone returns a deep copy of the sketch.
func (s *Sketch) Clone() *Sketch {
	c := &Sketch{p: s.p, seed: s.seed, sparse: s.sparse}
	if s.sparse {
		c.tmpSet = s.tmpSet.clone()
	} else {
		c.regs = make([]uint8, len(s.regs))
		copy(c.regs, s.regs)
	}
	return c
}

// Merge unions other into s. Both sketches must share the same seed and
// precision. Merging is commutative and associative: the result depends only
// on the set of input sketches, not on merge order.
func (s *Sketch) Merge(other *Sketch) error {
	if s.seed != other.seed {
		return ErrSeedMismatch
	}
	if s.p != other.p {
		return ErrPrecisionMismatch
	}
	switch {
	case s.sparse && other.sparse:
		s.tmpSet.merge(other.tmpSet)
		if s.tmpSet.len()*4 > 1<<s.p {
			s.toDense()
		}
	case !s.sparse && !other.sparse:
		for i, r := range other.regs {
			if r > s.regs[i] {
				s.regs[i] = r
			}
		}
	default:
		// Mixed representations: normalize both to dense.
		if s.sparse {
			s.toDense()
		}
		o := other
		if o.sparse {
			o = other.Clone()
			o.toDense()
		}
		for i, r := range o.regs {
			if r > s.regs[i] {
				s.regs[i] = r
			}
		}
	}
	return nil
}

// ReducePrecision returns a new sketch at precision p2, which must not exceed
// the current precision. Registers are mapped deterministically: each group
// of 2^(p-p2) source registers folds into one target register, recomputing
// rho values from the folded index bits. No information is invented, so the
// result equals a sketch built directly at p2 from the same hashes.
func (s *Sketch) ReducePrecision(p2 uint8) (*Sketch, error) {
	if p2 < MinPrecision || p2 > MaxPrecision {
		return nil, fmt.Errorf("hll: precision %d out of range [%d, %d]", p2, MinPrecision, MaxPrecision)
	}
	if p2 > s.p {
		return nil, ErrPrecisionIncrease
	}
	if p2 == s.p {
		return s.Clone(), nil
	}
	out := &Sketch{p: p2, seed: s.seed, sparse: s.sparse}
	if s.sparse {
		// Sparse values encode 25 hash bits but their flag bit depends on p,
		// so re-encode each value for the lower precision.
		out.tmpSet = newSparseList()
		for _, v := range s.tmpSet.vals {
			out.tmpSet.add(reencode(v, p2))
		}
		if out.tmpSet.len()*4 > 1<<p2 {
			out.toDense()
		}
		return out, nil
	}
	k := s.p - p2
	out.sparse = false
	out.regs = make([]uint8, 1<<p2)
	for i, r := range s.regs {
		if r == 0 {
			continue
		}
		j := uint32(i) >> k
		nr := mapRho(uint32(i), r, k)
		if nr > out.regs[j] {
			out.regs[j] = nr
		}
	}
	return out, nil
}

// mapRho recomputes the rho value of a register when folding k index bits
// back into the hash stream. If any of the folded bits is set, the first set
// bit among them determines the new rho; otherwise the old rho is shifted.
func mapRho(idx uint32, rho uint8, k uint8) uint8 {
	extra := idx & (1<<k - 1)
	if extra != 0 {
		return uint8(k) - uint8(bits.Len32(extra)) + 1
	}
	return uint8(k) + rho
}

// Estimate returns the estimated cardinality.
func (s *Sketch) Estimate() uint64 {
	return uint64(math.Round(s.cardinality()))
}

func (s *Sketch) cardinality() float64 {
	m := float64(uint64(1) << s.p)
	var regs []uint8
	if s.sparse {
		regs = make([]uint8, 1<<s.p)
		s.tmpSet.decodeTo(s.p, regs)
	} else {
		regs = s.regs
	}
	var sum float64
	var zeros float64
	for _, r := range regs {
		sum += math.Ldexp(1, -int(r))
		if r == 0 {
			zeros++
		}
	}
	raw := alpha(uint64(1)<<s.p) * m * m / sum
	// Linear counting for the small-cardinality range (HLL++ small-range
	// correction).
	if raw <= 2.5*m && zeros > 0 {
		return m * math.Log(m/zeros)
	}
	return raw
}

func alpha(m uint64) float64 {
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
