package dataeng

import "fmt"

// Section is an IMAP BODY section identifier. The empty string denotes the
// complete message (BODY[]), "HEADER" and "TEXT" denote message header and
// text, part numbers denote MIME parts, and so on. Section strings are used
// verbatim as keys; callers should pass the canonical spelling produced by
// their IMAP response parser.
type Section = string

// Range is a half-open octet range [Start, End).
type Range struct {
	Start int64
	End   int64
}

// Len returns the number of octets in the range.
func (r Range) Len() int64 {
	if r.End <= r.Start {
		return 0
	}
	return r.End - r.Start
}

func (r Range) String() string { return fmt.Sprintf("[%d,%d)", r.Start, r.End) }

// Span is an alias for Range.
type Span = Range

// Segment is one IMAP BODY literal fragment.
//
// Origin is the zero-based octet offset within Section. Data contains exactly
// the octets that the server returned; len(Data), not RequestedLength, is the
// authoritative literal length. RequestedLength is the FETCH partial length
// that produced the literal and may be zero when it is unknown. When it is
// positive and Data is shorter, the fragment is recorded as a short literal.
// If the expected section size is known, or data beyond the literal proves
// that the section continues, a short literal that does not reach the end of
// the section is reported as server truncation.
//
// The assembler copies Data; callers may reuse their read buffers.
type Segment struct {
	Section         Section
	Origin          int64
	Data            []byte
	RequestedLength int64
}

// Literal is an alias for Segment.
type Literal = Segment

// AddResult describes how a fragment affected a section.
type AddResult struct {
	Section    Section
	Added      int64
	Overlapped int64
	Truncated  bool
	Received   int64
	Complete   bool
}

// Truncation records one literal that was shorter than the portion of the
// section it was asked to cover.
type Truncation struct {
	Origin    int64
	Requested int64
	Received  int64
	Needed    int64
}

// SectionStatus is a point-in-time summary of a section.
type SectionStatus struct {
	Section       Section
	Expected      int64
	ExpectedKnown bool
	Received      int64
	Chunks        int
	Adds          int
	Complete      bool
	Truncated     bool
	ShortLiterals int
	Truncations   []Truncation
	Gaps          []Range
	Conflict      error
}
