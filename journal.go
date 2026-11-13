package dataeng

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"sync"
	"time"
)

// MemoryJournal is an in-process [Journal]. It is safe for concurrent use but
// does not survive a process crash.
type MemoryJournal struct {
	mu     sync.Mutex
	events []Event
	seq    uint64
}

// NewMemoryJournal returns an empty in-memory journal.
func NewMemoryJournal() *MemoryJournal {
	return &MemoryJournal{}
}

// Append implements Journal.
func (j *MemoryJournal) Append(_ context.Context, event Event) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.seq++
	event.Seq = j.seq
	if event.At.IsZero() {
		event.At = time.Now()
	}
	j.events = append(j.events, cloneEvent(event))
	return nil
}

// Replay implements Journal.
func (j *MemoryJournal) Replay(_ context.Context) ([]Event, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]Event, len(j.events))
	for i := range j.events {
		out[i] = cloneEvent(j.events[i])
	}
	return out, nil
}

func cloneEvent(e Event) Event {
	if e.Output != nil {
		output := make([]OutputRecord, len(e.Output))
		for i, record := range e.Output {
			output[i] = OutputRecord{
				Key:   append([]byte(nil), record.Key...),
				Value: append([]byte(nil), record.Value...),
			}
		}
		e.Output = output
	}
	return e
}

// FileJournal is an append-only [Journal] stored in a checksummed JSON-lines
// file. Every Append is followed by an fsync. A torn final frame left by a
// crash is discarded when the file is reopened.
type FileJournal struct {
	mu     sync.Mutex
	path   string
	file   *os.File
	seq    uint64
	closed bool
}

// OpenFileJournal opens (or creates) a file journal at path.
func OpenFileJournal(path string) (*FileJournal, error) {
	j := &FileJournal{path: path}
	if err := j.open(); err != nil {
		return nil, err
	}
	return j, nil
}

func (j *FileJournal) open() error {
	file, err := os.OpenFile(j.path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("dataeng: open journal: %w", err)
	}
	events, valid, err := readJournal(file)
	if err != nil {
		_ = file.Close()
		return err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return fmt.Errorf("dataeng: stat journal: %w", err)
	}
	if valid < info.Size() {
		if err := file.Truncate(valid); err != nil {
			_ = file.Close()
			return fmt.Errorf("dataeng: truncate torn journal tail: %w", err)
		}
	}
	if _, err := file.Seek(0, 2); err != nil {
		_ = file.Close()
		return fmt.Errorf("dataeng: seek journal: %w", err)
	}
	for _, event := range events {
		if event.Seq > j.seq {
			j.seq = event.Seq
		}
	}
	j.file = file
	return nil
}

// Append implements Journal.
func (j *FileJournal) Append(_ context.Context, event Event) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return errors.New("dataeng: journal is closed")
	}
	j.seq++
	event.Seq = j.seq
	if event.At.IsZero() {
		event.At = time.Now()
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("dataeng: marshal journal event: %w", err)
	}
	frame := make([]byte, 0, len(payload)+10)
	frame = fmt.Appendf(frame, "%08x ", crc32.ChecksumIEEE(payload))
	frame = append(frame, payload...)
	frame = append(frame, '\n')
	if _, err := j.file.Write(frame); err != nil {
		return fmt.Errorf("dataeng: append journal: %w", err)
	}
	if err := j.file.Sync(); err != nil {
		return fmt.Errorf("dataeng: sync journal: %w", err)
	}
	return nil
}

// Replay implements Journal.
func (j *FileJournal) Replay(_ context.Context) ([]Event, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return nil, errors.New("dataeng: journal is closed")
	}
	events, _, err := readJournal(j.file)
	return events, err
}

// Close closes the journal file.
func (j *FileJournal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return nil
	}
	j.closed = true
	return j.file.Close()
}

func readJournal(file *os.File) ([]Event, int64, error) {
	if _, err := file.Seek(0, 0); err != nil {
		return nil, 0, fmt.Errorf("dataeng: seek journal: %w", err)
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, 0, fmt.Errorf("dataeng: read journal: %w", err)
	}
	var (
		events []Event
		offset int
		lineNo int
	)
	for offset < len(data) {
		end := bytes.IndexByte(data[offset:], '\n')
		if end < 0 {
			// Torn final frame: no newline means the write did not complete.
			break
		}
		end += offset
		lineNo++
		event, err := decodeFrame(data[offset:end])
		if err != nil {
			if end+1 >= len(data) {
				break
			}
			return nil, int64(offset), fmt.Errorf("dataeng: journal frame %d: %w", lineNo, err)
		}
		events = append(events, event)
		offset = end + 1
	}
	return events, int64(offset), nil
}

func decodeFrame(line []byte) (Event, error) {
	var event Event
	space := bytes.IndexByte(line, ' ')
	if space != 8 {
		return event, errors.New("malformed frame header")
	}
	var want uint32
	if _, err := fmt.Sscanf(string(line[:space]), "%08x", &want); err != nil {
		return event, fmt.Errorf("malformed checksum: %w", err)
	}
	payload := line[space+1:]
	if got := crc32.ChecksumIEEE(payload); got != want {
		return event, errors.New("checksum mismatch")
	}
	if err := json.Unmarshal(payload, &event); err != nil {
		return event, fmt.Errorf("decode payload: %w", err)
	}
	if event.Kind == "" {
		return event, errors.New("event has no kind")
	}
	return event, nil
}

var _ Journal = (*MemoryJournal)(nil)
var _ Journal = (*FileJournal)(nil)
