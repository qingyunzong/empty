package tiff

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

// TIFF value types supported by this subset.
const (
	typeByte  = 1
	typeShort = 3
	typeLong  = 4
)

var typeSize = map[uint16]int{
	typeByte:  1,
	typeShort: 2,
	typeLong:  4,
}

// Recognized tags.
const (
	tagImageWidth      = 256
	tagImageLength     = 257
	tagBitsPerSample   = 258
	tagCompression     = 259
	tagStripOffsets    = 273
	tagSamplesPerPixel = 277
	tagRowsPerStrip    = 278
	tagStripByteCounts = 279
	tagPlanarConfig    = 284
)

// Rect selects a pixel rectangle. X and Y are the zero-based origin and
// Width/Height are the positive extents; the rectangle must lie fully inside
// the image.
type Rect struct {
	X      int
	Y      int
	Width  int
	Height int
}

type entry struct {
	tag         uint16
	typ         uint16
	count       uint32
	valueOrOff  uint32
	inline      [4]byte
	bytes       int
	externalOff uint32
	isExternal  bool
}

// Image is one parsed IFD directory.
type Image struct {
	Width        int
	Height       int
	Bands        int
	RowsPerStrip int
	PlanarConfig int
	Compression  int
	Strips       int

	reader         *Reader
	entries        map[uint16]*entry
	stripOffsets   []uint32
	stripByteCount []uint32
	stripRows      []int
	stripDecoded   []int
	rowBytes       int
	bandBytes      int
}

// Reader parses one TIFF stream and holds all of its IFD directories.
type Reader struct {
	r        io.ReaderAt
	size     int64
	order    binary.ByteOrder
	limits   Limits
	images   []*Image
	closer   io.Closer
	firstIFD uint32
}

// Open opens a TIFF file and parses its header and IFD chain. The returned
// Reader owns the file and Close must be called when done.
func Open(path string) (*Reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	r, err := NewReaderWithLimits(f, st.Size(), DefaultLimits)
	if err != nil {
		f.Close()
		return nil, err
	}
	r.closer = f
	return r, nil
}

// NewReader parses a TIFF stream backed by r using DefaultLimits. size is the
// total number of bytes in the stream.
func NewReader(r io.ReaderAt, size int64) (*Reader, error) {
	return NewReaderWithLimits(r, size, DefaultLimits)
}

// NewReaderWithLimits parses a TIFF stream using the supplied resource limits.
func NewReaderWithLimits(r io.ReaderAt, size int64, lim Limits) (*Reader, error) {
	if r == nil {
		return nil, errors.New("tiff: nil reader")
	}
	if size < 8 {
		return nil, errors.New("tiff: file smaller than TIFF header")
	}
	tr := &Reader{r: r, size: size, limits: lim.orDefault()}
	if err := tr.parseHeader(); err != nil {
		return nil, err
	}
	if err := tr.parseIFDs(); err != nil {
		return nil, err
	}
	return tr, nil
}

// Close releases the underlying file when the Reader was created with Open.
func (r *Reader) Close() error {
	if r.closer != nil {
		return r.closer.Close()
	}
	return nil
}

// Images returns the number of parsed IFD directories.
func (r *Reader) Images() int { return len(r.images) }

// Image returns the parsed directory at the given zero-based IFD index.
func (r *Reader) Image(index int) (*Image, error) {
	if index < 0 || index >= len(r.images) {
		return nil, fmt.Errorf("tiff: IFD index %d out of range (have %d)", index, len(r.images))
	}
	return r.images[index], nil
}

func (r *Reader) readAt(buf []byte, off int64) error {
	if off < 0 || int64(len(buf)) > r.size-off {
		return fmt.Errorf("tiff: read of %d bytes at offset %d exceeds file size %d", len(buf), off, r.size)
	}
	n, err := r.r.ReadAt(buf, off)
	if err != nil && err != io.EOF {
		return fmt.Errorf("tiff: read at offset %d: %w", off, err)
	}
	if n != len(buf) {
		return fmt.Errorf("tiff: short read at offset %d: got %d, want %d", off, n, len(buf))
	}
	return nil
}
