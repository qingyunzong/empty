package norm

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"hash"
	"io"
	"os"
	"path/filepath"
)

// segMeta describes one sorted run of object members spilled to disk.
type segMeta struct {
	File    string `json:"file"` // base name within the segment directory
	Records int    `json:"records"`
	Bytes   int64  `json:"bytes"`
	SHA256  string `json:"sha256"`
}

// segWriter appends length-prefixed (key, keyOffset, value) records,
// sorted by key, to a segment file.
type segWriter struct {
	f   *os.File
	bw  *bufio.Writer
	mw  io.Writer
	h   hash.Hash
	n   int
	err error
}

func newSegWriter(path string) (*segWriter, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	bw := bufio.NewWriter(f)
	return &segWriter{f: f, bw: bw, h: h, mw: io.MultiWriter(bw, h)}, nil
}

func (s *segWriter) writeRecord(key string, keyOff, valLen int64, val io.Reader) error {
	if s.err != nil {
		return s.err
	}
	var tmp [binary.MaxVarintLen64]byte
	wr := func(p []byte) {
		if s.err == nil {
			_, s.err = s.mw.Write(p)
		}
	}
	putU := func(v uint64) {
		m := binary.PutUvarint(tmp[:], v)
		wr(tmp[:m])
	}
	putU(uint64(len(key)))
	wr([]byte(key))
	putU(uint64(keyOff))
	putU(uint64(valLen))
	if s.err == nil {
		_, s.err = io.CopyN(s.mw, val, valLen)
	}
	s.n++
	return s.err
}

func (s *segWriter) close() (*segMeta, error) {
	if s.err == nil {
		s.err = s.bw.Flush()
	}
	if s.err == nil {
		s.err = s.f.Sync()
	}
	cerr := s.f.Close()
	if s.err != nil {
		return nil, s.err
	}
	if cerr != nil {
		return nil, cerr
	}
	st, err := os.Stat(s.f.Name())
	if err != nil {
		return nil, err
	}
	return &segMeta{
		File:    filepath.Base(s.f.Name()),
		Records: s.n,
		Bytes:   st.Size(),
		SHA256:  hex.EncodeToString(s.h.Sum(nil)),
	}, nil
}

// segReader iterates the records of one segment file in order.
type segReader struct {
	f      *os.File
	br     *bufio.Reader
	key    string
	keyOff int64
	valLen int64
	err    error
}

func openSegReader(path string) (*segReader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return &segReader{f: f, br: bufio.NewReader(f)}, nil
}

func (r *segReader) next() bool {
	if r.err != nil {
		return false
	}
	klen, err := binary.ReadUvarint(r.br)
	if err == io.EOF {
		return false
	}
	if err != nil {
		r.err = err
		return false
	}
	buf := make([]byte, klen)
	if _, err := io.ReadFull(r.br, buf); err != nil {
		r.err = err
		return false
	}
	koff, err := binary.ReadUvarint(r.br)
	if err != nil {
		r.err = err
		return false
	}
	vlen, err := binary.ReadUvarint(r.br)
	if err != nil {
		r.err = err
		return false
	}
	r.key = string(buf)
	r.keyOff = int64(koff)
	r.valLen = int64(vlen)
	return true
}

func (r *segReader) close() { r.f.Close() }
