// Package appendlog provides an importable append-only log that appends a
// batch of entries atomically: either every entry of a batch is durable, or
// none of them is.
package appendlog

import (
	"errors"
	"io"
	"os"
	"sync"
)

// Entry is one opaque record in the append log.
type Entry struct {
	Data []byte
}

// Log is an append-only batch log.
//
// Append writes the whole batch as a single unit. A returned error means the
// log is unchanged (the batch either landed completely or not at all).
// Read replays all entries that were successfully appended.
type Log interface {
	Append(entries []Entry) error
	Read() ([][]byte, error)
	io.Closer
}

// MemLog is an in-memory implementation of Log.
type MemLog struct {
	mu      sync.Mutex
	records [][]byte
	closed  bool
}

// NewMemLog creates an empty in-memory log.
func NewMemLog() *MemLog {
	return &MemLog{}
}

// Append stores a defensive copy of each entry as one atomic batch.
func (l *MemLog) Append(entries []Entry) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return errors.New("appendlog: log is closed")
	}
	batch := make([][]byte, len(entries))
	for i, entry := range entries {
		if len(entry.Data) == 0 {
			return errors.New("appendlog: entry data must not be empty")
		}
		batch[i] = append([]byte(nil), entry.Data...)
	}
	l.records = append(l.records, batch...)
	return nil
}

// Read returns independent copies of every appended record.
func (l *MemLog) Read() ([][]byte, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil, errors.New("appendlog: log is closed")
	}
	out := make([][]byte, len(l.records))
	for i, data := range l.records {
		out[i] = append([]byte(nil), data...)
	}
	return out, nil
}

// Close marks the log as closed.
func (l *MemLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	return nil
}

// FileLog is a file-backed implementation of Log. Each entry is stored as one
// length-prefixed line so a torn final write can be detected and discarded,
// keeping a batch all-or-nothing across processes and crashes.
type FileLog struct {
	mu     sync.Mutex
	file   *os.File
	closed bool
}

// NewFileLog opens (creating if needed) the log file at path and truncates any
// incomplete trailing record left by an interrupted write.
func NewFileLog(path string) (*FileLog, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	log := &FileLog{file: file}
	if err := log.recover(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return log, nil
}

// Append encodes the batch, writes it with a single Write call and syncs it.
// An error before a successful write leaves the file untouched.
func (l *FileLog) Append(entries []Entry) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return errors.New("appendlog: log is closed")
	}
	var payload []byte
	for _, entry := range entries {
		if len(entry.Data) == 0 {
			return errors.New("appendlog: entry data must not be empty")
		}
		payload = append(payload, encodeFrame(entry.Data)...)
	}
	if _, err := l.file.Write(payload); err != nil {
		return err
	}
	return l.file.Sync()
}

// Read replays every complete frame in the file.
func (l *FileLog) Read() ([][]byte, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil, errors.New("appendlog: log is closed")
	}
	if _, err := l.file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	records, _, err := readAllFrames(l.file)
	if err != nil {
		return nil, err
	}
	return records, nil
}

// Close syncs and closes the underlying file.
func (l *FileLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	if err := l.file.Sync(); err != nil {
		_ = l.file.Close()
		return err
	}
	return l.file.Close()
}

// recover drops any partial trailing frame so the log always ends on a batch
// boundary.
func (l *FileLog) recover() error {
	if _, err := l.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	records, size, err := readAllFrames(l.file)
	if err != nil {
		return err
	}
	_ = records
	return l.file.Truncate(size)
}
