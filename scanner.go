package dataeng

import "bytes"

type scanState uint8

const (
	stFieldStart scanState = iota
	stUnquoted
	stQuoted
	stAfterQuote
	stError
	stComment
)

type tokenMatcher struct {
	pat  []byte
	fail []int
	k    int
}

func newTokenMatcher(pat []byte) *tokenMatcher {
	m := &tokenMatcher{pat: append([]byte(nil), pat...)}
	if len(pat) == 0 {
		return m
	}
	m.fail = make([]int, len(pat))
	for i := 1; i < len(pat); i++ {
		j := m.fail[i-1]
		for j > 0 && pat[i] != pat[j] {
			j = m.fail[j-1]
		}
		if pat[i] == pat[j] {
			j++
		}
		m.fail[i] = j
	}
	return m
}

func (m *tokenMatcher) reset() { m.k = 0 }

func (m *tokenMatcher) feed(b byte) bool {
	if len(m.pat) == 0 {
		return false
	}
	for m.k > 0 && m.pat[m.k] != b {
		m.k = m.fail[m.k-1]
	}
	if m.pat[m.k] == b {
		m.k++
	}
	if m.k == len(m.pat) {
		m.k = 0
		return true
	}
	return false
}

// scanner splits the byte stream into physical/logical records. It deliberately
// keeps only the current record. When a record grows beyond MaxRecordSize it
// stops retaining bytes, but the quote/delimiter/newline state machine keeps
// running until the next reliable boundary.
type scanner struct {
	cfg   Config
	delim []byte
	quote []byte

	delimMatcher *tokenMatcher
	quoteMatcher *tokenMatcher

	recBuf     []byte
	recLen     int64
	recStart   int64
	recLine    int
	recStarted bool
	commenting bool
	truncated  bool
	recordErr  error

	state      scanState
	qPref      int
	after      []byte
	afterStart int64

	pendingCR    bool
	pendingCROff int64
	commentHeld  []byte

	line  int
	total int64
	done  bool

	out []*Record
}

func newScanner(cfg Config) (*scanner, error) {
	cfg = cfg.Sanitized()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &scanner{
		cfg:          cfg,
		delim:        cfg.Delimiter,
		quote:        cfg.Quote,
		delimMatcher: newTokenMatcher(cfg.Delimiter),
		quoteMatcher: newTokenMatcher(cfg.Quote),
		line:         1,
	}, nil
}

func (s *scanner) feed(data []byte) ([]*Record, error) {
	if s.done {
		return nil, nil
	}
	for _, b := range data {
		s.consume(b, true)
	}
	return s.take(), nil
}

// finish flushes the final record at EOF.
func (s *scanner) finish() ([]*Record, error) {
	if s.done {
		return s.take(), nil
	}
	s.done = true

	// A comment prefix that was still being matched is ordinary content.
	s.flushCommentHeld()

	if s.pendingCR {
		if s.state == stComment {
			s.pendingCR = false
		} else {
			s.consumeCR()
			s.pendingCR = false
		}
	}

	switch s.state {
	case stAfterQuote:
		if len(s.after) != 0 {
			if !s.cfg.LazyQuotes {
				s.setRecordErr(s.cfg, s.afterStart, ErrQuote)
			}
			s.appendRaw(s.after)
			s.after = s.after[:0]
		}
	case stQuoted:
		if !s.cfg.LazyQuotes {
			s.setRecordErrAtEnd(s.cfg, ErrQuote)
		}
	case stComment:
		s.commenting = true
	case stError:
		// The error was already recorded when we entered recovery mode.
	}

	if s.recStarted {
		s.emitRecord(s.total, s.line, s.total)
		s.resetRecord()
	}
	return s.take(), nil
}

func (s *scanner) take() []*Record {
	out := s.out
	s.out = nil
	return out
}

func (s *scanner) consume(b byte, allowComment bool) {
	off := s.total
	s.total++

	if !s.recStarted {
		s.recStarted = true
		s.recStart = off
		s.recLine = s.line
	}

	if s.pendingCR {
		if b == '\n' {
			s.emitBoundary(s.pendingCROff)
			return
		}
		if s.state == stComment {
			s.pendingCR = false
		} else {
			s.consumeCR()
			s.pendingCR = false
		}
	}

	if allowComment && len(s.cfg.Comment) != 0 && s.state == stFieldStart && s.recLen == 0 {
		s.commentHeld = append(s.commentHeld, b)
		if hasPrefix(s.cfg.Comment, s.commentHeld) {
			if bytesEqual(s.commentHeld, s.cfg.Comment) {
				s.commentHeld = s.commentHeld[:0]
				s.commenting = true
				s.state = stComment
			}
			return
		}
		held := append([]byte(nil), s.commentHeld...)
		s.commentHeld = s.commentHeld[:0]
		// These bytes were already counted when they arrived. Rewind the
		// absolute offset before replaying them so positions stay exact.
		s.total -= int64(len(held))
		for _, hb := range held {
			s.consume(hb, false)
		}
		return
	}

	switch s.state {
	case stComment:
		if b == '\n' {
			s.emitBoundary(off)
			return
		}
		if b == '\r' {
			s.pendingCR = true
			s.pendingCROff = off
		}
		return

	case stQuoted:
		s.appendByte(b)
		if b == '\n' {
			s.line++
		}
		if s.quoteMatcher.feed(b) {
			s.state = stAfterQuote
			s.after = s.after[:0]
		}
		return

	case stAfterQuote:
		if len(s.after) == 0 {
			s.afterStart = off
		}
		s.after = append(s.after, b)
		s.classifyAfter(off)
		return

	case stError:
		if b == '\n' {
			s.emitBoundary(off)
			return
		}
		if b == '\r' {
			s.pendingCR = true
			s.pendingCROff = off
			return
		}
		s.appendByte(b)
		return

	default: // stFieldStart or stUnquoted
		if b == '\n' {
			s.emitBoundary(off)
			return
		}
		if b == '\r' {
			s.pendingCR = true
			s.pendingCROff = off
			return
		}
		s.consumeOutside(b)
	}
}

func (s *scanner) consumeOutside(b byte) {
	switch s.state {
	case stFieldStart:
		if s.cfg.TrimLeadingSpace && (b == ' ' || b == '\t') && s.qPref == 0 {
			s.appendByte(b)
			return
		}
		if s.qPref < len(s.quote) && b == s.quote[s.qPref] {
			s.qPref++
			s.appendByte(b)
			if s.qPref == len(s.quote) {
				s.qPref = 0
				s.state = stQuoted
				s.quoteMatcher.reset()
			}
			return
		}
		if s.qPref != 0 {
			// The bytes were a false quote prefix and are ordinary field
			// content. The current byte has to be reconsidered normally.
			s.qPref = 0
		}
		if s.delimMatcher.feed(b) {
			s.appendByte(b)
			s.state = stFieldStart
			s.delimMatcher.reset()
			return
		}
		s.state = stUnquoted
		s.appendByte(b)

	case stUnquoted:
		if len(s.quote) != 0 && b == s.quote[0] && !s.cfg.LazyQuotes {
			s.appendByte(b)
			s.setRecordErr(s.cfg, s.total-1, ErrBareQuote)
			s.state = stError
			s.delimMatcher.reset()
			return
		}
		if s.delimMatcher.feed(b) {
			s.appendByte(b)
			s.state = stFieldStart
			s.delimMatcher.reset()
			return
		}
		s.appendByte(b)
	}
}

func (s *scanner) consumeCR() {
	if s.state == stError {
		s.appendByte('\r')
		return
	}
	s.consumeOutside('\r')
}

func (s *scanner) classifyAfter(off int64) {
	a := s.after

	if b := a[0]; b == '\n' {
		s.emitBoundary(off)
		return
	}
	if bytesEqual(a, []byte{'\r'}) {
		return
	}
	if bytesEqual(a, []byte{'\r', '\n'}) {
		s.emitBoundary(s.afterStart)
		return
	}
	if lf := bytes.IndexByte(a, '\n'); lf >= 0 {
		// The closing quote was followed by an invalid token and then the
		// physical line ended. Keep the invalid bytes for diagnostics, but
		// end recovery at this newline instead of swallowing the next line.
		lineEnd := lf
		if lineEnd > 0 && a[lineEnd-1] == '\r' {
			lineEnd--
		}
		s.appendRaw(a[:lineEnd])
		if !s.cfg.LazyQuotes {
			s.setRecordErr(s.cfg, s.afterStart, ErrQuote)
		}
		s.after = s.after[:0]
		s.emitBoundary(s.afterStart + int64(lineEnd))
		return
	}
	if bytesEqual(a, s.quote) {
		s.appendRaw(a)
		s.after = s.after[:0]
		s.state = stQuoted
		s.quoteMatcher.reset()
		return
	}
	if bytesEqual(a, s.delim) {
		s.appendRaw(a)
		s.after = s.after[:0]
		s.state = stFieldStart
		s.delimMatcher.reset()
		s.qPref = 0
		return
	}
	if hasPrefix(s.quote, a) || hasPrefix(s.delim, a) || hasPrefix([]byte{'\r', '\n'}, a) {
		return
	}

	// A closing quote followed by anything else is malformed.
	if s.cfg.LazyQuotes {
		s.appendRaw(a)
		s.after = s.after[:0]
		s.state = stQuoted
		s.quoteMatcher.reset()
		return
	}
	s.setRecordErr(s.cfg, s.afterStart, ErrQuote)
	s.appendRaw(a)
	s.after = s.after[:0]
	s.state = stError
}

func (s *scanner) appendByte(b byte) {
	s.recLen++
	if s.truncated {
		return
	}
	if s.cfg.MaxRecordSize > 0 && len(s.recBuf)+1 > s.cfg.MaxRecordSize {
		s.truncated = true
		s.recBuf = nil
		return
	}
	s.recBuf = append(s.recBuf, b)
}

func (s *scanner) appendRaw(raw []byte) {
	for _, b := range raw {
		s.appendByte(b)
	}
}

func (s *scanner) emitBoundary(end int64) {
	s.emitRecord(end, s.line, s.total)
	s.line++
	s.resetRecord()
}

func (s *scanner) emitRecord(end int64, endLine int, nextOffset int64) {
	if s.commenting {
		return
	}
	if s.recLen == 0 {
		keep := s.cfg.KeepEmptyLines && !s.cfg.SkipEmptyLines
		if !keep && s.recordErr == nil {
			return
		}
	}

	rec := &Record{
		Start:      s.recStart,
		End:        end,
		Line:       s.recLine,
		EndLine:    endLine,
		nextOffset: nextOffset,
	}
	if s.truncated {
		rec.Err = &ParseError{
			StartLine: s.recLine,
			Line:      endLine,
			Column:    1,
			Offset:    s.recStart,
			Err:       ErrRecordTooLarge,
		}
	} else {
		rec.Raw = append([]byte(nil), s.recBuf...)
		rec = parseRecord(rec, s.cfg, s.recordErr)
	}
	s.out = append(s.out, rec)
}

func (s *scanner) resetRecord() {
	s.recBuf = s.recBuf[:0]
	s.recLen = 0
	s.recStarted = false
	s.commenting = false
	s.truncated = false
	s.recordErr = nil
	s.state = stFieldStart
	s.qPref = 0
	s.after = s.after[:0]
	s.pendingCR = false
	s.commentHeld = s.commentHeld[:0]
	s.delimMatcher.reset()
	s.quoteMatcher.reset()
}

func (s *scanner) flushCommentHeld() {
	if len(s.commentHeld) == 0 {
		return
	}
	held := append([]byte(nil), s.commentHeld...)
	s.commentHeld = s.commentHeld[:0]
	s.total -= int64(len(held))
	for _, b := range held {
		s.consume(b, false)
	}
}

func (s *scanner) setRecordErr(cfg Config, off int64, err error) {
	if s.recordErr != nil {
		return
	}
	s.recordErr = makeParseError(cfg, s.recBuf, s.recStart, s.recLine, int(off-s.recStart), -1, err)
}

func (s *scanner) setRecordErrAtEnd(cfg Config, err error) {
	if s.recordErr != nil {
		return
	}
	s.recordErr = makeParseError(cfg, s.recBuf, s.recStart, s.recLine, int(s.recLen), -1, err)
}

func makeParseError(cfg Config, buf []byte, start int64, startLine int, index int, field int, err error) *ParseError {
	line, column := lineColumn(buf, index, startLine)
	return &ParseError{
		StartLine: startLine,
		Line:      line,
		Column:    column,
		Offset:    start + int64(index),
		Field:     field,
		Err:       err,
	}
}

func lineColumn(buf []byte, index int, startLine int) (line, column int) {
	if index < 0 {
		index = 0
	}
	if index > len(buf) {
		index = len(buf)
	}
	line = startLine
	lineStart := 0
	for i := 0; i < index; i++ {
		if buf[i] == '\n' {
			line++
			lineStart = i + 1
		}
	}
	return line, index - lineStart + 1
}
