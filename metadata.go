package dataeng

import (
	"fmt"
	"io"
	"math/bits"
	"sort"
)

// Dimension describes one CDF-1 dimension. At most one dimension may have
// Length zero: it is the record dimension and its effective length is
// NumRecords. The record dimension may only be used as the first dimension
// of a variable.
type Dimension struct {
	ID     int
	Length int64
}

// Variable describes one CDF-1 variable with metadata already parsed by the
// host. Begin is the byte offset of the variable data; VSize is the number of
// bytes occupied by one ordinary variable, or by one record slab, rounded up
// to a multiple of four.
type Variable struct {
	Name   string
	DimIDs []int
	Type   CDFType
	Begin  int64
	VSize  int64
}

// Metadata is the parsed CDF-1 header information handed to the package.
type Metadata struct {
	FileLength int64
	NumRecords int64
	Dimensions []Dimension
	Variables  []Variable
}

// Reader performs validated slice reads against a CDF-1 data source.
type Reader struct {
	r         io.ReaderAt
	fileLen   int64
	nrec      int64
	dimLen    map[int]int64
	recDimID  int
	recStart  int64 // begin of the record region, 0 when there are no record variables
	recStride int64 // physical step between consecutive records
	vars      []varLayout
}

// varLayout is the validated, precomputed layout of one variable.
type varLayout struct {
	idx      int // position in Metadata.Variables
	name     string
	typ      CDFType
	width    int64
	begin    int64
	vsize    int64
	record   bool
	dimIDs   []int
	lengths  []int64 // effective dimension lengths, record dimension expanded
	slabLens []int64 // physical dimension lengths inside one slab/ordinary variable
	nelem    int64   // number of values per ordinary variable or per record slab
	dataSize int64   // unpadded bytes per ordinary variable or per record slab
	base     int64   // offset of this variable's first record slab (records only)
}

// NewReader fully validates md and returns a Reader bound to r. No data bytes
// are read here: validation only uses metadata.
func NewReader(md *Metadata, r io.ReaderAt) (*Reader, error) {
	if md == nil {
		return nil, fmt.Errorf("%w: nil metadata", ErrMetadata)
	}
	if r == nil {
		return nil, fmt.Errorf("%w: nil ReaderAt", ErrMetadata)
	}
	if md.FileLength < 0 || md.NumRecords < 0 {
		return nil, fmt.Errorf("%w: negative file length or record count", ErrMetadata)
	}

	rd := &Reader{
		r:        r,
		fileLen:  md.FileLength,
		nrec:     md.NumRecords,
		dimLen:   make(map[int]int64, len(md.Dimensions)),
		recDimID: -1,
	}

	if err := rd.validateDimensions(md.Dimensions); err != nil {
		return nil, err
	}
	if len(md.Variables) == 0 {
		return rd, nil
	}

	normal := make([]varLayout, 0, len(md.Variables))
	record := make([]varLayout, 0, len(md.Variables))
	for i := range md.Variables {
		v, err := rd.validateVariable(&md.Variables[i])
		if err != nil {
			return nil, err
		}
		v.idx = i
		if v.record {
			record = append(record, v)
		} else {
			normal = append(normal, v)
		}
	}

	if err := validateNormalRegions(normal, rd.fileLen); err != nil {
		return nil, err
	}
	if len(record) > 0 {
		if err := rd.buildRecordLayout(record, normal); err != nil {
			return nil, err
		}
	}
	rd.vars = make([]varLayout, len(md.Variables))
	for _, v := range normal {
		rd.vars[v.idx] = v
	}
	for _, v := range record {
		rd.vars[v.idx] = v
	}
	return rd, nil
}

// validateDimensions checks dimension IDs, lengths and the single record
// dimension rule.
func (rd *Reader) validateDimensions(dims []Dimension) error {
	seen := make(map[int]bool, len(dims))
	for _, d := range dims {
		if d.ID < 0 {
			return fmt.Errorf("%w: negative dimension id %d", ErrMetadata, d.ID)
		}
		if seen[d.ID] {
			return fmt.Errorf("%w: duplicate dimension id %d", ErrMetadata, d.ID)
		}
		seen[d.ID] = true
		if d.Length < 0 {
			return fmt.Errorf("%w: negative dimension length", ErrMetadata)
		}
		if d.Length == 0 {
			if rd.recDimID != -1 {
				return fmt.Errorf("%w: more than one record dimension", ErrMetadata)
			}
			rd.recDimID = d.ID
		}
		rd.dimLen[d.ID] = d.Length
	}
	return nil
}

// validateVariable resolves dimensions, checks types and vsize, and computes
// the precomputed layout of one variable.
func (rd *Reader) validateVariable(v *Variable) (varLayout, error) {
	out := varLayout{
		name:  v.Name,
		typ:   v.Type,
		begin: v.Begin,
		vsize: v.VSize,
	}
	width := v.Type.Width()
	if width <= 0 {
		return out, fmt.Errorf("%w: variable %q: unsupported type %d", ErrMetadata, v.Name, v.Type)
	}
	out.width = width
	if v.Begin < 0 {
		return out, fmt.Errorf("%w: variable %q: negative begin", ErrMetadata, v.Name)
	}
	if v.Begin&3 != 0 {
		return out, fmt.Errorf("%w: variable %q: begin %d is not 4-byte aligned", ErrMetadata, v.Name, v.Begin)
	}
	if v.VSize < 0 {
		return out, fmt.Errorf("%w: variable %q: negative vsize", ErrMetadata, v.Name)
	}

	out.dimIDs = append(out.dimIDs, v.DimIDs...)
	out.lengths = make([]int64, len(v.DimIDs))
	out.slabLens = make([]int64, len(v.DimIDs))
	dimSeen := make(map[int]bool, len(v.DimIDs))
	for i, id := range v.DimIDs {
		if dimSeen[id] {
			return out, fmt.Errorf("%w: variable %q: repeated dimension id %d", ErrMetadata, v.Name, id)
		}
		dimSeen[id] = true
		length, ok := rd.dimLen[id]
		if !ok {
			return out, fmt.Errorf("%w: variable %q: unknown dimension id %d", ErrMetadata, v.Name, id)
		}
		if length == 0 {
			if i != 0 {
				return out, fmt.Errorf("%w: variable %q: record dimension must be first", ErrMetadata, v.Name)
			}
			out.record = true
			out.slabLens[i] = 0
			length = rd.nrec
		} else {
			out.slabLens[i] = length
		}
		out.lengths[i] = length
	}

	nelem := int64(1)
	for i, length := range out.lengths {
		// A record slab excludes the record dimension; its effective length
		// only matters for slice bounds.
		if out.record && i == 0 {
			continue
		}
		var ok bool
		nelem, ok = mulExact(nelem, length)
		if !ok {
			return out, fmt.Errorf("%w: variable %q: element count overflow", ErrOverflow, v.Name)
		}
	}
	out.nelem = nelem
	dataSize, ok := mulExact(nelem, width)
	if !ok {
		return out, fmt.Errorf("%w: variable %q: data size overflow", ErrOverflow, v.Name)
	}
	out.dataSize = dataSize
	expectedVSize, ok := pad4(dataSize)
	if !ok {
		return out, fmt.Errorf("%w: variable %q: vsize overflow", ErrOverflow, v.Name)
	}
	if v.VSize != expectedVSize {
		return out, fmt.Errorf("%w: variable %q: vsize %d does not match computed %d", ErrLayout, v.Name, v.VSize, expectedVSize)
	}
	return out, nil
}

// validateNormalRegions checks that ordinary variables fit inside the file,
// that their regions do not overlap, and that no begin lands inside another
// variable's data region. When a record region exists the caller additionally
// verifies they stay outside it.
func validateNormalRegions(normal []varLayout, fileLen int64) error {
	for i := range normal {
		v := &normal[i]
		end, ok := addExact(v.begin, v.dataSize)
		if !ok {
			return fmt.Errorf("%w: variable %q: end offset overflow", ErrOverflow, v.name)
		}
		if end > fileLen {
			return fmt.Errorf("%w: variable %q: region [%d,%d) exceeds file length %d", ErrMetadata, v.name, v.begin, end, fileLen)
		}
	}
	for i := 0; i < len(normal); i++ {
		a := &normal[i]
		aEnd, _ := addExact(a.begin, a.dataSize)
		for j := i + 1; j < len(normal); j++ {
			b := &normal[j]
			bEnd, _ := addExact(b.begin, b.dataSize)
			if a.begin < bEnd && b.begin < aEnd {
				return fmt.Errorf("%w: variables %q and %q regions overlap", ErrOverlap, a.name, b.name)
			}
		}
	}
	return nil
}

// buildRecordLayout verifies the per-record slab arrangement, computes the
// cross-record stride and ensures ordinary variables stay outside the record
// region.
func (rd *Reader) buildRecordLayout(record, normal []varLayout) error {
	sort.SliceStable(record, func(i, j int) bool {
		return record[i].begin < record[j].begin
	})
	for i := 1; i < len(record); i++ {
		if record[i].begin == record[i-1].begin {
			return fmt.Errorf("%w: record variables %q and %q share begin %d", ErrLayout, record[i-1].name, record[i].name, record[i].begin)
		}
	}

	recStart := record[0].begin
	unpaddedOnly := len(record) == 1 && (record[0].typ == TypeByte || record[0].typ == TypeChar || record[0].typ == TypeShort)

	prefix := int64(0)
	paddedSum := int64(0)
	for i := range record {
		v := &record[i]
		expectedBegin, ok := addExact(recStart, prefix)
		if !ok {
			return fmt.Errorf("%w: record slab offset overflow", ErrOverflow)
		}
		if v.begin != expectedBegin {
			return fmt.Errorf("%w: record variable %q: begin %d does not fit slab layout at %d", ErrLayout, v.name, v.begin, expectedBegin)
		}
		v.base = expectedBegin
		next, ok := addExact(prefix, v.vsize)
		if !ok {
			return fmt.Errorf("%w: record layout overflow", ErrOverflow)
		}
		prefix = next
		padded, ok := addExact(paddedSum, v.vsize)
		if !ok {
			return fmt.Errorf("%w: record stride overflow", ErrOverflow)
		}
		paddedSum = padded
	}

	stride := paddedSum
	if unpaddedOnly {
		stride = record[0].dataSize
	}
	recExtent, ok := mulExact(rd.nrec, stride)
	if !ok {
		return fmt.Errorf("%w: record region size overflow", ErrOverflow)
	}
	recEnd, ok := addExact(recStart, recExtent)
	if !ok {
		return fmt.Errorf("%w: record region end overflow", ErrOverflow)
	}
	if recEnd > rd.fileLen {
		return fmt.Errorf("%w: record region [%d,%d) exceeds file length %d", ErrMetadata, recStart, recEnd, rd.fileLen)
	}

	for i := range normal {
		v := &normal[i]
		end, _ := addExact(v.begin, v.dataSize)
		if end > recStart {
			return fmt.Errorf("%w: ordinary variable %q occupies the record region", ErrOverlap, v.name)
		}
	}

	rd.recStart = recStart
	rd.recStride = stride
	return nil
}

// NumVariables returns the number of validated variables.
func (rd *Reader) NumVariables() int { return len(rd.vars) }

// mulExact returns a*b and false when the int64 product overflows.
// Both operands must be non-negative, which holds for all validated sizes.
func mulExact(a, b int64) (int64, bool) {
	if a == 0 || b == 0 {
		return 0, true
	}
	hi, lo := bits.Mul64(uint64(a), uint64(b))
	if hi != 0 || lo > 1<<63-1 {
		return 0, false
	}
	return int64(lo), true
}

// addExact returns a+b and false when the int64 sum overflows.
func addExact(a, b int64) (int64, bool) {
	s := a + b
	if (s^a) < 0 && (s^b) < 0 {
		return 0, false
	}
	return s, true
}

// pad4 rounds n up to the next multiple of four.
func pad4(n int64) (int64, bool) {
	padded, ok := addExact(n, 3)
	if !ok {
		return 0, false
	}
	return padded &^ 3, true
}
