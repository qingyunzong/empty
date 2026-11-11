// Package q225 implements the request-body component of an HTTP gateway.
//
// A connection handler parses the request head itself and hands the
// framing header fields to this package together with the remaining wire
// bytes. Two entry points are provided:
//
//   - Decoder is a push-based, backpressure-oriented state machine. The
//     handler calls Decoder.Feed whenever new connection bytes are
//     available. Feed reports the exact number of bytes consumed, so the
//     end of one message never swallows bytes of the next pipelined
//     request, and decoded payload plus trailer fields are returned
//     separately.
//   - BodyReader wraps a Decoder in an idiomatic io.ReadCloser for
//     handlers that prefer streaming. Bytes of a pipelined next request
//     that arrive in the same connection read are exposed through
//     BodyReader.Leftover.
//
// Framing rules are strict. Exactly one of the following is accepted:
// one canonical Content-Length field, or one Transfer-Encoding field whose
// sole token is "chunked". Repeated Content-Length, comma-separated length
// lists, both framings together and any other transfer coding are rejected
// at construction.
//
// In chunked framing the chunk size is one or more hexadecimal digits and
// chunk extensions are parsed as token or quoted-string parameters, so a
// semicolon inside a quoted parameter does not split the extension. Every
// line ending is a strict CRLF; bare CR or LF bytes poison the connection.
// After the zero chunk a bounded trailing section is parsed; trailer fields
// named Content-Length, Transfer-Encoding, Host or Trailer are forbidden.
//
// Every protocol violation is sticky: the decoder or reader becomes
// poisoned and all later calls return an error matching ErrPoisoned, which
// tells the handler to close the connection instead of reusing it.
package q225
