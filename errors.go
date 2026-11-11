package q225

import "errors"

// Framing identifies how a request body is delimited on the wire.
type Framing int

const (
	// FramingNone means the message carries no body; the decoder reports
	// end-of-body immediately without consuming any input.
	FramingNone Framing = iota
	// FramingContentLength means the body is exactly Content-Length bytes.
	FramingContentLength
	// FramingChunked means the body uses the chunked transfer coding.
	FramingChunked
)

func (f Framing) String() string {
	switch f {
	case FramingContentLength:
		return "content-length"
	case FramingChunked:
		return "chunked"
	default:
		return "none"
	}
}

// Sentinel protocol errors. Every error reported by a Decoder or BodyReader
// for a malformed message matches one of these values via errors.Is.
var (
	// ErrDuplicateContentLength is reported when more than one
	// Content-Length header field is present, or its value is a
	// comma-separated list.
	ErrDuplicateContentLength = errors.New("q225: duplicate or list-valued Content-Length")
	// ErrBadContentLength is reported for an empty, non-canonical or
	// out-of-range Content-Length value.
	ErrBadContentLength = errors.New("q225: invalid Content-Length")
	// ErrBothFramings is reported when Content-Length and chunked
	// Transfer-Encoding are present together.
	ErrBothFramings = errors.New("q225: Content-Length and Transfer-Encoding both present")
	// ErrBadTransferEncoding is reported when Transfer-Encoding is not a
	// single, unquoted "chunked" token.
	ErrBadTransferEncoding = errors.New("q225: unsupported or malformed Transfer-Encoding")

	// ErrChunkSyntax is reported for an empty chunk-size line, non-hex
	// digits, or an unparseable chunk extension.
	ErrChunkSyntax = errors.New("q225: malformed chunk size or extension")
	// ErrChunkLineTooLong is reported when a chunk-size line (including
	// extensions) exceeds Limits.MaxChunkLine.
	ErrChunkLineTooLong = errors.New("q225: chunk line too long")
	// ErrBodyTooLarge is reported when the decoded body exceeds
	// Limits.MaxBodyBytes.
	ErrBodyTooLarge = errors.New("q225: request body too large")
	// ErrCRLF is reported whenever the wire encoding requires CRLF but
	// the stream supplies a bare CR, a bare LF or truncated bytes.
	ErrCRLF = errors.New("q225: expected CRLF")
	// ErrTrailerSyntax is reported for a malformed trailer field line,
	// obsolete line folding or an illegal field name/value byte.
	ErrTrailerSyntax = errors.New("q225: malformed trailer field")
	// ErrForbiddenTrailer is reported when a trailer uses one of the
	// forbidden names (Content-Length, Transfer-Encoding, Host, Trailer).
	ErrForbiddenTrailer = errors.New("q225: forbidden trailer field")
	// ErrTrailerTooLarge is reported when the trailing section exceeds
	// Limits.MaxTrailerBytes or Limits.MaxTrailerFields.
	ErrTrailerTooLarge = errors.New("q225: trailer section too large")
	// ErrTruncated is reported by Finish when the stream ends before the
	// body or its terminating CRLF was fully received.
	ErrTruncated = errors.New("q225: truncated request body")
	// ErrPoisoned is reported by every call after the first protocol
	// error; a connection returning this must be closed and never reused.
	ErrPoisoned = errors.New("q225: connection poisoned by previous protocol error")
)
