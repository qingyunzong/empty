package dedup

import (
	"io"
	"os"
	"path/filepath"
)

// Volume is a durable byte stream with staged writes. Append, Truncate
// and Replace only stage changes; Sync makes all staged changes durable.
// A crash before Sync loses every staged change; a crash after Sync
// preserves all of them.
type Volume interface {
	// ReadAll returns the durable contents.
	ReadAll() ([]byte, error)
	// Append stages an append of p at the end of the stream.
	Append(p []byte) error
	// Truncate stages a truncation to size bytes.
	Truncate(size int64) error
	// Replace stages an atomic replacement of the whole contents.
	Replace(p []byte) error
	// Sync makes all staged changes durable.
	Sync() error
}

type opKind int

const (
	opAppend opKind = iota
	opTruncate
	opReplace
)

type op struct {
	kind opKind
	data []byte
	size int64
}

// MemVolume is an in-memory Volume, useful as the durable medium under
// a FaultVolume in tests.
type MemVolume struct {
	durable []byte
	pending []op
}

// NewMemVolume returns an empty in-memory Volume.
func NewMemVolume() *MemVolume { return &MemVolume{} }

// ReadAll implements Volume.
func (m *MemVolume) ReadAll() ([]byte, error) {
	return append([]byte(nil), m.durable...), nil
}

// Append implements Volume.
func (m *MemVolume) Append(p []byte) error {
	m.pending = append(m.pending, op{kind: opAppend, data: append([]byte(nil), p...)})
	return nil
}

// Truncate implements Volume.
func (m *MemVolume) Truncate(size int64) error {
	m.pending = append(m.pending, op{kind: opTruncate, size: size})
	return nil
}

// Replace implements Volume.
func (m *MemVolume) Replace(p []byte) error {
	m.pending = append(m.pending, op{kind: opReplace, data: append([]byte(nil), p...)})
	return nil
}

// Sync implements Volume.
func (m *MemVolume) Sync() error {
	for _, o := range m.pending {
		switch o.kind {
		case opAppend:
			m.durable = append(m.durable, o.data...)
		case opTruncate:
			switch {
			case o.size < int64(len(m.durable)):
				m.durable = m.durable[:o.size]
			case o.size > int64(len(m.durable)):
				m.durable = append(m.durable, make([]byte, o.size-int64(len(m.durable)))...)
			}
		case opReplace:
			m.durable = append([]byte(nil), o.data...)
		}
	}
	m.pending = nil
	return nil
}

// FileVolume is a Volume backed by a real file. Appends and truncations
// are applied to the file and fsynced at Sync; Replace uses a temporary
// file, rename and a directory fsync so the replacement is atomic.
type FileVolume struct {
	path    string
	f       *os.File
	pending []op
}

// OpenFileVolume opens (or creates) the Volume stored at path.
func OpenFileVolume(path string) (*FileVolume, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	return &FileVolume{path: path, f: f}, nil
}

// Close closes the underlying file.
func (v *FileVolume) Close() error { return v.f.Close() }

// ReadAll implements Volume.
func (v *FileVolume) ReadAll() ([]byte, error) { return os.ReadFile(v.path) }

// Append implements Volume.
func (v *FileVolume) Append(p []byte) error {
	v.pending = append(v.pending, op{kind: opAppend, data: append([]byte(nil), p...)})
	return nil
}

// Truncate implements Volume.
func (v *FileVolume) Truncate(size int64) error {
	v.pending = append(v.pending, op{kind: opTruncate, size: size})
	return nil
}

// Replace implements Volume.
func (v *FileVolume) Replace(p []byte) error {
	v.pending = append(v.pending, op{kind: opReplace, data: append([]byte(nil), p...)})
	return nil
}

// Sync implements Volume.
func (v *FileVolume) Sync() error {
	for _, o := range v.pending {
		switch o.kind {
		case opAppend:
			if _, err := v.f.Seek(0, io.SeekEnd); err != nil {
				return err
			}
			if _, err := v.f.Write(o.data); err != nil {
				return err
			}
		case opTruncate:
			if err := v.f.Truncate(o.size); err != nil {
				return err
			}
		case opReplace:
			if err := v.replaceAll(o.data); err != nil {
				return err
			}
		}
	}
	v.pending = nil
	return v.f.Sync()
}

// replaceAll atomically replaces the file contents via write-to-temp,
// fsync, rename and directory fsync.
func (v *FileVolume) replaceAll(p []byte) error {
	tmp := v.path + ".tmp"
	tf, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := tf.Write(p); err != nil {
		tf.Close()
		return err
	}
	if err := tf.Sync(); err != nil {
		tf.Close()
		return err
	}
	if err := tf.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, v.path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(v.path))
	if err != nil {
		return err
	}
	if err := dir.Sync(); err != nil {
		dir.Close()
		return err
	}
	dir.Close()
	if err := v.f.Close(); err != nil {
		return err
	}
	f, err := os.OpenFile(v.path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	v.f = f
	return nil
}
