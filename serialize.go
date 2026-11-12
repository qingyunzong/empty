package dataeng

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	formatMagic   = "HLL1"
	formatVersion = 1
	repSparse     = 0
	repDense      = 1
)

// byteReader consumes a fixed byte buffer and reports trailing junk.
type byteReader struct {
	data []byte
	pos  int
}

func (r *byteReader) take(n int) ([]byte, error) {
	if r.pos+n > len(r.data) {
		return nil, errors.New("dataeng: truncated sketch payload")
	}
	chunk := r.data[r.pos : r.pos+n]
	r.pos += n
	return chunk, nil
}

func (r *byteReader) take1() (byte, error) {
	chunk, err := r.take(1)
	if err != nil {
		return 0, err
	}
	return chunk[0], nil
}

func (r *byteReader) takeUint16() (uint16, error) {
	chunk, err := r.take(2)
	if err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint16(chunk), nil
}

func (r *byteReader) takeUint32() (uint32, error) {
	chunk, err := r.take(4)
	if err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint32(chunk), nil
}

// MarshalBinary encodes the format version, precision, hash scheme id, sparse
// threshold and registers. Sparse sketches encode only non-zero entries;
// dense sketches encode the full canonical register sequence.
func (s *Sketch) MarshalBinary() ([]byte, error) {
	m := 1 << s.p
	idBytes := []byte(s.hashID)
	if len(idBytes) > 0xffff {
		return nil, errors.New("dataeng: hash id too long to encode")
	}

	out := make([]byte, 0, 16+m)
	out = append(out, formatMagic...)
	out = append(out, formatVersion)
	out = append(out, byte(s.p))
	out = binary.BigEndian.AppendUint16(out, uint16(len(idBytes)))
	out = append(out, idBytes...)
	out = binary.BigEndian.AppendUint32(out, uint32(s.threshold))

	if s.dense {
		out = append(out, repDense)
		out = binary.BigEndian.AppendUint32(out, uint32(m))
		out = append(out, s.registers...)
		return out, nil
	}

	out = append(out, repSparse)
	out = binary.BigEndian.AppendUint32(out, uint32(len(s.sparse)))
	for idx, rho := range s.sparse {
		out = binary.BigEndian.AppendUint32(out, idx)
		out = append(out, rho)
	}
	return out, nil
}

// Unmarshal restores a sketch from data. The host must supply the hasher for
// the encoded hash scheme; the hash id itself travels inside the payload.
// Malformed payloads (unknown version, duplicate sparse indices, out of range
// rho, trailing junk, ...) are rejected. The restored sketch accepts further
// updates exactly like a freshly built one.
func Unmarshal(hasher Hasher, data []byte) (*Sketch, error) {
	if hasher == nil {
		return nil, errors.New("dataeng: nil hasher")
	}
	s := &Sketch{hasher: hasher}
	if err := s.UnmarshalBinary(data); err != nil {
		return nil, err
	}
	return s, nil
}

// UnmarshalBinary implements encoding.BinaryUnmarshaler. The receiver must
// already carry the host hasher; all other state comes from data.
func (s *Sketch) UnmarshalBinary(data []byte) error {
	if s == nil || s.hasher == nil {
		return errors.New("dataeng: receiver needs a host hasher before unmarshalling")
	}
	r := &byteReader{data: data}

	magic, err := r.take(4)
	if err != nil {
		return err
	}
	if string(magic) != formatMagic {
		return errors.New("dataeng: bad magic")
	}
	version, err := r.take1()
	if err != nil {
		return err
	}
	if version != formatVersion {
		return fmt.Errorf("dataeng: unsupported format version %d", version)
	}

	p, err := r.take1()
	if err != nil {
		return err
	}
	if int(p) < minPrecision || int(p) > maxPrecision {
		return fmt.Errorf("dataeng: precision %d out of range [%d, %d]", p, minPrecision, maxPrecision)
	}
	m := 1 << p
	maxRho := uint8(65 - int(p))

	idLen, err := r.takeUint16()
	if err != nil {
		return err
	}
	idChunk, err := r.take(int(idLen))
	if err != nil {
		return err
	}
	hashID := string(idChunk)
	if hashID == "" {
		return errors.New("dataeng: empty hash scheme id")
	}

	threshold, err := r.takeUint32()
	if err != nil {
		return err
	}
	if threshold < 1 || int(threshold) > m {
		return fmt.Errorf("dataeng: sparse threshold %d out of range [1, %d]", threshold, m)
	}

	rep, err := r.take1()
	if err != nil {
		return err
	}
	count, err := r.takeUint32()
	if err != nil {
		return err
	}

	switch rep {
	case repSparse:
		if int(count) >= int(threshold) {
			return fmt.Errorf("dataeng: sparse representation with %d entries violates threshold %d", count, threshold)
		}
		if int(count) > m {
			return fmt.Errorf("dataeng: sparse entry count %d exceeds registers %d", count, m)
		}
		sparse := make(map[uint32]uint8, count)
		for i := uint32(0); i < count; i++ {
			idx, err := r.takeUint32()
			if err != nil {
				return err
			}
			rho, err := r.take1()
			if err != nil {
				return err
			}
			if idx >= uint32(m) {
				return fmt.Errorf("dataeng: sparse index %d out of range [0, %d)", idx, m)
			}
			if rho < 1 || rho > maxRho {
				return fmt.Errorf("dataeng: rho %d out of range [1, %d]", rho, maxRho)
			}
			if _, exists := sparse[idx]; exists {
				return fmt.Errorf("dataeng: duplicate sparse index %d", idx)
			}
			sparse[idx] = rho
		}
		if r.pos != len(data) {
			return errors.New("dataeng: trailing junk after sparse sketch")
		}
		s.p = int(p)
		s.hashID = hashID
		s.threshold = int(threshold)
		s.dense = false
		s.sparse = sparse
		s.registers = nil
		return nil

	case repDense:
		if int(count) != m {
			return fmt.Errorf("dataeng: dense register count %d != %d", count, m)
		}
		payload, err := r.take(int(count))
		if err != nil {
			return err
		}
		for _, rho := range payload {
			if rho > maxRho {
				return fmt.Errorf("dataeng: rho %d out of range [0, %d]", rho, maxRho)
			}
		}
		if r.pos != len(data) {
			return errors.New("dataeng: trailing junk after dense sketch")
		}
		registers := make([]uint8, m)
		copy(registers, payload)
		s.p = int(p)
		s.hashID = hashID
		s.threshold = int(threshold)
		s.dense = true
		s.sparse = nil
		s.registers = registers
		return nil

	default:
		return fmt.Errorf("dataeng: unknown representation byte %d", rep)
	}
}
