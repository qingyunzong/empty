package logparse

import "bytes"

// Stream parses input fed in arbitrary chunks. Physical lines are delimited
// by '\n'. A line that spans multiple chunks keeps the Config that was
// active when its first byte arrived: SetConfig (hot reload) only affects
// lines that start afterwards.
type Stream struct {
	cfg       *Config
	buf       []byte
	started   bool    // buf holds bytes of an unfinished line
	lineCfg   *Config // config captured when the current line started
	lineStart int     // absolute offset of the current line start
	abs       int     // absolute offset of the next byte to be appended
}

// NewStream creates a Stream using cfg (nil is allowed).
func NewStream(cfg *Config) *Stream { return &Stream{cfg: cfg} }

// SetConfig hot-reloads the configuration. Lines already started (buffered
// across chunks) still finish under the old rules; only lines beginning
// after this call use cfg.
func (s *Stream) SetConfig(cfg *Config) { s.cfg = cfg }

// Feed consumes a chunk and returns every line completed by it.
func (s *Stream) Feed(chunk []byte) []Line {
	var out []Line
	for len(chunk) > 0 {
		idx := bytes.IndexByte(chunk, '\n')
		if idx < 0 {
			s.append(chunk)
			break
		}
		s.append(chunk[:idx])
		s.abs++ // consume the newline itself
		out = append(out, s.emit())
		chunk = chunk[idx+1:]
	}
	return out
}

// Close flushes a trailing unterminated line, if any.
func (s *Stream) Close() []Line {
	if !s.started {
		return nil
	}
	return []Line{s.emit()}
}

func (s *Stream) append(p []byte) {
	if len(p) > 0 && !s.started {
		s.started = true
		s.lineCfg = s.cfg
		s.lineStart = s.abs
	}
	s.buf = append(s.buf, p...)
	s.abs += len(p)
}

func (s *Stream) emit() Line {
	cfg := s.lineCfg
	if !s.started {
		// Empty line: it "starts" at the newline, so the current config applies.
		cfg = s.cfg
		s.lineStart = s.abs
	}
	l := parseLine(string(s.buf), cfg, s.lineStart)
	s.buf = s.buf[:0]
	s.started = false
	s.lineCfg = nil
	return l
}

// ParseText parses a whole string as a stream of physical lines.
func ParseText(text string, cfg *Config) []Line {
	s := NewStream(cfg)
	lines := s.Feed([]byte(text))
	return append(lines, s.Close()...)
}
