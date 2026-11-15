package dataeng

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// CompressionKind mirrors ORC's CompressionKind enum.
type CompressionKind int32

const (
	CompressionNone   CompressionKind = 0
	CompressionZlib   CompressionKind = 1
	CompressionSnappy CompressionKind = 2
	CompressionLzo    CompressionKind = 3
	CompressionLz4    CompressionKind = 4
	CompressionZstd   CompressionKind = 5
)

func (c CompressionKind) String() string {
	switch c {
	case CompressionNone:
		return "NONE"
	case CompressionZlib:
		return "ZLIB"
	case CompressionSnappy:
		return "SNAPPY"
	case CompressionLzo:
		return "LZO"
	case CompressionLz4:
		return "LZ4"
	case CompressionZstd:
		return "ZSTD"
	default:
		return fmt.Sprintf("CompressionKind(%d)", int32(c))
	}
}

// ColumnKind mirrors ORC's Type.Kind enum.
type ColumnKind int32

const (
	KindBoolean          ColumnKind = 0
	KindByte             ColumnKind = 1
	KindShort            ColumnKind = 2
	KindInt              ColumnKind = 3
	KindLong             ColumnKind = 4
	KindFloat            ColumnKind = 5
	KindDouble           ColumnKind = 6
	KindString           ColumnKind = 7
	KindBinary           ColumnKind = 8
	KindTimestamp        ColumnKind = 9
	KindList             ColumnKind = 10
	KindMap              ColumnKind = 11
	KindStruct           ColumnKind = 12
	KindUnion            ColumnKind = 13
	KindDecimal          ColumnKind = 14
	KindDate             ColumnKind = 15
	KindVarchar          ColumnKind = 16
	KindChar             ColumnKind = 17
	KindTimestampInstant ColumnKind = 18
)

func (k ColumnKind) String() string {
	switch k {
	case KindBoolean:
		return "boolean"
	case KindByte:
		return "byte"
	case KindShort:
		return "short"
	case KindInt:
		return "int"
	case KindLong:
		return "long"
	case KindFloat:
		return "float"
	case KindDouble:
		return "double"
	case KindString:
		return "string"
	case KindBinary:
		return "binary"
	case KindTimestamp:
		return "timestamp"
	case KindList:
		return "list"
	case KindMap:
		return "map"
	case KindStruct:
		return "struct"
	case KindUnion:
		return "union"
	case KindDecimal:
		return "decimal"
	case KindDate:
		return "date"
	case KindVarchar:
		return "varchar"
	case KindChar:
		return "char"
	case KindTimestampInstant:
		return "timestamp_instant"
	default:
		return fmt.Sprintf("ColumnKind(%d)", int32(k))
	}
}

// StreamKind mirrors ORC's Stream.Kind enum.
type StreamKind int32

const (
	StreamPresent          StreamKind = 0
	StreamData             StreamKind = 1
	StreamLength           StreamKind = 2
	StreamDictionaryData   StreamKind = 3
	StreamDictionaryCount  StreamKind = 4
	StreamSecondary        StreamKind = 5
	StreamRowIndex         StreamKind = 6
	StreamBloomFilter      StreamKind = 7
	StreamBloomFilterUTF8  StreamKind = 8
	StreamEncryptedIndex   StreamKind = 9
	StreamEncryptedData    StreamKind = 10
	StreamStripeStatistics StreamKind = 100
	StreamFileStatistics   StreamKind = 101
)

// EncodingKind mirrors ORC's ColumnEncoding.Kind enum.
type EncodingKind int32

const (
	EncodingDirect       EncodingKind = 0
	EncodingDictionary   EncodingKind = 1
	EncodingDirectV2     EncodingKind = 2
	EncodingDictionaryV2 EncodingKind = 3
)

type postScript struct {
	FooterLength         uint64
	Compression          CompressionKind
	CompressionBlockSize uint64
	Version              []uint32
	MetadataLength       uint64
	WriterVersion        uint32
	HasWriterVersion     bool
	Magic                string
}

type stripeInformation struct {
	Offset       uint64
	IndexLength  uint64
	DataLength   uint64
	FooterLength uint64
	NumberOfRows uint64
}

type orcType struct {
	Kind          ColumnKind
	Subtypes      []uint32
	FieldNames    []string
	MaximumLength uint32
	Precision     uint32
	Scale         uint32
	Attributes    string
}

type footer struct {
	HeaderLength   uint64
	ContentLength  uint64
	Stripes        []stripeInformation
	Types          []orcType
	NumberOfRows   uint64
	Statistics     []*ColumnStatistics
	RowIndexStride uint32
	Writer         string
	WriterVersion  uint32
	Calendar       int32
	HasCalendar    bool
}

type metadata struct {
	StripeStats [][]*ColumnStatistics
}

type stream struct {
	Kind   StreamKind
	Column uint32
	Length uint64
	Offset uint64
}

type columnEncoding struct {
	Kind           EncodingKind
	DictionarySize uint32
	BloomEncoding  uint32
}

type stripeFooter struct {
	Streams        []stream
	Columns        []columnEncoding
	WriterTimezone string
}

type RowIndexEntry struct {
	Positions  []uint64
	Statistics *ColumnStatistics
}

type RowIndex struct {
	Entries []RowIndexEntry
}

// BloomFilter is the parsed form of ORC's BloomFilter message.
type BloomFilter struct {
	NumHashFunctions uint32
	Bitset           []uint64
	UTF8Bitset       []byte
}

func parsePostScript(b []byte) (*postScript, error) {
	p := newProtoReader(b)
	out := &postScript{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		switch field {
		case 1:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: postscript footerLength has wire type %d", wire)
			}
			out.FooterLength, err = p.varint()
		case 2:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: postscript compression has wire type %d", wire)
			}
			var v uint64
			v, err = p.varint()
			out.Compression = CompressionKind(v)
		case 3:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: postscript compressionBlockSize has wire type %d", wire)
			}
			out.CompressionBlockSize, err = p.varint()
		case 4:
			switch wire {
			case wireVarint:
				var v uint64
				v, err = p.varint()
				out.Version = append(out.Version, uint32(v))
			case wireBytes:
				var vs []uint64
				vs, err = p.packedUvarints()
				for _, v := range vs {
					out.Version = append(out.Version, uint32(v))
				}
			default:
				err = fmt.Errorf("dataeng: postscript version has wire type %d", wire)
			}
		case 5:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: postscript metadataLength has wire type %d", wire)
			}
			out.MetadataLength, err = p.varint()
		case 6:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: postscript writerVersion has wire type %d", wire)
			}
			var v uint64
			v, err = p.varint()
			out.WriterVersion = uint32(v)
			out.HasWriterVersion = true
		case 8000:
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: postscript magic has wire type %d", wire)
			}
			out.Magic, err = p.string()
		default:
			err = p.skip(wire)
		}
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func parseFooter(b []byte) (*footer, error) {
	p := newProtoReader(b)
	out := &footer{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		switch field {
		case 1:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: footer headerLength has wire type %d", wire)
			}
			out.HeaderLength, err = p.varint()
		case 2:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: footer contentLength has wire type %d", wire)
			}
			out.ContentLength, err = p.varint()
		case 3:
			var b []byte
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: footer stripe has wire type %d", wire)
			}
			b, err = p.bytes()
			if err == nil {
				var s stripeInformation
				s, err = parseStripeInformation(b)
				out.Stripes = append(out.Stripes, s)
			}
		case 4:
			var b []byte
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: footer type has wire type %d", wire)
			}
			b, err = p.bytes()
			if err == nil {
				var t orcType
				t, err = parseType(b)
				out.Types = append(out.Types, t)
			}
		case 5:
			err = p.skip(wire)
		case 6:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: footer numberOfRows has wire type %d", wire)
			}
			out.NumberOfRows, err = p.varint()
		case 7:
			var b []byte
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: footer statistics has wire type %d", wire)
			}
			b, err = p.bytes()
			if err == nil {
				var s *ColumnStatistics
				s, err = parseColumnStatistics(b)
				out.Statistics = append(out.Statistics, s)
			}
		case 8:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: footer rowIndexStride has wire type %d", wire)
			}
			var v uint64
			v, err = p.varint()
			out.RowIndexStride = uint32(v)
		case 9:
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: footer writer has wire type %d", wire)
			}
			out.Writer, err = p.string()
		case 11:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: footer calendar has wire type %d", wire)
			}
			var v uint64
			v, err = p.varint()
			out.Calendar = int32(v)
			out.HasCalendar = true
		default:
			err = p.skip(wire)
		}
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func parseStripeInformation(b []byte) (stripeInformation, error) {
	p := newProtoReader(b)
	var out stripeInformation
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return out, err
		}
		if wire != wireVarint {
			if err := p.skip(wire); err != nil {
				return out, err
			}
			continue
		}
		v, err := p.varint()
		if err != nil {
			return out, err
		}
		switch field {
		case 1:
			out.Offset = v
		case 2:
			out.IndexLength = v
		case 3:
			out.DataLength = v
		case 4:
			out.FooterLength = v
		case 5:
			out.NumberOfRows = v
		}
	}
	return out, nil
}

func parseType(b []byte) (orcType, error) {
	p := newProtoReader(b)
	var out orcType
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return out, err
		}
		switch field {
		case 1:
			if wire != wireVarint {
				return out, fmt.Errorf("dataeng: type kind has wire type %d", wire)
			}
			v, err := p.varint()
			if err != nil {
				return out, err
			}
			out.Kind = ColumnKind(v)
		case 2:
			switch wire {
			case wireVarint:
				v, err := p.varint()
				if err != nil {
					return out, err
				}
				out.Subtypes = append(out.Subtypes, uint32(v))
			case wireBytes:
				vs, err := p.packedUvarints()
				if err != nil {
					return out, err
				}
				for _, v := range vs {
					out.Subtypes = append(out.Subtypes, uint32(v))
				}
			default:
				return out, fmt.Errorf("dataeng: type subtypes has wire type %d", wire)
			}
		case 3:
			if wire != wireBytes {
				return out, fmt.Errorf("dataeng: type fieldNames has wire type %d", wire)
			}
			s, err := p.string()
			if err != nil {
				return out, err
			}
			out.FieldNames = append(out.FieldNames, s)
		case 4:
			v, err := p.varint()
			if err != nil {
				return out, err
			}
			out.MaximumLength = uint32(v)
		case 5:
			v, err := p.varint()
			if err != nil {
				return out, err
			}
			out.Precision = uint32(v)
		case 6:
			v, err := p.varint()
			if err != nil {
				return out, err
			}
			out.Scale = uint32(v)
		case 7:
			s, err := p.string()
			if err != nil {
				return out, err
			}
			out.Attributes = s
		default:
			if err := p.skip(wire); err != nil {
				return out, err
			}
		}
	}
	return out, nil
}

func parseMetadata(b []byte) (*metadata, error) {
	p := newProtoReader(b)
	out := &metadata{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if field == 1 && wire == wireBytes {
			b, err := p.bytes()
			if err != nil {
				return nil, err
			}
			stats, err := parseStripeStatistics(b)
			if err != nil {
				return nil, err
			}
			out.StripeStats = append(out.StripeStats, stats)
		} else if err := p.skip(wire); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func parseStripeStatistics(b []byte) ([]*ColumnStatistics, error) {
	p := newProtoReader(b)
	var out []*ColumnStatistics
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if field == 1 && wire == wireBytes {
			b, err := p.bytes()
			if err != nil {
				return nil, err
			}
			s, err := parseColumnStatistics(b)
			if err != nil {
				return nil, err
			}
			out = append(out, s)
		} else if err := p.skip(wire); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func parseStripeFooter(b []byte) (*stripeFooter, error) {
	p := newProtoReader(b)
	out := &stripeFooter{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		switch field {
		case 1:
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: stripe footer stream has wire type %d", wire)
			}
			b, err := p.bytes()
			if err != nil {
				return nil, err
			}
			s, err := parseStream(b)
			if err != nil {
				return nil, err
			}
			out.Streams = append(out.Streams, s)
		case 2:
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: stripe footer column has wire type %d", wire)
			}
			b, err := p.bytes()
			if err != nil {
				return nil, err
			}
			c, err := parseColumnEncoding(b)
			if err != nil {
				return nil, err
			}
			out.Columns = append(out.Columns, c)
		case 3:
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: stripe footer writerTimezone has wire type %d", wire)
			}
			out.WriterTimezone, err = p.string()
			if err != nil {
				return nil, err
			}
		default:
			if err := p.skip(wire); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

func parseStream(b []byte) (stream, error) {
	p := newProtoReader(b)
	var out stream
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return out, err
		}
		if wire != wireVarint {
			if err := p.skip(wire); err != nil {
				return out, err
			}
			continue
		}
		v, err := p.varint()
		if err != nil {
			return out, err
		}
		switch field {
		case 1:
			out.Kind = StreamKind(v)
		case 2:
			out.Column = uint32(v)
		case 3:
			out.Length = v
		}
	}
	return out, nil
}

func parseColumnEncoding(b []byte) (columnEncoding, error) {
	p := newProtoReader(b)
	var out columnEncoding
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return out, err
		}
		if wire != wireVarint {
			if err := p.skip(wire); err != nil {
				return out, err
			}
			continue
		}
		v, err := p.varint()
		if err != nil {
			return out, err
		}
		switch field {
		case 1:
			out.Kind = EncodingKind(v)
		case 2:
			out.DictionarySize = uint32(v)
		case 3:
			out.BloomEncoding = uint32(v)
		}
	}
	return out, nil
}

func parseRowIndex(b []byte) (*RowIndex, error) {
	p := newProtoReader(b)
	out := &RowIndex{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if field == 1 && wire == wireBytes {
			b, err := p.bytes()
			if err != nil {
				return nil, err
			}
			e, err := parseRowIndexEntry(b)
			if err != nil {
				return nil, err
			}
			out.Entries = append(out.Entries, e)
		} else if err := p.skip(wire); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func parseRowIndexEntry(b []byte) (RowIndexEntry, error) {
	p := newProtoReader(b)
	var out RowIndexEntry
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return out, err
		}
		switch field {
		case 1:
			switch wire {
			case wireVarint:
				v, err := p.varint()
				if err != nil {
					return out, err
				}
				out.Positions = append(out.Positions, v)
			case wireBytes:
				vs, err := p.packedUvarints()
				if err != nil {
					return out, err
				}
				out.Positions = append(out.Positions, vs...)
			default:
				return out, fmt.Errorf("dataeng: row index positions has wire type %d", wire)
			}
		case 2:
			if wire != wireBytes {
				return out, fmt.Errorf("dataeng: row index statistics has wire type %d", wire)
			}
			b, err := p.bytes()
			if err != nil {
				return out, err
			}
			s, err := parseColumnStatistics(b)
			if err != nil {
				return out, err
			}
			out.Statistics = s
		default:
			if err := p.skip(wire); err != nil {
				return out, err
			}
		}
	}
	return out, nil
}

func parseBloomFilterIndex(b []byte) ([]*BloomFilter, error) {
	p := newProtoReader(b)
	var out []*BloomFilter
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if field == 1 && wire == wireBytes {
			b, err := p.bytes()
			if err != nil {
				return nil, err
			}
			bf, err := parseBloomFilter(b)
			if err != nil {
				return nil, err
			}
			out = append(out, bf)
		} else if err := p.skip(wire); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func parseBloomFilter(b []byte) (*BloomFilter, error) {
	p := newProtoReader(b)
	out := &BloomFilter{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		switch field {
		case 1:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: bloom numHashFunctions has wire type %d", wire)
			}
			v, err := p.varint()
			if err != nil {
				return nil, err
			}
			out.NumHashFunctions = uint32(v)
		case 2:
			switch wire {
			case wireFixed64:
				v, err := p.fixed64()
				if err != nil {
					return nil, err
				}
				out.Bitset = append(out.Bitset, v)
			case wireBytes:
				b, err := p.bytes()
				if err != nil {
					return nil, err
				}
				if len(b)%8 != 0 {
					return nil, errors.New("dataeng: packed bloom bitset is not a multiple of 8 bytes")
				}
				for i := 0; i < len(b); i += 8 {
					out.Bitset = append(out.Bitset, binary.LittleEndian.Uint64(b[i:i+8]))
				}
			default:
				return nil, fmt.Errorf("dataeng: bloom bitset has wire type %d", wire)
			}
		case 3:
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: bloom utf8bitset has wire type %d", wire)
			}
			b, err := p.bytes()
			if err != nil {
				return nil, err
			}
			out.UTF8Bitset = append(out.UTF8Bitset, b...)
		default:
			if err := p.skip(wire); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

// ParseColumnStatistics parses a serialized ORC ColumnStatistics message.
func ParseColumnStatistics(b []byte) (*ColumnStatistics, error) {
	return parseColumnStatistics(b)
}

// ParseRowIndex parses a serialized ORC RowIndex message.
func ParseRowIndex(b []byte) (*RowIndex, error) {
	return parseRowIndex(b)
}

// ParseBloomFilterIndex parses a serialized ORC BloomFilterIndex message.
func ParseBloomFilterIndex(b []byte) ([]*BloomFilter, error) {
	return parseBloomFilterIndex(b)
}

// ParseBloomFilter parses a serialized ORC BloomFilter message.
func ParseBloomFilter(b []byte) (*BloomFilter, error) {
	return parseBloomFilter(b)
}
