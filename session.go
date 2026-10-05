package telemcodec

import (
	"encoding/binary"
	"io"
)

// Session carries decoded-field values across ReadStruct calls so that
// length references remain resolvable after a pause/resume. Its state is
// fully serializable.
type Session struct {
	r    *BitReader
	vals map[string]uint64
}

func NewSession(r *BitReader) *Session {
	return &Session{r: r, vals: map[string]uint64{}}
}

// Reader exposes the underlying bit reader.
func (s *Session) Reader() *BitReader { return s.r }

// ReadStruct decodes fields, remembering every decoded integer value so
// later fields (and later calls) can reference them by name.
func (s *Session) ReadStruct(fields []Field, sink *[]Entry) error {
	return readFields(s.r, fields, sink, s.vals)
}

// SessionState is a serializable snapshot of a Session.
type SessionState struct {
	Reader ReaderState
	Vals   map[string]uint64
}

var sessionMagic = []byte{'T', 'C', 'S', 'S'}

// Snapshot captures the session: reader cursor, cached bytes, bit limit,
// and all decoded values available for length references.
func (s *Session) Snapshot() SessionState {
	vals := make(map[string]uint64, len(s.vals))
	for k, v := range s.vals {
		vals[k] = v
	}
	return SessionState{Reader: s.r.Snapshot(), Vals: vals}
}

// Marshal encodes the session state into a self-contained binary form.
func (st SessionState) Marshal() []byte {
	rb := st.Reader.Marshal()
	out := make([]byte, 0, 4+4+len(rb)+4+len(st.Vals)*16)
	out = append(out, sessionMagic...)
	var tmp [8]byte
	binary.LittleEndian.PutUint32(tmp[:4], uint32(len(rb)))
	out = append(out, tmp[:4]...)
	out = append(out, rb...)
	binary.LittleEndian.PutUint32(tmp[:4], uint32(len(st.Vals)))
	out = append(out, tmp[:4]...)
	for k, v := range st.Vals {
		binary.LittleEndian.PutUint16(tmp[:2], uint16(len(k)))
		out = append(out, tmp[:2]...)
		out = append(out, k...)
		binary.LittleEndian.PutUint64(tmp[:8], v)
		out = append(out, tmp[:8]...)
	}
	return out
}

// UnmarshalSessionState decodes a state produced by SessionState.Marshal.
func UnmarshalSessionState(b []byte) (SessionState, error) {
	if len(b) < 4+4 || string(b[:4]) != string(sessionMagic) {
		return SessionState{}, ErrInvalid
	}
	rlen := int(binary.LittleEndian.Uint32(b[4:8]))
	if rlen < 0 || 8+rlen+4 > len(b) {
		return SessionState{}, ErrInvalid
	}
	rs, err := UnmarshalReaderState(b[8 : 8+rlen])
	if err != nil {
		return SessionState{}, err
	}
	rest := b[8+rlen:]
	n := binary.LittleEndian.Uint32(rest[:4])
	rest = rest[4:]
	vals := make(map[string]uint64, n)
	for i := uint32(0); i < n; i++ {
		if len(rest) < 2 {
			return SessionState{}, ErrInvalid
		}
		nl := int(binary.LittleEndian.Uint16(rest[:2]))
		rest = rest[2:]
		if len(rest) < nl+8 {
			return SessionState{}, ErrInvalid
		}
		name := string(rest[:nl])
		v := binary.LittleEndian.Uint64(rest[nl : nl+8])
		rest = rest[nl+8:]
		vals[name] = v
	}
	if len(rest) != 0 {
		return SessionState{}, ErrInvalid
	}
	return SessionState{Reader: rs, Vals: vals}, nil
}

// ResumeSession rebuilds a Session from a snapshot. src may be nil; see
// Resume for the source semantics.
func ResumeSession(st SessionState, src io.Reader) *Session {
	return &Session{r: Resume(st.Reader, src), vals: st.Vals}
}
