package dataeng

import (
	"encoding/binary"
	"fmt"
	"io"
	"testing"
)

// generatedReader synthesizes deterministic bytes at any absolute offset, so
// arbitrarily large layouts can be exercised without materializing a file.
type generatedReader struct {
	fileLen int64
	calls   int
}

func (g *generatedReader) ReadAt(p []byte, off int64) (int, error) {
	g.calls++
	if off < 0 || off+int64(len(p)) > g.fileLen {
		return 0, io.EOF
	}
	for i := range p {
		p[i] = genByte(off + int64(i))
	}
	return len(p), nil
}

// blockedReader fails the test if any byte is read.
type blockedReader struct{}

func (blockedReader) ReadAt(p []byte, off int64) (int, error) {
	return 0, fmt.Errorf("ReaderAt must not be accessed; attempted ReadAt(%d) len=%d", off, len(p))
}

// staticReader serves a precomputed byte array and reports EOF on short reads.
type staticReader struct{ data []byte }

func (s *staticReader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 || off >= int64(len(s.data)) {
		return 0, io.EOF
	}
	return copy(p, s.data[off:]), nil
}

// shortReader always returns fewer bytes than requested.
type shortReader struct{}

func (shortReader) ReadAt(p []byte, off int64) (int, error) {
	if len(p) <= 1 {
		return 0, io.EOF
	}
	return len(p) - 1, nil
}

func genByte(off int64) byte { return byte(off * 31) }

// modelValue independently decodes the value the reference model expects at
// absolute offset off.
func modelValue(typ CDFType, off int64) uint64 {
	width := typ.Width()
	buf := make([]byte, width)
	for i := range buf {
		buf[i] = genByte(off + int64(i))
	}
	switch typ {
	case TypeByte:
		return uint64(int8(buf[0]))
	case TypeChar:
		return uint64(buf[0])
	case TypeShort:
		return uint64(int16(binary.BigEndian.Uint16(buf)))
	case TypeInt:
		return uint64(int32(binary.BigEndian.Uint32(buf)))
	case TypeFloat:
		return uint64(binary.BigEndian.Uint32(buf))
	case TypeDouble:
		return binary.BigEndian.Uint64(buf)
	default:
		panic("bad type")
	}
}

func (md *Metadata) dimLengthOf(id int) int64 {
	for _, d := range md.Dimensions {
		if d.ID == id {
			return d.Length
		}
	}
	return -1
}

// slabDataSize returns the unpadded byte count of one ordinary variable or
// one record slab.
func slabDataSize(md *Metadata, v *Variable) int64 {
	nelem := int64(1)
	for i, id := range v.DimIDs {
		if i == 0 && md.dimLengthOf(id) == 0 {
			// One slab excludes the record dimension itself.
			continue
		}
		nelem *= md.dimLengthOf(id)
	}
	return nelem * v.Type.Width()
}

func vsizeOf(md *Metadata, v *Variable) int64 {
	return (slabDataSize(md, v) + 3) &^ 3
}

// modelOffset is the independent per-coordinate layout model mirroring the
// CDF-1 rules: last dimension fastest, record slabs ordered by begin.
func modelOffset(md *Metadata, vi int, coords []int64) int64 {
	v := md.Variables[vi]
	width := v.Type.Width()
	if len(v.DimIDs) == 0 {
		return v.Begin
	}

	if md.dimLengthOf(v.DimIDs[0]) != 0 {
		off := v.Begin
		for d := len(v.DimIDs) - 1; d >= 0; d-- {
			step := width
			for k := d + 1; k < len(v.DimIDs); k++ {
				step *= md.dimLengthOf(v.DimIDs[k])
			}
			off += coords[d] * step
		}
		return off
	}

	recVars := make([]Variable, 0)
	for _, rv := range md.Variables {
		if len(rv.DimIDs) > 0 && md.dimLengthOf(rv.DimIDs[0]) == 0 {
			recVars = append(recVars, rv)
		}
	}
	for i := 0; i < len(recVars); i++ {
		for j := i + 1; j < len(recVars); j++ {
			if recVars[j].Begin < recVars[i].Begin {
				recVars[i], recVars[j] = recVars[j], recVars[i]
			}
		}
	}
	recStart := recVars[0].Begin
	unpadded := len(recVars) == 1 &&
		(recVars[0].Type == TypeByte || recVars[0].Type == TypeChar || recVars[0].Type == TypeShort)

	stride := int64(0)
	if unpadded {
		stride = slabDataSize(md, &recVars[0])
	} else {
		for _, rv := range recVars {
			stride += rv.VSize
		}
	}

	base := recStart
	for _, rv := range recVars {
		if rv.Name == v.Name {
			break
		}
		base += rv.VSize
	}

	off := base + coords[0]*stride
	for d := len(v.DimIDs) - 1; d >= 1; d-- {
		step := width
		for k := d + 1; k < len(v.DimIDs); k++ {
			step *= md.dimLengthOf(v.DimIDs[k])
		}
		off += coords[d] * step
	}
	return off
}

// expectedCoords enumerates selected coordinates in last-dimension-fast order.
func expectedCoords(start, count, stride []int64) [][]int64 {
	if len(count) == 0 {
		return [][]int64{{}}
	}
	for _, c := range count {
		if c == 0 {
			return [][]int64{}
		}
	}
	total := int64(1)
	for _, c := range count {
		total *= c
	}
	out := make([][]int64, 0, total)
	odo := make([]int64, len(count))
	for {
		abs := make([]int64, len(count))
		for d := range odo {
			abs[d] = start[d] + odo[d]*stride[d]
		}
		out = append(out, abs)
		more := false
		for d := len(odo) - 1; d >= 0; d-- {
			odo[d]++
			if odo[d] < count[d] {
				more = true
				break
			}
			odo[d] = 0
		}
		if !more {
			break
		}
	}
	return out
}

func checkSlice(t *testing.T, rd *Reader, md *Metadata, vi int, start, count, stride []int64, limit int64) *Slice {
	t.Helper()
	sl, err := rd.ReadSlice(vi, start, count, stride, limit)
	if err != nil {
		t.Fatalf("ReadSlice: %v", err)
	}
	want := expectedCoords(start, count, stride)
	if len(want) == 0 {
		if len(sl.Values) != 0 || len(sl.Offsets) != 0 || sl.BytesRead != 0 {
			t.Fatalf("empty slice not empty: %+v", sl)
		}
		return sl
	}
	if len(sl.Values) != len(want) || len(sl.Offsets) != len(want) {
		t.Fatalf("length mismatch: got %d values, want %d", len(sl.Values), len(want))
	}
	var wantBytes int64
	for i, coords := range want {
		off := modelOffset(md, vi, coords)
		if sl.Offsets[i] != off {
			t.Fatalf("offset[%d] coords %v: got %d want %d", i, coords, sl.Offsets[i], off)
		}
		if got := sl.Values[i]; got != modelValue(md.Variables[vi].Type, off) {
			t.Fatalf("value[%d] at %d: got %#x want %#x", i, off, got, modelValue(md.Variables[vi].Type, off))
		}
		wantBytes += md.Variables[vi].Type.Width()
	}
	if sl.BytesRead != wantBytes {
		t.Fatalf("BytesRead got %d want %d", sl.BytesRead, wantBytes)
	}
	return sl
}

func buildMeta() *Metadata {
	return &Metadata{
		FileLength: 1 << 20,
		NumRecords: 6,
		Dimensions: []Dimension{
			{ID: 0, Length: 0},
			{ID: 1, Length: 4},
			{ID: 2, Length: 3},
			{ID: 3, Length: 5},
		},
	}
}
