package dataeng

import (
	"encoding/binary"
	"fmt"
	"math"
)

// Slice is the result of a ReadSlice call. Values are stored in last
// dimension fastest order and Offsets[i] is the physical byte offset of
// Values[i].
//
// Integer values are sign-extended into the uint64 slot; char values are
// zero-extended. Float and double values hold the original on-disk bit
// pattern (IEEE-754 binary32/binary64 respectively), retrievable through
// Float32 and Float64.
type Slice struct {
	Type      CDFType
	Values    []uint64
	Offsets   []int64
	BytesRead int64
}

// Int64 returns element i as a sign-extended integer.
func (s *Slice) Int64(i int) int64 { return int64(s.Values[i]) }

// Uint64 returns the raw encoded slot of element i.
func (s *Slice) Uint64(i int) uint64 { return s.Values[i] }

// Float32 reinterprets element i as a 32-bit IEEE floating-point value.
func (s *Slice) Float32(i int) float32 {
	return math.Float32frombits(uint32(s.Values[i]))
}

// Float64 reinterprets element i as a 64-bit IEEE floating-point value.
func (s *Slice) Float64(i int) float64 {
	return math.Float64frombits(s.Values[i])
}

// ReadSlice reads a hyperslab of variable varIndex. start, count and stride
// must have one entry per variable dimension (all empty for a scalar);
// strides must be positive and counts may be zero.
//
// Data is read lazily through the ReaderAt in physical runs, never by
// loading the whole file. Each underlying ReadAt call requests at most
// maxReadBytes bytes; BytesRead of the returned Slice accumulates every
// requested byte for the caller to verify. If any read is short, no Slice
// is returned.
func (rd *Reader) ReadSlice(varIndex int, start, count, stride []int64, maxReadBytes int64) (*Slice, error) {
	if varIndex < 0 || varIndex >= len(rd.vars) {
		return nil, fmt.Errorf("%w: variable index %d out of range", ErrSlice, varIndex)
	}
	v := &rd.vars[varIndex]
	nd := len(v.lengths)
	if len(start) != nd || len(count) != nd || len(stride) != nd {
		return nil, fmt.Errorf("%w: variable %q expects %d slice dimensions, got start=%d count=%d stride=%d",
			ErrSlice, v.name, nd, len(start), len(count), len(stride))
	}
	for d := 0; d < nd; d++ {
		if start[d] < 0 {
			return nil, fmt.Errorf("%w: negative start on dimension %d", ErrSlice, d)
		}
		if count[d] < 0 {
			return nil, fmt.Errorf("%w: negative count on dimension %d", ErrSlice, d)
		}
		if stride[d] <= 0 {
			return nil, fmt.Errorf("%w: non-positive stride on dimension %d", ErrSlice, d)
		}
	}

	out := &Slice{Type: v.typ, Values: []uint64{}, Offsets: []int64{}}
	total := int64(1)
	for d := 0; d < nd; d++ {
		if count[d] == 0 {
			// Empty hyperslab: return without touching the ReaderAt.
			return out, nil
		}
		var ok bool
		total, ok = mulExact(total, count[d])
		if !ok {
			return nil, fmt.Errorf("%w: slice element count overflow", ErrOverflow)
		}
		// Bounds are only checked for non-empty slices: the last selected
		// coordinate is start + (count-1)*stride.
		span, ok := mulExact(count[d]-1, stride[d])
		if !ok {
			return nil, fmt.Errorf("%w: slice span overflow on dimension %d", ErrOverflow, d)
		}
		last, ok := addExact(start[d], span)
		if !ok {
			return nil, fmt.Errorf("%w: slice coordinate overflow on dimension %d", ErrOverflow, d)
		}
		if last >= v.lengths[d] {
			return nil, fmt.Errorf("%w: variable %q dimension %d: last coordinate %d exceeds length %d",
				ErrSlice, v.name, d, last, v.lengths[d])
		}
	}

	if maxReadBytes < v.width {
		return nil, fmt.Errorf("%w: limit %d cannot hold one %d-byte value", ErrLimit, maxReadBytes, v.width)
	}

	// dimStep[d] is the byte distance between consecutive coordinates of
	// dimension d inside one ordinary variable or record slab. For record
	// variables dimension 0 is handled separately via recStride.
	dimStep := make([]int64, nd)
	// stride[d] = width * product(slab lengths of dimensions faster than d).
	// Faster dimensions are those with higher indices.
	cum := v.width
	for d := nd - 1; d >= 0; d-- {
		if v.record && d == 0 {
			break
		}
		// At this point cum is the product of dimensions d+1..nd-1.
		dimStep[d] = cum
		// Fold dimension d in for the next (slower) dimension.
		next, ok := mulExact(cum, v.slabLens[d])
		if !ok {
			return nil, fmt.Errorf("%w: dimension stride overflow", ErrOverflow)
		}
		cum = next
	}

	values := make([]uint64, 0, total)
	offsets := make([]int64, 0, total)
	// coords always holds absolute coordinates (start + odo*stride).
	coords := make([]int64, nd)
	copy(coords, start)

	// Physical runs are accumulated and flushed through chunked ReadAt
	// calls. A failed read aborts the whole call, so no partial Slice is
	// ever delivered.
	runOffset := int64(0)
	runLen := int64(0)

	flush := func() error {
		if runLen == 0 {
			return nil
		}
		chunkVals := maxReadBytes / v.width
		bufSize, ok := mulExact(chunkVals, v.width)
		if !ok {
			return fmt.Errorf("%w: chunk size overflow", ErrOverflow)
		}
		buf := make([]byte, bufSize)
		remaining := runLen
		pos := runOffset
		for remaining > 0 {
			n := chunkVals
			if n > remaining {
				n = remaining
			}
			nBytes, ok := mulExact(n, v.width)
			if !ok {
				return fmt.Errorf("%w: chunk byte count overflow", ErrOverflow)
			}
			got, err := rd.r.ReadAt(buf[:nBytes], pos)
			if err != nil {
				return fmt.Errorf("%w: variable %q at offset %d: %v", ErrShortRead, v.name, pos, err)
			}
			if got != int(nBytes) {
				return fmt.Errorf("%w: variable %q at offset %d: got %d bytes, want %d",
					ErrShortRead, v.name, pos, got, nBytes)
			}
			decodeRun(v.typ, buf[:nBytes], pos, &values, &offsets)
			out.BytesRead += nBytes
			pos, ok = addExact(pos, nBytes)
			if !ok {
				return fmt.Errorf("%w: read position overflow", ErrOverflow)
			}
			remaining -= n
		}
		runLen = 0
		return nil
	}

	for {
		offset, err := physicalOffset(rd, v, coords, dimStep)
		if err != nil {
			return nil, err
		}
		if runLen > 0 {
			runBytes, ok := mulExact(runLen, v.width)
			if !ok {
				return nil, fmt.Errorf("%w: run byte length overflow", ErrOverflow)
			}
			nextOff, ok := addExact(runOffset, runBytes)
			if !ok {
				return nil, fmt.Errorf("%w: run end offset overflow", ErrOverflow)
			}
			if offset != nextOff {
				if err := flush(); err != nil {
					return nil, err
				}
			}
		}
		if runLen == 0 {
			runOffset = offset
		}
		runLen++

		if !advance(coords, start, count, stride) {
			break
		}
	}
	if err := flush(); err != nil {
		return nil, err
	}

	if int64(len(values)) != total {
		return nil, fmt.Errorf("%w: internal slice count mismatch", ErrShortRead)
	}
	out.Values = values
	out.Offsets = offsets
	return out, nil
}

// physicalOffset computes the absolute file offset of the value at coords,
// checking every intermediate product with exact integer arithmetic.
func physicalOffset(rd *Reader, v *varLayout, coords, dimStep []int64) (int64, error) {
	first := 0
	offset := v.begin
	if v.record {
		recShift, ok := mulExact(coords[0], rd.recStride)
		if !ok {
			return 0, fmt.Errorf("%w: record offset overflow", ErrOverflow)
		}
		off, ok := addExact(v.base, recShift)
		if !ok {
			return 0, fmt.Errorf("%w: record base offset overflow", ErrOverflow)
		}
		offset = off
		first = 1
	}
	for d := first; d < len(coords); d++ {
		shift, ok := mulExact(coords[d], dimStep[d])
		if !ok {
			return 0, fmt.Errorf("%w: coordinate offset overflow on dimension %d", ErrOverflow, d)
		}
		next, ok := addExact(offset, shift)
		if !ok {
			return 0, fmt.Errorf("%w: physical offset overflow", ErrOverflow)
		}
		offset = next
	}
	return offset, nil
}

// advance increments the absolute-coordinate odometer in C order and
// reports whether another coordinate exists. An empty odometer (scalar)
// has exactly one position.
func advance(coords, start, count, stride []int64) bool {
	for d := len(coords) - 1; d >= 0; d-- {
		odo := (coords[d] - start[d]) / stride[d]
		if odo+1 < count[d] {
			coords[d] += stride[d]
			return true
		}
		coords[d] = start[d]
	}
	return false
}

// decodeRun decodes one physically contiguous chunk of big-endian values and
// appends their slots and physical offsets.
func decodeRun(typ CDFType, buf []byte, baseOffset int64, values *[]uint64, offsets *[]int64) {
	width := typ.Width()
	for off := int64(0); off < int64(len(buf)); off += width {
		var slot uint64
		switch typ {
		case TypeByte:
			slot = uint64(int8(buf[off]))
		case TypeChar:
			slot = uint64(buf[off])
		case TypeShort:
			slot = uint64(int16(binary.BigEndian.Uint16(buf[off:])))
		case TypeInt:
			slot = uint64(int32(binary.BigEndian.Uint32(buf[off:])))
		case TypeFloat:
			slot = uint64(binary.BigEndian.Uint32(buf[off:]))
		case TypeDouble:
			slot = binary.BigEndian.Uint64(buf[off:])
		}
		*values = append(*values, slot)
		*offsets = append(*offsets, baseOffset+off)
	}
}
