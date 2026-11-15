package dataeng

// Envelope holds the batch/file framing evidence exactly as observed in the
// payload. BTSMessageCount and FTSBatchCount are declarations from BTS-1 and
// FTS-1. They are never rewritten to match a smaller number of valid messages.
type Envelope struct {
	FHS *Segment
	BHS *Segment
	BTS *Segment
	FTS *Segment

	FileHeader   *Segment
	BatchHeader  *Segment
	BatchTrailer *Segment
	FileTrailer  *Segment

	BTSMessageCount    int
	BTSMessageCountSet bool
	BTSMessageCounts   []int
	FTSBatchCount      int
	FTSBatchCountSet   bool

	// DeclaredMessages and DeclaredBatches are aliases for the primary
	// BTSMessageCount and FTSBatchCount evidence.
	DeclaredMessages int
	DeclaredBatches  int

	ObservedBatches  int
	ObservedMessages int
	ValidMessages    int
	FailedMessages   int
}

// BatchSection is one BHS..BTS group. A payload containing messages without a
// BHS still receives one synthetic section; Header and Trailer are nil and the
// BTS count is not declared.
type BatchSection struct {
	Envelope
	Index       int
	Header      *Segment
	Trailer     *Segment
	Messages    []*Message
	Errors      []*ParseError
	StartLine   int
	EndLine     int
	StartOffset int
	EndOffset   int
	raw         []byte
	complete    bool
	synthetic   bool
	delimiters  Delimiters
}

// Complete reports whether a BHS section has its BTS and the declared message
// count agrees with the number of observed message starts.
func (s *BatchSection) Complete() bool {
	return s != nil && s.complete
}

// Valid reports whether the section is complete and every message decoded.
func (s *BatchSection) Valid() bool {
	return s != nil && s.complete && len(s.Errors) == 0
}

// Raw returns the exact bytes from BHS through BTS, or from the first message
// through the last segment for a synthetic section.
func (s *BatchSection) Raw() []byte {
	if s == nil {
		return nil
	}
	return append([]byte(nil), s.raw...)
}

func (s *BatchSection) finish(data []byte) {
	if s == nil {
		return
	}
	if s.Header != nil {
		s.StartLine = s.Header.Line
		s.StartOffset = s.Header.Offset
	} else if len(s.Messages) > 0 {
		first := s.Messages[0]
		s.StartLine = first.StartLine
		s.StartOffset = first.Offset
	}
	if s.Trailer != nil {
		s.EndLine = s.Trailer.Line
		s.EndOffset = s.Trailer.EndOffset + len(s.Trailer.Terminator)
	} else if len(s.Messages) > 0 {
		last := s.Messages[len(s.Messages)-1]
		s.EndLine = last.EndLine
		s.EndOffset = last.EndOffset
	} else if s.Header != nil {
		s.EndLine = s.Header.Line
		s.EndOffset = s.Header.EndOffset + len(s.Header.Terminator)
	}
	if s.StartOffset >= 0 && s.EndOffset >= s.StartOffset && s.EndOffset <= len(data) {
		s.raw = append([]byte(nil), data[s.StartOffset:s.EndOffset]...)
	}
}

// Batch is one complete HL7 payload. A Batch is only returned by Parse when
// its framing is complete and all envelope count declarations agree.
type Batch struct {
	Envelope
	Sections    []*BatchSection
	Messages    []*Message
	Errors      []*ParseError
	StartLine   int
	EndLine     int
	StartOffset int
	EndOffset   int
	raw         []byte
	complete    bool
}

// Raw returns a copy of the complete original payload.
func (b *Batch) Raw() []byte {
	if b == nil {
		return nil
	}
	return append([]byte(nil), b.raw...)
}

// Complete reports whether every envelope trailer and count declaration was
// present and consistent. Per-message decode failures do not make a batch
// structurally incomplete.
func (b *Batch) Complete() bool {
	return b != nil && b.complete
}

// Valid reports whether the batch is complete and every message decoded.
func (b *Batch) Valid() bool {
	return b != nil && b.complete && len(b.Errors) == 0
}

// Published reflects the parser's publication rule: truncated, count-mismatched
// and message-invalid batches are not published. Callers that intentionally
// quarantine failed messages can inspect Complete, Messages and Errors instead.
func (b *Batch) Published() bool {
	return b != nil && b.complete && len(b.Errors) == 0
}

// Section returns a one-based batch section.
func (b *Batch) Section(number int) *BatchSection {
	if b == nil || number < 1 || number > len(b.Sections) {
		return nil
	}
	return b.Sections[number-1]
}

// Message returns a one-based message across the whole payload.
func (b *Batch) Message(number int) *Message {
	if b == nil || number < 1 || number > len(b.Messages) {
		return nil
	}
	return b.Messages[number-1]
}

// Error returns the ordered diagnostics as an error, or nil when valid.
func (b *Batch) Error() error {
	if b == nil || len(b.Errors) == 0 {
		return nil
	}
	return ErrorList(b.Errors)
}

func (b *Batch) finish(data []byte) {
	if b == nil {
		return
	}
	b.StartOffset = 0
	b.EndOffset = len(data)
	if len(b.Messages) > 0 {
		b.StartLine = b.Messages[0].StartLine
		b.EndLine = b.Messages[len(b.Messages)-1].EndLine
	} else if b.FHS != nil {
		b.StartLine = b.FHS.Line
		b.EndLine = b.FHS.Line
	}
	if b.FTS != nil {
		b.EndLine = b.FTS.Line
	}
	if b.FHS != nil {
		b.StartLine = b.FHS.Line
	}
	if b.BHS != nil && (b.FHS == nil || b.StartLine == 0) {
		b.StartLine = b.BHS.Line
	}
	if b.FHS != nil {
		b.StartOffset = b.FHS.Offset
	} else if b.BHS != nil {
		b.StartOffset = b.BHS.Offset
	} else if len(b.Messages) > 0 {
		b.StartOffset = b.Messages[0].Offset
	}
	if b.BTS != nil {
		b.EndLine = b.BTS.Line
	}
	b.raw = append([]byte(nil), data...)
}
