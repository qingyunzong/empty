package dataeng

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/gob"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// SpillManager owns the on-disk spill area for one join and tracks spill
// files per transaction. Aborting a transaction deletes only that
// transaction's files; committed batches are kept until Close.
type SpillManager struct {
	dir  string
	own  bool
	mu   sync.Mutex
	seq  int64
	txns map[int64]*SpillTxn
	// committed holds file paths of committed batches, in commit order.
	committed []string
	closed    bool
}

// NewSpillManager creates a manager rooted at dir. If dir is empty a
// temporary directory is created and removed on Close.
func NewSpillManager(dir string) (*SpillManager, error) {
	own := false
	if dir == "" {
		d, err := os.MkdirTemp("", "dataeng-spill-")
		if err != nil {
			return nil, err
		}
		dir, own = d, true
	} else if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &SpillManager{dir: dir, own: own, txns: make(map[int64]*SpillTxn)}, nil
}

// Dir returns the spill directory.
func (m *SpillManager) Dir() string { return m.dir }

// Begin starts a new spill transaction.
func (m *SpillManager) Begin() (*SpillTxn, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errors.New("dataeng: spill manager is closed")
	}
	m.seq++
	t := &SpillTxn{m: m, id: m.seq}
	m.txns[t.id] = t
	return t, nil
}

// CommittedFiles returns the paths of all committed spill batches.
func (m *SpillManager) CommittedFiles() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.committed...)
}

// AbortActive aborts every uncommitted transaction, deleting their files.
// Committed batches are untouched.
func (m *SpillManager) AbortActive() {
	m.mu.Lock()
	txns := make([]*SpillTxn, 0, len(m.txns))
	for _, t := range m.txns {
		txns = append(txns, t)
	}
	m.mu.Unlock()
	for _, t := range txns {
		t.Abort()
	}
}

// Close aborts active transactions and removes all spill files, including
// committed batches. If the manager owns its directory, the directory is
// removed as well.
func (m *SpillManager) Close() error {
	m.AbortActive()
	m.mu.Lock()
	committed := m.committed
	m.committed = nil
	m.closed = true
	own, dir := m.own, m.dir
	m.mu.Unlock()
	for _, f := range committed {
		os.Remove(f)
	}
	if own {
		return os.RemoveAll(dir)
	}
	return nil
}

func (m *SpillManager) finish(t *SpillTxn, commit bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.txns, t.id)
	if commit {
		m.committed = append(m.committed, t.files...)
	}
}

// SpillTxn is a spill transaction: a set of spill files that are either
// committed (kept) or aborted (deleted) atomically.
type SpillTxn struct {
	m     *SpillManager
	id    int64
	mu    sync.Mutex
	files []string
	n     int
	done  bool
}

// Writer creates a new spill file within this transaction.
func (t *SpillTxn) Writer() (*SpillWriter, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.done {
		return nil, errors.New("dataeng: spill transaction is finished")
	}
	t.n++
	path := filepath.Join(t.m.dir, fmt.Sprintf("spill-%d-%d.gob", t.id, t.n))
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	t.files = append(t.files, path)
	return &SpillWriter{f: f, bw: bufio.NewWriter(f), path: path}, nil
}

// Commit marks the transaction's files as a committed batch. They survive
// cancellation and are removed only by SpillManager.Close.
func (t *SpillTxn) Commit() {
	t.mu.Lock()
	if t.done {
		t.mu.Unlock()
		return
	}
	t.done = true
	t.mu.Unlock()
	t.m.finish(t, true)
}

// Abort deletes all of the transaction's files.
func (t *SpillTxn) Abort() {
	t.mu.Lock()
	if t.done {
		t.mu.Unlock()
		return
	}
	t.done = true
	files := append([]string(nil), t.files...)
	t.mu.Unlock()
	t.m.finish(t, false)
	for _, f := range files {
		os.Remove(f)
	}
}

// SpillWriter appends rows to one spill file. Records are length-prefixed
// gob blobs so readers can track byte offsets for resumable reads.
// Payload types must be gob-encodable (register custom types with
// gob.Register).
type SpillWriter struct {
	f    *os.File
	bw   *bufio.Writer
	path string
	n    int64
}

// Path returns the spill file path.
func (w *SpillWriter) Path() string { return w.path }

// Rows returns the number of rows written so far.
func (w *SpillWriter) Rows() int64 { return w.n }

func (w *SpillWriter) Write(r Row) error {
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(&r); err != nil {
		return err
	}
	var lenBuf [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(lenBuf[:], uint64(buf.Len()))
	if _, err := w.bw.Write(lenBuf[:n]); err != nil {
		return err
	}
	if _, err := w.bw.Write(buf.Bytes()); err != nil {
		return err
	}
	w.n++
	return nil
}

func (w *SpillWriter) Close() error {
	if err := w.bw.Flush(); err != nil {
		w.f.Close()
		return err
	}
	return w.f.Close()
}

// SpillReader reads rows back from a spill file. It tracks the byte offset
// of the next record, so a consumer can persist Offset and later resume
// with OpenSpillReaderAt.
type SpillReader struct {
	f   *os.File
	br  *bufio.Reader
	off int64
}

// OpenSpillReader opens a spill file from the beginning.
func OpenSpillReader(path string) (*SpillReader, error) {
	return OpenSpillReaderAt(path, 0)
}

// OpenSpillReaderAt opens a spill file positioned at a byte offset
// previously obtained from Offset.
func OpenSpillReaderAt(path string, offset int64) (*SpillReader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			f.Close()
			return nil, err
		}
	}
	return &SpillReader{f: f, br: bufio.NewReader(f), off: offset}, nil
}

// Offset returns the byte offset of the next record to be read.
func (r *SpillReader) Offset() int64 { return r.off }

// Next reads the next row, returning io.EOF at the end of the file.
func (r *SpillReader) Next() (Row, error) {
	n, err := binary.ReadUvarint(r.br)
	if err != nil {
		return Row{}, err
	}
	hdr := int64(len(binary.AppendUvarint(nil, n)))
	buf := make([]byte, n)
	if _, err := io.ReadFull(r.br, buf); err != nil {
		return Row{}, err
	}
	var row Row
	if err := gob.NewDecoder(bytes.NewReader(buf)).Decode(&row); err != nil {
		return Row{}, err
	}
	r.off += hdr + int64(n)
	return row, nil
}

// Reset rewinds the reader to the beginning of the file.
func (r *SpillReader) Reset() error {
	if _, err := r.f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	r.br = bufio.NewReader(r.f)
	r.off = 0
	return nil
}

func (r *SpillReader) Close() error { return r.f.Close() }
