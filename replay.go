package filetrace

import (
	"bytes"
	"errors"
	"fmt"
)

// ErrInjectedCrash is returned by every call after a crash injected at the
// persistence point selected by Replayer.CrashAt.
var ErrInjectedCrash = errors.New("filetrace: injected crash at persistence point")

// Replayer consumes a Trace item by item. Every call must match the next
// recorded event in operation, arguments, and (by executing against the
// underlying MemFile) return values; any mismatch is an error. Finish
// reports an error if trace events remain unconsumed.
type Replayer struct {
	f       *MemFile
	tr      *Trace
	pos     int
	CrashAt int // persistence-point index at which to inject a crash; -1 disables
	crashed bool
}

// NewReplayer returns a Replayer that consumes tr from the beginning.
func NewReplayer(f *MemFile, tr *Trace) *Replayer {
	return NewReplayerAt(f, tr, 0)
}

// NewReplayerAt returns a Replayer that consumes tr starting at event start.
func NewReplayerAt(f *MemFile, tr *Trace, start int) *Replayer {
	return &Replayer{f: f, tr: tr, pos: start, CrashAt: -1}
}

// Pos returns the index of the next event to be consumed.
func (r *Replayer) Pos() int { return r.pos }

func (r *Replayer) next(op Op) (*Event, error) {
	if r.crashed {
		return nil, ErrInjectedCrash
	}
	if r.pos >= len(r.tr.Events) {
		return nil, fmt.Errorf("filetrace: unexpected %s call: trace exhausted after %d events", op, r.pos)
	}
	ev := &r.tr.Events[r.pos]
	if ev.Op != op {
		return nil, fmt.Errorf("filetrace: event %d: trace expects %s, got %s", r.pos, ev.Op, op)
	}
	return ev, nil
}

func (r *Replayer) checkResult(ev *Event, n int, ret64 int64, err error) error {
	if n != ev.N || ret64 != ev.Ret64 || errString(err) != ev.Err {
		return fmt.Errorf("filetrace: event %d: %s result mismatch: trace has (n=%d, ret=%d, err=%q), replay got (n=%d, ret=%d, err=%q)",
			r.pos, ev.Op, ev.N, ev.Ret64, ev.Err, n, ret64, errString(err))
	}
	return nil
}

func (r *Replayer) Write(p []byte) (int, error) {
	ev, err := r.next(OpWrite)
	if err != nil {
		return 0, err
	}
	if !bytes.Equal(ev.Data, p) {
		return 0, fmt.Errorf("filetrace: event %d: Write argument mismatch: trace has %q, got %q", r.pos, ev.Data, p)
	}
	n, aerr := r.f.Write(p)
	if err := r.checkResult(ev, n, 0, aerr); err != nil {
		return 0, err
	}
	r.pos++
	return n, aerr
}

func (r *Replayer) Read(p []byte) (int, error) {
	ev, err := r.next(OpRead)
	if err != nil {
		return 0, err
	}
	if len(p) != ev.Len {
		return 0, fmt.Errorf("filetrace: event %d: Read argument mismatch: trace has len %d, got %d", r.pos, ev.Len, len(p))
	}
	n, aerr := r.f.Read(p)
	if err := r.checkResult(ev, n, 0, aerr); err != nil {
		return 0, err
	}
	if !bytes.Equal(ev.Data, p[:n]) {
		return 0, fmt.Errorf("filetrace: event %d: Read data mismatch: trace has %q, replay read %q", r.pos, ev.Data, p[:n])
	}
	r.pos++
	return n, aerr
}

func (r *Replayer) Seek(offset int64, whence int) (int64, error) {
	ev, err := r.next(OpSeek)
	if err != nil {
		return 0, err
	}
	if offset != ev.Offset || whence != ev.Whence {
		return 0, fmt.Errorf("filetrace: event %d: Seek argument mismatch: trace has (%d, %d), got (%d, %d)",
			r.pos, ev.Offset, ev.Whence, offset, whence)
	}
	ret, aerr := r.f.Seek(offset, whence)
	if err := r.checkResult(ev, 0, ret, aerr); err != nil {
		return 0, err
	}
	r.pos++
	return ret, aerr
}

// Sync consumes a Sync event. If the event is the persistence point selected
// by CrashAt, the sync is applied (persisted bytes updated), a crash is
// injected, and ErrInjectedCrash is returned; already-persisted bytes are
// not modified by the crash itself.
func (r *Replayer) Sync() error {
	ev, err := r.next(OpSync)
	if err != nil {
		return err
	}
	aerr := r.f.Sync()
	if err := r.checkResult(ev, 0, 0, aerr); err != nil {
		return err
	}
	r.pos++
	if r.CrashAt >= 0 && ev.PersistSeq == r.CrashAt {
		r.f.Crash()
		r.crashed = true
		return ErrInjectedCrash
	}
	return aerr
}

func (r *Replayer) Close() error {
	ev, err := r.next(OpClose)
	if err != nil {
		return err
	}
	aerr := r.f.Close()
	if err := r.checkResult(ev, 0, 0, aerr); err != nil {
		return err
	}
	r.pos++
	return aerr
}

// Finish verifies the trace was fully consumed.
func (r *Replayer) Finish() error {
	if r.pos != len(r.tr.Events) {
		return fmt.Errorf("filetrace: %d unconsumed trace events, next is event %d (%s)",
			len(r.tr.Events)-r.pos, r.pos, r.tr.Events[r.pos].Op)
	}
	return nil
}

// Drive issues the recorded calls for events [start,end) of tr against r,
// stopping at the first error.
func Drive(r *Replayer, tr *Trace, start, end int) error {
	for i := start; i < end; i++ {
		ev := tr.Events[i]
		var err error
		switch ev.Op {
		case OpWrite:
			_, err = r.Write(ev.Data)
		case OpRead:
			_, err = r.Read(make([]byte, ev.Len))
		case OpSeek:
			_, err = r.Seek(ev.Offset, ev.Whence)
		case OpSync:
			err = r.Sync()
		case OpClose:
			err = r.Close()
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// ReplayAll replays the whole trace against a fresh state in f and requires
// full consumption of the trace.
func ReplayAll(f *MemFile, tr *Trace) error {
	r := NewReplayer(f, tr)
	if err := Drive(r, tr, 0, len(tr.Events)); err != nil {
		return err
	}
	return r.Finish()
}
