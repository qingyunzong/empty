package dataeng

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
)

var (
	// ErrNotORC is returned when the file does not end with ORC's magic and a
	// valid postscript.
	ErrNotORC = errors.New("dataeng: not an ORC file")
	// ErrColumnNotFound is returned when a predicate names an unknown column.
	ErrColumnNotFound = errors.New("dataeng: column not found")
)

// Options controls timestamp interpretation and optional index use.
type Options struct {
	TimestampMode       TimestampMode
	DisableBloomFilters bool
}

// Column describes a field in the ORC schema.
type Column struct {
	ID       uint32
	Name     string
	Path     string
	Kind     ColumnKind
	Subtypes []uint32
	Parent   uint32
}

// StreamInfo describes one stream in a stripe. Offset is the on-disk offset.
type StreamInfo struct {
	Kind   StreamKind
	Column uint32
	Offset uint64
	Length uint64
}

// ColumnEncodingInfo is the per-column encoding in a stripe.
type ColumnEncodingInfo struct {
	Kind           EncodingKind
	DictionarySize uint32
	BloomEncoding  uint32
}

// StripeInfo is the metadata for a single ORC stripe.
type StripeInfo struct {
	Index          int
	Offset         uint64
	IndexLength    uint64
	DataLength     uint64
	FooterLength   uint64
	NumberOfRows   uint64
	FirstRow       int64
	WriterTimezone string
	Streams        []StreamInfo
	Columns        []ColumnEncodingInfo
	Statistics     []*ColumnStatistics
}

// Reader provides stripe and row-group pruning over an ORC file. It is safe for
// concurrent use.
type Reader struct {
	ra     io.ReaderAt
	closer io.Closer
	size   int64
	opts   Options

	ps     *postScript
	foot   *footer
	meta   *metadata
	schema []Column
	byPath map[string]uint32
	byName map[string][]uint32

	stripes []StripeInfo

	mu     sync.Mutex
	rowIdx map[int]map[uint32]*RowIndex
	blooms map[int]map[uint32][]*BloomFilter
}

// ORCReader is an alias for Reader.
type ORCReader = Reader

// Open opens an ORC file for pruning.
func Open(path string) (*Reader, error) {
	return OpenWithOptions(path, Options{})
}

// OpenORC is an alias for Open.
func OpenORC(path string) (*Reader, error) { return Open(path) }

// OpenWithOptions opens an ORC file with explicit options.
func OpenWithOptions(path string, opts Options) (*Reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	r, err := NewReaderWithOptions(f, st.Size(), opts)
	if err != nil {
		f.Close()
		return nil, err
	}
	r.closer = f
	return r, nil
}

// NewReader creates a reader over an io.ReaderAt.
func NewReader(ra io.ReaderAt, size int64) (*Reader, error) {
	return NewReaderWithOptions(ra, size, Options{})
}

// NewORCReader is an alias for NewReader.
func NewORCReader(ra io.ReaderAt, size int64) (*Reader, error) {
	return NewReader(ra, size)
}

// NewReaderWithOptions creates a reader over an io.ReaderAt.
func NewReaderWithOptions(ra io.ReaderAt, size int64, opts Options) (*Reader, error) {
	if ra == nil {
		return nil, errors.New("dataeng: nil reader")
	}
	if size < 4 {
		return nil, ErrNotORC
	}
	r := &Reader{
		ra:     ra,
		size:   size,
		opts:   opts,
		byPath: map[string]uint32{},
		byName: map[string][]uint32{},
		rowIdx: map[int]map[uint32]*RowIndex{},
		blooms: map[int]map[uint32][]*BloomFilter{},
	}
	if err := r.readMetadata(); err != nil {
		return nil, err
	}
	return r, nil
}

// Close closes the underlying file if it was opened by Open.
func (r *Reader) Close() error {
	if r.closer != nil {
		return r.closer.Close()
	}
	return nil
}

// NumberOfRows returns the file's row count.
func (r *Reader) NumberOfRows() int64 {
	if r.foot != nil && r.foot.NumberOfRows > 0 {
		return int64(r.foot.NumberOfRows)
	}
	var n int64
	for i := range r.stripes {
		n += int64(r.stripes[i].NumberOfRows)
	}
	return n
}

// RowIndexStride returns the writer's row-group size. Zero means row indexes
// were not written.
func (r *Reader) RowIndexStride() int {
	if r.foot == nil {
		return 0
	}
	return int(r.foot.RowIndexStride)
}

// WriterVersion returns the declared ORC writer version and whether it was
// present in the postscript.
func (r *Reader) WriterVersion() (uint32, bool) {
	if r.ps == nil {
		return 0, false
	}
	return r.ps.WriterVersion, r.ps.HasWriterVersion
}

// Compression returns the file's compression codec.
func (r *Reader) Compression() CompressionKind {
	if r.ps == nil {
		return CompressionNone
	}
	return r.ps.Compression
}

// Writer returns the writer identification string from the ORC footer.
func (r *Reader) Writer() string {
	if r.foot == nil {
		return ""
	}
	return r.foot.Writer
}

// Stripes returns a copy of the parsed stripe metadata.
func (r *Reader) Stripes() []StripeInfo {
	out := make([]StripeInfo, len(r.stripes))
	copy(out, r.stripes)
	return out
}

// Columns returns the flattened schema in ORC column-id order.
func (r *Reader) Columns() []Column {
	out := make([]Column, len(r.schema))
	copy(out, r.schema)
	return out
}

// Column finds a column by path or name. Nested fields use dotted paths.
func (r *Reader) Column(name string) (*Column, bool) {
	if id, ok := r.byPath[name]; ok {
		return &r.schema[id], true
	}
	lower := strings.ToLower(name)
	if id, ok := r.byPath[lower]; ok {
		return &r.schema[id], true
	}
	if ids := r.byName[lower]; len(ids) == 1 {
		return &r.schema[ids[0]], true
	}
	return nil, false
}

// RowIndex returns the parsed row-index entries for a column in a stripe.
// A nil result means the stripe has no row index for that column; callers
// should treat the corresponding statistics as missing and may-match.
func (r *Reader) RowIndex(stripe int, column string) (*RowIndex, error) {
	if stripe < 0 || stripe >= len(r.stripes) {
		return nil, fmt.Errorf("dataeng: stripe %d out of range", stripe)
	}
	col, err := r.findColumn(column)
	if err != nil {
		return nil, err
	}
	return r.rowIndexFor(stripe, col.ID), nil
}

// BloomFilter returns the parsed bloom filter for one row group. A nil result
// means the file has no bloom filter for that column/group.
func (r *Reader) BloomFilter(stripe, group int, column string) (*BloomFilter, error) {
	if stripe < 0 || stripe >= len(r.stripes) {
		return nil, fmt.Errorf("dataeng: stripe %d out of range", stripe)
	}
	col, err := r.findColumn(column)
	if err != nil {
		return nil, err
	}
	filters := r.bloomsFor(stripe, col.ID)
	if group < 0 || group >= len(filters) {
		return nil, nil
	}
	return filters[group], nil
}

func (r *Reader) readRange(offset, length uint64) ([]byte, error) {
	if offset > uint64(r.size) || length > uint64(r.size)-offset {
		return nil, errors.New("dataeng: ORC metadata range is outside the file")
	}
	if length == 0 {
		return nil, nil
	}
	buf := make([]byte, int(length))
	n, err := r.ra.ReadAt(buf, int64(offset))
	if err != nil && err != io.EOF {
		return nil, err
	}
	if n != len(buf) {
		return nil, errTruncatedProto
	}
	return buf, nil
}

func (r *Reader) readStream(offset, length uint64) ([]byte, error) {
	b, err := r.readRange(offset, length)
	if err != nil {
		return nil, err
	}
	block := uint64(defaultCompressionBlockSize)
	if r.ps != nil && r.ps.CompressionBlockSize > 0 {
		block = r.ps.CompressionBlockSize
	}
	return decompressStream(b, r.ps.Compression, block)
}

func (r *Reader) readMetadata() error {
	tail, err := r.readRange(uint64(r.size-3), 3)
	if err != nil {
		return err
	}
	if string(tail) != "ORC" {
		return ErrNotORC
	}
	// The last four bytes are: one-byte postscript length followed by "ORC".
	lenBuf, err := r.readRange(uint64(r.size-4), 1)
	if err != nil {
		return err
	}
	psLen := uint64(lenBuf[0])
	if psLen == 0 || psLen+4 > uint64(r.size) {
		return ErrNotORC
	}
	psStart := uint64(r.size-4) - psLen
	psBytes, err := r.readRange(psStart, psLen)
	if err != nil {
		return err
	}
	ps, err := parsePostScript(psBytes)
	if err != nil {
		return fmt.Errorf("dataeng: parse postscript: %w", err)
	}
	if ps.Magic != "" && ps.Magic != "ORC" {
		return ErrNotORC
	}
	if ps.FooterLength == 0 || ps.FooterLength > psStart {
		return errors.New("dataeng: invalid ORC footer length")
	}
	footerStart := psStart - ps.FooterLength
	if ps.MetadataLength > footerStart {
		return errors.New("dataeng: invalid ORC metadata length")
	}
	metadataStart := footerStart - ps.MetadataLength

	footerBytes, err := r.readRange(footerStart, ps.FooterLength)
	if err != nil {
		return err
	}
	footerBytes, err = decompressStream(footerBytes, ps.Compression, ps.CompressionBlockSize)
	if err != nil {
		return fmt.Errorf("dataeng: decompress footer: %w", err)
	}
	foot, err := parseFooter(footerBytes)
	if err != nil {
		return fmt.Errorf("dataeng: parse footer: %w", err)
	}
	r.ps = ps
	r.foot = foot

	if ps.MetadataLength > 0 {
		metadataBytes, err := r.readRange(metadataStart, ps.MetadataLength)
		if err != nil {
			return err
		}
		metadataBytes, err = decompressStream(metadataBytes, ps.Compression, ps.CompressionBlockSize)
		if err != nil {
			return fmt.Errorf("dataeng: decompress metadata: %w", err)
		}
		meta, err := parseMetadata(metadataBytes)
		if err != nil {
			return fmt.Errorf("dataeng: parse metadata: %w", err)
		}
		r.meta = meta
	}

	r.buildSchema()
	return r.readStripes()
}

func (r *Reader) readStripes() error {
	var firstRow int64
	r.stripes = make([]StripeInfo, 0, len(r.foot.Stripes))
	for i, si := range r.foot.Stripes {
		info := StripeInfo{
			Index:        i,
			Offset:       si.Offset,
			IndexLength:  si.IndexLength,
			DataLength:   si.DataLength,
			FooterLength: si.FooterLength,
			NumberOfRows: si.NumberOfRows,
			FirstRow:     firstRow,
		}
		if r.meta != nil && i < len(r.meta.StripeStats) {
			info.Statistics = r.meta.StripeStats[i]
		}
		footerOffset := si.Offset + si.IndexLength + si.DataLength
		footerBytes, err := r.readRange(footerOffset, si.FooterLength)
		if err != nil {
			return err
		}
		footerBytes, err = decompressStream(footerBytes, r.ps.Compression, r.ps.CompressionBlockSize)
		if err != nil {
			return fmt.Errorf("dataeng: decompress stripe %d footer: %w", i, err)
		}
		sf, err := parseStripeFooter(footerBytes)
		if err != nil {
			return fmt.Errorf("dataeng: parse stripe %d footer: %w", i, err)
		}
		info.WriterTimezone = sf.WriterTimezone
		offset := si.Offset
		info.Streams = make([]StreamInfo, 0, len(sf.Streams))
		for _, s := range sf.Streams {
			info.Streams = append(info.Streams, StreamInfo{
				Kind:   s.Kind,
				Column: s.Column,
				Offset: offset,
				Length: s.Length,
			})
			offset += s.Length
		}
		info.Columns = make([]ColumnEncodingInfo, 0, len(sf.Columns))
		for _, c := range sf.Columns {
			info.Columns = append(info.Columns, ColumnEncodingInfo{
				Kind:           c.Kind,
				DictionarySize: c.DictionarySize,
				BloomEncoding:  c.BloomEncoding,
			})
		}
		r.stripes = append(r.stripes, info)
		firstRow += int64(si.NumberOfRows)
	}
	return nil
}

func (r *Reader) buildSchema() {
	if len(r.foot.Types) == 0 {
		return
	}
	r.schema = make([]Column, len(r.foot.Types))
	for i, t := range r.foot.Types {
		r.schema[i] = Column{ID: uint32(i), Kind: t.Kind, Subtypes: append([]uint32(nil), t.Subtypes...)}
	}
	var walk func(id uint32, path string, name string, parent uint32)
	walk = func(id uint32, path string, name string, parent uint32) {
		if id >= uint32(len(r.foot.Types)) {
			return
		}
		t := r.foot.Types[id]
		c := &r.schema[id]
		c.Path = path
		c.Name = name
		c.Parent = parent
		if path != "" {
			r.byPath[path] = id
			lower := strings.ToLower(path)
			r.byPath[lower] = id
		}
		if name != "" {
			lower := strings.ToLower(name)
			r.byName[lower] = append(r.byName[lower], id)
		}
		for j, child := range t.Subtypes {
			childName := ""
			if j < len(t.FieldNames) {
				childName = t.FieldNames[j]
			}
			childPath := path
			switch t.Kind {
			case KindStruct:
				if childName == "" {
					childName = fmt.Sprintf("field%d", j)
				}
				if childPath == "" {
					childPath = childName
				} else {
					childPath = childPath + "." + childName
				}
			case KindList:
				childName = "element"
				if childPath == "" {
					childPath = childName
				} else {
					childPath = childPath + "." + childName
				}
			case KindMap:
				if j == 0 {
					childName = "key"
				} else {
					childName = "value"
				}
				if childPath == "" {
					childPath = childName
				} else {
					childPath = childPath + "." + childName
				}
			case KindUnion:
				childName = fmt.Sprintf("member%d", j)
				if childPath == "" {
					childPath = childName
				} else {
					childPath = childPath + "." + childName
				}
			default:
				continue
			}
			walk(child, childPath, childName, id)
		}
	}
	if r.foot.Types[0].Kind == KindStruct {
		walk(0, "", "", 0)
	} else {
		walk(0, "col0", "col0", 0)
	}
}

func (r *Reader) findColumn(name string) (*Column, error) {
	if c, ok := r.Column(name); ok {
		return c, nil
	}
	return nil, fmt.Errorf("%w: %s", ErrColumnNotFound, name)
}

func (r *Reader) streamFor(stripeIdx int, column uint32, kinds ...StreamKind) (StreamInfo, bool) {
	if stripeIdx < 0 || stripeIdx >= len(r.stripes) {
		return StreamInfo{}, false
	}
	for _, s := range r.stripes[stripeIdx].Streams {
		if s.Column != column {
			continue
		}
		for _, k := range kinds {
			if s.Kind == k {
				return s, true
			}
		}
	}
	return StreamInfo{}, false
}

func (r *Reader) rowIndexFor(stripeIdx int, column uint32) *RowIndex {
	r.mu.Lock()
	defer r.mu.Unlock()
	if byCol, ok := r.rowIdx[stripeIdx]; ok {
		return byCol[column]
	}
	byCol := map[uint32]*RowIndex{}
	if stripeIdx >= 0 && stripeIdx < len(r.stripes) {
		for _, s := range r.stripes[stripeIdx].Streams {
			if s.Kind != StreamRowIndex {
				continue
			}
			if _, exists := byCol[s.Column]; exists {
				continue
			}
			b, err := r.readStream(s.Offset, s.Length)
			if err != nil {
				continue
			}
			ri := parseRowIndexStream(b, groupCount(r.stripes[stripeIdx].NumberOfRows, r.RowIndexStride()))
			if ri != nil {
				byCol[s.Column] = ri
			}
		}
	}
	r.rowIdx[stripeIdx] = byCol
	return byCol[column]
}

func (r *Reader) bloomsFor(stripeIdx int, column uint32) []*BloomFilter {
	r.mu.Lock()
	defer r.mu.Unlock()
	if byCol, ok := r.blooms[stripeIdx]; ok {
		return byCol[column]
	}
	byCol := map[uint32][]*BloomFilter{}
	r.blooms[stripeIdx] = byCol
	if r.opts.DisableBloomFilters || stripeIdx < 0 || stripeIdx >= len(r.stripes) {
		return nil
	}
	groups := groupCount(r.stripes[stripeIdx].NumberOfRows, r.RowIndexStride())
	for _, s := range r.stripes[stripeIdx].Streams {
		if s.Kind != StreamBloomFilter && s.Kind != StreamBloomFilterUTF8 {
			continue
		}
		if _, exists := byCol[s.Column]; exists {
			continue
		}
		b, err := r.readStream(s.Offset, s.Length)
		if err != nil {
			continue
		}
		byCol[s.Column] = parseBloomFilterStream(b, groups)
	}
	return byCol[column]
}

func groupCount(rows uint64, stride int) int {
	if rows == 0 {
		return 0
	}
	if stride <= 0 {
		return 1
	}
	return int((rows + uint64(stride) - 1) / uint64(stride))
}

func parseBloomFilterStream(data []byte, expected int) []*BloomFilter {
	if len(data) == 0 {
		return nil
	}
	// Modern ORC writers emit one length-delimited BloomFilterIndex per row
	// group. Accept that first, then fall back to a single/concatenated message
	// for older writers.
	var delimited []*BloomFilter
	rest := data
	ok := true
	for len(rest) > 0 {
		n, used := uvarint(rest)
		if used <= 0 || n == 0 || n > uint64(len(rest)-used) {
			ok = false
			break
		}
		bfs, err := parseBloomFilterIndex(rest[used : used+int(n)])
		if err != nil || len(bfs) == 0 {
			ok = false
			break
		}
		delimited = append(delimited, bfs...)
		rest = rest[used+int(n):]
	}
	if ok && len(rest) == 0 && (expected <= 0 || len(delimited) == expected) {
		return delimited
	}
	if raw, err := parseBloomFilterIndex(data); err == nil && len(raw) > 0 {
		return raw
	}
	if ok {
		return delimited
	}
	return nil
}

func uvarint(b []byte) (uint64, int) {
	var x uint64
	var s uint
	for i, c := range b {
		if c < 0x80 {
			if i > 9 || i == 9 && c > 1 {
				return 0, 0
			}
			return x | uint64(c)<<s, i + 1
		}
		x |= uint64(c&0x7f) << s
		s += 7
		if s >= 64 {
			return 0, 0
		}
	}
	return 0, 0
}

func parseRowIndexStream(data []byte, expected int) *RowIndex {
	if len(data) == 0 {
		return nil
	}
	raw, rawErr := parseRowIndex(data)
	// Some producers write one length-delimited RowIndex per row group. Raw
	// parsing usually fails on those, but accept whichever form yields the
	// expected number of entries.
	var delimited []RowIndexEntry
	rest := data
	delimOK := true
	for len(rest) > 0 {
		n, used := uvarint(rest)
		if used <= 0 || n == 0 || n > uint64(len(rest)-used) {
			delimOK = false
			break
		}
		ri, err := parseRowIndex(rest[used : used+int(n)])
		if err != nil || len(ri.Entries) == 0 {
			delimOK = false
			break
		}
		delimited = append(delimited, ri.Entries...)
		rest = rest[used+int(n):]
	}
	if delimOK && len(rest) == 0 && (expected <= 0 || len(delimited) == expected) {
		return &RowIndex{Entries: delimited}
	}
	if rawErr == nil && (expected <= 0 || len(raw.Entries) == expected) {
		return raw
	}
	if delimOK && len(rest) == 0 && len(delimited) > 0 {
		return &RowIndex{Entries: delimited}
	}
	if rawErr == nil && len(raw.Entries) > 0 {
		return raw
	}
	return nil
}

func (r *Reader) stripeStats(stripeIdx int, column uint32) *ColumnStatistics {
	if stripeIdx < 0 || stripeIdx >= len(r.stripes) {
		return nil
	}
	stats := r.stripes[stripeIdx].Statistics
	if int(column) < len(stats) {
		if s := stats[column]; s != nil {
			return s
		}
	}
	// Metadata is optional in older files. File-level statistics are a safe
	// (wider) superset for every stripe, so they can be used as a fallback.
	if r.foot != nil && int(column) < len(r.foot.Statistics) {
		return r.foot.Statistics[column]
	}
	return nil
}

func (r *Reader) bloomEncoding(stripeIdx int, column uint32) uint32 {
	if stripeIdx < 0 || stripeIdx >= len(r.stripes) {
		return 0
	}
	cols := r.stripes[stripeIdx].Columns
	if int(column) >= len(cols) {
		return 0
	}
	return cols[column].BloomEncoding
}
