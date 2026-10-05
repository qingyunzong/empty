// Package fileadapter provides page-oriented random access to a single
// data file. Pages are fixed size and addressed by page ID; reads beyond
// the end of the file return zero-filled pages.
package fileadapter

import (
	"fmt"
	"io"
	"os"
)

const PageSize = 4096

// FileAdapter maps page IDs to fixed-size blocks of an underlying file.
type FileAdapter struct {
	f *os.File
}

// Open opens (or creates) the file at path for page IO.
func Open(path string) (*FileAdapter, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, fmt.Errorf("fileadapter: open %s: %w", path, err)
	}
	return &FileAdapter{f: f}, nil
}

// ReadPage reads page id into buf. buf must be at least PageSize bytes.
// Pages never written read back as zeros.
func (a *FileAdapter) ReadPage(id uint64, buf []byte) error {
	if len(buf) < PageSize {
		return fmt.Errorf("fileadapter: buffer too small: %d", len(buf))
	}
	n, err := a.f.ReadAt(buf[:PageSize], int64(id)*PageSize)
	if err != nil && err != io.EOF {
		return fmt.Errorf("fileadapter: read page %d: %w", id, err)
	}
	for i := n; i < PageSize; i++ {
		buf[i] = 0
	}
	return nil
}

// WritePage writes the first PageSize bytes of buf to page id.
func (a *FileAdapter) WritePage(id uint64, buf []byte) error {
	if len(buf) < PageSize {
		return fmt.Errorf("fileadapter: buffer too small: %d", len(buf))
	}
	if _, err := a.f.WriteAt(buf[:PageSize], int64(id)*PageSize); err != nil {
		return fmt.Errorf("fileadapter: write page %d: %w", id, err)
	}
	return nil
}

// Sync flushes the file to stable storage.
func (a *FileAdapter) Sync() error {
	return a.f.Sync()
}

// Close closes the underlying file without flushing anything.
func (a *FileAdapter) Close() error {
	return a.f.Close()
}
