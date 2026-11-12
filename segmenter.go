package dataeng

import (
	"errors"
	"fmt"
	"unicode/utf8"
)

// Class is the grapheme-relevant property class reported by a PropertyLookup.
type Class uint8

const (
	ClassOther Class = iota
	ClassCR
	ClassLF
	ClassControl
	ClassL
	ClassV
	ClassT
	ClassLV
	ClassLVT
	ClassExtend
	ClassZWJ
	ClassSpacingMark
	ClassPrepend
	ClassRI
)

func (c Class) String() string {
	switch c {
	case ClassCR:
		return "CR"
	case ClassLF:
		return "LF"
	case ClassControl:
		return "Control"
	case ClassL:
		return "L"
	case ClassV:
		return "V"
	case ClassT:
		return "T"
	case ClassLV:
		return "LV"
	case ClassLVT:
		return "LVT"
	case ClassExtend:
		return "Extend"
	case ClassZWJ:
		return "ZWJ"
	case ClassSpacingMark:
		return "SpacingMark"
	case ClassPrepend:
		return "Prepend"
	case ClassRI:
		return "RI"
	case ClassOther:
		return "Other"
	default:
		return fmt.Sprintf("Class(%d)", uint8(c))
	}
}

// Properties is the property lookup result for one code point. The category
// and the Extended_Pictographic flag are deliberately independent.
type Properties struct {
	Class                Class
	ExtendedPictographic bool
}

// PropertyLookup returns the properties for r. It must be deterministic for
// the lifetime of a Segmenter.
type PropertyLookup func(r rune) Properties

// Grapheme describes one closed grapheme cluster. ByteStart, ByteEnd,
// UTF16Start, and UTF16End are half-open intervals in the complete input
// stream, not in the current chunk.
type Grapheme struct {
	ByteStart  int
	ByteEnd    int
	UTF16Start int
	UTF16End   int
	Text       string
}

// Sink receives a closed grapheme cluster. Returning nil marks the cluster as
// delivered. Returning an error stops the Segmenter permanently; the failed
// cluster is not considered delivered.
type Sink func(Grapheme) error

// Options configures a Segmenter.
//
// MaxClusterBytes must be positive. It bounds the raw byte length of every
// grapheme, including an open one. Exceeding it is a resource error; the
// Segmenter never manufactures an artificial boundary to stay under the limit.
type Options struct {
	Lookup          PropertyLookup
	MaxClusterBytes int
	Emit            Sink
}

var (
	// ErrInvalidOptions reports a nil lookup/sink or a non-positive size limit.
	ErrInvalidOptions = errors.New("dataeng: invalid segmenter options")
	// ErrInvalidUTF8 reports malformed UTF-8. Use EncodingError for the offset.
	ErrInvalidUTF8 = errors.New("dataeng: invalid UTF-8")
	// ErrTruncatedUTF8 reports an incomplete UTF-8 sequence at Finish.
	ErrTruncatedUTF8 = errors.New("dataeng: truncated UTF-8")
	// ErrClusterTooLarge reports a grapheme exceeding MaxClusterBytes.
	ErrClusterTooLarge = errors.New("dataeng: grapheme exceeds maximum byte length")
	// ErrFinished reports use of a Segmenter after a successful Finish.
	ErrFinished = errors.New("dataeng: segmenter already finished")
)

// EncodingError identifies the first byte of an invalid or truncated UTF-8
// sequence. Offset is absolute in the complete input stream.
type EncodingError struct {
	Offset    int
	Truncated bool
}

func (e *EncodingError) Error() string {
	if e.Truncated {
		return fmt.Sprintf("dataeng: truncated UTF-8 at byte %d", e.Offset)
	}
	return fmt.Sprintf("dataeng: invalid UTF-8 at byte %d", e.Offset)
}

func (e *EncodingError) Unwrap() error {
	if e.Truncated {
		return ErrTruncatedUTF8
	}
	return ErrInvalidUTF8
}

// ClusterTooLargeError describes the attempted cluster that exceeded the
// configured limit. Size is the byte length the cluster would have reached.
type ClusterTooLargeError struct {
	StartByte int
	Size      int
	Limit     int
}

func (e *ClusterTooLargeError) Error() string {
	return fmt.Sprintf(
		"dataeng: grapheme starting at byte %d would be %d bytes (limit %d)",
		e.StartByte, e.Size, e.Limit,
	)
}

func (e *ClusterTooLargeError) Unwrap() error { return ErrClusterTooLarge }

// Segmenter incrementally segments UTF-8 into grapheme clusters. A Segmenter
// is not safe for concurrent use and must not be called reentrantly from its
// Sink.
type Segmenter struct {
	lookup PropertyLookup
	max    int
	emit   Sink

	carry   []byte
	current []byte

	startByte  int
	startUTF16 int
	nextByte   int
	nextUTF16  int

	prevClass Class
	hasPrev   bool

	riRun       int
	epExtendRun bool
	epZWJReady  bool

	stopped bool
	done    bool
	stopErr error
}

// NewSegmenter validates options and returns a fresh Segmenter.
func NewSegmenter(opts Options) (*Segmenter, error) {
	if opts.Lookup == nil {
		return nil, fmt.Errorf("%w: Lookup is nil", ErrInvalidOptions)
	}
	if opts.Emit == nil {
		return nil, fmt.Errorf("%w: Emit is nil", ErrInvalidOptions)
	}
	if opts.MaxClusterBytes <= 0 {
		return nil, fmt.Errorf(
			"%w: MaxClusterBytes must be positive, got %d",
			ErrInvalidOptions, opts.MaxClusterBytes,
		)
	}
	return &Segmenter{
		lookup: opts.Lookup,
		max:    opts.MaxClusterBytes,
		emit:   opts.Emit,
	}, nil
}

// Feed supplies another UTF-8 chunk. It may deliver zero or more closed
// clusters through the Sink. Reaching the end of a chunk never closes a
// cluster; Finish is the only operation that applies the end-of-text boundary.
//
// A nil error means the chunk was consumed. Any error stops the Segmenter
// permanently, and no later Feed or Finish call accepts more input.
func (s *Segmenter) Feed(chunk []byte) error {
	if err := s.usable(); err != nil {
		return err
	}
	if len(chunk) == 0 {
		return nil
	}

	data := chunk
	if len(s.carry) != 0 {
		data = make([]byte, len(s.carry)+len(chunk))
		copy(data, s.carry)
		copy(data[len(s.carry):], chunk)
		s.carry = s.carry[:0]
	}

	for pos := 0; pos < len(data); {
		r, size := utf8.DecodeRune(data[pos:])
		if r == utf8.RuneError && size == 1 {
			if incompleteUTF8Prefix(data[pos:]) {
				s.carry = append(s.carry[:0], data[pos:]...)
				return nil
			}
			return s.halt(&EncodingError{Offset: s.nextByte})
		}

		if err := s.consume(data[pos:pos+size], r); err != nil {
			return err
		}
		s.nextByte += size
		pos += size
	}
	return nil
}

// Finish applies the end-of-text boundary and delivers the final open cluster,
// if any. An incomplete UTF-8 sequence is reported as a truncated encoding
// error and the open cluster is not delivered.
//
// Finish may be called once successfully. Its error also stops the Segmenter,
// matching all other failures.
func (s *Segmenter) Finish() error {
	if err := s.usable(); err != nil {
		return err
	}
	if len(s.carry) != 0 {
		return s.halt(&EncodingError{Offset: s.nextByte, Truncated: true})
	}
	if len(s.current) != 0 {
		if err := s.emitCurrent(); err != nil {
			return err
		}
	}
	s.done = true
	return nil
}

func (s *Segmenter) usable() error {
	if s.stopped {
		return s.stopErr
	}
	if s.done {
		return ErrFinished
	}
	return nil
}

func (s *Segmenter) halt(err error) error {
	if !s.stopped {
		s.stopped = true
		s.stopErr = err
	}
	return s.stopErr
}

func (s *Segmenter) consume(raw []byte, r rune) error {
	props := s.lookup(r)

	if s.hasPrev && s.breakBefore(props) {
		if err := s.emitCurrent(); err != nil {
			return err
		}
		s.beginCluster()
	}

	size := len(s.current) + len(raw)
	if size > s.max {
		return s.halt(&ClusterTooLargeError{
			StartByte: s.startByte,
			Size:      size,
			Limit:     s.max,
		})
	}

	s.current = append(s.current, raw...)
	s.nextUTF16 += utf16Units(r)
	s.updateState(props)
	s.prevClass = props.Class
	s.hasPrev = true
	return nil
}

func (s *Segmenter) emitCurrent() error {
	g := Grapheme{
		ByteStart:  s.startByte,
		ByteEnd:    s.nextByte,
		UTF16Start: s.startUTF16,
		UTF16End:   s.nextUTF16,
		Text:       string(s.current),
	}
	if err := s.emit(g); err != nil {
		return s.halt(err)
	}
	return nil
}

func (s *Segmenter) beginCluster() {
	s.current = s.current[:0]
	s.startByte = s.nextByte
	s.startUTF16 = s.nextUTF16
	s.hasPrev = false
	s.prevClass = ClassOther
	s.riRun = 0
	s.epExtendRun = false
	s.epZWJReady = false
}

// breakBefore applies the requested rules in priority order. The start-of-text
// boundary is handled by consume, and the end-of-text boundary by Finish.
func (s *Segmenter) breakBefore(curr Properties) bool {
	prev := s.prevClass

	if prev == ClassCR && curr.Class == ClassLF {
		return false
	}
	if isBreakControl(prev) || isBreakControl(curr.Class) {
		return true
	}
	if hangulNoBreak(prev, curr.Class) {
		return false
	}
	if curr.Class == ClassExtend ||
		curr.Class == ClassZWJ ||
		curr.Class == ClassSpacingMark {
		return false
	}
	if prev == ClassPrepend {
		return false
	}
	if prev == ClassZWJ && s.epZWJReady && curr.ExtendedPictographic {
		return false
	}
	if prev == ClassRI && curr.Class == ClassRI && s.riRun%2 == 1 {
		return false
	}
	return true
}

func (s *Segmenter) updateState(curr Properties) {
	oldExtendRun := s.epExtendRun

	switch {
	case curr.ExtendedPictographic:
		// The current code point is a fresh Extended_Pictographic anchor.
		s.epExtendRun = true
		// If it is also a ZWJ, it can simultaneously close an older
		// Extended_Pictographic Extend* sequence.
		s.epZWJReady = curr.Class == ClassZWJ && oldExtendRun
	case curr.Class == ClassExtend:
		// Extend preserves an Extended_Pictographic Extend* suffix, but
		// consumes any ZWJ-ready state.
		s.epExtendRun = oldExtendRun
		s.epZWJReady = false
	case curr.Class == ClassZWJ:
		s.epExtendRun = false
		s.epZWJReady = oldExtendRun
	default:
		s.epExtendRun = false
		s.epZWJReady = false
	}

	if curr.Class == ClassRI {
		s.riRun++
	} else {
		s.riRun = 0
	}
}

func isBreakControl(c Class) bool {
	return c == ClassControl || c == ClassCR || c == ClassLF
}

func hangulNoBreak(prev, curr Class) bool {
	switch prev {
	case ClassL:
		return curr == ClassL || curr == ClassV ||
			curr == ClassLV || curr == ClassLVT
	case ClassLV, ClassV:
		return curr == ClassV || curr == ClassT
	case ClassLVT, ClassT:
		return curr == ClassT
	default:
		return false
	}
}

func utf16Units(r rune) int {
	if r > 0xFFFF {
		return 2
	}
	return 1
}

// incompleteUTF8Prefix reports whether b is a proper prefix of a valid UTF-8
// encoding. It is only used after utf8.DecodeRune has rejected b[0].
func incompleteUTF8Prefix(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	need := utf8SequenceLen(b[0])
	if need < 2 || len(b) >= need {
		return false
	}
	for i := 1; i < len(b); i++ {
		if !validUTF8Continuation(b[0], i, b[i]) {
			return false
		}
	}
	return true
}

func utf8SequenceLen(lead byte) int {
	switch {
	case lead >= 0xC2 && lead <= 0xDF:
		return 2
	case lead >= 0xE0 && lead <= 0xEF:
		return 3
	case lead >= 0xF0 && lead <= 0xF4:
		return 4
	default:
		return 0
	}
}

func validUTF8Continuation(lead byte, index int, b byte) bool {
	if index == 1 {
		switch lead {
		case 0xE0:
			return b >= 0xA0 && b <= 0xBF
		case 0xED:
			return b >= 0x80 && b <= 0x9F
		case 0xF0:
			return b >= 0x90 && b <= 0xBF
		case 0xF4:
			return b >= 0x80 && b <= 0x8F
		}
	}
	return b >= 0x80 && b <= 0xBF
}
