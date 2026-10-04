package fsm

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// RecordKind distinguishes the kinds of records persisted in the log.
type RecordKind string

const (
	// KindSession records the creation of a session and its expiry.
	KindSession RecordKind = "session"
	// KindTransition records one authorized state transition.
	KindTransition RecordKind = "transition"
)

// Record is a persisted state transition record. The Engine appends it to
// the WAL (and fsyncs) before applying it in memory and before returning.
type Record struct {
	Seq       uint64     `json:"seq"`
	Kind      RecordKind `json:"kind"`
	Session   string     `json:"session"`
	Key       string     `json:"key,omitempty"`
	Action    Action     `json:"action,omitempty"`
	From      State      `json:"from,omitempty"`
	To        State      `json:"to,omitempty"`
	ExpiresAt int64      `json:"expires_at,omitempty"` // unix nanos, session records only
}

// WritePoint identifies a step of the commit path of WAL.Append.
type WritePoint int

const (
	// PointBeforeWrite is reached before any bytes hit the file.
	PointBeforeWrite WritePoint = iota
	// PointBeforeSync is reached after write(2) but before fsync(2).
	PointBeforeSync
	// PointAfterSync is reached after fsync(2), before the caller returns.
	PointAfterSync
)

// CrashHook, when non-nil, is invoked at every WritePoint of WAL.Append.
// It is a test-only fault injection knob and stays nil in production.
var CrashHook func(point WritePoint)

func hook(p WritePoint) {
	if CrashHook != nil {
		CrashHook(p)
	}
}

// WAL is an append-only, fsync-on-commit log of Records backed by one file.
type WAL struct {
	f      *os.File
	seq    uint64
	off    int64 // current write offset
	synced int64 // offset durably fsynced
	closed bool
}

// OpenWAL opens (creating if needed) the log at path, replays every complete
// record, and discards a torn tail left by a crash mid-write.
func OpenWAL(path string) (*WAL, []Record, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, nil, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	var recs []Record
	var seq uint64
	good := 0
	for len(data) > 0 {
		nl := bytes.IndexByte(data, '\n')
		if nl < 0 {
			break // torn tail from a crash between write and fsync
		}
		var r Record
		if err := json.Unmarshal(data[:nl], &r); err != nil {
			f.Close()
			return nil, nil, fmt.Errorf("fsm: corrupt record at offset %d: %w", good, err)
		}
		recs = append(recs, r)
		if r.Seq > seq {
			seq = r.Seq
		}
		data = data[nl+1:]
		good += nl + 1
	}
	if err := f.Truncate(int64(good)); err != nil {
		f.Close()
		return nil, nil, err
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		f.Close()
		return nil, nil, err
	}
	w := &WAL{f: f, seq: seq, off: int64(good), synced: int64(good)}
	return w, recs, nil
}

// Append persists rec durably (write + fsync) and only then returns.
// rec.Seq is assigned by the WAL.
func (w *WAL) Append(rec *Record) error {
	if w.closed {
		return errors.New("fsm: wal closed")
	}
	w.seq++
	rec.Seq = w.seq
	buf, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	buf = append(buf, '\n')
	hook(PointBeforeWrite)
	if _, err := w.f.Write(buf); err != nil {
		return err
	}
	w.off += int64(len(buf))
	hook(PointBeforeSync)
	if err := w.f.Sync(); err != nil {
		return err
	}
	w.synced = w.off
	hook(PointAfterSync)
	return nil
}

// SimulateCrash mimics power loss: any bytes written since the last fsync
// are lost and the WAL becomes unusable. Test helper.
func (w *WAL) SimulateCrash() {
	if w.closed {
		return
	}
	w.f.Truncate(w.synced)
	w.f.Close()
	w.closed = true
}

// Close flushes and closes the log file.
func (w *WAL) Close() error {
	if w.closed {
		return nil
	}
	w.closed = true
	if err := w.f.Sync(); err != nil {
		w.f.Close()
		return err
	}
	return w.f.Close()
}
