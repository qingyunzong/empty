package dataeng

import (
	"errors"
	"fmt"
	"io"
)

// Extent is a half-open byte range [Offset, Offset+Length) in a sparse file.
//
// A sparse map describes the regions of a file that contain data. Every byte
// that is not covered by an extent is a hole and reads as zero.
type Extent struct {
	Offset int64
	Length int64
}

// End returns the first offset after the extent.
func (e Extent) End() int64 { return e.Offset + e.Length }

// Empty reports whether the extent contains no bytes.
func (e Extent) Empty() bool { return e.Length == 0 }

// SparseExtent, Segment, and DataExtent are descriptive aliases for Extent.
type (
	SparseExtent = Extent
	Segment      = Extent
	DataExtent   = Extent
)

// SparseFile and FileMap are aliases for SparseMap.
type (
	SparseFile = SparseMap
	FileMap    = SparseMap
)

// SparseMap describes a sparse file.
//
// Extents is kept in the order in which it was encoded in the archive. A
// valid map is ordered, has no overlapping extents, and has no extent beyond
// LogicalSize. Empty extents are permitted because several GNU encodings use
// a final zero-length extent to mark the end of the file.
type SparseMap struct {
	// LogicalSize is the size of the expanded file, including holes.
	LogicalSize int64

	// Size is a compatibility alias for LogicalSize. Parsers populate both
	// fields. If a map was constructed manually with only Size set, it is
	// used as the logical size.
	Size int64

	// Extents contains the data regions in ascending offset order.
	Extents []Extent

	// CompactSize is the total number of compact data bytes referenced by
	// Extents. It is informational; PhysicalSize performs the same sum with
	// overflow checking.
	CompactSize int64
}

// Logical returns the logical size of the file. If both size fields are set,
// LogicalSize takes precedence.
func (m *SparseMap) Logical() int64 {
	if m == nil {
		return 0
	}
	if m.LogicalSize != 0 || m.Size == 0 {
		return m.LogicalSize
	}
	return m.Size
}

// PhysicalSize returns the number of compact data bytes referenced by the
// map. It does not include any sparse-map metadata stored in the entry body.
func (m *SparseMap) PhysicalSize() (int64, error) {
	if m == nil {
		return 0, ErrInvalidSparseMap
	}
	var total int64
	for _, e := range m.Extents {
		if e.Length < 0 || total > maxInt64-e.Length {
			return 0, fmt.Errorf("%w: extent length overflows", ErrInvalidSparseMap)
		}
		total += e.Length
	}
	return total, nil
}

// Validate checks that the map is ordered, non-overlapping, and contained in
// the logical file size.
func (m *SparseMap) Validate() error {
	if m == nil {
		return ErrInvalidSparseMap
	}
	return ValidateExtents(m.Extents, m.Logical())
}

// ValidateExtents checks a data-extent list against a logical file size.
//
// The checks are intentionally the strict form required by sparse importers:
// offsets and lengths may not be negative, arithmetic may not overflow,
// extents must be sorted, extents may not overlap, and the end of an extent
// may not exceed size.
func ValidateExtents(extents []Extent, size int64) error {
	if size < 0 {
		return fmt.Errorf("%w: negative logical size %d", ErrInvalidSparseMap, size)
	}

	var previous Extent
	for i, extent := range extents {
		switch {
		case extent.Offset < 0:
			return fmt.Errorf("%w: extent %d has negative offset %d", ErrInvalidSparseMap, i, extent.Offset)
		case extent.Length < 0:
			return fmt.Errorf("%w: extent %d has negative length %d", ErrInvalidSparseMap, i, extent.Length)
		case extent.Offset > maxInt64-extent.Length:
			return fmt.Errorf("%w: extent %d overflows", ErrInvalidSparseMap, i)
		case extent.End() > size:
			return fmt.Errorf("%w: extent %d ends at %d beyond logical size %d",
				ErrInvalidSparseMap, i, extent.End(), size)
		case i > 0 && previous.End() > extent.Offset:
			return fmt.Errorf("%w: extent %d at %d overlaps previous extent ending at %d",
				ErrInvalidSparseMap, i, extent.Offset, previous.End())
		}
		previous = extent
	}
	return nil
}

// Holes returns the gaps between data extents, including leading and trailing
// holes. The map must be valid.
func (m *SparseMap) Holes() []Extent {
	if m == nil {
		return nil
	}
	size := m.Logical()
	var holes []Extent
	position := int64(0)
	for _, extent := range m.Extents {
		if extent.Offset > position {
			holes = append(holes, Extent{Offset: position, Length: extent.Offset - position})
		}
		if end := extent.End(); end > position {
			position = end
		}
	}
	if position < size {
		holes = append(holes, Extent{Offset: position, Length: size - position})
	}
	return holes
}

// Clone returns a deep copy of the map.
func (m *SparseMap) Clone() *SparseMap {
	if m == nil {
		return nil
	}
	clone := *m
	clone.Extents = append([]Extent(nil), m.Extents...)
	return &clone
}

// SparseReader reads the logical contents of a sparse file from its compact
// data stream. Regions not covered by an extent are returned as zero bytes
// without reading or allocating backing storage for the holes.
//
// A SparseReader reads forward only. If the compact data source also supports
// io.ReaderAt, ReadAt can be used for random access.
type SparseReader struct {
	data    io.Reader
	readAt  io.ReaderAt
	mapData *SparseMap
	extents []Extent

	logicalSize int64
	position    int64
	extentIndex int
	remaining   int64
}

// SparseMapReader is an alias for SparseReader.
type SparseMapReader = SparseReader

// NewSparseReader returns a reader for the expanded file described by m. The
// compact reader must supply exactly the bytes named by the map's extents, in
// order.
func NewSparseReader(m *SparseMap, compact io.Reader) (*SparseReader, error) {
	if m == nil {
		return nil, ErrInvalidSparseMap
	}
	if compact == nil {
		return nil, errors.New("dataeng: nil compact data reader")
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}

	extents := make([]Extent, 0, len(m.Extents))
	for _, extent := range m.Extents {
		if extent.Length > 0 {
			extents = append(extents, extent)
		}
	}

	reader := &SparseReader{
		data:        compact,
		mapData:     m,
		extents:     extents,
		logicalSize: m.Logical(),
	}
	if ra, ok := compact.(io.ReaderAt); ok {
		reader.readAt = ra
	}
	return reader, nil
}

// NewSparseFileReader is an alias for NewSparseReader.
func NewSparseFileReader(m *SparseMap, compact io.Reader) (*SparseReader, error) {
	return NewSparseReader(m, compact)
}

// Size returns the logical size of the sparse file.
func (r *SparseReader) Size() int64 {
	if r == nil {
		return 0
	}
	return r.logicalSize
}

// Map returns the sparse map backing the reader.
func (r *SparseReader) Map() *SparseMap {
	if r == nil {
		return nil
	}
	return r.mapData
}

// Seek sets the logical read position. Seeking past the end is permitted;
// the next Read returns io.EOF.
func (r *SparseReader) Seek(offset int64, whence int) (int64, error) {
	if r == nil {
		return 0, errors.New("dataeng: nil sparse reader")
	}
	var base int64
	switch whence {
	case io.SeekStart:
		base = 0
	case io.SeekCurrent:
		base = r.position
	case io.SeekEnd:
		base = r.logicalSize
	default:
		return 0, errors.New("dataeng: invalid seek whence")
	}
	if offset > 0 && base > maxInt64-offset {
		return 0, errors.New("dataeng: seek offset overflows")
	}
	target := base + offset
	if target < 0 {
		return 0, errors.New("dataeng: negative seek position")
	}

	// SparseReader is a forward-only reader over compact data. A backward
	// seek requires the compact source to implement io.Seeker.
	if target < r.position {
		seeker, ok := r.data.(io.Seeker)
		if !ok {
			return 0, errors.New("dataeng: cannot seek backward on a streaming source")
		}
		physical := r.physicalOffset(target)
		if _, err := seeker.Seek(physical, io.SeekStart); err != nil {
			return r.position, err
		}
		r.position = target
		r.recomputePosition()
		return target, nil
	}

	// Advance without reading compact data by skipping holes and, when
	// moving within a data extent, the corresponding compact bytes.
	if err := r.skipTo(target); err != nil {
		return r.position, err
	}
	return r.position, nil
}

func (r *SparseReader) physicalOffset(target int64) int64 {
	var physical int64
	for _, extent := range r.extents {
		if target <= extent.Offset {
			break
		}
		if target >= extent.End() {
			physical += extent.Length
			continue
		}
		physical += target - extent.Offset
		break
	}
	return physical
}

func (r *SparseReader) recomputePosition() {
	r.extentIndex = 0
	r.remaining = 0
	for r.extentIndex < len(r.extents) && r.extents[r.extentIndex].End() <= r.position {
		r.extentIndex++
	}
	if r.extentIndex < len(r.extents) && r.position >= r.extents[r.extentIndex].Offset {
		r.remaining = r.extents[r.extentIndex].End() - r.position
	}
}

func (r *SparseReader) skipTo(target int64) error {
	for r.position < target {
		// Drop exhausted extents.
		for r.extentIndex < len(r.extents) && r.position >= r.extents[r.extentIndex].End() {
			r.extentIndex++
		}

		if r.extentIndex >= len(r.extents) || r.position < r.extents[r.extentIndex].Offset {
			// Hole.
			next := target
			if r.extentIndex < len(r.extents) && r.extents[r.extentIndex].Offset < next {
				next = r.extents[r.extentIndex].Offset
			}
			if next > r.logicalSize {
				next = r.logicalSize
			}
			if next <= r.position {
				r.position = target
				break
			}
			r.position = next
			continue
		}

		// Data. Consume compact bytes from the current position.
		extent := r.extents[r.extentIndex]
		if r.remaining == 0 {
			r.remaining = extent.End() - r.position
		}
		want := target - r.position
		if want > r.remaining {
			want = r.remaining
		}
		if want <= 0 {
			r.extentIndex++
			continue
		}
		n, err := io.CopyN(io.Discard, r.data, want)
		r.position += n
		r.remaining -= n
		if err != nil {
			if errors.Is(err, io.EOF) {
				return io.ErrUnexpectedEOF
			}
			return err
		}
		if r.remaining == 0 {
			r.extentIndex++
		}
	}
	return nil
}

// Read implements io.Reader over the expanded file.
func (r *SparseReader) Read(p []byte) (int, error) {
	if r == nil {
		return 0, errors.New("dataeng: nil sparse reader")
	}
	if len(p) == 0 {
		return 0, nil
	}
	if r.position >= r.logicalSize {
		return 0, io.EOF
	}

	total := 0
	for len(p) > 0 && r.position < r.logicalSize {
		for r.extentIndex < len(r.extents) && r.position >= r.extents[r.extentIndex].End() {
			r.extentIndex++
			r.remaining = 0
		}

		var (
			n   int
			err error
		)
		if r.extentIndex >= len(r.extents) || r.position < r.extents[r.extentIndex].Offset {
			// Hole. Clear the caller's buffer directly; no backing storage is
			// allocated for the hole.
			n = len(p)
			if r.extentIndex < len(r.extents) {
				if available := r.extents[r.extentIndex].Offset - r.position; available < int64(n) {
					n = int(available)
				}
			} else if available := r.logicalSize - r.position; available < int64(n) {
				n = int(available)
			}
			clear(p[:n])
			r.position += int64(n)
		} else {
			extent := r.extents[r.extentIndex]
			if r.remaining == 0 {
				r.remaining = extent.End() - r.position
			}
			n = len(p)
			if int64(n) > r.remaining {
				n = int(r.remaining)
			}
			n, err = r.data.Read(p[:n])
			r.position += int64(n)
			r.remaining -= int64(n)
			if r.remaining == 0 {
				r.extentIndex++
			}
			if err != nil {
				if errors.Is(err, io.EOF) && r.position < extent.End() {
					err = io.ErrUnexpectedEOF
				}
				if n > 0 {
					// Return the bytes now; the error is reported on the next
					// call so callers do not silently lose progress.
					p = p[n:]
					total += n
					break
				}
				return total, err
			}
		}

		p = p[n:]
		total += n
	}

	if total > 0 {
		return total, nil
	}
	if r.position >= r.logicalSize {
		return 0, io.EOF
	}
	return 0, nil
}

// ReadAt implements io.ReaderAt when the compact source supports it. Holes
// are filled with zeroes. ReadAt does not change the sequential read position.
func (r *SparseReader) ReadAt(p []byte, offset int64) (int, error) {
	if r == nil {
		return 0, errors.New("dataeng: nil sparse reader")
	}
	if offset < 0 {
		return 0, errors.New("dataeng: negative offset")
	}
	if r.readAt == nil {
		return 0, ErrNotRandomAccess
	}
	if len(p) == 0 {
		return 0, nil
	}
	if offset >= r.logicalSize {
		return 0, io.EOF
	}

	remaining := r.logicalSize - offset
	want64 := int64(len(p))
	if want64 > remaining {
		want64 = remaining
	}
	want := int(want64)
	limit := offset + want64

	clear(p[:want])
	physicalBase := int64(0)
	for _, extent := range r.extents {
		extentEnd := extent.End()
		physicalBase += extent.Length
		if extentEnd <= offset {
			continue
		}
		if extent.Offset >= limit {
			break
		}

		start := max(offset, extent.Offset)
		end := min(limit, extentEnd)
		if start >= end {
			continue
		}
		physical := physicalBase - extent.Length + (start - extent.Offset)
		n, err := r.readAt.ReadAt(p[start-offset:end-offset], physical)
		if err != nil && !errors.Is(err, io.EOF) {
			return int(start - offset + int64(n)), err
		}
		if n != int(end-start) {
			return int(start - offset + int64(n)), io.ErrUnexpectedEOF
		}
	}

	if want < len(p) {
		return want, io.EOF
	}
	return want, nil
}

// WriteTo writes the expanded file to w. If w implements io.WriteSeeker, the
// holes are skipped with Seek rather than written, so a sparse destination is
// not forced to allocate blocks for them.
func (r *SparseReader) WriteTo(w io.Writer) (int64, error) {
	if r == nil {
		return 0, errors.New("dataeng: nil sparse reader")
	}
	if w == nil {
		return 0, errors.New("dataeng: nil writer")
	}

	if seeker, ok := w.(io.WriteSeeker); ok {
		return r.writeToSeeker(seeker)
	}
	return r.copyLogical(w)
}

func (r *SparseReader) copyLogical(w io.Writer) (int64, error) {
	n, err := io.Copy(w, struct{ io.Reader }{r})
	return n, err
}

func (r *SparseReader) writeToSeeker(w io.WriteSeeker) (int64, error) {
	start := r.position
	var written int64
	var lastWasHole bool

	// Make sure the destination is seekable before committing to this path.
	if _, err := w.Seek(0, io.SeekCurrent); err != nil {
		return r.copyLogical(w)
	}

	for r.position < r.logicalSize {
		for r.extentIndex < len(r.extents) && r.position >= r.extents[r.extentIndex].End() {
			r.extentIndex++
			r.remaining = 0
		}

		if r.extentIndex >= len(r.extents) || r.position < r.extents[r.extentIndex].Offset {
			var holeEnd int64
			if r.extentIndex < len(r.extents) {
				holeEnd = r.extents[r.extentIndex].Offset
			} else {
				holeEnd = r.logicalSize
			}
			hole := holeEnd - r.position
			if hole < 0 {
				break
			}
			if _, err := w.Seek(hole, io.SeekCurrent); err != nil {
				return written, err
			}
			r.position = holeEnd
			written += hole
			lastWasHole = true
			continue
		}

		extent := r.extents[r.extentIndex]
		if r.remaining == 0 {
			r.remaining = extent.End() - r.position
		}
		n, err := io.CopyN(w, r.data, r.remaining)
		r.position += n
		r.remaining -= n
		written += n
		lastWasHole = false
		if err != nil {
			if errors.Is(err, io.EOF) {
				return written, io.ErrUnexpectedEOF
			}
			return written, err
		}
		r.extentIndex++
	}

	// Seeking past the end does not extend a file. When the file ends with a
	// hole, seek one byte back and write a single zero byte to establish the
	// correct logical size without allocating the hole.
	if lastWasHole && r.logicalSize > start {
		if _, err := w.Seek(-1, io.SeekCurrent); err != nil {
			return written, err
		}
		if _, err := w.Write([]byte{0}); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

// Expand writes the expanded file to dst.
//
// When dst can seek, holes are skipped and dst can keep its sparse layout.
// Otherwise the logical byte stream, including zero-filled holes, is written.
func Expand(dst io.Writer, m *SparseMap, compact io.Reader) error {
	reader, err := NewSparseReader(m, compact)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, reader)
	return err
}

// Extract expands a sparse file into dst. Holes are skipped when dst supports
// io.WriteSeeker.
func Extract(dst io.Writer, m *SparseMap, compact io.Reader) error {
	return Expand(dst, m, compact)
}

// ExpandSparse is an alias for Expand.
func ExpandSparse(dst io.Writer, m *SparseMap, compact io.Reader) error {
	return Expand(dst, m, compact)
}

// WriteSparse is an alias for Expand.
func WriteSparse(dst io.Writer, m *SparseMap, compact io.Reader) error {
	return Expand(dst, m, compact)
}

// ValidateSparseMap is an alias for SparseMap.Validate.
func ValidateSparseMap(m *SparseMap) error {
	if m == nil {
		return ErrInvalidSparseMap
	}
	return m.Validate()
}

const maxInt64 = int64(^uint64(0) >> 1)
