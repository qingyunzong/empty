package dataeng

import (
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// Parser controls resource limits for batch parsing. A zero Parser is ready to
// use and has no byte limit.
type Parser struct {
	// MaxBatchBytes limits ParseReader input. Zero means unlimited.
	MaxBatchBytes int64
}

// NewParser returns a parser with an optional byte limit. A non-positive limit,
// or no argument, means unlimited.
func NewParser(maxBatchBytes ...int64) *Parser {
	parser := &Parser{}
	if len(maxBatchBytes) > 0 {
		parser.MaxBatchBytes = maxBatchBytes[0]
	}
	return parser
}

// Parse parses a complete payload.
//
// A nil batch and a non-nil error are returned for a truncated envelope,
// missing trailer, count mismatch or other framing error. The error carries
// the envelope evidence and exact raw segment/message bytes.
//
// A non-nil batch and a non-nil error are returned when the envelope is
// complete but one or more messages failed to decode. In that case the
// declared BTS/FTS counts remain untouched, observed and failed counts are
// separated, and every failed message is replayable.
func Parse(data []byte) (*Batch, error) {
	return (*Parser)(nil).Parse(data)
}

// ParseBatch is an alias for Parse.
func ParseBatch(data []byte) (*Batch, error) {
	return Parse(data)
}

// ParseHL7Batch is an alias for Parse.
func ParseHL7Batch(data []byte) (*Batch, error) {
	return Parse(data)
}

// ParseReader reads the entire input before parsing. Nothing is published
// incrementally.
func ParseReader(reader io.Reader) (*Batch, error) {
	return (*Parser)(nil).ParseReader(reader)
}

// ParseBatchReader is an alias for ParseReader.
func ParseBatchReader(reader io.Reader) (*Batch, error) {
	return ParseReader(reader)
}

// ParseMessage parses a payload containing exactly one message. Envelope
// segments are optional.
func ParseMessage(data []byte) (*Message, error) {
	batch, err := Parse(data)
	if batch == nil {
		return nil, err
	}
	switch len(batch.Messages) {
	case 0:
		return nil, ErrorList{{
			Kind:   ErrInvalidInput,
			Detail: "payload contains no HL7 message",
			Batch:  batch,
		}}
	case 1:
		return batch.Messages[0], err
	default:
		return nil, ErrorList{{
			Kind:   ErrInvalidInput,
			Detail: fmt.Sprintf("payload contains %d messages; expected one", len(batch.Messages)),
			Batch:  batch,
		}}
	}
}

// Parse parses a complete payload. It has the same publication rules as the
// package-level Parse function.
func (p *Parser) Parse(data []byte) (*Batch, error) {
	if p == nil {
		p = &Parser{}
	}
	if p.MaxBatchBytes > 0 && int64(len(data)) > p.MaxBatchBytes {
		return nil, ErrorList{{
			Kind:   ErrInvalidInput,
			Detail: fmt.Sprintf("payload exceeds maximum batch size of %d bytes", p.MaxBatchBytes),
		}}
	}

	payload := append([]byte(nil), data...)
	builder := newBatchBuilder(payload)
	batch, fatal := builder.parse()
	if len(fatal) > 0 {
		batch.complete = false
		batch.finish(payload)
		builder.attachEvidence(batch)
		return nil, ErrorList(fatal)
	}

	batch.complete = true
	batch.finish(payload)
	builder.attachEvidence(batch)
	if len(batch.Errors) > 0 {
		return batch, ErrorList(batch.Errors)
	}
	return batch, nil
}

// ParseReader reads and parses all input.
func (p *Parser) ParseReader(reader io.Reader) (*Batch, error) {
	if p == nil {
		p = &Parser{}
	}
	var data []byte
	var err error
	if p.MaxBatchBytes > 0 {
		data, err = io.ReadAll(io.LimitReader(reader, p.MaxBatchBytes+1))
		if err == nil && int64(len(data)) > p.MaxBatchBytes {
			return nil, ErrorList{{
				Kind:   ErrInvalidInput,
				Detail: fmt.Sprintf("payload exceeds maximum batch size of %d bytes", p.MaxBatchBytes),
			}}
		}
	} else {
		data, err = io.ReadAll(reader)
	}
	if err != nil {
		return nil, ErrorList{{
			Kind:   ErrIO,
			Detail: "read batch payload",
			Cause:  err,
		}}
	}
	return p.Parse(data)
}

type batchBuilder struct {
	data []byte

	batch       *Batch
	section     *BatchSection
	message     *Message
	fileDelims  Delimiters
	fileDelimOK bool

	segmentIndex int
	structural   []*ParseError
	seenFTS      bool
	lastRecord   rawRecord
}

func newBatchBuilder(data []byte) *batchBuilder {
	return &batchBuilder{
		data:  data,
		batch: &Batch{},
	}
}

func (b *batchBuilder) parse() (*Batch, []*ParseError) {
	records := splitRecords(b.data)
	meaningful := 0

	for _, record := range records {
		if record.isBlank() {
			continue
		}
		meaningful++
		b.segmentIndex++
		b.lastRecord = record

		if b.seenFTS {
			b.addStructural(
				ErrUnexpected,
				"segment appears after FTS",
				record,
				nil,
				nil,
				nil,
			)
			continue
		}

		switch record.id {
		case "FHS":
			b.parseFHS(record)
		case "BHS":
			b.parseBHS(record)
		case "BTS":
			b.parseBTS(record)
		case "FTS":
			b.parseFTS(record)
		case "MSH":
			b.parseMSH(record)
		default:
			b.parseOrdinary(record)
		}
	}

	if meaningful == 0 {
		b.addStructural(
			ErrInvalidInput,
			"payload contains no HL7 segments",
			rawRecord{line: 1, offset: 0, endOffset: len(b.data)},
			nil,
			nil,
			nil,
		)
	}

	b.closeMessage()
	b.closeSection(true)

	if b.batch.FHS != nil && b.batch.FTS == nil {
		record := b.eofRecord("FTS")
		b.addStructural(
			ErrTruncated,
			"FHS is missing its FTS trailer",
			record,
			nil,
			nil,
			nil,
		)
	}
	if b.batch.FTS != nil && b.batch.FHS == nil {
		b.addStructural(
			ErrUnexpected,
			"FTS appears without FHS",
			b.lastRecord,
			b.batch.FTS,
			nil,
			nil,
		)
	}
	if b.batch.FTSBatchCountSet && b.batch.FTSBatchCount != len(b.batch.Sections) {
		b.addStructural(
			ErrCountMismatch,
			fmt.Sprintf(
				"FTS-1 declares %d batches but %d were observed",
				b.batch.FTSBatchCount,
				len(b.batch.Sections),
			),
			recordForSegment(b.batch.FTS, b.lastRecord),
			b.batch.FTS,
			nil,
			nil,
		)
	}

	b.aggregateCounts()
	return b.batch, b.structural
}

func (b *batchBuilder) parseFHS(record rawRecord) {
	if b.batch.FHS != nil {
		b.addStructural(ErrUnexpected, "duplicate FHS", record, nil, nil, nil)
		return
	}
	if len(b.batch.Sections) > 0 || b.section != nil || b.message != nil {
		b.addStructural(ErrUnexpected, "FHS appears after batch content", record, nil, nil, nil)
		return
	}

	segment, delimiters, err := b.parseHeader(record)
	if err != nil {
		b.addStructural(ErrDelimiter, err.Error(), record, segment, nil, err)
		return
	}
	b.fileDelims = delimiters
	b.fileDelimOK = true
	b.batch.FHS = segment
	b.batch.FileHeader = segment
	b.batch.StartLine = segment.Line
	b.batch.StartOffset = segment.Offset
}

func (b *batchBuilder) parseBHS(record rawRecord) {
	b.closeMessage()
	b.closeSection(b.section != nil && b.section.Trailer == nil)

	segment, delimiters, err := b.parseHeader(record)
	var headerErr *ParseError
	if err != nil {
		headerErr = b.addStructural(ErrDelimiter, err.Error(), record, segment, nil, err)
		delimiters = Delimiters{}
	}

	section := &BatchSection{
		Index:       len(b.batch.Sections) + 1,
		Header:      segment,
		StartLine:   record.line,
		StartOffset: record.offset,
	}
	section.delimiters = delimiters
	section.BHS = segment
	section.BatchHeader = segment
	if headerErr != nil {
		section.Errors = append(section.Errors, headerErr)
		section.complete = false
	}
	b.batch.Sections = append(b.batch.Sections, section)
	b.section = section
	if b.batch.BHS == nil {
		b.batch.BHS = segment
		b.batch.BatchHeader = segment
	}
}

func (b *batchBuilder) parseBTS(record rawRecord) {
	if b.batch.FHS == nil && b.section == nil {
		b.addStructural(ErrUnexpected, "BTS appears without BHS", record, nil, nil, nil)
		return
	}
	if b.section == nil {
		b.addStructural(ErrUnexpected, "BTS appears without an open BHS section", record, nil, nil, nil)
		return
	}
	section := b.section
	if section.Header == nil {
		b.addStructural(ErrUnexpected, "BTS appears without BHS", record, nil, nil, nil)
		return
	}

	b.closeMessage()
	segment, err := parseSegment(record, b.segmentIndex, section.delimiters)
	parseOK := err == nil
	if err != nil {
		parseErr := b.addStructural(
			errorKindFor(err),
			err.Error(),
			record,
			segment,
			nil,
			err,
		)
		segment.Err = parseErr
		section.Errors = append(section.Errors, parseErr)
	}

	section.Trailer = segment
	section.BTS = segment
	section.BatchTrailer = segment
	b.batch.BTS = segment
	b.batch.BatchTrailer = segment
	section.ObservedMessages = len(section.Messages)

	count, countErr := segmentCount(segment, "BTS-1")
	if countErr != nil {
		parseErr := b.addStructural(
			ErrEnvelope,
			countErr.Error(),
			record,
			segment,
			nil,
			countErr,
		)
		section.Errors = append(section.Errors, parseErr)
		section.complete = false
	} else {
		section.BTSMessageCount = count
		section.BTSMessageCountSet = true
		section.DeclaredMessages = count
		section.BTSMessageCounts = []int{count}
		if count != len(section.Messages) {
			parseErr := b.addStructural(
				ErrCountMismatch,
				fmt.Sprintf(
					"BTS-1 declares %d messages but %d were observed",
					count,
					len(section.Messages),
				),
				record,
				segment,
				nil,
				nil,
			)
			section.Errors = append(section.Errors, parseErr)
			section.complete = false
		} else {
			section.complete = parseOK
		}
	}
	if !parseOK {
		section.complete = false
	}

	section.finish(b.data)
	b.section = nil
}

func (b *batchBuilder) parseFTS(record rawRecord) {
	if b.batch.FHS == nil {
		b.addStructural(ErrUnexpected, "FTS appears without FHS", record, nil, nil, nil)
		return
	}
	if b.batch.FTS != nil {
		b.addStructural(ErrUnexpected, "duplicate FTS", record, nil, nil, nil)
		return
	}
	if !b.fileDelimOK {
		b.addStructural(ErrDelimiter, "FTS cannot be parsed without FHS delimiters", record, nil, nil, nil)
		return
	}

	b.closeMessage()
	b.closeSection(b.section != nil && b.section.Trailer == nil)

	segment, err := parseSegment(record, b.segmentIndex, b.fileDelims)
	if err != nil {
		parseErr := b.addStructural(
			errorKindFor(err),
			err.Error(),
			record,
			segment,
			nil,
			err,
		)
		segment.Err = parseErr
	}
	b.batch.FTS = segment
	b.batch.FileTrailer = segment
	b.batch.EndLine = segment.Line
	b.batch.EndOffset = segment.EndOffset + len(segment.Terminator)

	count, countErr := segmentCount(segment, "FTS-1")
	if countErr != nil {
		b.addStructural(
			ErrEnvelope,
			countErr.Error(),
			record,
			segment,
			nil,
			countErr,
		)
	} else {
		b.batch.FTSBatchCount = count
		b.batch.FTSBatchCountSet = true
		b.batch.DeclaredBatches = count
	}
	b.seenFTS = true
}

func (b *batchBuilder) parseMSH(record rawRecord) {
	b.closeMessage()
	outsideBHS := false
	if b.section == nil {
		outsideBHS = b.batch.FHS != nil || b.batch.BHS != nil
		b.ensureSection(record)
	}

	message := &Message{
		Index:        len(b.batch.Messages) + 1,
		SectionIndex: b.section.Index,
		StartLine:    record.line,
		Offset:       record.offset,
	}
	b.batch.Messages = append(b.batch.Messages, message)
	b.section.Messages = append(b.section.Messages, message)
	b.message = message

	segment, delimiters, err := b.parseHeader(record)
	b.appendMessageSegment(message, segment)
	message.MSH = segment
	if outsideBHS {
		parseErr := b.addStructural(
			ErrUnexpected,
			"MSH appears outside a BHS section",
			record,
			segment,
			message,
			nil,
		)
		message.addError(parseErr)
		segment.Err = parseErr
		b.section.Errors = append(b.section.Errors, parseErr)
	}
	if err != nil {
		kind := ErrDelimiter
		if delimiters != (Delimiters{}) {
			message.Delimiters = delimiters
			kind = errorKindFor(err)
		} else {
			message.Delimiters = Delimiters{}
		}
		parseErr := b.addMessageError(
			message,
			segment,
			record,
			kind,
			err.Error(),
			err,
		)
		segment.Err = parseErr
		return
	}

	message.Delimiters = delimiters
}

func (b *batchBuilder) parseOrdinary(record rawRecord) {
	if b.message == nil {
		b.addStructural(
			ErrUnexpected,
			"segment appears outside an HL7 message",
			record,
			nil,
			nil,
			nil,
		)
		return
	}
	if !validSegmentID(record.id) {
		segment := baseSegment(record, b.segmentIndex)
		b.appendMessageSegment(b.message, segment)
		parseErr := b.addMessageError(
			b.message,
			segment,
			record,
			ErrSegment,
			fmt.Sprintf("invalid segment ID %q", record.id),
			nil,
		)
		segment.Err = parseErr
		return
	}

	if b.message.MSH != nil && b.message.Err != nil && b.message.Delimiters == (Delimiters{}) {
		segment := baseSegment(record, b.segmentIndex)
		b.appendMessageSegment(b.message, segment)
		return
	}

	segment, err := parseSegment(record, b.segmentIndex, b.message.Delimiters)
	b.appendMessageSegment(b.message, segment)
	if err != nil {
		parseErr := b.addMessageError(
			b.message,
			segment,
			record,
			errorKindFor(err),
			err.Error(),
			err,
		)
		segment.Err = parseErr
	}
}

func (b *batchBuilder) parseHeader(record rawRecord) (*Segment, Delimiters, error) {
	delimiters, err := DelimitersFromHeader(record.content)
	if err != nil {
		return baseSegment(record, b.segmentIndex), Delimiters{}, err
	}
	segment, err := parseHeaderSegment(record, b.segmentIndex, delimiters)
	return segment, delimiters, err
}

func (b *batchBuilder) ensureSection(record rawRecord) {
	section := &BatchSection{
		Index:       len(b.batch.Sections) + 1,
		StartLine:   record.line,
		StartOffset: record.offset,
		synthetic:   true,
	}
	b.batch.Sections = append(b.batch.Sections, section)
	b.section = section
}

func (b *batchBuilder) appendMessageSegment(message *Message, segment *Segment) {
	segment.MessageIndex = message.Index
	segment.MessageSegmentIndex = len(message.Segments) + 1
	segment.message = message
	message.Segments = append(message.Segments, segment)
}

func (b *batchBuilder) closeMessage() {
	if b.message == nil {
		return
	}
	b.message.finish(b.data)
	b.message = nil
}

func (b *batchBuilder) closeSection(missingTrailer bool) {
	section := b.section
	if section == nil {
		return
	}
	section.ObservedMessages = len(section.Messages)
	if section.Header == nil {
		section.complete = true
	} else if section.Trailer != nil {
		// Completion was decided when BTS was parsed.
	} else {
		section.complete = false
		if missingTrailer {
			parseErr := b.addStructural(
				ErrTruncated,
				"BHS section is missing its BTS trailer",
				recordForSegment(section.Header, b.eofRecord("BTS")),
				section.Header,
				nil,
				nil,
			)
			section.Errors = append(section.Errors, parseErr)
		}
	}
	section.finish(b.data)
	b.section = nil
}

func (b *batchBuilder) addMessageError(
	message *Message,
	segment *Segment,
	record rawRecord,
	kind ErrorKind,
	detail string,
	cause error,
) *ParseError {
	parseErr := parseErrorAt(kind, detail, record, segment, message, cause)
	parseErr.Column = escapeColumn(record.content, cause)
	if segment != nil {
		parseErr.SegmentIndex = segment.Index
		parseErr.MessageSegmentIndex = segment.MessageSegmentIndex
	}
	message.addError(parseErr)
	b.batch.Errors = append(b.batch.Errors, parseErr)
	if b.section != nil {
		b.section.Errors = append(b.section.Errors, parseErr)
	}
	return parseErr
}

func (b *batchBuilder) addStructural(
	kind ErrorKind,
	detail string,
	record rawRecord,
	segment *Segment,
	message *Message,
	cause error,
) *ParseError {
	parseErr := parseErrorAt(kind, detail, record, segment, message, cause)
	parseErr.Column = escapeColumn(record.content, cause)
	if segment != nil {
		parseErr.SegmentIndex = segment.Index
	}
	b.structural = append(b.structural, parseErr)
	b.batch.Errors = append(b.batch.Errors, parseErr)
	return parseErr
}

func (b *batchBuilder) aggregateCounts() {
	envelope := &b.batch.Envelope
	envelope.ObservedBatches = len(b.batch.Sections)
	envelope.ObservedMessages = len(b.batch.Messages)

	for _, section := range b.batch.Sections {
		section.ObservedMessages = len(section.Messages)
		section.ValidMessages = 0
		section.FailedMessages = 0
		for _, message := range section.Messages {
			if message.Valid() {
				section.ValidMessages++
			} else {
				section.FailedMessages++
			}
		}
		if section.BTSMessageCountSet {
			if !envelope.BTSMessageCountSet {
				envelope.BTSMessageCountSet = true
			}
			envelope.BTSMessageCount += section.BTSMessageCount
			envelope.BTSMessageCounts = append(
				envelope.BTSMessageCounts,
				section.BTSMessageCount,
			)
		}
	}
	envelope.DeclaredMessages = envelope.BTSMessageCount
	envelope.DeclaredBatches = envelope.FTSBatchCount

	for _, message := range b.batch.Messages {
		if message.Valid() {
			envelope.ValidMessages++
		} else {
			envelope.FailedMessages++
		}
	}
}

func (b *batchBuilder) attachEvidence(batch *Batch) {
	for _, parseErr := range batch.Errors {
		parseErr.Evidence = &batch.Envelope
		parseErr.Batch = batch
		if parseErr.Segment == nil {
			continue
		}
		if parseErr.Message != nil {
			parseErr.MessageIndex = parseErr.Message.Index
		}
		if len(parseErr.RawMessage) == 0 && parseErr.Message != nil {
			parseErr.RawMessage = parseErr.Message.Raw()
		}
		if len(parseErr.RawSegment) == 0 {
			parseErr.RawSegment = parseErr.Segment.RawBytes()
		}
	}
}

func (b *batchBuilder) eofRecord(id string) rawRecord {
	line := 1
	offset := len(b.data)
	if b.lastRecord.line > 0 {
		line = b.lastRecord.line + 1
		offset = b.lastRecord.rawEndOffset()
	}
	return rawRecord{
		id:        id,
		line:      line,
		offset:    offset,
		endOffset: offset,
	}
}

func recordForSegment(segment *Segment, fallback rawRecord) rawRecord {
	if segment == nil {
		return fallback
	}
	return rawRecord{
		id:         segment.ID,
		line:       segment.Line,
		offset:     segment.Offset,
		endOffset:  segment.EndOffset,
		content:    segment.Raw,
		terminator: segment.Terminator,
	}
}

func segmentCount(segment *Segment, fieldName string) (int, error) {
	if segment == nil {
		return 0, fmt.Errorf("hl7: %s is unavailable", fieldName)
	}
	field := segment.Field(1)
	if field == nil {
		return 0, fmt.Errorf("hl7: %s is missing", fieldName)
	}
	value := strings.TrimSpace(field.Value())
	if value == "" {
		return 0, fmt.Errorf("hl7: %s is empty", fieldName)
	}
	count, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("hl7: %s is not an integer: %q", fieldName, value)
	}
	if count < 0 {
		return 0, fmt.Errorf("hl7: %s cannot be negative: %d", fieldName, count)
	}
	return count, nil
}

func errorKindFor(err error) ErrorKind {
	var escapeErr *EscapeError
	if errors.As(err, &escapeErr) {
		return ErrEscape
	}
	return ErrSegment
}
