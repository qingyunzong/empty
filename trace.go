package filetrace

// Op identifies a recorded file-interface call.
type Op int

const (
	OpWrite Op = iota
	OpRead
	OpSeek
	OpSync
	OpClose
)

func (o Op) String() string {
	switch o {
	case OpWrite:
		return "Write"
	case OpRead:
		return "Read"
	case OpSeek:
		return "Seek"
	case OpSync:
		return "Sync"
	case OpClose:
		return "Close"
	}
	return "Unknown"
}

// Event is one recorded call: operation, arguments, and return values.
type Event struct {
	Op         Op
	Data       []byte // Write payload, or bytes returned by Read
	Len        int    // Read: requested length
	Offset     int64  // Seek: offset argument
	Whence     int    // Seek: whence argument
	N          int    // Write/Read: byte count returned
	Ret64      int64  // Seek: position returned
	Err        string // error string, "" for nil
	PersistSeq int    // Sync only: persistence-point index, -1 otherwise
}

// Trace is the recorded trajectory plus a snapshot per persistence point.
// Snapshots[i] is the file state right after the i-th Sync.
type Trace struct {
	Events    []Event
	Snapshots []Snapshot
}

// SegmentBounds splits the trace into [start,end) event ranges: one range
// per persistence point (each ending with its Sync event), plus a trailing
// range for any events after the last Sync.
func (tr *Trace) SegmentBounds() [][2]int {
	var bounds [][2]int
	start := 0
	for i, ev := range tr.Events {
		if ev.Op == OpSync {
			bounds = append(bounds, [2]int{start, i + 1})
			start = i + 1
		}
	}
	if start < len(tr.Events) {
		bounds = append(bounds, [2]int{start, len(tr.Events)})
	}
	return bounds
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// Recorder wraps a MemFile and records every call into a Trace.
type Recorder struct {
	f     *MemFile
	Trace *Trace
}

// NewRecorder returns a Recorder wrapping f.
func NewRecorder(f *MemFile) *Recorder {
	return &Recorder{f: f, Trace: &Trace{}}
}

func (r *Recorder) Write(p []byte) (int, error) {
	n, err := r.f.Write(p)
	r.Trace.Events = append(r.Trace.Events, Event{
		Op:         OpWrite,
		Data:       append([]byte(nil), p[:n]...),
		N:          n,
		Err:        errString(err),
		PersistSeq: -1,
	})
	return n, err
}

func (r *Recorder) Read(p []byte) (int, error) {
	n, err := r.f.Read(p)
	r.Trace.Events = append(r.Trace.Events, Event{
		Op:         OpRead,
		Data:       append([]byte(nil), p[:n]...),
		Len:        len(p),
		N:          n,
		Err:        errString(err),
		PersistSeq: -1,
	})
	return n, err
}

func (r *Recorder) Seek(offset int64, whence int) (int64, error) {
	ret, err := r.f.Seek(offset, whence)
	r.Trace.Events = append(r.Trace.Events, Event{
		Op:         OpSeek,
		Offset:     offset,
		Whence:     whence,
		Ret64:      ret,
		Err:        errString(err),
		PersistSeq: -1,
	})
	return ret, err
}

// Sync persists and records a persistence point, saving a snapshot of the
// file state taken immediately after the sync.
func (r *Recorder) Sync() error {
	err := r.f.Sync()
	seq := len(r.Trace.Snapshots)
	r.Trace.Events = append(r.Trace.Events, Event{
		Op:         OpSync,
		Err:        errString(err),
		PersistSeq: seq,
	})
	r.Trace.Snapshots = append(r.Trace.Snapshots, r.f.Snapshot(seq))
	return err
}

func (r *Recorder) Close() error {
	err := r.f.Close()
	r.Trace.Events = append(r.Trace.Events, Event{
		Op:         OpClose,
		Err:        errString(err),
		PersistSeq: -1,
	})
	return err
}
