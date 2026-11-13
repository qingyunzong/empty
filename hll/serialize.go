package hll

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Stable binary format (little-endian, deterministic):
//
//	offset 0:  magic "H1"          (2 bytes)
//	offset 2:  format version = 1  (1 byte)
//	offset 3:  encoding 0=dense    (1 byte)
//	                  1=sparse
//	offset 4:  precision p         (1 byte)
//	offset 5:  reserved, must be 0 (1 byte)
//	offset 6:  hash seed           (8 bytes)
//	offset 14: payload
//
// Dense payload: exactly 1<<p register bytes.
// Sparse payload: uint32 count, then count uint32 values in ascending order.
const (
	magic0, magic1 = 'H', '1'
	formatVersion  = 1
	headerSize     = 14

	encDense  = 0
	encSparse = 1
)

// ErrInvalidEncoding is returned by UnmarshalBinary for malformed input.
var ErrInvalidEncoding = errors.New("hll: invalid serialized sketch")

// MarshalBinary serializes the sketch into the stable binary format.
func (s *Sketch) MarshalBinary() ([]byte, error) {
	var out []byte
	if s.sparse {
		out = make([]byte, headerSize, headerSize+4+4*s.tmpSet.len())
		out[3] = encSparse
	} else {
		out = make([]byte, headerSize, headerSize+len(s.regs))
		out[3] = encDense
	}
	out[0], out[1], out[2] = magic0, magic1, formatVersion
	out[4] = s.p
	binary.LittleEndian.PutUint64(out[6:14], s.seed)
	if s.sparse {
		var cnt [4]byte
		binary.LittleEndian.PutUint32(cnt[:], uint32(s.tmpSet.len()))
		out = append(out, cnt[:]...)
		var buf [4]byte
		for _, v := range s.tmpSet.vals {
			binary.LittleEndian.PutUint32(buf[:], v)
			out = append(out, buf[:]...)
		}
	} else {
		out = append(out, s.regs...)
	}
	return out, nil
}

// UnmarshalBinary loads a sketch produced by MarshalBinary.
func (s *Sketch) UnmarshalBinary(data []byte) error {
	if len(data) < headerSize {
		return ErrInvalidEncoding
	}
	if data[0] != magic0 || data[1] != magic1 || data[2] != formatVersion || data[5] != 0 {
		return ErrInvalidEncoding
	}
	p := data[4]
	if p < MinPrecision || p > MaxPrecision {
		return fmt.Errorf("hll: serialized precision %d out of range", p)
	}
	seed := binary.LittleEndian.Uint64(data[6:14])
	body := data[headerSize:]

	next := &Sketch{p: p, seed: seed}
	switch data[3] {
	case encDense:
		if len(body) != 1<<p {
			return ErrInvalidEncoding
		}
		next.regs = make([]uint8, 1<<p)
		copy(next.regs, body)
	case encSparse:
		if len(body) < 4 {
			return ErrInvalidEncoding
		}
		n := binary.LittleEndian.Uint32(body[:4])
		body = body[4:]
		if uint64(n)*4 != uint64(len(body)) {
			return ErrInvalidEncoding
		}
		l := newSparseList()
		l.vals = make([]uint32, n)
		for i := range l.vals {
			l.vals[i] = binary.LittleEndian.Uint32(body[i*4:])
		}
		next.sparse = true
		next.tmpSet = l
	default:
		return ErrInvalidEncoding
	}
	*s = *next
	return nil
}

// Equal reports whether both sketches hold identical state. It is used to
// verify merge commutativity and serialization round-trips.
func (s *Sketch) Equal(o *Sketch) bool {
	if s.p != o.p || s.seed != o.seed || s.sparse != o.sparse {
		return false
	}
	if s.sparse {
		if len(s.tmpSet.vals) != len(o.tmpSet.vals) {
			return false
		}
		for i, v := range s.tmpSet.vals {
			if v != o.tmpSet.vals[i] {
				return false
			}
		}
		return true
	}
	if len(s.regs) != len(o.regs) {
		return false
	}
	for i, r := range s.regs {
		if r != o.regs[i] {
			return false
		}
	}
	return true
}
