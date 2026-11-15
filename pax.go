package dataeng

import (
	"archive/tar"
	"bytes"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// GNU sparse PAX record names.
const (
	PAXGNUSparseMajor     = "GNU.sparse.major"
	PAXGNUSparseMinor     = "GNU.sparse.minor"
	PAXGNUSparseName      = "GNU.sparse.name"
	PAXGNUSparseSize      = "GNU.sparse.size"
	PAXGNUSparseRealSize  = "GNU.sparse.realsize"
	PAXGNUSparseNumBlocks = "GNU.sparse.numblocks"
	PAXGNUSparseMap       = "GNU.sparse.map"
	PAXGNUSparseOffset    = "GNU.sparse.offset"
	PAXGNUSparseNumBytes  = "GNU.sparse.numbytes"
)

// SparseFormat identifies the encoding used for a sparse map.
type SparseFormat int

const (
	SparseNone SparseFormat = iota
	SparsePAX00
	SparsePAX01
	SparsePAX10
	SparseGNULegacy
)

// Compatibility aliases with the Sparse prefix spelled out.
const (
	FormatSparseNone      = SparseNone
	FormatSparsePAX00     = SparsePAX00
	FormatSparsePAX01     = SparsePAX01
	FormatSparsePAX10     = SparsePAX10
	FormatGNUHeader       = SparseGNULegacy
	FormatSparseGNULegacy = SparseGNULegacy
)

func (f SparseFormat) String() string {
	switch f {
	case SparseNone:
		return "none"
	case SparsePAX00:
		return "GNU.sparse 0.0"
	case SparsePAX01:
		return "GNU.sparse 0.1"
	case SparsePAX10:
		return "GNU.sparse 1.0"
	case SparseGNULegacy:
		return "GNU legacy header"
	default:
		return fmt.Sprintf("SparseFormat(%d)", int(f))
	}
}

// PAXRecord is one key/value pair from a PAX extended header.
type PAXRecord struct {
	Key   string
	Value string
}

type paxHeader struct {
	records  map[string]string
	pairs    []string
	hasPairs bool
}

// ParsePAXRecords parses a PAX extended-header body. The returned map includes
// a synthesized GNU.sparse.map when the body used the 0.0 offset/numbytes
// representation.
func ParsePAXRecords(data []byte) (map[string]string, error) {
	header, err := parsePAXHeader(data)
	if err != nil {
		return nil, err
	}
	return header.records, nil
}

func parsePAXHeader(data []byte) (*paxHeader, error) {
	header := &paxHeader{records: make(map[string]string)}
	remaining := data

	for len(remaining) > 0 {
		space := bytes.IndexByte(remaining, ' ')
		if space <= 0 {
			return nil, fmt.Errorf("%w: missing record length", ErrInvalidPAX)
		}
		recordLen, err := strconv.ParseInt(string(remaining[:space]), 10, 64)
		if err != nil || recordLen <= 0 || recordLen > int64(len(remaining)) {
			return nil, fmt.Errorf("%w: invalid record length", ErrInvalidPAX)
		}
		if recordLen <= int64(space)+1 {
			return nil, fmt.Errorf("%w: record length is too small", ErrInvalidPAX)
		}
		record := remaining[space+1 : recordLen]
		if len(record) == 0 || record[len(record)-1] != '\n' {
			return nil, fmt.Errorf("%w: record is not newline-terminated", ErrInvalidPAX)
		}
		record = record[:len(record)-1]

		equals := bytes.IndexByte(record, '=')
		if equals <= 0 {
			return nil, fmt.Errorf("%w: malformed key/value record", ErrInvalidPAX)
		}
		key := string(record[:equals])
		value := string(record[equals+1:])

		switch key {
		case PAXGNUSparseOffset, PAXGNUSparseNumBytes:
			if strings.Contains(value, ",") {
				return nil, fmt.Errorf("%w: comma in %s", ErrInvalidPAX, key)
			}
			if len(header.pairs)%2 == 0 && key != PAXGNUSparseOffset {
				return nil, fmt.Errorf("%w: %s must follow %s",
					ErrInvalidPAX, PAXGNUSparseNumBytes, PAXGNUSparseOffset)
			}
			if len(header.pairs)%2 == 1 && key != PAXGNUSparseNumBytes {
				return nil, fmt.Errorf("%w: %s must follow %s",
					ErrInvalidPAX, PAXGNUSparseOffset, PAXGNUSparseNumBytes)
			}
			header.pairs = append(header.pairs, value)
			header.hasPairs = true
		default:
			header.records[key] = value
		}

		remaining = remaining[recordLen:]
	}

	if len(header.pairs) > 0 {
		if len(header.pairs)%2 != 0 {
			return nil, fmt.Errorf("%w: incomplete sparse offset/numbytes pair", ErrInvalidPAX)
		}
		header.records[PAXGNUSparseMap] = strings.Join(header.pairs, ",")
	}
	return header, nil
}

func sparsePAXFormat(records map[string]string, hasPairs bool) (SparseFormat, bool, error) {
	major, minor := records[PAXGNUSparseMajor], records[PAXGNUSparseMinor]
	switch {
	case major == "" && minor == "":
		if records[PAXGNUSparseMap] != "" || hasPairs ||
			records[PAXGNUSparseNumBlocks] != "" || records[PAXGNUSparseSize] != "" ||
			records[PAXGNUSparseRealSize] != "" {
			if hasPairs {
				return SparsePAX00, true, nil
			}
			return SparsePAX01, true, nil
		}
		return SparseNone, false, nil
	case major == "0" && minor == "0":
		return SparsePAX00, true, nil
	case major == "0" && minor == "1":
		return SparsePAX01, true, nil
	case major == "1" && minor == "0":
		return SparsePAX10, true, nil
	default:
		return SparseNone, false, fmt.Errorf("%w: %s.%s",
			ErrUnsupportedSparseVersion, major, minor)
	}
}

func logicalSizeFromPAX(records map[string]string, fallback int64) (int64, error) {
	value := records[PAXGNUSparseSize]
	if value == "" {
		value = records[PAXGNUSparseRealSize]
	}
	if value == "" {
		return fallback, nil
	}
	size, err := strconv.ParseInt(value, 10, 64)
	if err != nil || size < 0 {
		return 0, fmt.Errorf("%w: invalid GNU sparse size %q", ErrHeader, value)
	}
	return size, nil
}

func parseExtentValues(values []string, logicalSize int64) ([]Extent, error) {
	if len(values)%2 != 0 {
		return nil, fmt.Errorf("%w: odd number of sparse map values", ErrHeader)
	}
	extents := make([]Extent, 0, len(values)/2)
	for i := 0; i < len(values); i += 2 {
		offset, offsetErr := strconv.ParseInt(values[i], 10, 64)
		length, lengthErr := strconv.ParseInt(values[i+1], 10, 64)
		if offsetErr != nil || lengthErr != nil {
			return nil, fmt.Errorf("%w: invalid sparse extent %q/%q",
				ErrHeader, values[i], values[i+1])
		}
		extents = append(extents, Extent{Offset: offset, Length: length})
		if len(extents) > maxSparseFileEntries {
			return nil, ErrSparseMapTooLong
		}
	}
	if err := ValidateExtents(extents, logicalSize); err != nil {
		return nil, err
	}
	return extents, nil
}

func parsePAXMapValues(records map[string]string, logicalSize int64) ([]Extent, error) {
	raw := records[PAXGNUSparseMap]
	var values []string
	if raw != "" {
		values = strings.Split(raw, ",")
	}

	if numBlocksValue, ok := records[PAXGNUSparseNumBlocks]; ok && numBlocksValue != "" {
		numBlocks, err := strconv.ParseInt(numBlocksValue, 10, 64)
		if err != nil || numBlocks < 0 || numBlocks > maxSparseFileEntries {
			return nil, fmt.Errorf("%w: invalid GNU.sparse.numblocks %q",
				ErrHeader, numBlocksValue)
		}
		if int64(len(values)) != 2*numBlocks {
			return nil, fmt.Errorf("%w: numblocks=%d but map has %d values",
				ErrHeader, numBlocks, len(values))
		}
	}
	return parseExtentValues(values, logicalSize)
}

func parseSparsePAX(
	records map[string]string,
	pairs []string,
	hasPairs bool,
	body io.Reader,
	physicalSize int64,
) (*SparseMap, SparseFormat, int64, error) {
	format, isSparse, err := sparsePAXFormat(records, hasPairs)
	if err != nil {
		return nil, format, 0, err
	}
	if !isSparse {
		return nil, SparseNone, 0, nil
	}

	logicalSize, err := logicalSizeFromPAX(records, physicalSize)
	if err != nil {
		return nil, format, 0, err
	}

	var (
		extents      []Extent
		metadataSize int64
	)
	switch format {
	case SparsePAX10:
		if body == nil {
			return nil, format, 0, fmt.Errorf("%w: PAX 1.0 map requires an entry body", ErrHeader)
		}
		extents, metadataSize, err = readSparseMap1x0(body, physicalSize)
		if err != nil {
			return nil, format, 0, err
		}
		if err := ValidateExtents(extents, logicalSize); err != nil {
			return nil, format, 0, err
		}
	default:
		if hasPairs {
			extents, err = parseExtentValues(pairs, logicalSize)
		} else {
			extents, err = parsePAXMapValues(records, logicalSize)
		}
		if err != nil {
			return nil, format, 0, err
		}
	}

	var compactSize int64
	for _, extent := range extents {
		if extent.Length > maxInt64-compactSize {
			return nil, format, 0, fmt.Errorf("%w: compact size overflows", ErrSizeMismatch)
		}
		compactSize += extent.Length
	}
	if physicalSize >= 0 {
		expected := physicalSize - metadataSize
		if expected < 0 || compactSize != expected {
			return nil, format, 0, fmt.Errorf("%w: extents consume %d bytes, entry body has %d",
				ErrSizeMismatch, compactSize, expected)
		}
	}

	m := &SparseMap{
		LogicalSize: logicalSize,
		Size:        logicalSize,
		Extents:     extents,
		CompactSize: compactSize,
	}
	return m, format, metadataSize, nil
}

// readSparseMap1x0 reads the newline-delimited map at the start of a PAX 1.0
// entry body. The map occupies one or more complete 512-byte blocks. It
// returns the extents and the exact number of body bytes consumed by the map.
func readSparseMap1x0(r io.Reader, physicalSize int64) ([]Extent, int64, error) {
	if r == nil {
		return nil, 0, fmt.Errorf("%w: nil sparse map reader", ErrHeader)
	}

	var (
		buffer    bytes.Buffer
		blocks    int64
		newlines  int64
		block     [blockSize]byte
		required  int64 = 1
		haveCount bool
		count     int64
	)

	for newlines < required {
		if blocks*blockSize >= maxSpecialFileSize {
			return nil, 0, ErrSparseMapTooLong
		}
		n, err := io.ReadFull(r, block[:])
		if err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return nil, 0, fmt.Errorf("dataeng: reading PAX 1.0 map block %d: %w", blocks, io.ErrUnexpectedEOF)
			}
			return nil, 0, err
		}
		if n != blockSize {
			return nil, 0, io.ErrUnexpectedEOF
		}
		blocks++
		if physicalSize >= 0 && blocks*blockSize > physicalSize {
			return nil, 0, fmt.Errorf("%w: sparse map exceeds entry body", ErrHeader)
		}
		buffer.Write(block[:])
		for _, c := range block {
			if c == '\n' {
				newlines++
			}
		}

		if !haveCount && newlines >= 1 {
			line, err := buffer.ReadString('\n')
			if err != nil {
				return nil, 0, io.ErrUnexpectedEOF
			}
			text := strings.TrimSpace(line)
			count, err = strconv.ParseInt(text, 10, 64)
			if err != nil || count < 0 || count > maxSparseFileEntries {
				return nil, 0, fmt.Errorf("%w: invalid sparse entry count %q", ErrHeader, text)
			}
			if count > (maxInt64-1)/2 {
				return nil, 0, ErrSparseMapTooLong
			}
			required = 1 + 2*count
			haveCount = true
		}
	}

	values := make([]string, 0, 2*count)
	for i := int64(0); i < 2*count; i++ {
		line, err := buffer.ReadString('\n')
		if err != nil {
			return nil, 0, io.ErrUnexpectedEOF
		}
		text := strings.TrimSuffix(line, "\n")
		text = strings.TrimSuffix(text, "\r")
		values = append(values, text)
	}

	// The map is padded to a block boundary. NUL padding is not a token, but
	// reject a non-empty residue so a truncated or misaligned map cannot make
	// the following data look like additional map entries.
	if residue := bytes.TrimRight(buffer.Bytes(), "\x00"); len(residue) != 0 {
		return nil, 0, fmt.Errorf("%w: trailing data in PAX 1.0 sparse map", ErrHeader)
	}

	logicalSize := int64(0)
	for i := 0; i < len(values); i += 2 {
		offset, err1 := strconv.ParseInt(values[i], 10, 64)
		length, err2 := strconv.ParseInt(values[i+1], 10, 64)
		if err1 != nil || err2 != nil || offset < 0 || length < 0 || offset > maxInt64-length {
			return nil, 0, fmt.Errorf("%w: invalid PAX 1.0 sparse extent", ErrHeader)
		}
		if end := offset + length; end > logicalSize {
			logicalSize = end
		}
	}
	extents, err := parseExtentValues(values, logicalSize)
	if err != nil {
		return nil, 0, err
	}
	return extents, blocks * blockSize, nil
}

// ParsePAXSparse parses a GNU.sparse map from PAX records. PAX 0.0 and 0.1
// maps are stored entirely in the records; a PAX 1.0 map is stored in the
// entry body and therefore requires ParsePAXEntry.
func ParsePAXSparse(records map[string]string) (*SparseMap, error) {
	m, format, _, err := parseSparsePAX(records, nil, false, nil, -1)
	if err != nil {
		return nil, err
	}
	if format == SparsePAX10 {
		return nil, fmt.Errorf("%w: PAX 1.0 requires the entry body", ErrHeader)
	}
	return m, nil
}

// ParsePAXEntry parses a GNU sparse PAX entry. body must be positioned at the
// beginning of the entry body and physicalSize must be the body size encoded
// in the tar header (before logical-size substitution). For PAX 1.0 the map
// bytes are consumed from body; the remaining bytes are the compact data.
func ParsePAXEntry(records map[string]string, body io.Reader, physicalSize int64) (*SparseMap, SparseFormat, error) {
	m, format, _, err := parseSparsePAX(records, nil, false, body, physicalSize)
	return m, format, err
}

// ParseSparseMap parses a GNU sparse map from the supplied inputs.
//
// The usual call forms are:
//
//	ParseSparseMap(*tar.Header, io.Reader)
//	ParseSparseMap(map[string]string)
//	ParseSparseMap(map[string]string, io.Reader, int64) // physical body size
//	ParseSparseMap(io.Reader, int64)                    // PAX 1.0 map body
//	ParseSparseMap([]byte)                              // PAX records
//
// For a tar.Header, body must be positioned at the entry body (required for
// PAX 1.0). When a physical body size is supplied, the compact data referenced
// by the map is required to match it exactly. Without a physical size,
// archive/tar's logical Header.Size cannot provide that cross-check.
func ParseSparseMap(args ...any) (*SparseMap, error) {
	var (
		header   *tar.Header
		records  map[string]string
		pairs    []string
		hasPairs bool
		body     io.Reader
		physical int64 = -1
		logical  int64 = -1
		extents  []Extent
		haveExts bool
	)

	for _, arg := range args {
		switch value := arg.(type) {
		case *tar.Header:
			header = value
		case tar.Header:
			copy := value
			header = &copy
		case map[string]string:
			records = cloneRecords(value)
		case []PAXRecord:
			records = parsePAXRecordList(value, &pairs, &hasPairs)
		case []byte:
			parsed, err := parsePAXHeader(value)
			if err != nil {
				return nil, err
			}
			records = parsed.records
			pairs = append(pairs, parsed.pairs...)
			hasPairs = hasPairs || parsed.hasPairs
		case string:
			parsed, err := parsePAXHeader([]byte(value))
			if err != nil {
				return nil, err
			}
			records = parsed.records
			pairs = append(pairs, parsed.pairs...)
			hasPairs = hasPairs || parsed.hasPairs
		case io.Reader:
			body = value
		case int64:
			if header == nil && records == nil {
				logical = value
			} else {
				physical = value
			}
		case int:
			if header == nil && records == nil {
				logical = int64(value)
			} else {
				physical = int64(value)
			}
		case *SparseMap:
			if value == nil {
				return nil, ErrInvalidSparseMap
			}
			if err := value.Validate(); err != nil {
				return nil, err
			}
			return value.Clone(), nil
		case []Extent:
			extents = append([]Extent(nil), value...)
			haveExts = true
		case nil:
			// Ignore an optional nil body.
		default:
			return nil, fmt.Errorf("%w: unsupported ParseSparseMap argument %T", ErrHeader, arg)
		}
	}

	if header != nil {
		if records == nil {
			records = cloneRecords(header.PAXRecords)
		}
		if records == nil {
			return nil, nil
		}
		m, format, _, err := parseSparsePAX(records, pairs, hasPairs, body, physical)
		if err != nil {
			return nil, err
		}
		if format == SparseNone {
			return nil, nil
		}
		return m, nil
	}

	if records != nil {
		m, format, _, err := parseSparsePAX(records, pairs, hasPairs, body, physical)
		if err != nil {
			return nil, err
		}
		if format == SparseNone {
			return nil, nil
		}
		return m, nil
	}

	if haveExts {
		if logical < 0 {
			logical = maxExtentEnd(extents)
		}
		if err := ValidateExtents(extents, logical); err != nil {
			return nil, err
		}
		return &SparseMap{LogicalSize: logical, Size: logical, Extents: extents,
			CompactSize: sumExtentLengths(extents)}, nil
	}

	if body != nil {
		parsed, metadataSize, err := readSparseMap1x0(body, physical)
		if err != nil {
			return nil, err
		}
		if logical < 0 {
			logical = maxExtentEnd(parsed)
		}
		if err := ValidateExtents(parsed, logical); err != nil {
			return nil, err
		}
		compactSize := sumExtentLengths(parsed)
		if physical >= 0 && physical-metadataSize != compactSize {
			return nil, fmt.Errorf("%w: extents consume %d bytes, entry body has %d",
				ErrSizeMismatch, compactSize, physical-metadataSize)
		}
		return &SparseMap{LogicalSize: logical, Size: logical, Extents: parsed,
			CompactSize: compactSize}, nil
	}

	return nil, fmt.Errorf("%w: no sparse map input", ErrHeader)
}

func cloneRecords(records map[string]string) map[string]string {
	if records == nil {
		return nil
	}
	clone := make(map[string]string, len(records))
	for key, value := range records {
		clone[key] = value
	}
	return clone
}

func parsePAXRecordList(list []PAXRecord, pairs *[]string, hasPairs *bool) map[string]string {
	records := make(map[string]string, len(list))
	var sparseValues []string
	for _, record := range list {
		records[record.Key] = record.Value
		if record.Key == PAXGNUSparseOffset || record.Key == PAXGNUSparseNumBytes {
			sparseValues = append(sparseValues, record.Value)
		}
	}
	if len(sparseValues) > 0 {
		records[PAXGNUSparseMap] = strings.Join(sparseValues, ",")
		*pairs = append(*pairs, sparseValues...)
		*hasPairs = true
	}
	return records
}

func maxExtentEnd(extents []Extent) int64 {
	var maximum int64
	for _, extent := range extents {
		if end := extent.End(); end > maximum {
			maximum = end
		}
	}
	return maximum
}

func sumExtentLengths(extents []Extent) int64 {
	var total int64
	for _, extent := range extents {
		total += extent.Length
	}
	return total
}

// ParseSparseHeader is an alias for ParseSparseMap.
func ParseSparseHeader(header *tar.Header, body io.Reader) (*SparseMap, error) {
	return ParseSparseMap(header, body)
}

// ParseSparseExtents extracts just the data extents from a PAX sparse header.
func ParseSparseExtents(header *tar.Header, body io.Reader) ([]Extent, error) {
	m, err := ParseSparseMap(header, body)
	if err != nil {
		return nil, err
	}
	if m == nil {
		return nil, nil
	}
	return append([]Extent(nil), m.Extents...), nil
}
