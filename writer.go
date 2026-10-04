package tailer

import "os"

// Writer appends records to segment files in a directory. It is not safe for
// concurrent use.
type Writer struct {
	dir string
	f   *os.File
	seg int
}

// NewWriter creates a Writer appending to dir. Writing starts after the
// highest existing segment id, or at segment 1 in an empty directory.
func NewWriter(dir string) (*Writer, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	ids, err := listSegments(dir)
	if err != nil {
		return nil, err
	}
	seg := 1
	if len(ids) > 0 {
		seg = ids[len(ids)-1]
	}
	w := &Writer{dir: dir}
	if err := w.open(seg); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *Writer) open(seg int) error {
	f, err := os.OpenFile(segmentPath(w.dir, seg), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if w.f != nil {
		if err := w.f.Close(); err != nil {
			f.Close()
			return err
		}
	}
	w.f, w.seg = f, seg
	return nil
}

// Segment returns the id of the segment currently being written.
func (w *Writer) Segment() int { return w.seg }

// Append encodes payload as one record and writes it atomically, then fsyncs
// so a tailing reader can observe it.
func (w *Writer) Append(payload []byte) error { return w.AppendRaw(EncodeRecord(payload)) }

// AppendRaw writes raw bytes to the current segment and fsyncs. Tests use it
// to split a record's header and payload across multiple observable writes.
func (w *Writer) AppendRaw(p []byte) error {
	if _, err := w.f.Write(p); err != nil {
		return err
	}
	return w.f.Sync()
}

// Rotate closes the current segment and starts appending to a fresh one.
func (w *Writer) Rotate() error { return w.open(w.seg + 1) }

// Close flushes and closes the current segment file.
func (w *Writer) Close() error {
	if w.f == nil {
		return nil
	}
	err := w.f.Close()
	w.f = nil
	return err
}
