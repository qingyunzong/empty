// Package pagestore provides a page file adapter plus a small buffer
// pool with steal/no-force semantics: a dirty page may be written back
// to disk at any moment, even if the transaction that modified it is
// still uncommitted, and commits never force pages to disk.
package pagestore

import (
	"encoding/binary"
	"errors"
	"io"
	"os"

	"pagedb/wal"
)

const (
	// PageSize is the payload size of a single page in bytes.
	PageSize = 4096
	hdrSize  = 8 // per-page header: 8-byte page LSN
	frameSz  = hdrSize + PageSize
)

// FileAdapter reads and writes pages in a single data file. Page i lives
// at offset i*frameSz, prefixed by the LSN of the log record that last
// modified it (the page LSN), which recovery uses to keep redo
// idempotent.
type FileAdapter struct {
	f *os.File
}

// OpenFileAdapter opens (or creates) the page file at path.
func OpenFileAdapter(path string) (*FileAdapter, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	return &FileAdapter{f: f}, nil
}

// ReadPage returns the page LSN and payload of page id. A page that was
// never written reads as a zero page with LSN 0.
func (a *FileAdapter) ReadPage(id uint32) (uint64, []byte, error) {
	buf := make([]byte, frameSz)
	n, err := a.f.ReadAt(buf, int64(id)*frameSz)
	if err != nil && !errors.Is(err, io.EOF) {
		return 0, nil, err
	}
	if n == 0 {
		return 0, make([]byte, PageSize), nil
	}
	if n < frameSz {
		return 0, nil, errors.New("pagestore: torn page on disk")
	}
	data := make([]byte, PageSize)
	copy(data, buf[hdrSize:])
	return binary.BigEndian.Uint64(buf[:hdrSize]), data, nil
}

// WritePage persists page id with the given page LSN.
func (a *FileAdapter) WritePage(id uint32, lsn uint64, data []byte) error {
	buf := make([]byte, frameSz)
	binary.BigEndian.PutUint64(buf[:hdrSize], lsn)
	copy(buf[hdrSize:], data)
	_, err := a.f.WriteAt(buf, int64(id)*frameSz)
	return err
}

// Sync forces the page file to stable storage.
func (a *FileAdapter) Sync() error { return a.f.Sync() }

// Close closes the page file.
func (a *FileAdapter) Close() error { return a.f.Close() }

// Page is a buffered page image.
type Page struct {
	Data  []byte // page payload, PageSize bytes
	LSN   uint64 // LSN of the log record that produced this image
	Dirty bool   // buffered image is newer than the disk image
}

// Store is a buffer pool over a FileAdapter. It enforces the WAL rule on
// flush (log first) but never checks commit status: uncommitted pages
// may be stolen to disk at any time.
type Store struct {
	ad    *FileAdapter
	log   *wal.Log
	pages map[uint32]*Page
}

// NewStore creates a Store backed by ad, writing ahead to log.
func NewStore(ad *FileAdapter, log *wal.Log) *Store {
	return &Store{ad: ad, log: log, pages: make(map[uint32]*Page)}
}

// Fetch returns the buffered image of page id, loading it from disk on
// first access.
func (s *Store) Fetch(id uint32) (*Page, error) {
	if p, ok := s.pages[id]; ok {
		return p, nil
	}
	lsn, data, err := s.ad.ReadPage(id)
	if err != nil {
		return nil, err
	}
	p := &Page{Data: data, LSN: lsn}
	s.pages[id] = p
	return p, nil
}

// Flush writes page id back to disk if dirty. The WAL rule is enforced
// (the log is synced up to the page LSN first); the commit status of the
// modifying transaction is deliberately not consulted (steal).
func (s *Store) Flush(id uint32) error {
	p, ok := s.pages[id]
	if !ok || !p.Dirty {
		return nil
	}
	if err := s.log.Sync(); err != nil {
		return err
	}
	if err := s.ad.WritePage(id, p.LSN, p.Data); err != nil {
		return err
	}
	if err := s.ad.Sync(); err != nil {
		return err
	}
	p.Dirty = false
	return nil
}

// FlushAll flushes every dirty page.
func (s *Store) FlushAll() error {
	for id := range s.pages {
		if err := s.Flush(id); err != nil {
			return err
		}
	}
	return nil
}
