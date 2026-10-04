package scheduler

import (
	"bufio"
	"encoding/json"
	"os"
)

type op string

const (
	opAdd   op = "add"
	opClaim op = "claim"
	opAck   op = "ack"
)

// record is one entry in the append-only log.
type record struct {
	Op       op     `json:"op"`
	ID       string `json:"id"`
	Deadline int64  `json:"deadline,omitempty"`
	Payload  string `json:"payload,omitempty"`
	Gen      int    `json:"gen,omitempty"`
	Expiry   int64  `json:"expiry,omitempty"`
}

// store is an append-only log. Appends land in an in-memory buffer and reach
// the file only on sync, so a crash loses exactly the unsynced tail — which
// is what lets tests inject realistic crashes by discarding the buffer.
type store struct {
	f   *os.File
	buf []byte
}

func openStore(path string) (*store, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &store{f: f}, nil
}

func (s *store) append(rec record) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	s.buf = append(s.buf, b...)
	s.buf = append(s.buf, '\n')
	return nil
}

// sync flushes the buffered records to the file and fsyncs it.
func (s *store) sync() error {
	if len(s.buf) == 0 {
		return nil
	}
	if _, err := s.f.Write(s.buf); err != nil {
		return err
	}
	s.buf = s.buf[:0]
	return s.f.Sync()
}

// replay applies every logged record to apply, in order.
func (s *store) replay(apply func(record) error) error {
	if _, err := s.f.Seek(0, 0); err != nil {
		return err
	}
	sc := bufio.NewScanner(s.f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var rec record
		if err := json.Unmarshal(line, &rec); err != nil {
			return err
		}
		if err := apply(rec); err != nil {
			return err
		}
	}
	return sc.Err()
}

// close drops any unsynced buffered records and closes the file.
func (s *store) close() error {
	s.buf = nil
	return s.f.Close()
}
