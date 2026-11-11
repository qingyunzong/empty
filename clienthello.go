package q270

import (
	"errors"
	"fmt"
)

// TLS record layer constants (RFC 8446, RFC 5246).
const (
	recordHeaderLen          = 5
	recordTypeHandshake      = 22
	handshakeHeaderLen       = 4
	handshakeTypeClientHello = 1
	extServerName            = 0
	extALPN                  = 16
	sniHostName              = 0
)

// Default budgets applied when the corresponding Config field is left zero.
const (
	// DefaultMaxHandshakeMessage bounds a single handshake message body
	// (the 3-byte handshake length field).
	DefaultMaxHandshakeMessage = 64 * 1024
	// DefaultMaxBuffered bounds the total wire bytes a Reader holds while
	// waiting for a complete ClientHello.
	DefaultMaxBuffered = 128 * 1024
)

// Sentinel errors returned by the reader. Use errors.Is to match them.
var (
	// ErrShortBuffer is returned internally when more wire bytes are needed;
	// Feed translates it into a (nil, nil) result and never surfaces it.
	ErrShortBuffer = errors.New("q270: incomplete TLS data, more bytes required")
	// ErrLengthOutOfBounds indicates a nested length field runs past the
	// enclosing structure or has an invalid shape.
	ErrLengthOutOfBounds = errors.New("q270: length field exceeds enclosing structure")
	// ErrDuplicateExtension indicates an extension type appears more than once
	// in the ClientHello extension block.
	ErrDuplicateExtension = errors.New("q270: duplicate TLS extension")
	// ErrMessageTooLarge indicates a configured byte budget was exceeded.
	ErrMessageTooLarge = errors.New("q270: handshake message exceeds configured budget")
	// ErrUnexpectedRecord indicates a non-handshake record appeared before the
	// ClientHello was fully read.
	ErrUnexpectedRecord = errors.New("q270: unexpected TLS record type before ClientHello")
	// ErrUnexpectedHandshake indicates the first handshake message is not a
	// ClientHello.
	ErrUnexpectedHandshake = errors.New("q270: first handshake message is not ClientHello")
	// ErrInvalidClientHello indicates a well-bounded but semantically invalid
	// ClientHello structure.
	ErrInvalidClientHello = errors.New("q270: malformed ClientHello")
	// ErrAlreadyRead indicates Feed was called after a ClientHello had already
	// been validated and consumed.
	ErrAlreadyRead = errors.New("q270: ClientHello already consumed")
)

// ClientHelloInfo carries the parsed, protocol-only view of a ClientHello.
// No decryption is performed and no key material is derived.
type ClientHelloInfo struct {
	// SessionID is the raw session identifier (0..32 bytes in practice).
	SessionID []byte
	// CipherSuites is the ordered list of offered cipher suite identifiers.
	CipherSuites []uint16
	// CompressionMethods is the ordered list of offered compression methods.
	CompressionMethods []uint8
	// ExtensionsLength is the declared byte length of the extension block.
	ExtensionsLength int
	// ServerName is the unique SNI host name, or "" when absent.
	ServerName string
	// ALPN is the ordered application-layer protocol name list.
	ALPN []string
	// Raw is the exact, contiguous slice of wire bytes consumed for this
	// ClientHello (record headers and payloads alike), retained for downstream
	// replay. It is an owned copy and stays valid after later Feed calls.
	Raw []byte
}

// Router is invoked exactly once, only after an entire ClientHello has been
// fully validated. Raw is already an owned copy safe to retain.
type Router interface {
	RouteClientHello(info ClientHelloInfo)
}

// RouterFunc adapts a plain function to the Router interface.
type RouterFunc func(info ClientHelloInfo)

// RouteClientHello implements Router.
func (f RouterFunc) RouteClientHello(info ClientHelloInfo) { f(info) }

// Config configures a Reader. Zero values select the documented defaults.
type Config struct {
	// MaxHandshakeMessage bounds a single handshake message body in bytes.
	MaxHandshakeMessage int
	// MaxBuffered bounds the total wire bytes buffered across Feed calls
	// before a complete ClientHello is available.
	MaxBuffered int
	// Router receives the validated ClientHello. A nil Router turns the
	// Reader into a pure parser.
	Router Router
}

// Reader incrementally parses a TLS record stream until the first ClientHello
// is fully validated. Feed is intended for sequential use only.
type Reader struct {
	maxMessage  int
	maxBuffered int
	router      Router

	buf  []byte
	done bool
}

// NewReader creates a Reader with the given configuration, applying defaults
// to zero-valued budget fields.
func NewReader(cfg Config) *Reader {
	if cfg.MaxHandshakeMessage <= 0 {
		cfg.MaxHandshakeMessage = DefaultMaxHandshakeMessage
	}
	if cfg.MaxBuffered <= 0 {
		cfg.MaxBuffered = DefaultMaxBuffered
	}
	return &Reader{
		maxMessage:  cfg.MaxHandshakeMessage,
		maxBuffered: cfg.MaxBuffered,
		router:      cfg.Router,
	}
}

// Feed appends a wire chunk to the internal stream and parses as far as
// possible. It returns (nil, nil) while the ClientHello is still incomplete,
// a non-nil info once a full ClientHello has been validated, or a non-nil
// error on any protocol violation. The Router is invoked only on the fully
// validated success path, immediately before the result is returned.
//
// Consumed bytes are preserved in ClientHelloInfo.Raw for replay; every
// unconsumed trailing byte (partial records, further handshake messages,
// subsequent records) remains available via Unconsumed.
func (r *Reader) Feed(chunk []byte) (*ClientHelloInfo, error) {
	if r.done {
		return nil, ErrAlreadyRead
	}
	r.buf = append(r.buf, chunk...)
	if len(r.buf) > r.maxBuffered {
		return nil, fmt.Errorf("%w: buffered %d bytes", ErrMessageTooLarge, len(r.buf))
	}

	info, consumed, err := parseClientHello(r.buf, r.maxMessage)
	if err != nil {
		if errors.Is(err, ErrShortBuffer) {
			return nil, nil
		}
		return nil, err
	}

	r.buf = r.buf[consumed:]
	r.done = true
	if r.router != nil {
		r.router.RouteClientHello(info)
	}
	return &info, nil
}

// Unconsumed returns the buffered wire bytes not yet consumed by a validated
// ClientHello. The returned slice aliases the internal buffer and must not be
// modified.
func (r *Reader) Unconsumed() []byte {
	return r.buf
}

// parseClientHello parses the first ClientHello out of a contiguous TLS record
// stream. It returns the parsed info and the number of wire bytes consumed.
// ErrShortBuffer signals that b does not yet contain the full message.
//
// A handshake message may span several records and a single record may carry
// several messages; both layouts are handled by reassembling the handshake
// byte stream out of record payloads before parsing the message body.
func parseClientHello(b []byte, maxMessage int) (ClientHelloInfo, int, error) {
	var (
		info        ClientHelloInfo
		pos         int
		firstRecord = -1
		hdr         [handshakeHeaderLen]byte
		hdrLen      int
		msgLen      int
		body        []byte
	)

	for {
		if len(b)-pos < recordHeaderLen {
			return info, 0, ErrShortBuffer
		}
		recType := b[pos]
		recLen := int(b[pos+3])<<8 | int(b[pos+4])
		recEnd := pos + recordHeaderLen + recLen
		if recEnd > len(b) {
			return info, 0, ErrShortBuffer
		}
		if firstRecord == -1 {
			firstRecord = pos
		}
		if recType != recordTypeHandshake {
			return info, 0, fmt.Errorf("%w: record type %d", ErrUnexpectedRecord, recType)
		}

		payload := b[pos+recordHeaderLen : recEnd]
		off := 0
		for off < len(payload) {
			if hdrLen < handshakeHeaderLen {
				// The 4-byte handshake header may itself straddle a record.
				take := min(handshakeHeaderLen-hdrLen, len(payload)-off)
				copy(hdr[hdrLen:], payload[off:off+take])
				hdrLen += take
				off += take
				if hdrLen == handshakeHeaderLen {
					if hdr[0] != handshakeTypeClientHello {
						return info, 0, fmt.Errorf("%w: handshake type %d",
							ErrUnexpectedHandshake, hdr[0])
					}
					msgLen = int(hdr[1])<<16 | int(hdr[2])<<8 | int(hdr[3])
					if msgLen > maxMessage {
						return info, 0, fmt.Errorf("%w: message length %d",
							ErrMessageTooLarge, msgLen)
					}
				}
				continue
			}

			need := msgLen - len(body)
			take := min(need, len(payload)-off)
			body = append(body, payload[off:off+take]...)
			off += take

			if len(body) == msgLen {
				parsed, err := parseClientHelloBody(body)
				if err != nil {
					return info, 0, err
				}
				consumed := pos + recordHeaderLen + off
				// Owned copy: stays replayable after the Reader reslices its buffer.
				parsed.Raw = append([]byte(nil), b[firstRecord:consumed]...)
				return parsed, consumed, nil
			}
		}
		pos = recEnd
	}
}

// parseClientHelloBody parses the ClientHello handshake body (the handshake
// header is already consumed) and validates every nested length field against
// its enclosing structure.
func parseClientHelloBody(body []byte) (ClientHelloInfo, error) {
	info := ClientHelloInfo{}
	const fixedPrefix = 2 + 32 // client_version + random
	if len(body) < fixedPrefix+1 {
		return info, fmt.Errorf("%w: body shorter than session_id length", ErrLengthOutOfBounds)
	}
	p := fixedPrefix

	sidLen := int(body[p])
	p++
	if p+sidLen > len(body) {
		return info, fmt.Errorf("%w: session_id", ErrLengthOutOfBounds)
	}
	info.SessionID = append([]byte(nil), body[p:p+sidLen]...)
	p += sidLen

	if p+2 > len(body) {
		return info, fmt.Errorf("%w: cipher_suites length", ErrLengthOutOfBounds)
	}
	csLen := int(be16(body[p:]))
	p += 2
	if csLen%2 != 0 {
		return info, fmt.Errorf("%w: odd cipher_suites length %d", ErrInvalidClientHello, csLen)
	}
	if p+csLen > len(body) {
		return info, fmt.Errorf("%w: cipher_suites", ErrLengthOutOfBounds)
	}
	info.CipherSuites = make([]uint16, csLen/2)
	for i := range info.CipherSuites {
		info.CipherSuites[i] = be16(body[p:])
		p += 2
	}

	if p+1 > len(body) {
		return info, fmt.Errorf("%w: compression_methods length", ErrLengthOutOfBounds)
	}
	cmLen := int(body[p])
	p++
	if p+cmLen > len(body) {
		return info, fmt.Errorf("%w: compression_methods", ErrLengthOutOfBounds)
	}
	info.CompressionMethods = append([]uint8(nil), body[p:p+cmLen]...)
	p += cmLen

	// Extensions are optional in TLS 1.2 but must exactly fill the remainder.
	if p < len(body) {
		if p+2 > len(body) {
			return info, fmt.Errorf("%w: extensions length", ErrLengthOutOfBounds)
		}
		extLen := int(be16(body[p:]))
		p += 2
		if p+extLen != len(body) {
			return info, fmt.Errorf("%w: extensions block", ErrLengthOutOfBounds)
		}
		info.ExtensionsLength = extLen
		if err := parseExtensions(body[p:p+extLen], &info); err != nil {
			return info, err
		}
		p += extLen
	}
	if p != len(body) {
		return info, fmt.Errorf("%w: trailing ClientHello bytes", ErrLengthOutOfBounds)
	}
	return info, nil
}
