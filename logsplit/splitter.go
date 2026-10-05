// Package logsplit splits a byte stream into records separated by a
// delimiter, with backslash escaping.
//
// Semantics:
//   - The delimiter is any non-empty byte string. It is matched against
//     the stream left to right and non-overlapping, so a self-overlapping
//     delimiter such as "aa" splits "aaa" into ["", "a"].
//   - A backslash (\) literalizes the next byte: the pair is replaced by
//     that byte, which is treated as plain data and can never take part
//     in a delimiter match. "\\" therefore yields a single literal
//     backslash, and "\<delim>" embeds the delimiter in the record.
//   - Escape state persists across Write calls: if a chunk ends with a
//     backslash, the first byte of the next chunk is literalized
//     ("block-tail escape keeps the unfinished state").
//   - Records contain unescaped content; the delimiter itself is not
//     part of any record.
//   - Because a raw backslash is always consumed as an escape
//     introducer, a delimiter containing '\' can never match.
//   - Finish flushes the trailing partial input as the final record. A
//     dangling trailing backslash is preserved as a literal backslash.
package logsplit

// Splitter incrementally splits a byte stream into records.
type Splitter struct {
	delim []byte
	fail  []int // KMP prefix function, fail[i] for prefix length i

	pending  []byte // unescaped bytes of the current record
	matchLen int    // delimiter prefix bytes currently held as a candidate match
	escaped  bool   // previous byte was an escape-introducing backslash

	out      [][]byte // completed records awaiting Drain
	finished bool
}

// NewSplitter returns a Splitter using delim as the record delimiter.
// It panics if delim is empty.
func NewSplitter(delim []byte) *Splitter {
	if len(delim) == 0 {
		panic("logsplit: empty delimiter")
	}
	d := make([]byte, len(delim))
	copy(d, delim)
	return &Splitter{delim: d, fail: prefixFunc(d)}
}

// prefixFunc computes the KMP prefix function: f[i] is the length of the
// longest proper prefix of p[:i] that is also a suffix of p[:i].
func prefixFunc(p []byte) []int {
	f := make([]int, len(p)+1)
	for i := 1; i < len(p); i++ {
		j := f[i]
		for j > 0 && p[i] != p[j] {
			j = f[j]
		}
		if p[i] == p[j] {
			j++
		}
		f[i+1] = j
	}
	return f
}

// Write feeds one chunk of the stream. Chunk boundaries are irrelevant to
// the result; in particular a trailing backslash keeps the escape state
// for the next chunk. Completed records can be retrieved with Drain.
func (s *Splitter) Write(p []byte) {
	if s.finished {
		panic("logsplit: Write after Finish")
	}
	for _, b := range p {
		s.feed(b)
	}
}

func (s *Splitter) feed(b byte) {
	if s.escaped {
		// Literalized byte: plain data, never part of a delimiter.
		s.escaped = false
		s.pending = append(s.pending, b)
		return
	}
	if b == '\\' {
		// Escape introducer. Any candidate match in progress is broken;
		// its held bytes are plain data.
		s.flushMatch()
		s.escaped = true
		return
	}
	for {
		if b == s.delim[s.matchLen] {
			s.matchLen++
			if s.matchLen == len(s.delim) {
				s.matchLen = 0
				s.out = append(s.out, s.takeRecord())
			}
			return
		}
		if s.matchLen == 0 {
			s.pending = append(s.pending, b)
			return
		}
		// Mismatch: fall back along the prefix function. The bytes that
		// stop being part of the candidate match become record data.
		k := s.fail[s.matchLen]
		s.pending = append(s.pending, s.delim[:s.matchLen-k]...)
		s.matchLen = k
	}
}

// flushMatch releases the bytes held by an incomplete candidate match.
func (s *Splitter) flushMatch() {
	s.pending = append(s.pending, s.delim[:s.matchLen]...)
	s.matchLen = 0
}

func (s *Splitter) takeRecord() []byte {
	r := make([]byte, len(s.pending))
	copy(r, s.pending)
	s.pending = s.pending[:0]
	return r
}

// Drain returns the records completed so far and removes them from the
// splitter. The returned slice is safe to keep.
func (s *Splitter) Drain() [][]byte {
	r := s.out
	s.out = nil
	return r
}

// Finish signals the end of the stream and returns the final record,
// which may be empty. A dangling trailing backslash is preserved as a
// literal backslash. The splitter must not be used afterwards.
func (s *Splitter) Finish() []byte {
	if s.finished {
		panic("logsplit: Finish called twice")
	}
	s.finished = true
	s.flushMatch()
	if s.escaped {
		s.escaped = false
		s.pending = append(s.pending, '\\')
	}
	return s.takeRecord()
}

// Split is a convenience wrapper that splits data in one shot. The number
// of returned records equals the number of delimiter occurrences plus
// one, mirroring strings.Split.
func Split(data, delim []byte) [][]byte {
	s := NewSplitter(delim)
	s.Write(data)
	recs := s.Drain()
	return append(recs, s.Finish())
}
