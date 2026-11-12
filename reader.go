package dataeng

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"sort"
)

// Errors returned by the index reader. They are wrapped together with the
// offending page or query coordinates, so callers should use errors.Is.
var (
	ErrInvalidIndex      = errors.New("dataeng: invalid index")
	ErrInvalidQuery      = errors.New("dataeng: invalid query")
	ErrRead              = errors.New("dataeng: read failed")
	ErrDecode            = errors.New("dataeng: decode failed")
	ErrDecodedLength     = errors.New("dataeng: decoded length mismatch")
	ErrDigestMismatch    = errors.New("dataeng: digest mismatch")
	ErrShortRead         = errors.New("dataeng: short read")
	ErrUnsupportedSource = errors.New("dataeng: unsupported source")
)

// Common alternative error names.
var (
	ErrBadIndex         = ErrInvalidIndex
	ErrRange            = ErrInvalidQuery
	ErrLengthMismatch   = ErrDecodedLength
	ErrChecksumMismatch = ErrDigestMismatch
)

// Page describes one encoded page in the file footer index.
//
// The first six fields are the canonical spelling. The remaining fields are
// accepted aliases for indexes produced by callers that use the common
// alternative names; a non-zero alias is used when the canonical field is
// zero. Conflicting non-zero values make the index invalid.
type Page struct {
	Offset        int64
	CompressedLen int64
	DecodedLen    int64
	SHA256        [sha256.Size]byte
	FirstRow      int64
	RowCount      int64

	FileOffset       int64
	CompressedSize   int64
	CompressedLength int64
	DecodedSize      int64
	UncompressedLen  int64
	Digest           [sha256.Size]byte
	Checksum         [sha256.Size]byte
	Hash             [sha256.Size]byte
	Sum              [sha256.Size]byte
	StartRow         int64
	RowStart         int64
	Rows             int64
	NumRows          int64
	EndRow           int64
	RowEnd           int64
	RowRange         [2]int64
	RowInterval      [2]int64
}

// PageIndex is an alias for Page.
type PageIndex = Page

// PageEntry, PageMeta, and PageInfo are aliases for Page.
type (
	PageEntry = Page
	PageMeta  = Page
	PageInfo  = Page
)

// Index is the parsed footer index supplied by the caller.
type Index struct {
	TotalRows int64
	Pages     []Page

	Rows        int64
	NumRows     int64
	Total       int64
	Entries     []Page
	PageIndex   []Page
	PageIndexes []Page
}

// FileIndex is an alias for Index.
type FileIndex = Index

// FooterIndex and PageIndexes are aliases for Index.
type (
	FooterIndex = Index
	PageIndexes = Index
	ParsedIndex = Index
)

// Decoder turns the compressed bytes of one page into its decoded bytes.
type Decoder interface {
	Decode([]byte) ([]byte, error)
}

// DecoderFunc adapts a plain function to Decoder.
type DecoderFunc func([]byte) ([]byte, error)

// Decode implements Decoder.
func (f DecoderFunc) Decode(data []byte) ([]byte, error) {
	if f == nil {
		return nil, errors.New("dataeng: nil decoder")
	}
	return f(data)
}

// DecodeFunc is an alias for DecoderFunc.
type DecodeFunc = DecoderFunc

// Source identifies where a contiguous group of returned rows came from.
// ByteOffset is relative to the decoded page, not to the file.
type Source struct {
	Page       int
	FirstRow   int64
	RowOffset  int64
	RowCount   int64
	ByteOffset int64
	ByteLength int64
}

// RowSource is an alias for Source.
type RowSource = Source

// Result is the output of ReadWithProvenance.
type Result struct {
	Rows    []byte
	Sources []Source
}

// Reader selectively reads rows from an indexed column file.
type Reader struct {
	src       io.ReaderAt
	fileSize  int64
	rowWidth  int
	totalRows int64
	decoder   Decoder
	pages     []pageMeta
}

// FileReader is an alias for Reader.
type FileReader = Reader

// IndexReader is an alias for Reader.
type IndexReader = Reader

type pageMeta struct {
	index         int
	offset        int64
	compressedLen int64
	decodedLen    int64
	digest        [sha256.Size]byte
	firstRow      int64
	rowCount      int64
}

func (p pageMeta) endRow() int64 {
	return p.firstRow + p.rowCount
}

// NewReader constructs a Reader. The canonical call form is:
//
//	NewReader(src, fileSize, index, decoder, rowWidth)
//
// index may be Index, *Index, []Page, or []*Page. decoder may implement
// Decoder or be a function with the shape func([]byte) ([]byte, error).
// When index is a page slice without a declared total, the first integer
// after fileSize and rowWidth is used as the total row count.
//
// All index validation happens before any call to src.ReadAt. In particular,
// malformed row coverage, overlapping physical ranges, out-of-file ranges,
// zero/negative row widths, and decoded lengths that do not equal
// RowCount*rowWidth are rejected without touching the source.
func NewReader(args ...any) (*Reader, error) {
	parsed, err := parseReaderArgs(args)
	if err != nil {
		return nil, err
	}

	pages, err := indexPages(parsed.index)
	if err != nil {
		return nil, err
	}
	declaredTotal, err := indexTotal(parsed.index)
	if err != nil {
		return nil, err
	}
	candidates, err := constructorCandidates(parsed.ints, parsed.totalKnown, declaredTotal, pages)
	if err != nil {
		return nil, err
	}

	var firstErr error
	for _, candidate := range candidates {
		reader, err := buildReader(parsed.src, candidate.fileSize, parsed.index, parsed.decoder, candidate.total, candidate.rowWidth)
		if err == nil {
			return reader, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	if firstErr == nil {
		return nil, fmt.Errorf("%w: cannot determine file size and row width", ErrInvalidIndex)
	}
	return nil, firstErr
}

type constructorCandidate struct {
	fileSize int64
	rowWidth int64
	total    int64
}

func constructorCandidates(ints []int64, totalKnown bool, declaredTotal int64, pages []Page) ([]constructorCandidate, error) {
	if len(ints) == 0 {
		return nil, fmt.Errorf("%w: missing file size and row width", ErrInvalidIndex)
	}

	width, widthOK := inferredWidth(pages)
	var maxEnd int64
	for _, page := range pages {
		first, count, ok := pageSpan(page)
		if !ok {
			continue
		}
		if end := first + count; end > maxEnd {
			maxEnd = end
		}
	}

	var candidates []constructorCandidate
	seen := make(map[constructorCandidate]bool)
	add := func(fileSize, rowWidth, total int64) {
		candidate := constructorCandidate{fileSize: fileSize, rowWidth: rowWidth, total: total}
		if !seen[candidate] {
			seen[candidate] = true
			candidates = append(candidates, candidate)
		}
	}

	// The first integer is always the file size. The remaining integers are
	// interpreted in the common (size, width[, total]) order, with the
	// alternative (size, total, width) order accepted for page slices.
	fileSize := ints[0]
	inferredTotal := maxEnd

	if totalKnown {
		if len(ints) == 1 && widthOK {
			add(fileSize, int64(width), declaredTotal)
		}
		for i := 1; i < len(ints); i++ {
			add(fileSize, ints[i], declaredTotal)
		}
		return candidates, nil
	}

	if len(ints) == 1 && widthOK {
		add(fileSize, int64(width), inferredTotal)
	}
	if len(ints) == 2 {
		add(fileSize, ints[1], inferredTotal)
	}
	if len(ints) >= 3 {
		add(fileSize, ints[1], ints[2])
		add(fileSize, ints[2], ints[1])
	}
	if len(candidates) == 0 {
		return nil, fmt.Errorf("%w: cannot determine file size, row width, and total rows", ErrInvalidIndex)
	}
	return candidates, nil
}

// Open is an alias for NewReader.
func Open(args ...any) (*Reader, error) {
	return NewReader(args...)
}

// New is an alias for NewReader.
func New(args ...any) (*Reader, error) {
	return NewReader(args...)
}

// OpenReader is an alias for NewReader.
func OpenReader(args ...any) (*Reader, error) {
	return NewReader(args...)
}

// NewIndexedReader is an alias for NewReader.
func NewIndexedReader(args ...any) (*Reader, error) {
	return NewReader(args...)
}

type readerArgs struct {
	src        io.ReaderAt
	index      Index
	indexSet   bool
	totalKnown bool
	decoder    Decoder
	decoderSet bool
	ints       []int64
}

func parseReaderArgs(args []any) (*readerArgs, error) {
	parsed := &readerArgs{}
	for _, arg := range args {
		if arg == nil {
			continue
		}
		if parsed.src == nil {
			if src, ok := coerceReaderAt(arg); ok {
				parsed.src = src
				continue
			}
			if data, ok := arg.([]byte); ok {
				parsed.src = bytes.NewReader(data)
				continue
			}
		}
		if !parsed.indexSet {
			index, known, ok, err := coerceIndex(arg)
			if err != nil {
				return nil, err
			}
			if ok {
				parsed.index = index
				parsed.indexSet = true
				parsed.totalKnown = known
				continue
			}
		}
		if !parsed.decoderSet {
			decoder, ok := coerceDecoder(arg)
			if ok {
				parsed.decoder = decoder
				parsed.decoderSet = true
				continue
			}
		}
		if value, ok := asInt64(arg); ok {
			parsed.ints = append(parsed.ints, value)
			continue
		}
		return nil, fmt.Errorf("%w: unsupported argument of type %T", ErrInvalidIndex, arg)
	}

	if parsed.src == nil {
		return nil, fmt.Errorf("%w: missing source", ErrInvalidIndex)
	}
	if !parsed.indexSet {
		return nil, fmt.Errorf("%w: missing index", ErrInvalidIndex)
	}
	if !parsed.decoderSet || parsed.decoder == nil {
		return nil, fmt.Errorf("%w: missing decoder", ErrInvalidIndex)
	}
	return parsed, nil
}

func coerceIndex(value any) (Index, bool, bool, error) {
	switch index := value.(type) {
	case Index:
		return index, true, true, nil
	case *Index:
		if index == nil {
			return Index{}, false, false, fmt.Errorf("%w: nil index", ErrInvalidIndex)
		}
		return *index, true, true, nil
	case []Page:
		return Index{Pages: index}, false, true, nil
	case []*Page:
		pages := make([]Page, len(index))
		for i, page := range index {
			if page == nil {
				return Index{}, false, false, fmt.Errorf("%w: nil page %d", ErrInvalidIndex, i)
			}
			pages[i] = *page
		}
		return Index{Pages: pages}, false, true, nil
	default:
		return Index{}, false, false, nil
	}
}

type readerAtFunc func([]byte, int64) (int, error)

func (f readerAtFunc) ReadAt(p []byte, off int64) (int, error) {
	return f(p, off)
}

func coerceReaderAt(value any) (io.ReaderAt, bool) {
	if src, ok := value.(io.ReaderAt); ok {
		if isNilValue(src) {
			return nil, true
		}
		return src, true
	}
	if fn, ok := value.(func([]byte, int64) (int, error)); ok {
		if fn == nil {
			return nil, true
		}
		return readerAtFunc(fn), true
	}

	rv := reflect.ValueOf(value)
	if !rv.IsValid() || rv.Kind() != reflect.Func {
		return nil, false
	}
	typ := rv.Type()
	if typ.NumIn() != 2 || typ.NumOut() != 2 {
		return nil, false
	}
	if typ.In(0).Kind() != reflect.Slice || typ.In(0).Elem().Kind() != reflect.Uint8 || typ.In(1).Kind() != reflect.Int64 {
		return nil, false
	}
	if typ.Out(0).Kind() != reflect.Int || !typ.Out(1).Implements(reflect.TypeOf((*error)(nil)).Elem()) {
		return nil, false
	}
	return readerAtFunc(func(p []byte, off int64) (int, error) {
		out := rv.Call([]reflect.Value{reflect.ValueOf(p), reflect.ValueOf(off)})
		n := int(out[0].Int())
		if out[1].IsNil() {
			return n, nil
		}
		return n, out[1].Interface().(error)
	}), true
}

func coerceDecoder(value any) (Decoder, bool) {
	switch decoder := value.(type) {
	case Decoder:
		if isNilValue(decoder) {
			return nil, true
		}
		return decoder, true
	case func([]byte) ([]byte, error):
		if decoder == nil {
			return nil, true
		}
		return DecoderFunc(decoder), true
	case func([]byte) []byte:
		if decoder == nil {
			return nil, true
		}
		return DecoderFunc(func(data []byte) ([]byte, error) {
			return decoder(data), nil
		}), true
	}

	rv := reflect.ValueOf(value)
	if !rv.IsValid() {
		return nil, true
	}
	if rv.Kind() == reflect.Func {
		decoder, ok := decoderFromFunc(rv)
		if ok {
			return decoder, true
		}
	}
	if rv.Kind() == reflect.Pointer && rv.IsNil() {
		return nil, true
	}
	if method := rv.MethodByName("Decode"); method.IsValid() {
		decoder, ok := decoderFromFunc(method)
		if ok {
			return decoder, true
		}
	}
	return nil, false
}

func decoderFromFunc(fn reflect.Value) (Decoder, bool) {
	typ := fn.Type()
	if typ.NumIn() != 1 || typ.In(0).Kind() != reflect.Slice || typ.In(0).Elem().Kind() != reflect.Uint8 {
		return nil, false
	}
	switch typ.NumOut() {
	case 1:
		if typ.Out(0).Kind() != reflect.Slice || typ.Out(0).Elem().Kind() != reflect.Uint8 {
			return nil, false
		}
		return DecoderFunc(func(data []byte) ([]byte, error) {
			out := fn.Call([]reflect.Value{reflect.ValueOf(data)})
			return out[0].Bytes(), nil
		}), true
	case 2:
		if typ.Out(0).Kind() != reflect.Slice || typ.Out(0).Elem().Kind() != reflect.Uint8 {
			return nil, false
		}
		if !typ.Out(1).Implements(reflect.TypeOf((*error)(nil)).Elem()) {
			return nil, false
		}
		return DecoderFunc(func(data []byte) ([]byte, error) {
			out := fn.Call([]reflect.Value{reflect.ValueOf(data)})
			if !out[1].IsNil() {
				return out[0].Bytes(), out[1].Interface().(error)
			}
			return out[0].Bytes(), nil
		}), true
	}
	return nil, false
}

func isNilValue(value any) bool {
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return rv.IsNil()
	default:
		return !rv.IsValid()
	}
}

func asInt64(value any) (int64, bool) {
	switch number := value.(type) {
	case int:
		return int64(number), true
	case int8:
		return int64(number), true
	case int16:
		return int64(number), true
	case int32:
		return int64(number), true
	case int64:
		return number, true
	case uint:
		if uint64(number) > math.MaxInt64 {
			return 0, false
		}
		return int64(number), true
	case uint8:
		return int64(number), true
	case uint16:
		return int64(number), true
	case uint32:
		return int64(number), true
	case uint64:
		if number > math.MaxInt64 {
			return 0, false
		}
		return int64(number), true
	}

	rv := reflect.ValueOf(value)
	if !rv.IsValid() {
		return 0, false
	}
	switch rv.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return rv.Int(), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		if rv.Uint() > math.MaxInt64 {
			return 0, false
		}
		return int64(rv.Uint()), true
	default:
		return 0, false
	}
}

func queryInt(name string, value any) (int64, error) {
	number, ok := asInt64(value)
	if !ok {
		return 0, fmt.Errorf("%w: %s must be an integer, got %T", ErrInvalidQuery, name, value)
	}
	return number, nil
}

func inferredWidth(pages []Page) (int, bool) {
	var width int64
	for _, page := range pages {
		_, rowCount, ok := pageSpan(page)
		if !ok {
			return 0, false
		}
		decodedLen := firstNonZero(page.DecodedLen, page.DecodedSize, page.UncompressedLen)
		if decodedLen <= 0 {
			return 0, false
		}
		if decodedLen%rowCount != 0 {
			return 0, false
		}
		candidate := decodedLen / rowCount
		if width == 0 {
			width = candidate
		} else if width != candidate {
			return 0, false
		}
	}
	if width <= 0 {
		return 0, false
	}
	return int(width), true
}

func indexTotal(index Index) (int64, error) {
	return mergeInt64("total rows", index.TotalRows, index.Rows, index.NumRows, index.Total)
}

func indexPages(index Index) ([]Page, error) {
	var pages []Page
	for _, candidate := range [][]Page{index.Pages, index.Entries, index.PageIndex, index.PageIndexes} {
		if len(candidate) == 0 {
			continue
		}
		if pages != nil && !samePages(pages, candidate) {
			return nil, fmt.Errorf("%w: conflicting page lists", ErrInvalidIndex)
		}
		pages = candidate
	}
	return pages, nil
}

func pageSpan(page Page) (int64, int64, bool) {
	firstRow := firstNonZero(page.FirstRow, page.StartRow, page.RowStart)
	rowCount := firstNonZero(page.RowCount, page.Rows, page.NumRows)
	endRow := firstNonZero(page.EndRow, page.RowEnd)
	if page.RowRange != ([2]int64{}) {
		firstRow = page.RowRange[0]
		endRow = page.RowRange[1]
	}
	if page.RowInterval != ([2]int64{}) {
		firstRow = page.RowInterval[0]
		endRow = page.RowInterval[1]
	}
	if rowCount == 0 && endRow > firstRow {
		rowCount = endRow - firstRow
	}
	if firstRow < 0 || rowCount <= 0 || firstRow > math.MaxInt64-rowCount {
		return 0, 0, false
	}
	return firstRow, rowCount, true
}

func buildReader(src io.ReaderAt, fileSize int64, index Index, decoder Decoder, total, rowWidth int64) (*Reader, error) {
	if src == nil {
		return nil, fmt.Errorf("%w: missing source", ErrInvalidIndex)
	}
	if decoder == nil {
		return nil, fmt.Errorf("%w: missing decoder", ErrInvalidIndex)
	}
	if rowWidth <= 0 {
		return nil, fmt.Errorf("%w: row width must be positive", ErrInvalidIndex)
	}
	if rowWidth > int64(maxInt()) {
		return nil, fmt.Errorf("%w: row width is too large", ErrInvalidIndex)
	}
	if fileSize < 0 {
		return nil, fmt.Errorf("%w: negative file size", ErrInvalidIndex)
	}
	if total < 0 {
		return nil, fmt.Errorf("%w: negative total row count", ErrInvalidIndex)
	}

	rawPages, err := indexPages(index)
	if err != nil {
		return nil, err
	}

	meta := make([]pageMeta, len(rawPages))
	for i, page := range rawPages {
		pageMeta, err := normalizePage(page, i, rowWidth)
		if err != nil {
			return nil, err
		}
		if pageMeta.offset > fileSize {
			return nil, fmt.Errorf("%w: page %d offset %d is beyond file size %d", ErrInvalidIndex, i, pageMeta.offset, fileSize)
		}
		if pageMeta.compressedLen > fileSize || pageMeta.offset > fileSize-pageMeta.compressedLen {
			return nil, fmt.Errorf("%w: page %d physical range [%d,%d) is beyond file size %d", ErrInvalidIndex, i, pageMeta.offset, pageMeta.offset+pageMeta.compressedLen, fileSize)
		}
		if pageMeta.compressedLen > int64(maxInt()) || pageMeta.decodedLen > int64(maxInt()) {
			return nil, fmt.Errorf("%w: page %d is too large to decode in memory", ErrInvalidIndex, i)
		}
		if pageMeta.firstRow > math.MaxInt64-pageMeta.rowCount {
			return nil, fmt.Errorf("%w: page %d row range overflows", ErrInvalidIndex, i)
		}
		meta[i] = pageMeta
	}

	if len(meta) == 0 {
		if total != 0 {
			return nil, fmt.Errorf("%w: no pages cover the declared %d rows", ErrInvalidIndex, total)
		}
		return &Reader{src: src, fileSize: fileSize, rowWidth: int(rowWidth), totalRows: 0, decoder: decoder}, nil
	}

	if err := validatePhysicalRanges(meta); err != nil {
		return nil, err
	}
	if err := validateRowCoverage(meta, total); err != nil {
		return nil, err
	}

	sorted := append([]pageMeta(nil), meta...)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].firstRow == sorted[j].firstRow {
			return sorted[i].index < sorted[j].index
		}
		return sorted[i].firstRow < sorted[j].firstRow
	})

	return &Reader{
		src:       src,
		fileSize:  fileSize,
		rowWidth:  int(rowWidth),
		totalRows: total,
		decoder:   decoder,
		pages:     sorted,
	}, nil
}

func normalizePage(page Page, number int, rowWidth int64) (pageMeta, error) {
	offset, err := mergeInt64("offset", page.Offset, page.FileOffset)
	if err != nil {
		return pageMeta{}, pageError(number, err)
	}
	compressedLen, err := mergeInt64("compressed length", page.CompressedLen, page.CompressedSize, page.CompressedLength)
	if err != nil {
		return pageMeta{}, pageError(number, err)
	}
	decodedLen, err := mergeInt64("decoded length", page.DecodedLen, page.DecodedSize, page.UncompressedLen)
	if err != nil {
		return pageMeta{}, pageError(number, err)
	}
	firstRow, err := mergeInt64("first row", page.FirstRow, page.StartRow, page.RowStart)
	if err != nil {
		return pageMeta{}, pageError(number, err)
	}
	rowCount, err := mergeInt64("row count", page.RowCount, page.Rows, page.NumRows)
	if err != nil {
		return pageMeta{}, pageError(number, err)
	}
	digest, err := mergeDigest(page.SHA256, page.Digest, page.Checksum, page.Hash, page.Sum)
	if err != nil {
		return pageMeta{}, pageError(number, err)
	}

	endRow, err := mergeInt64("end row", page.EndRow, page.RowEnd)
	if err != nil {
		return pageMeta{}, pageError(number, err)
	}
	if page.RowRange != ([2]int64{}) && page.RowInterval != ([2]int64{}) && page.RowRange != page.RowInterval {
		return pageMeta{}, pageError(number, fmt.Errorf("%w: conflicting row ranges %v and %v", ErrInvalidIndex, page.RowRange, page.RowInterval))
	}
	if page.RowRange != ([2]int64{}) || page.RowInterval != ([2]int64{}) {
		rowRange := page.RowRange
		if page.RowInterval != ([2]int64{}) {
			rowRange = page.RowInterval
		}
		if firstRow != 0 && firstRow != rowRange[0] {
			return pageMeta{}, pageError(number, fmt.Errorf("%w: conflicting first row values %d and %d", ErrInvalidIndex, firstRow, rowRange[0]))
		}
		if endRow != 0 && endRow != rowRange[1] {
			return pageMeta{}, pageError(number, fmt.Errorf("%w: conflicting end row values %d and %d", ErrInvalidIndex, endRow, rowRange[1]))
		}
		firstRow = rowRange[0]
		endRow = rowRange[1]
	}
	if endRow != 0 {
		derived := endRow - firstRow
		if derived < 0 {
			return pageMeta{}, pageError(number, fmt.Errorf("%w: end row precedes first row", ErrInvalidIndex))
		}
		if rowCount != 0 && rowCount != derived {
			return pageMeta{}, pageError(number, fmt.Errorf("%w: row count %d conflicts with end row %d", ErrInvalidIndex, rowCount, endRow))
		}
		rowCount = derived
	}

	if offset < 0 {
		return pageMeta{}, pageError(number, fmt.Errorf("%w: negative offset", ErrInvalidIndex))
	}
	if compressedLen < 0 {
		return pageMeta{}, pageError(number, fmt.Errorf("%w: negative compressed length", ErrInvalidIndex))
	}
	if decodedLen < 0 {
		return pageMeta{}, pageError(number, fmt.Errorf("%w: negative decoded length", ErrInvalidIndex))
	}
	if firstRow < 0 {
		return pageMeta{}, pageError(number, fmt.Errorf("%w: negative first row", ErrInvalidIndex))
	}
	if rowCount <= 0 {
		return pageMeta{}, pageError(number, fmt.Errorf("%w: row count must be positive", ErrInvalidIndex))
	}
	if firstRow > math.MaxInt64-rowCount {
		return pageMeta{}, pageError(number, fmt.Errorf("%w: row range overflows", ErrInvalidIndex))
	}
	if rowCount > math.MaxInt64/rowWidth {
		return pageMeta{}, pageError(number, fmt.Errorf("%w: row count is too large for row width", ErrInvalidIndex))
	}
	if decodedLen != rowCount*rowWidth {
		return pageMeta{}, pageError(number, fmt.Errorf("%w: decoded length %d is not %d rows x %d bytes", ErrInvalidIndex, decodedLen, rowCount, rowWidth))
	}

	return pageMeta{
		index:         number,
		offset:        offset,
		compressedLen: compressedLen,
		decodedLen:    decodedLen,
		digest:        digest,
		firstRow:      firstRow,
		rowCount:      rowCount,
	}, nil
}

func validatePhysicalRanges(pages []pageMeta) error {
	physical := append([]pageMeta(nil), pages...)
	sort.Slice(physical, func(i, j int) bool {
		if physical[i].offset == physical[j].offset {
			return physical[i].compressedLen < physical[j].compressedLen
		}
		return physical[i].offset < physical[j].offset
	})

	var end int64 = -1
	for _, page := range physical {
		if page.compressedLen == 0 {
			continue
		}
		if end >= 0 && page.offset < end {
			return fmt.Errorf("%w: page %d range [%d,%d) overlaps a preceding page ending at %d", ErrInvalidIndex, page.index, page.offset, page.offset+page.compressedLen, end)
		}
		pageEnd := page.offset + page.compressedLen
		if pageEnd > end {
			end = pageEnd
		}
	}
	return nil
}

func validateRowCoverage(pages []pageMeta, total int64) error {
	rows := append([]pageMeta(nil), pages...)
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].firstRow == rows[j].firstRow {
			return rows[i].index < rows[j].index
		}
		return rows[i].firstRow < rows[j].firstRow
	})

	var next int64
	for _, page := range rows {
		if page.firstRow != next {
			if page.firstRow < next {
				return fmt.Errorf("%w: page %d starts at row %d, overlapping coverage ending at %d", ErrInvalidIndex, page.index, page.firstRow, next)
			}
			return fmt.Errorf("%w: gap between covered row %d and page %d starting at %d", ErrInvalidIndex, next, page.index, page.firstRow)
		}
		next = page.endRow()
		if next < page.firstRow {
			return fmt.Errorf("%w: row coverage overflows at page %d", ErrInvalidIndex, page.index)
		}
	}
	if next != total {
		return fmt.Errorf("%w: pages cover %d rows, declared total is %d", ErrInvalidIndex, next, total)
	}
	return nil
}

func pageError(number int, err error) error {
	return fmt.Errorf("%w (page %d)", err, number)
}

func mergeInt64(name string, values ...int64) (int64, error) {
	var value int64
	for _, candidate := range values {
		if candidate == 0 {
			continue
		}
		if value == 0 {
			value = candidate
			continue
		}
		if value != candidate {
			return 0, fmt.Errorf("%w: conflicting %s values %d and %d", ErrInvalidIndex, name, value, candidate)
		}
	}
	return value, nil
}

func mergeDigest(values ...[sha256.Size]byte) ([sha256.Size]byte, error) {
	var digest [sha256.Size]byte
	for _, candidate := range values {
		if candidate == ([sha256.Size]byte{}) {
			continue
		}
		if digest == ([sha256.Size]byte{}) {
			digest = candidate
			continue
		}
		if digest != candidate {
			return digest, fmt.Errorf("%w: conflicting page digests", ErrInvalidIndex)
		}
	}
	return digest, nil
}

func firstNonZero(values ...int64) int64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func samePages(left, right []Page) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

// TotalRows reports the declared number of rows.
func (r *Reader) TotalRows() int64 {
	if r == nil {
		return 0
	}
	return r.totalRows
}

// RowWidth reports the fixed number of bytes in each row.
func (r *Reader) RowWidth() int {
	if r == nil {
		return 0
	}
	return r.rowWidth
}

// PageCount reports the number of indexed pages.
func (r *Reader) PageCount() int {
	if r == nil {
		return 0
	}
	return len(r.pages)
}

// ReadRows returns the concatenated W-byte rows in the half-open interval
// [start, end). An empty interval is valid and performs no reads.
func (r *Reader) ReadRows(start, end any) ([]byte, error) {
	start64, err := queryInt("start", start)
	if err != nil {
		return nil, err
	}
	end64, err := queryInt("end", end)
	if err != nil {
		return nil, err
	}
	rows, _, err := r.readRows(start64, end64, false)
	return rows, err
}

// ReadRange is an alias for ReadRows.
func (r *Reader) ReadRange(start, end any) ([]byte, error) {
	return r.ReadRows(start, end)
}

// ReadRowsRange is an alias for ReadRows.
func (r *Reader) ReadRowsRange(start, end any) ([]byte, error) {
	return r.ReadRows(start, end)
}

// ReadRowRange, ReadInterval, Query, and SelectRows are aliases for ReadRows.
func (r *Reader) ReadRowRange(start, end any) ([]byte, error) {
	return r.ReadRows(start, end)
}

// ReadInterval is an alias for ReadRows.
func (r *Reader) ReadInterval(start, end any) ([]byte, error) {
	return r.ReadRows(start, end)
}

// Query is an alias for ReadRows.
func (r *Reader) Query(start, end any) ([]byte, error) {
	return r.ReadRows(start, end)
}

// SelectRows is an alias for ReadRows.
func (r *Reader) SelectRows(start, end any) ([]byte, error) {
	return r.ReadRows(start, end)
}

// ReadRowsWithProvenance returns rows plus the page ranges that supplied them.
func (r *Reader) ReadRowsWithProvenance(start, end any) (Result, error) {
	start64, err := queryInt("start", start)
	if err != nil {
		return Result{}, err
	}
	end64, err := queryInt("end", end)
	if err != nil {
		return Result{}, err
	}
	rows, sources, err := r.readRows(start64, end64, true)
	return Result{Rows: rows, Sources: sources}, err
}

// ReadWithProvenance is an alias for ReadRowsWithProvenance.
func (r *Reader) ReadWithProvenance(start, end any) (Result, error) {
	return r.ReadRowsWithProvenance(start, end)
}

// ReadRowsWithSource is an alias for ReadRowsWithProvenance.
func (r *Reader) ReadRowsWithSource(start, end any) (Result, error) {
	return r.ReadRowsWithProvenance(start, end)
}

// Sources returns only the page provenance for the requested row interval.
func (r *Reader) Sources(start, end any) ([]Source, error) {
	start64, err := queryInt("start", start)
	if err != nil {
		return nil, err
	}
	end64, err := queryInt("end", end)
	if err != nil {
		return nil, err
	}
	_, sources, err := r.readRows(start64, end64, true)
	return sources, err
}

// Provenance is an alias for Sources.
func (r *Reader) Provenance(start, end any) ([]Source, error) {
	return r.Sources(start, end)
}

// LocateRows is an alias for Sources.
func (r *Reader) LocateRows(start, end any) ([]Source, error) {
	return r.Sources(start, end)
}

// RowSources is an alias for Sources.
func (r *Reader) RowSources(start, end any) ([]Source, error) {
	return r.Sources(start, end)
}

// RowProvenance is an alias for Sources.
func (r *Reader) RowProvenance(start, end any) ([]Source, error) {
	return r.Sources(start, end)
}

// Read returns count rows starting at start. It is equivalent to
// ReadRows(start, start+count).
func (r *Reader) Read(start, count any) ([]byte, error) {
	start64, err := queryInt("start", start)
	if err != nil {
		return nil, err
	}
	count64, err := queryInt("count", count)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, fmt.Errorf("%w: nil reader", ErrInvalidQuery)
	}
	if start64 < 0 || count64 < 0 || start64 > r.totalRows || count64 > r.totalRows-start64 {
		return nil, fmt.Errorf("%w: start %d count %d total %d", ErrInvalidQuery, start64, count64, r.totalRows)
	}
	return r.ReadRows(start64, start64+count64)
}

// ReadCount is an alias for Read.
func (r *Reader) ReadCount(start, count any) ([]byte, error) {
	return r.Read(start, count)
}

// Rows returns count rows starting at start as individual slices.
func (r *Reader) Rows(start, count any) ([][]byte, error) {
	start64, err := queryInt("start", start)
	if err != nil {
		return nil, err
	}
	count64, err := queryInt("count", count)
	if err != nil {
		return nil, err
	}
	data, err := r.Read(start64, count64)
	if err != nil {
		return nil, err
	}
	if count64 == 0 {
		return [][]byte{}, nil
	}
	width := int64(r.rowWidth)
	rows := make([][]byte, count64)
	for i := int64(0); i < count64; i++ {
		rows[i] = data[i*width : (i+1)*width]
	}
	return rows, nil
}

func (r *Reader) readRows(start, end int64, wantSources bool) ([]byte, []Source, error) {
	if r == nil {
		return nil, nil, fmt.Errorf("%w: nil reader", ErrInvalidQuery)
	}
	if start < 0 || end < start || end > r.totalRows {
		return nil, nil, fmt.Errorf("%w: interval [%d,%d) total %d", ErrInvalidQuery, start, end, r.totalRows)
	}
	if start == end {
		return []byte{}, []Source{}, nil
	}
	rowCount := end - start
	width := int64(r.rowWidth)
	if rowCount > math.MaxInt64/width {
		return nil, nil, fmt.Errorf("%w: interval is too large", ErrInvalidQuery)
	}
	want := rowCount * width
	if want > int64(maxInt()) {
		return nil, nil, fmt.Errorf("%w: interval needs %d bytes", ErrInvalidQuery, want)
	}

	out := make([]byte, 0, int(want))
	var sources []Source
	for _, page := range r.pages {
		if page.firstRow >= end {
			break
		}
		if page.endRow() <= start {
			continue
		}

		from := start
		if page.firstRow > from {
			from = page.firstRow
		}
		to := end
		if page.endRow() < to {
			to = page.endRow()
		}

		decoded, err := r.readPage(page)
		if err != nil {
			return nil, nil, err
		}
		byteFrom := (from - page.firstRow) * width
		byteTo := (to - page.firstRow) * width
		if byteFrom < 0 || byteTo > int64(len(decoded)) || byteFrom > byteTo {
			return nil, nil, fmt.Errorf("%w: page %d slice [%d,%d) outside decoded length %d", ErrInvalidIndex, page.index, byteFrom, byteTo, len(decoded))
		}
		out = append(out, decoded[byteFrom:byteTo]...)
		if wantSources {
			sources = append(sources, Source{
				Page:       page.index,
				FirstRow:   page.firstRow,
				RowOffset:  from - page.firstRow,
				RowCount:   to - from,
				ByteOffset: byteFrom,
				ByteLength: byteTo - byteFrom,
			})
		}
	}

	if int64(len(out)) != want {
		return nil, nil, fmt.Errorf("%w: assembled %d bytes, wanted %d", ErrInvalidIndex, len(out), want)
	}
	return out, sources, nil
}

func (r *Reader) readPage(page pageMeta) ([]byte, error) {
	var compressed []byte
	if page.compressedLen > 0 {
		if page.compressedLen > int64(maxInt()) {
			return nil, fmt.Errorf("%w: page %d compressed length is too large", ErrRead, page.index)
		}
		compressed = make([]byte, int(page.compressedLen))
		n, err := r.src.ReadAt(compressed, page.offset)
		if n != len(compressed) {
			if err != nil {
				return nil, fmt.Errorf("%w: page %d read %d of %d bytes at offset %d: %w", ErrShortRead, page.index, n, len(compressed), page.offset, err)
			}
			return nil, fmt.Errorf("%w: page %d read %d of %d bytes at offset %d", ErrShortRead, page.index, n, len(compressed), page.offset)
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("%w: page %d at offset %d: %w", ErrRead, page.index, page.offset, err)
		}
	}

	decoded, err := r.decoder.Decode(compressed)
	if err != nil {
		return nil, fmt.Errorf("%w: page %d: %w", ErrDecode, page.index, err)
	}
	if int64(len(decoded)) != page.decodedLen {
		return nil, fmt.Errorf("%w: page %d decoded to %d bytes, index says %d", ErrDecodedLength, page.index, len(decoded), page.decodedLen)
	}
	digest := sha256.Sum256(decoded)
	if digest != page.digest {
		return nil, fmt.Errorf("%w: page %d got %x want %x", ErrDigestMismatch, page.index, digest, page.digest)
	}
	return decoded, nil
}

func maxInt() int {
	return int(^uint(0) >> 1)
}
