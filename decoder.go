package dataeng

import (
	"fmt"
	"io"
	"math"
	"sort"
)

// Decoder decodes string streams from one or more ORC stripes (or string
// chunks). Decoding state is immutable once a chunk is built, so a random
// Seek returns exactly the values that a sequential scan from the start of the
// stripe would return.
type Decoder struct {
	segments []*segment
	starts   []int
	total    int
	pos      int

	scanActive bool
	scanValue  Value
	err        error
}

// StringDecoder, StringStreamDecoder and StreamDecoder are aliases for
// Decoder.
type StringDecoder = Decoder
type StringStreamDecoder = Decoder
type StreamDecoder = Decoder
type StripeDecoder = Decoder
type ORCStringDecoder = Decoder
type ColumnDecoder = Decoder

type segment struct {
	start int
	rows  int
	enc   Encoding

	present       []byte
	presentOffset int
	nonNullPrefix []int

	directData    []byte
	directLengths []int
	directOffsets []int

	dictionary []string
	indices    []int
}

func (s *segment) isNull(row int) bool {
	if s.present == nil {
		return false
	}
	bit := s.presentOffset + row
	return s.present[bit/8]&(1<<uint(7-bit%8)) == 0
}

func (s *segment) value(row int) Value {
	if s.isNull(row) {
		return Value{Null: true}
	}
	index := s.nonNullPrefix[row]
	if s.enc.IsDictionary() {
		return Value{Text: s.dictionary[s.indices[index]]}
	}
	offset := s.directOffsets[index]
	length := s.directLengths[index]
	return Value{Text: string(s.directData[offset : offset+length])}
}

// NewStringDecoder constructs a decoder from a StringStream/Stripe, a set of
// streams plus a row count and encoding, or a sequence of such values. It
// accepts the typed constructors' layouts in any argument order, which keeps
// call sites that obtain metadata and streams separately simple.
//
// The most explicit form is:
//
//	NewStringDecoder(StringStream{Rows: n, Encoding: EncodingDirect,
//		Present: p, Data: d, Length: l})
//
// It also accepts (Rows, Encoding, Streams), []Stream, and
// map[StreamKind][]byte.
func NewStringDecoder(args ...any) (*Decoder, error) {
	var stripes []*StringStream
	var rowGroups []RowGroup
	var streams Streams
	encoding := EncodingDirect
	rows := -1
	var raw [][]byte
	haveStreams := false

	for _, arg := range args {
		switch value := arg.(type) {
		case nil:
			continue
		case StringStream:
			st := normalizeStream(value)
			stripes = append(stripes, &st)
		case *StringStream:
			if value != nil {
				st := normalizeStream(*value)
				stripes = append(stripes, &st)
			}
		case RowGroup:
			group := normalizeGroup(value)
			rowGroups = append(rowGroups, group)
		case *RowGroup:
			if value != nil {
				rowGroups = append(rowGroups, normalizeGroup(*value))
			}
		case Streams:
			streams = value
			haveStreams = true
		case *Streams:
			if value != nil {
				streams = *value
				haveStreams = true
			}
		case Stream:
			setStream(&streams, streamKind(value), streamData(value))
			haveStreams = true
		case *Stream:
			if value != nil {
				setStream(&streams, streamKind(*value), streamData(*value))
				haveStreams = true
			}
		case []Stream:
			for _, stream := range value {
				setStream(&streams, streamKind(stream), streamData(stream))
			}
			haveStreams = true
		case map[StreamKind][]byte:
			for kind, data := range value {
				setStream(&streams, kind, data)
			}
			haveStreams = true
		case map[string][]byte:
			for name, data := range value {
				kind, err := parseStreamKind(name)
				if err != nil {
					return nil, err
				}
				setStream(&streams, kind, data)
			}
			haveStreams = true
		case Encoding:
			encoding = value
		case int:
			rows = value
		case int64:
			if value < 0 || value > int64(math.MaxInt) {
				return nil, corruptf("row count %d", value)
			}
			rows = int(value)
		case uint:
			if uint64(value) > uint64(math.MaxInt) {
				return nil, corruptf("row count %d", value)
			}
			rows = int(value)
		case []byte:
			raw = append(raw, value)
		default:
			return nil, corruptf("unsupported decoder argument %T", arg)
		}
	}

	if len(raw) > 0 {
		if len(raw) > 6 {
			return nil, corruptf("too many raw byte streams")
		}
		// Raw slices are interpreted as PRESENT, DATA, LENGTH and then the
		// dictionary streams. With two slices this means DATA and LENGTH.
		var present, data, length, dictData, dictLength, indices []byte
		switch len(raw) {
		case 1:
			data = raw[0]
		case 2:
			data, length = raw[0], raw[1]
		default:
			present, data, length = raw[0], raw[1], raw[2]
			if len(raw) > 3 {
				dictData = raw[3]
			}
			if len(raw) > 4 {
				dictLength = raw[4]
			}
			if len(raw) > 5 {
				indices = raw[5]
			}
		}
		streams = Streams{
			Present:          present,
			Data:             data,
			Length:           length,
			DictionaryData:   dictData,
			DictionaryLength: dictLength,
			Indices:          indices,
		}
		haveStreams = true
	}

	if len(rowGroups) > 0 {
		st := StringStream{Encoding: encoding, RowGroups: rowGroups}
		if rows >= 0 {
			st.Rows = rows
		}
		if haveStreams {
			applyStreams(&st, streams)
		}
		stripes = append(stripes, &st)
	} else if haveStreams {
		st := StringStream{Rows: rows, Encoding: encoding}
		applyStreams(&st, streams)
		stripes = append(stripes, &st)
	}

	if len(stripes) == 0 && rows >= 0 {
		stripes = append(stripes, &StringStream{Rows: rows, Encoding: encoding})
	}
	if len(stripes) == 0 {
		return nil, corruptf("no string stream supplied")
	}
	decoder := &Decoder{}
	for _, st := range stripes {
		if err := decoder.appendStripe(st); err != nil {
			return nil, err
		}
	}
	return decoder, nil
}

// NewDecoder is an alias for NewStringDecoder accepting the same flexible
// arguments.
func NewDecoder(args ...any) (*Decoder, error) {
	return NewStringDecoder(args...)
}

// NewStringStreamDecoder is an alias for NewStringDecoder.
func NewStringStreamDecoder(args ...any) (*Decoder, error) {
	return NewStringDecoder(args...)
}

// NewStreamDecoder is an alias for NewStringDecoder.
func NewStreamDecoder(args ...any) (*Decoder, error) {
	return NewStringDecoder(args...)
}

// NewStripeDecoder is an alias for NewStringDecoder.
func NewStripeDecoder(args ...any) (*Decoder, error) {
	return NewStringDecoder(args...)
}

// MustNewDecoder panics if the streams cannot be decoded.
func MustNewDecoder(args ...any) *Decoder {
	decoder, err := NewStringDecoder(args...)
	if err != nil {
		panic(err)
	}
	return decoder
}

// MustNewStringDecoder panics if the streams cannot be decoded.
func MustNewStringDecoder(args ...any) *Decoder {
	return MustNewDecoder(args...)
}

func applyStreams(st *StringStream, streams Streams) {
	st.Present = streams.Present
	st.Data = streams.Data
	st.Length = streams.Length
	st.DictionaryData = firstBytes(streams.DictionaryData, streams.Dictionary, streams.DictData)
	st.DictionaryLength = firstBytes(streams.DictionaryLength, streams.DictionaryLengths)
	st.Indices = firstBytes(streams.Indices, streams.Index)
}

func normalizeStream(st StringStream) StringStream {
	st.Rows = streamRowCount(st.Rows, st.RowCount, st.NumRows)
	for i := range st.RowGroups {
		st.RowGroups[i] = normalizeGroup(st.RowGroups[i])
	}
	return st
}

func normalizeGroup(group RowGroup) RowGroup {
	group.Rows = streamRowCount(group.Rows, group.RowCount, group.NumRows)
	return group
}

func streamRowCount(rows, rowCount, numRows int) int {
	if rows != 0 {
		return rows
	}
	if rowCount != 0 {
		return rowCount
	}
	return numRows
}

func streamKind(stream Stream) StreamKind {
	if stream.Kind == PresentStream && stream.Type != PresentStream {
		return stream.Type
	}
	return stream.Kind
}

func streamData(stream Stream) []byte {
	if stream.Data != nil {
		return stream.Data
	}
	return stream.Bytes
}

func setStream(streams *Streams, kind StreamKind, data []byte) {
	switch kind {
	case PresentStream:
		streams.Present = data
	case DataStream:
		streams.Data = data
	case LengthStream:
		streams.Length = data
	case DictionaryDataStream:
		streams.DictionaryData = data
	case DictionaryLengthStream:
		streams.DictionaryLength = data
	case IndicesStream:
		streams.Indices = data
	}
}

func parseStreamKind(name string) (StreamKind, error) {
	switch normalizeName(name) {
	case "PRESENT", "PRESENTSTREAM":
		return PresentStream, nil
	case "DATA", "DATASTREAM":
		return DataStream, nil
	case "LENGTH", "LENGTHSTREAM":
		return LengthStream, nil
	case "DICTIONARY", "DICTIONARYDATA", "DICTIONARYDATASTREAM", "DICTDATA":
		return DictionaryDataStream, nil
	case "DICTIONARYLENGTH", "DICTIONARYLENGTHS", "DICTIONARYLENGTHSTREAM", "DICTLENGTH":
		return DictionaryLengthStream, nil
	case "INDEX", "INDEXES", "INDICES", "INDICESSTREAM", "DICTIONARYINDICES":
		return IndicesStream, nil
	default:
		return 0, corruptf("unknown stream %q", name)
	}
}

func normalizeName(name string) string {
	result := make([]byte, 0, len(name))
	for i := 0; i < len(name); i++ {
		c := name[i]
		if c == '_' || c == '-' || c == ' ' || c == '.' {
			continue
		}
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		result = append(result, c)
	}
	return string(result)
}

// AddStripe appends another stripe without resetting the decoder's row
// position or the row numbers already decoded. Encoding state for the new
// stripe is built from scratch.
func (d *Decoder) AddStripe(stripe *StringStream) error {
	if stripe == nil {
		return corruptf("nil stripe")
	}
	return d.appendStripe(stripe)
}

// AppendStripe is an alias for AddStripe.
func (d *Decoder) AppendStripe(stripe *StringStream) error {
	return d.AddStripe(stripe)
}

// AddRowGroup appends one independently encoded group. It is the direct way to
// switch between dictionary and direct encoding while preserving row numbers.
func (d *Decoder) AddRowGroup(group RowGroup) error {
	group = normalizeGroup(group)
	st := StringStream{
		Rows:              group.Rows,
		Encoding:          group.Encoding,
		Present:           group.Present,
		Data:              group.Data,
		Length:            group.Length,
		DictionaryData:    group.DictionaryData,
		DictionaryLength:  group.DictionaryLength,
		Indices:           group.Indices,
		Dictionary:        group.Dictionary,
		DictData:          group.DictData,
		DictionaryLengths: group.DictionaryLengths,
		Index:             group.Index,
	}
	return d.AddStripe(&st)
}

// AppendRowGroup is an alias for AddRowGroup.
func (d *Decoder) AppendRowGroup(group RowGroup) error { return d.AddRowGroup(group) }

// SwitchEncoding appends a newly encoded row group. The decoder's global row
// number is preserved; only dictionary, data and integer-decoder state for the
// new rows is reset.
func (d *Decoder) SwitchEncoding(rows int, encoding Encoding, streams Streams) error {
	st := StringStream{Rows: rows, Encoding: encoding}
	applyStreams(&st, streams)
	return d.AddStripe(&st)
}

func (d *Decoder) appendStripe(stripe *StringStream) error {
	segments, err := buildSegments(stripe, d.total)
	if err != nil {
		return err
	}
	total := d.total
	for _, seg := range segments {
		if seg.rows > math.MaxInt-total {
			return corruptf("total row count overflows int")
		}
		total += seg.rows
	}
	for _, seg := range segments {
		d.segments = append(d.segments, seg)
		d.starts = append(d.starts, seg.start)
	}
	d.total = total
	return nil
}

func buildSegments(stripe *StringStream, start int) ([]*segment, error) {
	if stripe == nil {
		return nil, corruptf("nil stripe")
	}
	normalized := normalizeStream(*stripe)
	stripe = &normalized
	if stripe.Rows < 0 {
		return nil, corruptf("negative row count %d", stripe.Rows)
	}
	if len(stripe.RowGroups) == 0 {
		seg, err := buildSegment(RowGroup{
			Rows:              stripe.Rows,
			Encoding:          stripe.Encoding,
			Present:           stripe.Present,
			Data:              stripe.Data,
			Length:            stripe.Length,
			DictionaryData:    stripe.DictionaryData,
			DictionaryLength:  stripe.DictionaryLength,
			Indices:           stripe.Indices,
			Dictionary:        stripe.Dictionary,
			DictData:          stripe.DictData,
			DictionaryLengths: stripe.DictionaryLengths,
			Index:             stripe.Index,
		}, start, nil, 0)
		if err != nil {
			return nil, err
		}
		return []*segment{seg}, nil
	}

	groupRows := 0
	for i, group := range stripe.RowGroups {
		if group.Rows < 0 {
			return nil, corruptf("row group %d has negative row count", i)
		}
		if groupRows > math.MaxInt-group.Rows {
			return nil, corruptf("row group row count overflows int")
		}
		groupRows += group.Rows
	}
	if stripe.Rows != 0 && stripe.Rows != groupRows {
		return nil, corruptf("stripe has %d rows but row groups have %d", stripe.Rows, groupRows)
	}

	result := make([]*segment, 0, len(stripe.RowGroups))
	rowOffset := 0
	for i, group := range stripe.RowGroups {
		seg, err := buildSegment(group, start+rowOffset, stripe.Present, rowOffset)
		if err != nil {
			return nil, fmt.Errorf("row group %d: %w", i, err)
		}
		result = append(result, seg)
		rowOffset += group.Rows
	}
	return result, nil
}

func buildSegment(group RowGroup, start int, inheritedPresent []byte, presentOffset int) (*segment, error) {
	if group.Encoding > EncodingDictionaryV2 {
		return nil, fmt.Errorf("%w: %d", ErrInvalidEncoding, group.Encoding)
	}
	seg := &segment{
		start:         start,
		rows:          group.Rows,
		enc:           group.Encoding,
		present:       group.Present,
		presentOffset: 0,
	}
	if seg.present == nil && inheritedPresent != nil {
		seg.present = inheritedPresent
		seg.presentOffset = presentOffset
	}
	if seg.present != nil {
		requiredBits := seg.presentOffset + seg.rows
		if requiredBits > len(seg.present)*8 {
			return nil, corruptf("PRESENT stream has %d bits but %d are needed",
				len(seg.present)*8, requiredBits)
		}
	}

	seg.nonNullPrefix = make([]int, seg.rows+1)
	for i := 0; i < seg.rows; i++ {
		seg.nonNullPrefix[i+1] = seg.nonNullPrefix[i]
		if !seg.isNull(i) {
			seg.nonNullPrefix[i+1]++
		}
	}
	nonNull := seg.nonNullPrefix[seg.rows]

	// An all-null run is the only case in which DATA and LENGTH may be
	// absent. There is nothing to decode in that case.
	if nonNull == 0 {
		return seg, nil
	}

	if group.Encoding.IsDictionary() {
		if err := buildDictionarySegment(seg, group); err != nil {
			return nil, err
		}
		return seg, nil
	}
	if err := buildDirectSegment(seg, group); err != nil {
		return nil, err
	}
	return seg, nil
}

func buildDirectSegment(seg *segment, group RowGroup) error {
	if group.Data == nil {
		return fmt.Errorf("%w: DATA for %d non-null rows", ErrMissingStream, seg.nonNullPrefix[seg.rows])
	}
	if group.Length == nil {
		return fmt.Errorf("%w: LENGTH for %d non-null rows", ErrMissingStream, seg.nonNullPrefix[seg.rows])
	}

	length64, err := decodeInts(group.Length, group.Encoding.IsV2(), false)
	if err != nil {
		return fmt.Errorf("LENGTH: %w", err)
	}
	nonNull := seg.nonNullPrefix[seg.rows]
	if len(length64) < nonNull {
		return corruptf("LENGTH has %d values but %d are needed", len(length64), nonNull)
	}

	seg.directData = group.Data
	seg.directLengths = make([]int, nonNull)
	seg.directOffsets = make([]int, nonNull+1)
	for i := 0; i < nonNull; i++ {
		if length64[i] < 0 || length64[i] > math.MaxInt {
			return corruptf("string length %d at index %d", length64[i], i)
		}
		length := int(length64[i])
		if seg.directOffsets[i] > math.MaxInt-length {
			return corruptf("data offset overflows int")
		}
		seg.directLengths[i] = length
		seg.directOffsets[i+1] = seg.directOffsets[i] + length
	}
	if seg.directOffsets[nonNull] > len(group.Data) {
		return corruptf("DATA has %d bytes but %d are needed", len(group.Data), seg.directOffsets[nonNull])
	}
	return nil
}

func buildDictionarySegment(seg *segment, group RowGroup) error {
	indicesData := firstBytes(group.Indices, group.Index, group.Data)
	dictionaryData := firstBytes(group.DictionaryData, group.Dictionary, group.DictData)
	if group.Indices != nil || group.Index != nil {
		if dictionaryData == nil {
			dictionaryData = group.Data
		}
	}
	dictionaryLengthData := firstBytes(group.DictionaryLength, group.DictionaryLengths, group.Length)

	if indicesData == nil {
		return fmt.Errorf("%w: DATA indices for dictionary encoding", ErrMissingStream)
	}
	if dictionaryData == nil {
		return fmt.Errorf("%w: DICTIONARY_DATA", ErrMissingStream)
	}
	if dictionaryLengthData == nil {
		return fmt.Errorf("%w: LENGTH for dictionary entries", ErrMissingStream)
	}

	indices64, err := decodeInts(indicesData, group.Encoding.IsV2(), false)
	if err != nil {
		return fmt.Errorf("dictionary indices: %w", err)
	}
	nonNull := seg.nonNullPrefix[seg.rows]
	if len(indices64) < nonNull {
		return corruptf("dictionary index stream has %d values but %d are needed", len(indices64), nonNull)
	}

	lengths64, err := decodeInts(dictionaryLengthData, group.Encoding.IsV2(), false)
	if err != nil {
		return fmt.Errorf("dictionary lengths: %w", err)
	}

	cursor := 0
	seg.dictionary = make([]string, len(lengths64))
	for i, length := range lengths64 {
		if length < 0 || length > math.MaxInt {
			return corruptf("dictionary length %d at index %d", length, i)
		}
		n := int(length)
		if cursor > len(dictionaryData) || n > len(dictionaryData)-cursor {
			return corruptf("DICTIONARY_DATA is too short for dictionary entry %d", i)
		}
		seg.dictionary[i] = string(dictionaryData[cursor : cursor+n])
		cursor += n
	}
	if cursor != len(dictionaryData) {
		return corruptf("DICTIONARY_DATA has %d trailing bytes", len(dictionaryData)-cursor)
	}

	seg.indices = make([]int, nonNull)
	for i := 0; i < nonNull; i++ {
		index := indices64[i]
		if index < 0 || index >= int64(len(seg.dictionary)) {
			return fmt.Errorf("%w: %d (dictionary size %d)", ErrDictionaryIndex, index, len(seg.dictionary))
		}
		seg.indices[i] = int(index)
	}
	return nil
}

func firstBytes(values ...[]byte) []byte {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

// Rows returns the total number of rows in the decoder.
func (d *Decoder) Rows() int { return d.total }

// Len is an alias for Rows.
func (d *Decoder) Len() int { return d.total }

// Row returns the next row number that will be read.
func (d *Decoder) Row() int { return d.pos }

// Position is an alias for Row.
func (d *Decoder) Position() int { return d.pos }

// AtEnd reports whether all rows have been read.
func (d *Decoder) AtEnd() bool { return d.pos >= d.total }

// Remaining returns the number of rows not yet read.
func (d *Decoder) Remaining() int { return d.total - d.pos }

// Total is an alias for Rows.
func (d *Decoder) Total() int { return d.total }

// CurrentRow is an alias for Row.
func (d *Decoder) CurrentRow() int { return d.pos }

// Seek moves the decoder to row. It is valid for row to equal Rows.
func (d *Decoder) Seek(row int) error {
	if row < 0 || row > d.total {
		return fmt.Errorf("%w: %d (0..%d)", ErrRowOutOfRange, row, d.total)
	}
	d.pos = row
	d.scanActive = false
	d.err = nil
	return nil
}

// SeekRow is an alias for Seek.
func (d *Decoder) SeekRow(row int) error { return d.Seek(row) }

// SeekTo is an alias for Seek.
func (d *Decoder) SeekTo(row int) error { return d.Seek(row) }

// SeekToRow is an alias for Seek.
func (d *Decoder) SeekToRow(row int) error { return d.Seek(row) }

// Skip advances by n rows.
func (d *Decoder) Skip(n int) error {
	if n < 0 || n > d.total-d.pos {
		return fmt.Errorf("%w: skip %d from %d (total %d)", ErrRowOutOfRange, n, d.pos, d.total)
	}
	return d.Seek(d.pos + n)
}

// SkipRows is an alias for Skip.
func (d *Decoder) SkipRows(n int) error { return d.Skip(n) }

// Reset rewinds the decoder to the first row.
func (d *Decoder) Reset() {
	d.pos = 0
	d.scanActive = false
	d.scanValue = Value{}
	d.err = nil
}

// Rewind is an alias for Reset.
func (d *Decoder) Rewind() { d.Reset() }

// RowGroups returns the number of independently encoded runs in the decoder.
func (d *Decoder) RowGroups() int { return len(d.segments) }

// NumRowGroups is an alias for RowGroups.
func (d *Decoder) NumRowGroups() int { return d.RowGroups() }

// SeekRowGroup moves to the first row of an independently encoded run.
func (d *Decoder) SeekRowGroup(group int) error {
	if group < 0 || group >= len(d.segments) {
		return fmt.Errorf("%w: row group %d (0..%d)", ErrRowOutOfRange, group, len(d.segments)-1)
	}
	return d.Seek(d.segments[group].start)
}

// SeekToRowGroup is an alias for SeekRowGroup.
func (d *Decoder) SeekToRowGroup(group int) error { return d.SeekRowGroup(group) }

// RowGroup returns the row group containing the next row. At the end it
// returns RowGroups.
func (d *Decoder) RowGroup() int {
	if d.pos >= d.total {
		return len(d.segments)
	}
	return d.segmentIndex(d.pos)
}

// RowGroupStart returns the first global row of a row group.
func (d *Decoder) RowGroupStart(group int) (int, error) {
	if group < 0 || group >= len(d.segments) {
		return 0, fmt.Errorf("%w: row group %d", ErrRowOutOfRange, group)
	}
	return d.segments[group].start, nil
}

// RowGroupRows returns the number of rows in a row group.
func (d *Decoder) RowGroupRows(group int) (int, error) {
	if group < 0 || group >= len(d.segments) {
		return 0, fmt.Errorf("%w: row group %d", ErrRowOutOfRange, group)
	}
	return d.segments[group].rows, nil
}

// Next returns the next string, whether it is non-null, and an error. A null
// value is returned as ("", false, nil). io.EOF marks the end of the stream.
func (d *Decoder) Next() (string, bool, error) {
	value, err := d.NextValue()
	if err != nil {
		return "", false, err
	}
	return value.Text, !value.Null, nil
}

// Read is an alias for Next.
func (d *Decoder) Read() (string, bool, error) { return d.Next() }

// NextString returns the next string and an error. A null value is returned as
// an empty string. Use Next or NextValue when null and empty must be
// distinguished.
func (d *Decoder) NextString() (string, error) {
	value, err := d.NextValue()
	if err != nil {
		return "", err
	}
	return value.Text, nil
}

// ReadString returns the next string and an error. A null value is returned
// as an empty string.
func (d *Decoder) ReadString() (string, error) { return d.NextString() }

// NextValue returns the next decoded Value.
func (d *Decoder) NextValue() (Value, error) {
	if d.pos >= d.total {
		d.err = io.EOF
		d.scanActive = false
		return Value{}, io.EOF
	}
	segment := d.segments[d.segmentIndex(d.pos)]
	value := segment.value(d.pos - segment.start)
	d.pos++
	d.scanValue = value
	d.scanActive = true
	d.err = nil
	return value, nil
}

// NextRow is an alias for NextValue.
func (d *Decoder) NextRow() (Value, error) { return d.NextValue() }

// DecodeRow is an alias for NextValue.
func (d *Decoder) DecodeRow() (Value, error) { return d.NextValue() }

// ValueAt returns a row without changing the decoder position.
func (d *Decoder) ValueAt(row int) (Value, error) {
	if row < 0 || row >= d.total {
		return Value{}, fmt.Errorf("%w: %d (0..%d)", ErrRowOutOfRange, row, d.total)
	}
	segment := d.segments[d.segmentIndex(row)]
	return segment.value(row - segment.start), nil
}

// Scan advances by one row and reports whether a row was available. Null and
// non-null rows both return true; use IsNull to distinguish them. The usual
// database/sql-style loop is:
//
//	for d.Scan() {
//		if d.IsNull() { ... } else { use(d.Value()) }
//	}
//	if err := d.Err(); err != nil { ... }
func (d *Decoder) Scan() bool {
	if d.pos >= d.total {
		d.scanActive = false
		d.err = io.EOF
		return false
	}
	segment := d.segments[d.segmentIndex(d.pos)]
	d.scanValue = segment.value(d.pos - segment.start)
	d.pos++
	d.scanActive = true
	d.err = nil
	return true
}

// Value returns the value selected by the most recent Scan.
func (d *Decoder) Value() string { return d.scanValue.Text }

// IsNull reports whether the most recent Scan selected a null value.
func (d *Decoder) IsNull() bool { return d.scanActive && d.scanValue.Null }

// Err returns the error that ended iteration.
func (d *Decoder) Err() error {
	if d.err == io.EOF {
		return nil
	}
	return d.err
}

func (d *Decoder) segmentIndex(row int) int {
	index := sort.Search(len(d.segments), func(i int) bool {
		return d.segments[i].start+d.segments[i].rows > row
	})
	if index >= len(d.segments) {
		return len(d.segments) - 1
	}
	return index
}

// DecodeAll decodes the remaining rows. It returns the string values and a
// parallel null mask. Null values have an empty string.
func (d *Decoder) DecodeAll() ([]string, []bool, error) {
	d.scanActive = false
	values := make([]string, 0, d.total-d.pos)
	nulls := make([]bool, 0, d.total-d.pos)
	for d.pos < d.total {
		segment := d.segments[d.segmentIndex(d.pos)]
		value := segment.value(d.pos - segment.start)
		d.pos++
		values = append(values, value.Text)
		nulls = append(nulls, value.Null)
	}
	return values, nulls, nil
}

// DecodeAllFromStart rewinds and decodes every row.
func (d *Decoder) DecodeAllFromStart() ([]string, []bool, error) {
	d.Reset()
	return d.DecodeAll()
}

// Decode returns all remaining values. Nulls are represented by "".
func (d *Decoder) Decode() ([]string, error) {
	values, _, err := d.DecodeAll()
	return values, err
}

// Strings is an alias for Decode.
func (d *Decoder) Strings() ([]string, error) { return d.Decode() }

// Values returns the remaining rows as Value entries.
func (d *Decoder) Values() ([]Value, error) {
	d.scanActive = false
	values := make([]Value, 0, d.total-d.pos)
	for d.pos < d.total {
		segment := d.segments[d.segmentIndex(d.pos)]
		values = append(values, segment.value(d.pos-segment.start))
		d.pos++
	}
	return values, nil
}

// DecodeStrings builds a temporary decoder and returns its values and null
// mask. It is a convenience for one-shot decoding.
func DecodeStrings(args ...any) ([]string, []bool, error) {
	decoder, err := NewStringDecoder(args...)
	if err != nil {
		return nil, nil, err
	}
	return decoder.DecodeAllFromStart()
}

// DecodeStringStream is an alias for DecodeStrings.
func DecodeStringStream(args ...any) ([]string, []bool, error) {
	return DecodeStrings(args...)
}

// Decode builds a temporary decoder and returns all strings. Nulls are
// represented by empty strings.
func Decode(args ...any) ([]string, error) {
	values, _, err := DecodeStrings(args...)
	return values, err
}

// DecodeAll is an alias for Decode.
func DecodeAll(args ...any) ([]string, error) {
	return Decode(args...)
}
