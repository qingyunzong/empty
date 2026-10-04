// Package filetrace records file-interface calls (arguments, return values
// and persistence points) into a trace, replays traces with strict
// item-by-item matching, supports crash injection at the k-th persistence
// point without disturbing already-persisted bytes, and saves snapshots so
// that segmented replay can be proven equivalent to a full run.
package filetrace

import (
	"errors"
	"io"
)

// ErrClosed is returned by operations on a closed MemFile.
var ErrClosed = errors.New("filetrace: file closed")

// MemFile is a simulated file with volatile contents and durable
// (persisted) bytes. Sync is a persistence point; Crash models a power
// failure that discards volatile state but never touches persisted bytes.
type MemFile struct {
	data    []byte // volatile contents
	durable []byte // persisted contents
	off     int64
	closed  bool
}

// NewMemFile returns an empty MemFile.
func NewMemFile() *MemFile { return &MemFile{} }

func (f *MemFile) Write(p []byte) (int, error) {
	if f.closed {
		return 0, ErrClosed
	}
	end := f.off + int64(len(p))
	if end > int64(len(f.data)) {
		grown := make([]byte, end)
		copy(grown, f.data)
		f.data = grown
	}
	copy(f.data[f.off:], p)
	f.off = end
	return len(p), nil
}

func (f *MemFile) Read(p []byte) (int, error) {
	if f.closed {
		return 0, ErrClosed
	}
	if f.off >= int64(len(f.data)) {
		return 0, io.EOF
	}
	n := copy(p, f.data[f.off:])
	f.off += int64(n)
	return n, nil
}

func (f *MemFile) Seek(offset int64, whence int) (int64, error) {
	if f.closed {
		return 0, ErrClosed
	}
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = f.off + offset
	case io.SeekEnd:
		abs = int64(len(f.data)) + offset
	default:
		return 0, errors.New("filetrace: invalid whence")
	}
	if abs < 0 {
		return 0, errors.New("filetrace: negative position")
	}
	f.off = abs
	return abs, nil
}

// Sync is a persistence point: volatile contents become durable.
func (f *MemFile) Sync() error {
	if f.closed {
		return ErrClosed
	}
	f.durable = append([]byte(nil), f.data...)
	return nil
}

func (f *MemFile) Close() error {
	f.closed = true
	return nil
}

// Crash simulates a power failure: volatile state is reset to the last
// persisted state. Already-persisted bytes are left untouched.
func (f *MemFile) Crash() {
	f.data = append([]byte(nil), f.durable...)
	f.off = 0
	f.closed = false
}

// Data returns a copy of the volatile contents.
func (f *MemFile) Data() []byte { return append([]byte(nil), f.data...) }

// Durable returns a copy of the persisted bytes.
func (f *MemFile) Durable() []byte { return append([]byte(nil), f.durable...) }

// Offset returns the current file offset.
func (f *MemFile) Offset() int64 { return f.off }
