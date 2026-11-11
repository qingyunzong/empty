package q225

import "strings"

// Header is the subset of an HTTP message header the decoder needs.
//
// Keys are canonicalized with mime.CanonicalHeaderKey and each value slice
// element represents one received header line, so duplicates stay visible.
// Connection handlers typically build it while reading the head of the
// request.
type Header map[string][]string

// Get returns the first value for the given (case-insensitive) key.
func (h Header) Get(key string) string {
	values := h[canonicalKey(key)]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

// Values returns every received value for the given (case-insensitive) key.
func (h Header) Values(key string) []string {
	return h[canonicalKey(key)]
}

// canonicalKey converts an HTTP field name to canonical MIME header form,
// e.g. "content-length" -> "Content-Length". Bytes that are not letters or
// digits are treated as word separators.
func canonicalKey(key string) string {
	upper := true
	var b strings.Builder
	b.Grow(len(key))
	for i := 0; i < len(key); i++ {
		c := key[i]
		if c >= 'a' && c <= 'z' {
			if upper {
				c -= 'a' - 'A'
			}
			upper = false
		} else if c >= 'A' && c <= 'Z' {
			if !upper {
				c += 'a' - 'A'
			}
			upper = false
		} else {
			upper = true
		}
		b.WriteByte(c)
	}
	return b.String()
}

// Limits bounds the resources a single request body may consume.
//
// The zero value of Limits is not valid; use DefaultLimits or fill every
// field explicitly.
type Limits struct {
	// MaxBodyBytes bounds the decoded payload (sum of chunk data, or the
	// Content-Length value).
	MaxBodyBytes int64
	// MaxTrailerBytes bounds the total wire size of the trailing section,
	// including its terminating empty CRLF line.
	MaxTrailerBytes int
	// MaxTrailerFields bounds the number of trailer fields.
	MaxTrailerFields int
	// MaxChunkLine bounds a single chunk-size line including extensions.
	MaxChunkLine int
}

// DefaultLimits is used by NewDecoder / NewBodyReader for every zero field.
var DefaultLimits = Limits{
	MaxBodyBytes:     10 << 20,
	MaxTrailerBytes:  64 << 10,
	MaxTrailerFields: 64,
	MaxChunkLine:     8 << 10,
}

func (l *Limits) withDefaults() Limits {
	out := *l
	if out.MaxBodyBytes <= 0 {
		out.MaxBodyBytes = DefaultLimits.MaxBodyBytes
	}
	if out.MaxTrailerBytes <= 0 {
		out.MaxTrailerBytes = DefaultLimits.MaxTrailerBytes
	}
	if out.MaxTrailerFields <= 0 {
		out.MaxTrailerFields = DefaultLimits.MaxTrailerFields
	}
	if out.MaxChunkLine <= 0 {
		out.MaxChunkLine = DefaultLimits.MaxChunkLine
	}
	return out
}

// Decoder is a push-based request-body parser.
//
// It implements backpressure directly: the connection handler decides when
// more wire bytes become available by calling Feed, so unread bytes of a
// pipelined next request are never pulled in and never have to be pushed
// back into the connection. Decoded payload bytes are returned as out and
// every consumed wire byte is counted precisely, available via Consumed.
//
// A Decoder is single use. Once it reports an error it is permanently
// poisoned: subsequent Feed calls return ErrPoisoned and the handler must
// close the connection rather than reuse it.
type Decoder struct {
	framing   Framing
	limits    Limits
	trailers  Header
	state     decoderState
	remaining int64 // bytes left in the current chunk or Content-Length body
	emitted   int64 // decoded payload bytes produced so far
	consumed  int64 // wire bytes consumed so far
	trailerSz int   // wire bytes accumulated in the trailing section

	// line holds a partial line between Feed calls (never including a
	// terminating CRLF).
	line []byte
	// crPending is set when line ends with a dangling CR awaiting the LF.
	crPending bool
	// out accumulates decoded payload within one Feed call.
	out []byte

	err       error
	completed bool
}

type decoderState int

const (
	stateNone      decoderState = iota // no body expected, next Feed ends immediately
	stateFixed                         // reading a Content-Length body
	stateChunkLine                     // reading a chunk-size line
	stateChunkData                     // reading chunk payload
	stateChunkCRLF                     // expecting CRLF after chunk payload
	stateTrailer                       // reading trailer fields / final CRLF
	stateDone                          // full body parsed
)

// NewDecoder validates the framing headers and returns a ready Decoder.
//
// Exactly one framing is accepted:
//   - one canonical Content-Length header (a single non-negative decimal
//     integer with no whitespace, folding or comma list), or
//   - one Transfer-Encoding header whose sole token is "chunked".
//
// Both framings together, repeated Content-Length, repeated
// Transfer-Encoding and any other transfer coding are rejected.
func NewDecoder(header Header, limits Limits) (*Decoder, error) {
	limits = limits.withDefaults()

	clValues := header.Values("Content-Length")
	teValues := header.Values("Transfer-Encoding")

	var length int64
	haveLength := len(clValues) > 0
	if haveLength {
		if len(clValues) != 1 {
			return nil, ErrDuplicateContentLength
		}
		parsed, err := parseContentLength(clValues[0])
		if err != nil {
			return nil, err
		}
		length = parsed
	}

	haveChunked := false
	if len(teValues) > 0 {
		if len(teValues) != 1 {
			return nil, ErrBadTransferEncoding
		}
		chunked, ok := singleChunked(teValues[0])
		if !ok || !chunked {
			return nil, ErrBadTransferEncoding
		}
		haveChunked = true
	}

	if haveLength && haveChunked {
		return nil, ErrBothFramings
	}

	d := &Decoder{
		limits:   limits,
		trailers: Header{},
	}
	switch {
	case haveChunked:
		d.framing = FramingChunked
		d.state = stateChunkLine
	case haveLength:
		d.framing = FramingContentLength
		d.state = stateFixed
		d.remaining = length
		if length == 0 {
			d.state = stateDone
			d.completed = true
		}
	default:
		d.framing = FramingNone
		d.state = stateDone
		d.completed = true
	}
	return d, nil
}

// parseContentLength enforces the canonical form: one or more decimal
// digits, no leading/trailing whitespace, no sign, no comma list, no
// overflow.
func parseContentLength(value string) (int64, error) {
	if value == "" {
		return 0, ErrBadContentLength
	}
	var length int64
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c < '0' || c > '9' {
			return 0, ErrBadContentLength
		}
		digit := int64(c - '0')
		if length > (1<<63-1-digit)/10 {
			return 0, ErrBadContentLength
		}
		length = length*10 + digit
	}
	return length, nil
}

// singleChunked reports whether value is a single transfer-coding token
// equal to "chunked" (case-insensitive), with no parameters and no other
// coding such as identity, gzip or a comma list.
func singleChunked(value string) (bool, bool) {
	if value == "" {
		return false, false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		// A single transfer-coding token: only tchar letters are legal,
		// so any separator (comma, semicolon, whitespace, ...) is rejected.
		if !isTokenChar(c) {
			return false, false
		}
	}
	return strings.EqualFold(value, "chunked"), true
}
