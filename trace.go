package replayfs

import (
	"bytes"
	"errors"
	"fmt"
)

// ErrCrash is the injected interruption delivered at a chosen persistence
// point. Bytes already committed by that persistence point stay durable.
var ErrCrash = errors.New("replayfs: injected crash at persistence point")

// Entry is one recorded file-interface call.
type Entry struct {
	Op      string // Open, Write, Read, Sync, Close
	Path    string
	Data    []byte // Write argument / Read result bytes
	N       int    // Write return value / Read request size
	Err     string // "" means nil
	Persist bool   // true if this entry is a persistence point
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// Handle is the file handle interface shared by recording and replay.
type Handle interface {
	Write(p []byte) (int, error)
	Read(p []byte) (int, error)
	Sync() error
	Close() error
}

// System is the file system interface shared by Recorder and Replayer,
// so the same workload can run against either.
type System interface {
	Open(path string) (Handle, error)
}

// Recorder records every call into a trace. If CrashAt > 0, an
// interruption (ErrCrash) is injected at the CrashAt-th persistence
// point (1-based), after its bytes are committed; all later calls fail.
type Recorder struct {
	fs       *FS
	Entries  []Entry
	CrashAt  int
	persists int
	crashed  bool
}

// NewRecorder returns a Recorder wrapping fs.
func NewRecorder(fs *FS) *Recorder { return &Recorder{fs: fs} }

func (r *Recorder) append(e Entry) { r.Entries = append(r.Entries, e) }

// Open records and performs an Open call.
func (r *Recorder) Open(path string) (Handle, error) {
	if r.crashed {
		r.append(Entry{Op: "Open", Path: path, Err: errString(ErrCrash)})
		return nil, ErrCrash
	}
	f, err := r.fs.Open(path)
	r.append(Entry{Op: "Open", Path: path, Err: errString(err)})
	if err != nil {
		return nil, err
	}
	return &recFile{rec: r, file: f, path: path}, nil
}

type recFile struct {
	rec  *Recorder
	file *File
	path string
}

func (rf *recFile) Write(p []byte) (int, error) {
	r := rf.rec
	if r.crashed {
		r.append(Entry{Op: "Write", Path: rf.path, Data: p, Err: errString(ErrCrash)})
		return 0, ErrCrash
	}
	n, err := rf.file.Write(p)
	r.append(Entry{Op: "Write", Path: rf.path, Data: append([]byte(nil), p...), N: n, Err: errString(err)})
	return n, err
}

func (rf *recFile) Read(p []byte) (int, error) {
	r := rf.rec
	if r.crashed {
		r.append(Entry{Op: "Read", Path: rf.path, N: len(p), Err: errString(ErrCrash)})
		return 0, ErrCrash
	}
	n, err := rf.file.Read(p)
	r.append(Entry{Op: "Read", Path: rf.path, Data: append([]byte(nil), p[:n]...), N: len(p), Err: errString(err)})
	return n, err
}

func (rf *recFile) Sync() error {
	r := rf.rec
	if r.crashed {
		r.append(Entry{Op: "Sync", Path: rf.path, Err: errString(ErrCrash)})
		return ErrCrash
	}
	err := rf.file.Sync()
	e := Entry{Op: "Sync", Path: rf.path, Err: errString(err)}
	if err == nil {
		e.Persist = true
		r.persists++
		if r.CrashAt > 0 && r.persists == r.CrashAt {
			// Bytes are already committed; only the interruption is injected.
			r.crashed = true
			e.Err = errString(ErrCrash)
		}
	}
	r.append(e)
	if r.crashed {
		return ErrCrash
	}
	return err
}

func (rf *recFile) Close() error {
	r := rf.rec
	if r.crashed {
		r.append(Entry{Op: "Close", Path: rf.path, Err: errString(ErrCrash)})
		return ErrCrash
	}
	err := rf.file.Close()
	e := Entry{Op: "Close", Path: rf.path, Err: errString(err)}
	if err == nil {
		e.Persist = true
		r.persists++
		if r.CrashAt > 0 && r.persists == r.CrashAt {
			r.crashed = true
			e.Err = errString(ErrCrash)
		}
	}
	r.append(e)
	if r.crashed {
		return ErrCrash
	}
	return err
}

// Replayer drives a trace against a real FS, verifying every call
// item by item: operation, path, and arguments must match, and the
// recorded return values are cross-checked against the live results.
type Replayer struct {
	fs      *FS
	entries []Entry
	pos     int
}

// NewReplayer returns a Replayer that consumes entries against fs.
func NewReplayer(fs *FS, entries []Entry) *Replayer {
	return &Replayer{fs: fs, entries: entries}
}

func (rp *Replayer) next(op, path string) (Entry, error) {
	if rp.pos >= len(rp.entries) {
		return Entry{}, fmt.Errorf("replayfs: trace exhausted: unexpected %s on %q", op, path)
	}
	e := rp.entries[rp.pos]
	rp.pos++
	if e.Op != op || e.Path != path {
		return Entry{}, fmt.Errorf("replayfs: trace mismatch at entry %d: recorded %s on %q, replayed %s on %q",
			rp.pos-1, e.Op, e.Path, op, path)
	}
	return e, nil
}

// Finish must be called after the workload completes. It fails if any
// trace entries were left unconsumed.
func (rp *Replayer) Finish() error {
	if rp.pos != len(rp.entries) {
		e := rp.entries[rp.pos]
		return fmt.Errorf("replayfs: %d unconsumed trace entries (next: %s on %q)",
			len(rp.entries)-rp.pos, e.Op, e.Path)
	}
	return nil
}

// Open replays an Open call.
func (rp *Replayer) Open(path string) (Handle, error) {
	e, err := rp.next("Open", path)
	if err != nil {
		return nil, err
	}
	if e.Err == errString(ErrCrash) {
		return nil, ErrCrash
	}
	f, err := rp.fs.Open(path)
	if errString(err) != e.Err {
		return nil, fmt.Errorf("replayfs: Open %q: recorded error %q, got %q", path, e.Err, errString(err))
	}
	if err != nil {
		return nil, err
	}
	return &repFile{rp: rp, file: f, path: path}, nil
}

type repFile struct {
	rp   *Replayer
	file *File
	path string
}

// Attach returns a replaying handle for path without consuming a trace
// entry. It is used when resuming a segmented replay: the Open happened
// in an earlier segment, but subsequent calls on the handle must still
// be verified against the trace.
func (rp *Replayer) Attach(path string) (Handle, error) {
	f, err := rp.fs.Open(path)
	if err != nil {
		return nil, err
	}
	return &repFile{rp: rp, file: f, path: path}, nil
}

func (rf *repFile) Write(p []byte) (int, error) {
	e, err := rf.rp.next("Write", rf.path)
	if err != nil {
		return 0, err
	}
	if !bytes.Equal(e.Data, p) {
		return 0, fmt.Errorf("replayfs: Write %q: recorded %d bytes %q, replayed %d bytes %q",
			rf.path, len(e.Data), e.Data, len(p), p)
	}
	if e.Err == errString(ErrCrash) {
		return 0, ErrCrash
	}
	n, err := rf.file.Write(p)
	if n != e.N || errString(err) != e.Err {
		return n, fmt.Errorf("replayfs: Write %q: recorded (%d, %q), got (%d, %q)", rf.path, e.N, e.Err, n, errString(err))
	}
	return n, err
}

func (rf *repFile) Read(p []byte) (int, error) {
	e, err := rf.rp.next("Read", rf.path)
	if err != nil {
		return 0, err
	}
	if e.N != len(p) {
		return 0, fmt.Errorf("replayfs: Read %q: recorded request %d bytes, replayed %d", rf.path, e.N, len(p))
	}
	if e.Err == errString(ErrCrash) {
		return 0, ErrCrash
	}
	n, err := rf.file.Read(p)
	if errString(err) != e.Err || !bytes.Equal(p[:n], e.Data) {
		return n, fmt.Errorf("replayfs: Read %q: recorded (%q, %q), got (%q, %q)", rf.path, e.Data, e.Err, p[:n], errString(err))
	}
	return n, err
}

func (rf *repFile) Sync() error {
	e, err := rf.rp.next("Sync", rf.path)
	if err != nil {
		return err
	}
	if e.Err == errString(ErrCrash) && !e.Persist {
		return ErrCrash
	}
	// The recorded Sync committed its bytes (even if a crash was
	// injected right after), so perform it for real.
	syncErr := rf.file.Sync()
	if e.Err == errString(ErrCrash) {
		return ErrCrash
	}
	if errString(syncErr) != e.Err {
		return fmt.Errorf("replayfs: Sync %q: recorded error %q, got %q", rf.path, e.Err, errString(syncErr))
	}
	return syncErr
}

func (rf *repFile) Close() error {
	e, err := rf.rp.next("Close", rf.path)
	if err != nil {
		return err
	}
	if e.Err == errString(ErrCrash) && !e.Persist {
		return ErrCrash
	}
	closeErr := rf.file.Close()
	if e.Err == errString(ErrCrash) {
		return ErrCrash
	}
	if errString(closeErr) != e.Err {
		return fmt.Errorf("replayfs: Close %q: recorded error %q, got %q", rf.path, e.Err, errString(closeErr))
	}
	return closeErr
}
