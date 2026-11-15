package dataeng

import (
	"archive/tar"
	"bytes"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
)

// Header is the tar header type used by the sparse importer.
type Header = tar.Header

// Entry is one file in a tar archive.
//
// Header.Size is the logical size after GNU sparse expansion. PhysicalSize is
// the number of bytes occupied by the entry body in the archive, excluding
// any header or extension blocks and excluding the entry's 512-byte padding.
// For PAX 1.0, PhysicalSize includes the in-body sparse map.
type Entry struct {
	Header *tar.Header
	entryHeader
	Sparse       *SparseMap
	Map          *SparseMap
	Extents      []Extent
	Format       SparseFormat
	PhysicalSize int64
	CompactSize  int64
	LogicalSize  int64

	// Data is the logical file content. Holes are produced as zeroes on
	// read; they are not backed by allocated storage.
	Data io.Reader
}

// entryHeader promotes the fields of tar.Header so an Entry can be used in
// the same places as the header returned by archive/tar while still exposing
// the sparse metadata under Entry.Header.
type entryHeader struct {
	*tar.Header
}

// Read implements io.Reader for the current entry.
func (e *Entry) Read(p []byte) (int, error) {
	if e == nil || e.Data == nil {
		return 0, io.EOF
	}
	return e.Data.Read(p)
}

// WriteTo writes the logical file content to w.
func (e *Entry) WriteTo(w io.Writer) (int64, error) {
	if e == nil || e.Data == nil {
		return 0, nil
	}
	if writerTo, ok := e.Data.(io.WriterTo); ok {
		return writerTo.WriteTo(w)
	}
	return io.Copy(w, e.Data)
}

// IsSparse reports whether the entry used a GNU sparse encoding.
func (e *Entry) IsSparse() bool { return e != nil && e.Sparse != nil }

// Reader sequentially imports tar entries, expanding GNU sparse files.
//
// Reader deliberately exposes the sparse map alongside the logical data so
// callers can either stream the expanded bytes or re-create the file
// sparsely with WriteTo/Expand.
type Reader struct {
	r io.Reader

	current    *Entry
	body       *io.LimitedReader
	currentPad int64

	globalPAX map[string]string
	done      bool
	err       error
}

// Importer, ArchiveReader, and TarReader are aliases for Reader.
type (
	Importer      = Reader
	ArchiveReader = Reader
	TarReader     = Reader
)

// NewReader creates a streaming sparse-aware tar importer.
func NewReader(r io.Reader) *Reader {
	return &Reader{r: r}
}

// NewImporter creates a streaming sparse-aware tar importer.
func NewImporter(r io.Reader) *Importer { return NewReader(r) }

// NewArchiveReader creates a streaming sparse-aware tar importer.
func NewArchiveReader(r io.Reader) *Reader { return NewReader(r) }

// NewTarReader creates a streaming sparse-aware tar importer.
func NewTarReader(r io.Reader) *Reader { return NewReader(r) }

// Next advances to the next file entry. Data left unread in the previous
// entry, including compact sparse data and padding, is consumed before the
// next header is read.
func (r *Reader) Next() (*Entry, error) {
	if r.err != nil {
		return nil, r.err
	}
	if r.done {
		return nil, io.EOF
	}
	if err := r.finishCurrent(); err != nil {
		r.err = err
		return nil, err
	}

	var (
		pendingPAX *paxHeader
		longName   string
		longLink   string
	)

	for {
		block, err := r.readHeaderBlock()
		if err != nil {
			r.err = err
			return nil, err
		}
		header, fileFormat, err := parseRawHeader(block[:])
		if err != nil {
			r.err = err
			return nil, err
		}

		switch header.Typeflag {
		case tar.TypeXHeader, tar.TypeXGlobalHeader:
			payload, err := r.readSpecialPayload(header.Size)
			if err != nil {
				r.err = err
				return nil, err
			}
			parsed, err := parsePAXHeader(payload)
			if err != nil {
				r.err = err
				return nil, err
			}
			if header.Typeflag == tar.TypeXGlobalHeader {
				if r.globalPAX == nil {
					r.globalPAX = make(map[string]string)
				}
				for key, value := range parsed.records {
					r.globalPAX[key] = value
				}
				continue
			}
			if pendingPAX == nil {
				pendingPAX = &paxHeader{records: make(map[string]string)}
			}
			for key, value := range parsed.records {
				pendingPAX.records[key] = value
			}
			if parsed.hasPairs {
				pendingPAX.pairs = append(pendingPAX.pairs, parsed.pairs...)
				pendingPAX.hasPairs = true
			}
			continue

		case tar.TypeGNULongName, tar.TypeGNULongLink:
			payload, err := r.readSpecialPayload(header.Size)
			if err != nil {
				r.err = err
				return nil, err
			}
			value := string(bytes.TrimRight(payload, "\x00"))
			if header.Typeflag == tar.TypeGNULongName {
				longName = value
			} else {
				longLink = value
			}
			continue
		}

		merged := r.mergedPAX(pendingPAX)
		header.PAXRecords = merged

		physicalSize := header.Size
		if isHeaderOnlyType(header.Typeflag) {
			physicalSize = 0
		}
		if err := applyPAXHeader(header, merged, &physicalSize); err != nil {
			r.err = err
			return nil, err
		}
		if pendingPAX != nil && fileFormat == tar.FormatUSTAR {
			header.Format = tar.FormatPAX
		}
		if longName != "" {
			header.Name = longName
		}
		if longLink != "" {
			header.Linkname = longLink
		}
		if name := merged[PAXGNUSparseName]; name != "" {
			header.Name = name
		}

		entry, compactSize, metadataSize, format, err := r.prepareEntry(
			header, fileFormat, block, pendingPAX, physicalSize,
		)
		if err != nil {
			r.err = err
			return nil, err
		}
		_ = metadataSize

		entry.Format = format
		entry.PhysicalSize = physicalSize
		entry.CompactSize = compactSize
		entry.LogicalSize = header.Size
		entry.Extents = nil
		if entry.Sparse != nil {
			entry.Extents = append([]Extent(nil), entry.Sparse.Extents...)
		}

		r.body = &io.LimitedReader{R: r.r, N: compactSize}
		switch {
		case entry.Sparse == nil:
			entry.Data = r.body
		default:
			sparseReader, err := NewSparseReader(entry.Sparse, r.body)
			if err != nil {
				r.err = err
				return nil, err
			}
			entry.Data = sparseReader
		}
		r.current = entry
		r.currentPad = padding(physicalSize)
		return entry, nil
	}
}

// NextEntry is an alias for Next.
func (r *Reader) NextEntry() (*Entry, error) { return r.Next() }

// NextHeader advances to the next entry and returns only its tar header.
// The entry body remains available through Reader.Read until the following
// call to Next.
func (r *Reader) NextHeader() (*tar.Header, error) {
	entry, err := r.Next()
	if err != nil {
		return nil, err
	}
	return entry.Header, nil
}

// Read implements io.Reader for the logical content of the current entry.
func (r *Reader) Read(p []byte) (int, error) {
	if r.err != nil {
		return 0, r.err
	}
	if r.current == nil || r.current.Data == nil {
		return 0, io.EOF
	}
	n, err := r.current.Data.Read(p)
	if err != nil && err != io.EOF {
		r.err = err
	}
	return n, err
}

// Current returns the current entry, if any.
func (r *Reader) Current() *Entry {
	if r == nil {
		return nil
	}
	return r.current
}

func (r *Reader) readHeaderBlock() ([blockSize]byte, error) {
	var block [blockSize]byte
	n, err := io.ReadFull(r.r, block[:])
	if err != nil {
		if err == io.EOF && n == 0 {
			r.done = true
			return block, io.EOF
		}
		if err == io.ErrUnexpectedEOF || err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		return block, err
	}
	if isZeroBlock(block[:]) {
		var second [blockSize]byte
		n, err = io.ReadFull(r.r, second[:])
		if err != nil {
			if (err == io.EOF || err == io.ErrUnexpectedEOF) && n == 0 {
				r.done = true
				return block, io.EOF
			}
			if err == io.EOF {
				err = io.ErrUnexpectedEOF
			}
			return block, err
		}
		if !isZeroBlock(second[:]) {
			return block, fmt.Errorf("%w: zero block followed by a non-zero block", ErrHeader)
		}
		r.done = true
		return block, io.EOF
	}
	return block, nil
}

func (r *Reader) readSpecialPayload(size int64) ([]byte, error) {
	if size < 0 {
		return nil, fmt.Errorf("%w: negative special-file size", ErrHeader)
	}
	if size > maxSpecialFileSize {
		return nil, ErrSparseMapTooLong
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(r.r, payload); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	if err := discard(r.r, padding(size)); err != nil {
		return nil, err
	}
	return payload, nil
}

func (r *Reader) mergedPAX(local *paxHeader) map[string]string {
	merged := make(map[string]string, len(r.globalPAX)+8)
	for key, value := range r.globalPAX {
		merged[key] = value
	}
	if local != nil {
		for key, value := range local.records {
			merged[key] = value
		}
	}
	return merged
}

func (r *Reader) prepareEntry(
	header *tar.Header,
	fileFormat tar.Format,
	rawBlock [blockSize]byte,
	pendingPAX *paxHeader,
	physicalSize int64,
) (*Entry, int64, int64, SparseFormat, error) {
	entry := &Entry{Header: header}
	entry.entryHeader.Header = header

	if header.Typeflag == tar.TypeGNUSparse {
		if fileFormat != tar.FormatGNU {
			return nil, 0, 0, SparseNone, fmt.Errorf("%w: type S sparse file without GNU format", ErrHeader)
		}
		extents, logicalSize, err := readOldGNUSparseMap(rawBlock[:], r.r)
		if err != nil {
			return nil, 0, 0, SparseNone, err
		}
		compactSize, err := validateCompactSize(extents, physicalSize)
		if err != nil {
			return nil, 0, 0, SparseNone, err
		}
		m := &SparseMap{
			LogicalSize: logicalSize,
			Size:        logicalSize,
			Extents:     extents,
			CompactSize: compactSize,
		}
		header.Size = logicalSize
		header.Format = tar.FormatGNU
		entry.Sparse = m
		entry.Map = m
		return entry, compactSize, 0, SparseGNULegacy, nil
	}

	var (
		pairs    []string
		hasPairs bool
	)
	if pendingPAX != nil {
		pairs, hasPairs = pendingPAX.pairs, pendingPAX.hasPairs
	}
	sparseMap, format, metadataSize, err := parseSparsePAX(
		header.PAXRecords, pairs, hasPairs, r.r, physicalSize,
	)
	if err != nil {
		return nil, 0, 0, SparseNone, err
	}
	if sparseMap != nil {
		if isHeaderOnlyType(header.Typeflag) {
			return nil, 0, 0, SparseNone, fmt.Errorf("%w: header-only entry cannot be sparse", ErrHeader)
		}
		compactSize := physicalSize - metadataSize
		if compactSize < 0 {
			return nil, 0, 0, SparseNone, fmt.Errorf("%w: sparse map exceeds entry body", ErrSizeMismatch)
		}
		if _, err := validateCompactSize(sparseMap.Extents, compactSize); err != nil {
			return nil, 0, 0, SparseNone, err
		}
		header.Size = sparseMap.LogicalSize
		header.Format = tar.FormatPAX
		entry.Sparse = sparseMap
		entry.Map = sparseMap
		return entry, compactSize, metadataSize, format, nil
	}

	return entry, physicalSize, 0, SparseNone, nil
}

func validateCompactSize(extents []Extent, physicalSize int64) (int64, error) {
	if physicalSize < 0 {
		return 0, fmt.Errorf("%w: negative entry body size", ErrSizeMismatch)
	}
	var compact int64
	for _, extent := range extents {
		if extent.Length > maxInt64-compact {
			return 0, fmt.Errorf("%w: compact data size overflows", ErrSizeMismatch)
		}
		compact += extent.Length
	}
	if compact != physicalSize {
		return 0, fmt.Errorf("%w: extents reference %d bytes, entry body has %d",
			ErrSizeMismatch, compact, physicalSize)
	}
	return compact, nil
}

func applyPAXHeader(header *tar.Header, records map[string]string, physicalSize *int64) error {
	for key, value := range records {
		if value == "" {
			continue
		}
		switch key {
		case "path":
			header.Name = value
		case "linkpath":
			header.Linkname = value
		case "uname":
			header.Uname = value
		case "gname":
			header.Gname = value
		case "uid":
			number, err := strconv.ParseInt(value, 10, 64)
			if err != nil || number < 0 || int64(int(number)) != number {
				return fmt.Errorf("%w: invalid uid %q", ErrHeader, value)
			}
			header.Uid = int(number)
		case "gid":
			number, err := strconv.ParseInt(value, 10, 64)
			if err != nil || number < 0 || int64(int(number)) != number {
				return fmt.Errorf("%w: invalid gid %q", ErrHeader, value)
			}
			header.Gid = int(number)
		case "size":
			number, err := strconv.ParseInt(value, 10, 64)
			if err != nil || number < 0 {
				return fmt.Errorf("%w: invalid size %q", ErrHeader, value)
			}
			*physicalSize = number
			header.Size = number
		case "mtime":
			parsed, err := parsePAXTime(value)
			if err != nil {
				return err
			}
			header.ModTime = parsed
		case "atime":
			parsed, err := parsePAXTime(value)
			if err != nil {
				return err
			}
			header.AccessTime = parsed
		case "ctime":
			parsed, err := parsePAXTime(value)
			if err != nil {
				return err
			}
			header.ChangeTime = parsed
		default:
			if strings.HasPrefix(key, "SCHILY.xattr.") {
				if header.Xattrs == nil {
					header.Xattrs = make(map[string]string)
				}
				header.Xattrs[strings.TrimPrefix(key, "SCHILY.xattr.")] = value
			}
		}
	}
	return nil
}

func parsePAXTime(value string) (time.Time, error) {
	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return time.Time{}, fmt.Errorf("%w: invalid PAX time %q", ErrHeader, value)
	}
	whole := math.Floor(seconds)
	fraction := seconds - whole
	if whole > math.MaxInt64/1e9 || whole < math.MinInt64/1e9 {
		return time.Time{}, fmt.Errorf("%w: PAX time out of range", ErrHeader)
	}
	return time.Unix(int64(whole), int64(fraction*1e9)), nil
}

func isHeaderOnlyType(typeflag byte) bool {
	switch typeflag {
	case tar.TypeLink, tar.TypeSymlink, tar.TypeChar, tar.TypeBlock,
		tar.TypeDir, tar.TypeFifo, tar.TypeGNULongName, tar.TypeGNULongLink,
		tar.TypeXHeader, tar.TypeXGlobalHeader:
		return true
	default:
		return false
	}
}

func padding(size int64) int64 {
	return -size & (blockSize - 1)
}

func discard(r io.Reader, size int64) error {
	if size <= 0 {
		return nil
	}
	_, err := io.CopyN(io.Discard, r, size)
	if err != nil {
		if err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		return err
	}
	return nil
}

func (r *Reader) finishCurrent() error {
	if r.current == nil {
		return nil
	}
	if r.body != nil && r.body.N > 0 {
		if err := discard(r.r, r.body.N); err != nil {
			return err
		}
		r.body.N = 0
	}
	if r.currentPad > 0 {
		if err := discard(r.r, r.currentPad); err != nil {
			return err
		}
		r.currentPad = 0
	}
	r.current = nil
	r.body = nil
	return nil
}
