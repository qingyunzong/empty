package formal

import (
	"slices"
	"sync"
	"sync/atomic"
)

// OpKind identifies the recorded gateway operation.
type OpKind int

const (
	OpBegin OpKind = iota
	OpPutPart
	OpComplete
	OpGet
)

// Event is one completed operation in an operation history: its inputs,
// its observed outputs, and the invocation/response timestamps taken from a
// single monotonic clock, so Call/Ret impose a real-time order.
type Event struct {
	Kind     OpKind
	Call     int64
	Ret      int64
	Key      string
	UploadID string
	Spec     PartSpec
	Data     []byte
	Manifest []PartRef

	Gen     uint64
	Version uint64
	Object  []byte
	Found   bool
	Err     error
}

// Recorder wraps a Gateway and records every operation as an Event for
// later linearizability checking.
type Recorder struct {
	g   *Gateway
	clk atomic.Int64
	mu  sync.Mutex
	evs []*Event
}

func NewRecorder(g *Gateway) *Recorder {
	return &Recorder{g: g}
}

func (r *Recorder) record(e *Event) {
	r.mu.Lock()
	r.evs = append(r.evs, e)
	r.mu.Unlock()
}

func (r *Recorder) BeginUpload(key string) string {
	call := r.clk.Add(1)
	id := r.g.BeginUpload(key)
	ret := r.clk.Add(1)
	r.record(&Event{Kind: OpBegin, Call: call, Ret: ret, Key: key, UploadID: id})
	return id
}

func (r *Recorder) PutPart(uploadID string, spec PartSpec, data []byte) (uint64, error) {
	call := r.clk.Add(1)
	gen, err := r.g.PutPart(uploadID, spec, data)
	ret := r.clk.Add(1)
	r.record(&Event{
		Kind: OpPutPart, Call: call, Ret: ret, UploadID: uploadID,
		Spec: spec, Data: slices.Clone(data), Gen: gen, Err: err,
	})
	return gen, err
}

func (r *Recorder) Complete(uploadID string, manifest []PartRef) (uint64, error) {
	call := r.clk.Add(1)
	version, err := r.g.Complete(uploadID, manifest)
	ret := r.clk.Add(1)
	r.record(&Event{
		Kind: OpComplete, Call: call, Ret: ret, UploadID: uploadID,
		Manifest: slices.Clone(manifest), Version: version, Err: err,
	})
	return version, err
}

func (r *Recorder) GetObject(key string) ([]byte, uint64, bool) {
	call := r.clk.Add(1)
	data, version, ok := r.g.GetObject(key)
	ret := r.clk.Add(1)
	r.record(&Event{
		Kind: OpGet, Call: call, Ret: ret, Key: key,
		Object: data, Version: version, Found: ok,
	})
	return data, version, ok
}

// History returns the recorded events in invocation order.
func (r *Recorder) History() []*Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.evs)
}
