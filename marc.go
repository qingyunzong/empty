// Stream reader, record model and strict MARC21 validation.
package dataeng

import (
	"errors"
	"fmt"
	"io"
	"sort"
	"unicode/utf8"
)

// MARC structural bytes and fixed sizes.
const (
	leaderLength   = 24
	dirEntryLength = 12

	recordTerminator  byte = 0x1d
	fieldTerminator   byte = 0x1e
	subfieldDelimiter byte = 0x1f
)

// DefaultMaxRecordSize is the largest accepted declared record size. MARC21
// length fields have five decimal digits, so 99999 is the natural ceiling.
const DefaultMaxRecordSize = 99999

// DefaultMaxFields limits the number of directory entries a record may carry.
const DefaultMaxFields = 10000

// ByteRange is a half-open byte interval [Start, End). Offsets are absolute
// positions in the input stream for records returned by Reader, and offsets
// relative to the first record byte for records built with ParseRecord.
type ByteRange struct {
	Start int64
	End   int64
}

// Len returns the number of bytes covered by the range.
func (r ByteRange) Len() int64 { return r.End - r.Start }

// Subfield describes one 0x1f-delimited subfield of a data field. Range
// covers the delimiter, the single subfield code and the value; ValueRange
// covers only the value bytes (which may be empty).
type Subfield struct {
	Code       byte
	Range      ByteRange
	ValueRange ByteRange
}

// Linkage is the parsed TTT-NN value carried by a code-6 subfield.
type Linkage struct {
	Target     string
	Occurrence int
}

// Field is one directory entry in directory order. Control fields carry
// their bytes in Content and have no indicators or subfields; data fields
// carry indicators, subfields and an optional parsed Linkage.
//
// LinkedIndex is the directory index of the paired field for a code-6
// linkage with a non-zero occurrence, or -1 when the field is unpaired
// (including NN=00 independent alternate representations).
type Field struct {
	Tag            string
	Control        bool
	Indicators     ByteRange
	Content        ByteRange
	Range          ByteRange
	Subfields      []Subfield
	Linkage        *Linkage
	LinkedIndex    int
	DirectoryIndex int

	linkOffset int64
}

// Record is one fully validated MARC21 record. Leader keeps the 24 leader
// bytes verbatim and Range covers the whole record including the final 0x1d.
type Record struct {
	Leader [leaderLength]byte
	Fields []Field
	Range  ByteRange

	raw []byte
}

// Raw returns the complete record bytes. The returned slice is owned by the
// record and stays valid for the record's lifetime.
func (r *Record) Raw() []byte { return r.raw }

// Slice resolves a byte range against the record bytes.
func (r *Record) Slice(br ByteRange) ([]byte, error) {
	if br.Start < r.Range.Start || br.End > r.Range.End || br.Start > br.End {
		return nil, fmt.Errorf("dataeng: range [%d,%d) outside record [%d,%d)",
			br.Start, br.End, r.Range.Start, r.Range.End)
	}
	base := r.Range.Start
	return r.raw[br.Start-base : br.End-base], nil
}

// SyntaxError describes a record that is fully present but violates the
// structure, encoding or linkage rules. RecordOffset is the stream position
// of the record start and LocalOffset the offending byte inside the record.
// A syntax error consumes the declared record; the next Reader call
// continues with the following record.
type SyntaxError struct {
	RecordOffset int64
	LocalOffset  int64
	Reason       string
}

func (e *SyntaxError) Error() string {
	return fmt.Sprintf("dataeng: invalid record at offset %d (local %d): %s",
		e.RecordOffset, e.LocalOffset, e.Reason)
}

// TruncatedError reports that the input ended before a complete record could
// be read. LocalOffset is the number of bytes of the partial record that
// were actually received. The stream cannot be resynchronized, so the reader
// is exhausted afterwards.
type TruncatedError struct {
	RecordOffset int64
	LocalOffset  int64
	Reason       string
}

func (e *TruncatedError) Error() string {
	return fmt.Sprintf("dataeng: truncated record at offset %d (local %d): %s",
		e.RecordOffset, e.LocalOffset, e.Reason)
}

func syntaxError(local int64, format string, args ...any) *SyntaxError {
	return &SyntaxError{LocalOffset: local, Reason: fmt.Sprintf(format, args...)}
}

// Option configures a Reader.
type Option func(*Reader)

// WithMaxRecordSize declares the host limit on bytes per record. Declared
// records larger than this are rejected before any deep parsing. Non-positive
// values keep the default.
func WithMaxRecordSize(n int) Option {
	return func(r *Reader) {
		if n > 0 {
			r.maxRecordSize = n
		}
	}
}

// WithMaxFields declares the host limit on directory entries per record.
// Non-positive values keep the default.
func WithMaxFields(n int) Option {
	return func(r *Reader) {
		if n > 0 {
			r.maxFields = n
		}
	}
}

// Reader streams MARC21 records from any io.Reader, tolerating arbitrary
// chunk boundaries.
type Reader struct {
	src           io.Reader
	maxRecordSize int
	maxFields     int

	buf       []byte
	consumed  int64 // absolute stream offset of buf[0]
	skip      int64 // bytes of a rejected oversized record still to discard
	exhausted bool
}

// NewReader builds a stream reader over src.
func NewReader(src io.Reader, opts ...Option) *Reader {
	r := &Reader{
		src:           src,
		maxRecordSize: DefaultMaxRecordSize,
		maxFields:     DefaultMaxFields,
	}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// Next returns the next fully validated record. It returns io.EOF at a clean
// end of stream, *TruncatedError when the final record is cut short, or
// *SyntaxError for a rejected record while keeping the stream readable.
func (r *Reader) Next() (*Record, error) {
	if r.exhausted {
		return nil, io.EOF
	}
	if err := r.drainSkip(); err != nil {
		return nil, err
	}

	if err := r.fill(5); err != nil {
		if !errors.Is(err, io.EOF) {
			return nil, err
		}
		r.exhausted = true
		if len(r.buf) == 0 {
			return nil, io.EOF
		}
		return nil, &TruncatedError{
			RecordOffset: r.consumed,
			LocalOffset:  int64(len(r.buf)),
			Reason:       "stream ended before a complete record leader",
		}
	}

	declared, ok := parseDecimal(r.buf[:5])
	recordStart := r.consumed
	if !ok || declared < 26 {
		// The length prefix itself is unusable, so no resync point exists.
		r.exhausted = true
		return nil, &SyntaxError{
			RecordOffset: recordStart,
			LocalOffset:  0,
			Reason:       "leader does not carry a five-digit record length of at least 26",
		}
	}

	if declared > r.maxRecordSize {
		r.skip = int64(declared)
		if err := r.drainSkip(); err != nil {
			return nil, err
		}
		return nil, &SyntaxError{
			RecordOffset: recordStart,
			LocalOffset:  0,
			Reason:       fmt.Sprintf("declared record size %d exceeds host limit %d", declared, r.maxRecordSize),
		}
	}

	if err := r.fill(declared); err != nil {
		if !errors.Is(err, io.EOF) {
			return nil, err
		}
		r.exhausted = true
		return nil, &TruncatedError{
			RecordOffset: recordStart,
			LocalOffset:  int64(len(r.buf)),
			Reason:       "stream ended before the declared record length was received",
		}
	}

	raw := make([]byte, declared)
	copy(raw, r.buf[:declared])

	rec, serr := parseRecord(raw, r.maxFields)
	// The declared bytes belong to this record regardless of validity.
	r.buf = r.buf[declared:]
	r.consumed += int64(declared)
	if serr != nil {
		serr.RecordOffset = recordStart
		return nil, serr
	}
	shiftRecord(rec, recordStart)
	return rec, nil
}

// fill blocks until at least n bytes are buffered or the source ends.
func (r *Reader) fill(n int) error {
	for len(r.buf) < n {
		want := n - len(r.buf)
		if want > 4096 {
			want = 4096
		}
		tmp := make([]byte, want)
		k, err := r.src.Read(tmp)
		r.buf = append(r.buf, tmp[:k]...)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return io.EOF
			}
			return err
		}
		if k == 0 {
			// A well-behaved Reader must not do this, but stay defensive so
			// a non-conforming source cannot spin this loop forever.
			return io.ErrNoProgress
		}
	}
	return nil
}

// ParseRecord validates one complete self-contained record. Byte ranges are
// relative to the start of raw.
func ParseRecord(raw []byte) (*Record, error) {
	rec, serr := parseRecord(raw, DefaultMaxFields)
	if serr != nil {
		return nil, serr
	}
	return rec, nil
}

type directoryEntry struct {
	tag      string
	length   int
	offset   int
	start    int
	end      int
	dirIndex int
}

type linkKey struct {
	tag string
	occ int
}

func parseRecord(raw []byte, maxFields int) (*Record, *SyntaxError) {
	total := len(raw)
	if total < 26 {
		return nil, syntaxError(int64(total), "record length %d is below the minimum of 26", total)
	}

	declared, ok := parseDecimal(raw[0:5])
	if !ok {
		return nil, syntaxError(0, "leader bytes 0..4 are not five ASCII decimal digits")
	}
	if declared != total {
		return nil, syntaxError(0, "declared length %d does not match the %d bytes presented", declared, total)
	}
	if raw[9] != 'a' {
		return nil, syntaxError(9, "leader byte 9 must be 'a'")
	}
	if raw[10] != '2' || raw[11] != '2' {
		return nil, syntaxError(10, "leader bytes 10..11 must be \"22\"")
	}
	if string(raw[20:24]) != "4500" {
		return nil, syntaxError(20, "leader bytes 20..23 must be \"4500\"")
	}

	base, ok := parseDecimal(raw[12:17])
	if !ok {
		return nil, syntaxError(12, "leader bytes 12..16 are not five ASCII decimal digits")
	}
	if base < 25 || base > total-1 {
		return nil, syntaxError(12, "data base address %d must be within [25,%d]", base, total-1)
	}
	if raw[total-1] != recordTerminator {
		return nil, syntaxError(int64(total-1), "final record byte must be 0x1d")
	}

	terminator := base - 1
	if raw[terminator] != fieldTerminator {
		return nil, syntaxError(int64(terminator), "directory must end with a single 0x1e at byte %d", terminator)
	}
	directoryLength := terminator - leaderLength
	if directoryLength%dirEntryLength != 0 {
		return nil, syntaxError(leaderLength, "directory length %d is not a whole number of 12-byte entries", directoryLength)
	}
	fieldCount := directoryLength / dirEntryLength
	if fieldCount > maxFields {
		return nil, syntaxError(leaderLength, "field count %d exceeds host limit %d", fieldCount, maxFields)
	}

	entries := make([]directoryEntry, 0, fieldCount)
	for i := 0; i < fieldCount; i++ {
		entryStart := leaderLength + i*dirEntryLength
		tagText := string(raw[entryStart : entryStart+3])
		tagNum, tagOK := parseDecimal(raw[entryStart : entryStart+3])
		if !tagOK {
			return nil, syntaxError(int64(entryStart), "directory entry %d has a non-numeric tag", i)
		}
		if tagNum == 0 {
			return nil, syntaxError(int64(entryStart), "tag 000 is not allowed")
		}
		length, lenOK := parseDecimal(raw[entryStart+3 : entryStart+7])
		if !lenOK {
			return nil, syntaxError(int64(entryStart+3), "directory entry %d has a non-numeric field length", i)
		}
		if length <= 0 {
			return nil, syntaxError(int64(entryStart+3), "directory entry %d field length must be positive", i)
		}
		offset, offOK := parseDecimal(raw[entryStart+7 : entryStart+12])
		if !offOK {
			return nil, syntaxError(int64(entryStart+7), "directory entry %d has a non-numeric offset", i)
		}
		start := base + offset
		end := start + length
		if start < base || end > total-1 {
			return nil, syntaxError(int64(entryStart+7),
				"directory entry %d field range [%d,%d) escapes the data area [%d,%d)",
				i, start, end, base, total-1)
		}
		entries = append(entries, directoryEntry{
			tag:      tagText,
			length:   length,
			offset:   offset,
			start:    start,
			end:      end,
			dirIndex: i,
		})
	}

	if err := validateCoverage(entries, base, total-1); err != nil {
		return nil, err
	}

	fields := make([]Field, 0, len(entries))
	regularLinks := map[linkKey]int{}
	alternateLinks := map[linkKey]int{}

	for _, entry := range entries {
		if raw[entry.end-1] != fieldTerminator {
			return nil, syntaxError(int64(entry.end-1),
				"field %s at directory index %d must end with 0x1e", entry.tag, entry.dirIndex)
		}

		field := Field{
			Tag:            entry.tag,
			LinkedIndex:    -1,
			DirectoryIndex: entry.dirIndex,
			Range:          ByteRange{Start: int64(entry.start), End: int64(entry.end)},
		}

		tagNum := mustDecimal(entry.tag)
		if tagNum <= 9 {
			// Control field 001..009: raw content, terminator excluded.
			field.Control = true
			contentStart := entry.start
			contentEnd := entry.end - 1
			if err := validateText(raw[contentStart:contentEnd], int64(contentStart)); err != nil {
				return nil, err
			}
			field.Content = ByteRange{Start: int64(contentStart), End: int64(contentEnd)}
			fields = append(fields, field)
			continue
		}

		// Data field 010..999.
		if entry.length < 5 {
			return nil, syntaxError(int64(entry.start),
				"data field %s at directory index %d is too short for indicators and one subfield",
				entry.tag, entry.dirIndex)
		}
		if !isPrintableASCII(raw[entry.start]) || !isPrintableASCII(raw[entry.start+1]) {
			return nil, syntaxError(int64(entry.start),
				"data field %s indicators must be two printable ASCII bytes", entry.tag)
		}
		field.Indicators = ByteRange{Start: int64(entry.start), End: int64(entry.start + 2)}

		pos := entry.start + 2
		firstSubfield := true
		for pos < entry.end-1 {
			if raw[pos] != subfieldDelimiter {
				return nil, syntaxError(int64(pos),
					"data field %s expects a 0x1f subfield delimiter", entry.tag)
			}
			if pos+1 >= entry.end-1 {
				return nil, syntaxError(int64(pos), "data field %s ends with a dangling delimiter", entry.tag)
			}
			code := raw[pos+1]
			if !isAlphanumericASCII(code) {
				return nil, syntaxError(int64(pos+1),
					"data field %s subfield code %q must be a single ASCII letter or digit", entry.tag, code)
			}
			valueStart := pos + 2
			valueEnd := valueStart
			for valueEnd < entry.end-1 && raw[valueEnd] != subfieldDelimiter {
				valueEnd++
			}
			if err := validateText(raw[valueStart:valueEnd], int64(valueStart)); err != nil {
				return nil, err
			}
			field.Subfields = append(field.Subfields, Subfield{
				Code:       code,
				Range:      ByteRange{Start: int64(pos), End: int64(valueEnd)},
				ValueRange: ByteRange{Start: int64(valueStart), End: int64(valueEnd)},
			})

			if code == '6' {
				if field.Linkage != nil {
					return nil, syntaxError(int64(pos), "data field %s has more than one code-6 subfield", entry.tag)
				}
				if !firstSubfield {
					return nil, syntaxError(int64(pos), "code-6 subfield must be the first subfield")
				}
				linkage, reason := parseLinkage(raw[valueStart:valueEnd])
				if reason != "" {
					return nil, syntaxError(int64(valueStart),
						"data field %s code-6 value %q is invalid: %s", entry.tag,
						string(raw[valueStart:valueEnd]), reason)
				}
				field.Linkage = &linkage
				field.linkOffset = int64(valueStart)
				if entry.tag == "880" {
					if linkage.Target == "880" {
						return nil, syntaxError(int64(valueStart), "880 field cannot point at another 880 field")
					}
					if !validTargetTag(linkage.Target) {
						return nil, syntaxError(int64(valueStart), "880 target tag must lie in 010..999")
					}
				} else if linkage.Target != "880" {
					return nil, syntaxError(int64(valueStart), "ordinary field code-6 target must be 880")
				}
			}

			firstSubfield = false
			pos = valueEnd
		}

		if len(field.Subfields) == 0 {
			return nil, syntaxError(int64(entry.start), "data field %s must contain at least one subfield", entry.tag)
		}
		if entry.tag == "880" {
			if field.Linkage == nil || field.Subfields[0].Code != '6' {
				return nil, syntaxError(int64(entry.start), "880 field must carry code-6 as its first subfield")
			}
			key := linkKey{tag: field.Linkage.Target, occ: field.Linkage.Occurrence}
			if field.Linkage.Occurrence != 0 {
				if _, dup := alternateLinks[key]; dup {
					return nil, syntaxError(field.linkOffset,
						"duplicate 880 linkage %s-%02d", key.tag, key.occ)
				}
				alternateLinks[key] = entry.dirIndex
			}
		} else if field.Linkage != nil && field.Linkage.Occurrence != 0 {
			key := linkKey{tag: entry.tag, occ: field.Linkage.Occurrence}
			if _, dup := regularLinks[key]; dup {
				return nil, syntaxError(field.linkOffset,
					"duplicate ordinary linkage %s-%02d", key.tag, key.occ)
			}
			regularLinks[key] = entry.dirIndex
		}

		fields = append(fields, field)
	}

	if err := validatePairing(fields, regularLinks, alternateLinks); err != nil {
		return nil, err
	}

	rec := &Record{
		Fields: fields,
		Range:  ByteRange{Start: 0, End: int64(total)},
		raw:    raw,
	}
	copy(rec.Leader[:], raw[:leaderLength])
	return rec, nil
}

// validateCoverage requires the directory field ranges to tile the data area
// [base, dataEnd) exactly: no overlap and no holes, in any physical order.
func validateCoverage(entries []directoryEntry, base, dataEnd int) *SyntaxError {
	if len(entries) == 0 {
		if base != dataEnd {
			return syntaxError(int64(base), "data area is not covered by any directory entry")
		}
		return nil
	}
	ordered := make([]directoryEntry, len(entries))
	copy(ordered, entries)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].start < ordered[j].start })
	next := base
	for _, entry := range ordered {
		if entry.start != next {
			return syntaxError(int64(next),
				"field ranges do not tile the data area without overlaps or holes near byte %d", next)
		}
		next = entry.end
	}
	if next != dataEnd {
		return syntaxError(int64(next), "field ranges leave %d data bytes uncovered", dataEnd-next)
	}
	return nil
}

func validatePairing(fields []Field, regular, alternate map[linkKey]int) *SyntaxError {
	for key, regularIndex := range regular {
		alternateIndex, ok := alternate[key]
		if !ok {
			return syntaxError(fields[regularIndex].linkOffset,
				"ordinary field %s has no matching 880 occurrence %02d", key.tag, key.occ)
		}
		fields[regularIndex].LinkedIndex = alternateIndex
		fields[alternateIndex].LinkedIndex = regularIndex
	}
	for key, alternateIndex := range alternate {
		if _, ok := regular[key]; !ok {
			return syntaxError(fields[alternateIndex].linkOffset,
				"880 field has no matching ordinary %s occurrence %02d", key.tag, key.occ)
		}
	}
	return nil
}

func shiftRecord(rec *Record, delta int64) {
	rec.Range.Start += delta
	rec.Range.End += delta
	for i := range rec.Fields {
		field := &rec.Fields[i]
		field.Indicators.Start += delta
		field.Indicators.End += delta
		field.Content.Start += delta
		field.Content.End += delta
		field.Range.Start += delta
		field.Range.End += delta
		field.linkOffset += delta
		for j := range field.Subfields {
			field.Subfields[j].Range.Start += delta
			field.Subfields[j].Range.End += delta
			field.Subfields[j].ValueRange.Start += delta
			field.Subfields[j].ValueRange.End += delta
		}
	}
}

func validateText(text []byte, offset int64) *SyntaxError {
	for i, b := range text {
		switch b {
		case fieldTerminator, recordTerminator, subfieldDelimiter:
			return syntaxError(offset+int64(i),
				"text must not contain control byte 0x%02x", b)
		}
	}
	if !utf8.Valid(text) {
		return syntaxError(offset, "text is not valid UTF-8")
	}
	return nil
}

// parseLinkage accepts exactly TTT-NN: three ASCII digits, a hyphen and two
// ASCII digits.
func parseLinkage(value []byte) (Linkage, string) {
	if len(value) != 6 || value[3] != '-' {
		return Linkage{}, "expected TTT-NN with three digits, a hyphen and two digits"
	}
	_, tagOK := parseDecimal(value[0:3])
	occ, occOK := parseDecimal(value[4:6])
	if !tagOK || !occOK {
		return Linkage{}, "TTT and NN must be decimal digits"
	}
	return Linkage{Target: string(value[:3]), Occurrence: occ}, ""
}

func validTargetTag(tag string) bool {
	if len(tag) != 3 {
		return false
	}
	tagNum, ok := parseDecimal([]byte(tag))
	return ok && tagNum >= 10
}

func parseDecimal(b []byte) (int, bool) {
	value := 0
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0, false
		}
		value = value*10 + int(c-'0')
	}
	return value, true
}

func mustDecimal(s string) int {
	value, _ := parseDecimal([]byte(s))
	return value
}

func isPrintableASCII(b byte) bool {
	return b >= 0x20 && b <= 0x7e
}

func isAlphanumericASCII(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// drainSkip discards bytes of a record rejected for exceeding the size limit.
// An early end of stream becomes a truncation error anchored at the record.
func (r *Reader) drainSkip() error {
	if r.skip == 0 {
		return nil
	}
	recordStart := r.consumed
	local := int64(0)
	for r.skip > 0 {
		if len(r.buf) > 0 {
			take := len(r.buf)
			if int64(take) > r.skip {
				take = int(r.skip)
			}
			r.buf = r.buf[take:]
			r.consumed += int64(take)
			r.skip -= int64(take)
			local += int64(take)
			continue
		}
		tmp := make([]byte, 4096)
		want := len(tmp)
		if int64(want) > r.skip {
			want = int(r.skip)
		}
		k, err := r.src.Read(tmp[:want])
		r.consumed += int64(k)
		r.skip -= int64(k)
		local += int64(k)
		if err != nil {
			if errors.Is(err, io.EOF) {
				r.exhausted = true
				return &TruncatedError{
					RecordOffset: recordStart,
					LocalOffset:  local,
					Reason:       "stream ended while discarding an oversized record",
				}
			}
			return err
		}
	}
	return nil
}
