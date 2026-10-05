// Package logsplit splits a byte stream into pieces on an unescaped
// delimiter. The delimiter is any non-empty byte string. In the input,
// a backslash literalizes the next byte: neither the backslash nor the
// escaped byte can take part in a delimiter match. A backslash that is
// the last byte of the stream is kept as a literal byte.
//
// Because a backslash in the input always acts as an escape character,
// a delimiter containing a backslash can never match.
//
// Delimiter occurrences that overlap themselves are matched
// left-to-right and non-overlapping: after a match, scanning resumes
// immediately after the matched delimiter.
package logsplit

import "bytes"

// Splitter incrementally splits a byte stream. The zero value is not
// usable; construct one with New.
type Splitter struct {
	delim []byte
	fail  []int // KMP failure function for delim

	escaped bool // previous byte was an unescaped backslash
	matched int  // trailing bytes of piece equal to delim[:matched]
	piece   []byte
}

// New returns a Splitter that splits on delim. It panics if delim is
// empty.
func New(delim []byte) *Splitter {
	if len(delim) == 0 {
		panic("logsplit: empty delimiter")
	}
	s := &Splitter{
		delim: append([]byte(nil), delim...),
		fail:  make([]int, len(delim)),
	}
	for i, k := 1, 0; i < len(delim); i++ {
		for k > 0 && delim[i] != delim[k] {
			k = s.fail[k-1]
		}
		if delim[i] == delim[k] {
			k++
		}
		s.fail[i] = k
	}
	return s
}

// Write feeds p into the splitter and returns the pieces completed by
// these bytes. The returned slices are safe to retain. Bytes not yet
// known to belong to a completed piece are buffered internally.
func (s *Splitter) Write(p []byte) (pieces [][]byte) {
	for _, b := range p {
		s.piece = append(s.piece, b)
		if s.escaped {
			// Literal byte: cannot be part of a delimiter.
			s.escaped = false
			continue
		}
		if b == '\\' {
			// Escape character: literalizes the next byte and
			// breaks any partial delimiter match.
			s.escaped = true
			s.matched = 0
			continue
		}
		for s.matched > 0 && b != s.delim[s.matched] {
			s.matched = s.fail[s.matched-1]
		}
		if b == s.delim[s.matched] {
			s.matched++
			if s.matched == len(s.delim) {
				end := len(s.piece) - len(s.delim)
				pieces = append(pieces, append([]byte(nil), s.piece[:end]...))
				s.piece = s.piece[:0]
				s.matched = 0
			}
		}
	}
	return pieces
}

// Finish ends the stream and returns the final piece. A trailing
// escape state is harmless: the backslash is already part of the
// piece. The Splitter is reset and may be reused.
func (s *Splitter) Finish() []byte {
	piece := s.piece
	s.piece = nil
	s.escaped = false
	s.matched = 0
	return piece
}

// Split splits s on unescaped occurrences of delim, scanning the whole
// input at once. It is the reference for the streaming Splitter: for
// any chunking of the input, feeding the chunks to a Splitter and
// calling Finish yields the same pieces. It panics if delim is empty.
func Split(s, delim []byte) [][]byte {
	if len(delim) == 0 {
		panic("logsplit: empty delimiter")
	}
	var pieces [][]byte
	start := 0
	for i := 0; i < len(s); {
		if s[i] == '\\' {
			i += 2 // backslash and the literalized byte (if any)
			continue
		}
		if bytes.HasPrefix(s[i:], delim) {
			pieces = append(pieces, s[start:i])
			i += len(delim)
			start = i
			continue
		}
		i++
	}
	return append(pieces, s[start:])
}
