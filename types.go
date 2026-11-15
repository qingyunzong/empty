package dataeng

import (
	"errors"
	"fmt"
	"strings"
)

// Encoding is the string encoding used by one ORC stripe or row group.
//
// DIRECT/DICTIONARY use RLEv1 integer streams and DIRECT_V2/DICTIONARY_V2 use
// RLEv2 integer streams.
type Encoding uint8

// StringEncoding and ColumnEncoding are aliases for Encoding.
type StringEncoding = Encoding
type ColumnEncoding = Encoding

const (
	EncodingDirect Encoding = iota
	EncodingDictionary
	EncodingDirectV2
	EncodingDictionaryV2
)

// Short names for callers that prefer the ORC names without the Encoding
// prefix.
const (
	Direct       = EncodingDirect
	Dictionary   = EncodingDictionary
	DirectV2     = EncodingDirectV2
	DictionaryV2 = EncodingDictionaryV2
)

const (
	DirectV1             = EncodingDirect
	DictionaryV1         = EncodingDictionary
	EncodingDirectV1     = EncodingDirect
	EncodingDictionaryV1 = EncodingDictionary
	EncodingDIRECT       = EncodingDirect
	EncodingDICTIONARY   = EncodingDictionary
	EncodingDIRECTV2     = EncodingDirectV2
	EncodingDICTIONARYV2 = EncodingDictionaryV2
)

const (
	DIRECT        = EncodingDirect
	DICTIONARY    = EncodingDictionary
	DIRECT_V2     = EncodingDirectV2
	DICTIONARY_V2 = EncodingDictionaryV2
	DIRECT_V1     = EncodingDirect
	DICTIONARY_V1 = EncodingDictionary
)

func (e Encoding) String() string {
	switch e {
	case EncodingDirect:
		return "DIRECT"
	case EncodingDictionary:
		return "DICTIONARY"
	case EncodingDirectV2:
		return "DIRECT_V2"
	case EncodingDictionaryV2:
		return "DICTIONARY_V2"
	default:
		return fmt.Sprintf("Encoding(%d)", uint8(e))
	}
}

// IsDictionary reports whether the encoding references a dictionary.
func (e Encoding) IsDictionary() bool {
	return e == EncodingDictionary || e == EncodingDictionaryV2
}

// IsV2 reports whether integer streams use RLEv2.
func (e Encoding) IsV2() bool {
	return e == EncodingDirectV2 || e == EncodingDictionaryV2
}

// ParseEncoding accepts the ORC encoding names, case-insensitively.
func ParseEncoding(s string) (Encoding, error) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "DIRECT":
		return EncodingDirect, nil
	case "DICTIONARY":
		return EncodingDictionary, nil
	case "DIRECT_V2", "DIRECTV2":
		return EncodingDirectV2, nil
	case "DICTIONARY_V2", "DICTIONARYV2":
		return EncodingDictionaryV2, nil
	default:
		return 0, fmt.Errorf("%w: %q", ErrInvalidEncoding, s)
	}
}

// StreamKind identifies one stream in a string column chunk.
type StreamKind uint8

// StreamType is an alias for StreamKind.
type StreamType = StreamKind

const (
	PresentStream StreamKind = iota
	DataStream
	LengthStream
	DictionaryDataStream
	DictionaryLengthStream
	IndicesStream
)

// Short stream-kind names.
const (
	Present          = PresentStream
	Data             = DataStream
	Length           = LengthStream
	DictionaryData   = DictionaryDataStream
	DictionaryLength = DictionaryLengthStream
	Indices          = IndicesStream
)

const (
	PRESENT           = PresentStream
	DATA              = DataStream
	LENGTH            = LengthStream
	DICTIONARY_DATA   = DictionaryDataStream
	DICTIONARY_LENGTH = DictionaryLengthStream
	INDICES           = IndicesStream
)

const (
	PresentStreamKind          = PresentStream
	DataStreamKind             = DataStream
	LengthStreamKind           = LengthStream
	DictionaryDataStreamKind   = DictionaryDataStream
	DictionaryLengthStreamKind = DictionaryLengthStream
	IndicesStreamKind          = IndicesStream
)

const (
	StreamPresent          = PresentStream
	StreamData             = DataStream
	StreamLength           = LengthStream
	StreamDictionaryData   = DictionaryDataStream
	StreamDictionaryLength = DictionaryLengthStream
	StreamIndices          = IndicesStream
)

func (k StreamKind) String() string {
	switch k {
	case PresentStream:
		return "PRESENT"
	case DataStream:
		return "DATA"
	case LengthStream:
		return "LENGTH"
	case DictionaryDataStream:
		return "DICTIONARY_DATA"
	case DictionaryLengthStream:
		return "DICTIONARY_LENGTH"
	case IndicesStream:
		return "INDICES"
	default:
		return fmt.Sprintf("StreamKind(%d)", uint8(k))
	}
}

// Stream is a single named stream. It is accepted by NewStringDecoder.
type Stream struct {
	Kind  StreamKind
	Type  StreamKind
	Data  []byte
	Bytes []byte
}

// EncodedStream is an alias for Stream.
type EncodedStream = Stream

// Streams contains the streams of a direct or dictionary encoded string
// column chunk.
//
// For direct encoding, Data holds the concatenated UTF-8 bytes and Length
// holds one length per non-null row.
//
// For ORC dictionary encoding, Data holds the dictionary indices, Length (or
// DictionaryLength, when supplied) holds the dictionary entry lengths, and
// DictionaryData holds the concatenated dictionary bytes.
//
// A non-standard but convenient layout is also accepted: put indices in
// Indices and dictionary bytes in Data. In either layout a nil slice means
// that the stream is absent. An empty, non-nil slice is a present but empty
// stream.
type Streams struct {
	Present           []byte
	Data              []byte
	Length            []byte
	DictionaryData    []byte
	DictionaryLength  []byte
	Indices           []byte
	Dictionary        []byte
	DictData          []byte
	DictionaryLengths []byte
	Index             []byte
}

// StringStream describes one independently encoded run of strings. It is the
// usual input to a Decoder. Encoding state (dictionary, data cursor and integer
// streams) is reset at the start of every StringStream, while row numbers are
// continued by the decoder across streams.
//
// RowGroups optionally splits one stripe into independently encoded runs. This
// is useful when an encoder switches between dictionary and direct encoding
// inside a stripe. When RowGroups is non-empty, the row count is the sum of the
// group row counts. A group without PRESENT inherits the corresponding bit
// range from the stripe-level Present stream.
type StringStream struct {
	Rows     int
	RowCount int
	NumRows  int
	Encoding Encoding

	Present           []byte
	Data              []byte
	Length            []byte
	DictionaryData    []byte
	DictionaryLength  []byte
	Indices           []byte
	Dictionary        []byte
	DictData          []byte
	DictionaryLengths []byte
	Index             []byte

	RowGroups []RowGroup
}

// Stripe is an alias for StringStream.
type Stripe = StringStream

// RowGroup is one independently encoded run inside a stripe.
type RowGroup struct {
	Rows     int
	RowCount int
	NumRows  int
	Encoding Encoding

	Present           []byte
	Data              []byte
	Length            []byte
	DictionaryData    []byte
	DictionaryLength  []byte
	Indices           []byte
	Dictionary        []byte
	DictData          []byte
	DictionaryLengths []byte
	Index             []byte
}

// Chunk is an alias for RowGroup.
type Chunk = RowGroup

// Value is one decoded string. Null is true for an ORC null value.
type Value struct {
	Text string
	Null bool
}

// String returns the text, or the empty string for a null value.
func (v Value) String() string { return v.Text }

var (
	// ErrCorrupt reports a malformed encoded stream.
	ErrCorrupt = errors.New("dataeng: corrupt ORC string stream")
	// ErrMissingStream reports a required stream that is absent.
	ErrMissingStream = errors.New("dataeng: missing ORC stream")
	// ErrInvalidEncoding reports an unknown encoding.
	ErrInvalidEncoding = errors.New("dataeng: invalid string encoding")
	// ErrRowOutOfRange reports a seek outside the decoded row range.
	ErrRowOutOfRange = errors.New("dataeng: row out of range")
	// ErrDictionaryIndex reports an out-of-range dictionary reference.
	ErrDictionaryIndex = errors.New("dataeng: dictionary index out of range")
)
