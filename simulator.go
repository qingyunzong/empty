// Package simulator implements a deterministic sliding-window (selective-repeat
// style) device transmission simulator.
//
// Features:
//   - cumulative and selective acknowledgements, resolved by sequence number
//   - retransmission only for unacknowledged frames, bounded by a retry limit
//   - acknowledgements are processed before timeouts expiring at the same tick
//   - wrap-around sequence numbers, disambiguated by window < modulus/2
//   - window resizable while frames are in flight; shrinking never drops them
//   - snapshot/restore preserving per-frame deadlines and retry counts
package simulator

import (
	"container/heap"
	"fmt"
	"sort"
)

// Config configures a Sim.
type Config struct {
	Modulus    int                         // sequence-number space size; seq = abs % Modulus
	Window     int                         // sender window; must satisfy 2*Window < Modulus
	Timeout    int                         // retransmission timeout in ticks
	Latency    int                         // one-way network latency in ticks
	MaxRetries int                         // maximum retransmissions per frame (initial send excluded)
	Cumulative bool                        // true: cumulative acks; false: selective acks
	Loss       func(abs, attempt int) bool // reports whether a transmission is lost
}

// Transmission records one physical send of a frame.
type Transmission struct {
	Tick    int
	Abs     int // absolute (never reused) frame number
	Seq     int // wire sequence number, Abs % Modulus
	Attempt int // 0 = initial send, >=1 = retransmission
}

// FrameState is an exported view of an in-flight frame.
type FrameState struct {
	Abs      int
	Seq      int
	Data     string
	Deadline int // tick at which the current transmission times out
	Retries  int // retransmissions performed so far
}

type eventKind int

const (
	// evReceive sorts before evTimeout so that at equal ticks the
	// acknowledgement produced by a reception is processed first.
	evReceive eventKind = iota
	evTimeout
)

type event struct {
	tick     int
	kind     eventKind
	order    uint64
	abs      int
	seq      int
	data     string
	deadline int // timeout: expected frame deadline, for staleness detection
}

type eventHeap []event

func (h eventHeap) Len() int { return len(h) }
func (h eventHeap) Less(i, j int) bool {
	a, b := h[i], h[j]
	if a.tick != b.tick {
		return a.tick < b.tick
	}
	if a.kind != b.kind {
		return a.kind < b.kind
	}
	return a.order < b.order
}
func (h eventHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *eventHeap) Push(x any)   { *h = append(*h, x.(event)) }
func (h *eventHeap) Pop() any {
	old := *h
	n := len(old)
	e := old[n-1]
	*h = old[:n-1]
	return e
}

type frame struct {
	abs      int
	seq      int
	data     string
	deadline int
	retries  int
}

// Sim is a deterministic transmission simulator.
type Sim struct {
	cfg    Config
	window int

	now        int
	queue      []string
	frames     map[int]*frame // in-flight, unacknowledged, by absolute number
	next       int            // next absolute number to assign
	expect     int            // receiver: next absolute number to deliver
	recvBuf    map[int]string // receiver: out-of-order buffer
	delivered  []string
	trajectory []Transmission
	failed     []int
	events     eventHeap
	order      uint64

	// sendHook, when set, is called before each send with the number of
	// in-flight frames. Used by tests.
	sendHook func(inflight int)
}

// New validates cfg and returns a ready simulator.
func New(cfg Config) (*Sim, error) {
	if cfg.Modulus < 2 {
		return nil, fmt.Errorf("modulus %d too small", cfg.Modulus)
	}
	if err := checkWindow(cfg.Window, cfg.Modulus); err != nil {
		return nil, err
	}
	if cfg.Timeout < 1 {
		return nil, fmt.Errorf("timeout must be >= 1")
	}
	if cfg.Latency < 0 {
		return nil, fmt.Errorf("latency must be >= 0")
	}
	if cfg.MaxRetries < 0 {
		return nil, fmt.Errorf("max retries must be >= 0")
	}
	return &Sim{
		cfg:     cfg,
		window:  cfg.Window,
		frames:  map[int]*frame{},
		recvBuf: map[int]string{},
	}, nil
}

func checkWindow(w, modulus int) error {
	// Disambiguation requires the window to be strictly less than half the
	// modulus, so any in-flight set spans less than half the sequence space.
	if w < 1 || 2*w >= modulus {
		return fmt.Errorf("window %d out of range: need 1 <= w and 2*w < modulus %d", w, modulus)
	}
	return nil
}

// Send queues payloads and transmits as the window allows.
func (s *Sim) Send(data ...string) {
	s.queue = append(s.queue, data...)
	s.pump()
}

// ResizeWindow changes the sender window. In-flight frames are never dropped:
// after a shrink they keep their deadlines and retry counts, and new sends
// simply pause until the in-flight count falls below the new window.
func (s *Sim) ResizeWindow(w int) error {
	if err := checkWindow(w, s.cfg.Modulus); err != nil {
		return err
	}
	s.window = w
	s.pump()
	return nil
}

// pump fills the window with queued payloads.
func (s *Sim) pump() {
	for len(s.queue) > 0 && len(s.frames) < s.window {
		if s.sendHook != nil {
			s.sendHook(len(s.frames))
		}
		data := s.queue[0]
		s.queue = s.queue[1:]
		f := &frame{abs: s.next, seq: s.next % s.cfg.Modulus, data: data}
		s.next++
		s.frames[f.abs] = f
		s.transmit(f)
	}
}

// transmit performs one physical send of f and schedules its consequences.
func (s *Sim) transmit(f *frame) {
	f.deadline = s.now + s.cfg.Timeout
	s.trajectory = append(s.trajectory, Transmission{
		Tick: s.now, Abs: f.abs, Seq: f.seq, Attempt: f.retries,
	})
	lost := s.cfg.Loss != nil && s.cfg.Loss(f.abs, f.retries)
	if !lost {
		s.push(event{tick: s.now + s.cfg.Latency, kind: evReceive,
			abs: f.abs, seq: f.seq, data: f.data})
	}
	s.push(event{tick: f.deadline, kind: evTimeout, abs: f.abs, deadline: f.deadline})
}

func (s *Sim) push(e event) {
	e.order = s.order
	s.order++
	heap.Push(&s.events, e)
}

// Step processes the next event. It returns false when no events remain.
func (s *Sim) Step() bool {
	if len(s.events) == 0 {
		return false
	}
	e := heap.Pop(&s.events).(event)
	s.now = e.tick
	switch e.kind {
	case evReceive:
		s.receive(e)
	case evTimeout:
		s.onTimeout(e)
	}
	return true
}

// Run processes events until none remain.
func (s *Sim) Run() {
	for s.Step() {
	}
}

// receive models the receiver: in-order delivery with duplicate suppression,
// then acknowledgement (cumulative or selective, per config).
func (s *Sim) receive(e event) {
	if e.abs >= s.expect {
		if _, ok := s.recvBuf[e.abs]; !ok {
			s.recvBuf[e.abs] = e.data
		}
		for {
			data, ok := s.recvBuf[s.expect]
			if !ok {
				break
			}
			delete(s.recvBuf, s.expect)
			s.delivered = append(s.delivered, data)
			s.expect++
		}
	}
	if s.cfg.Cumulative {
		if s.expect > 0 {
			s.ack((s.expect-1)%s.cfg.Modulus, true)
		}
	} else {
		s.ack(e.seq, false)
	}
}

// ack resolves a wire sequence number to in-flight frames. Because the window
// is strictly less than half the modulus, in-flight sequence numbers span less
// than half the space and the resolution is unambiguous.
func (s *Sim) ack(seq int, cumulative bool) {
	if cumulative {
		for abs, f := range s.frames {
			if (seq-f.seq+s.cfg.Modulus)%s.cfg.Modulus < s.cfg.Modulus/2 {
				delete(s.frames, abs)
			}
		}
	} else {
		for abs, f := range s.frames {
			if f.seq == seq {
				delete(s.frames, abs)
				break
			}
		}
	}
	s.pump()
}

// onTimeout retransmits an unacknowledged frame whose current deadline
// matches the event; stale events (already acked or superseded) are ignored.
func (s *Sim) onTimeout(e event) {
	f, ok := s.frames[e.abs]
	if !ok || f.deadline != e.deadline {
		return
	}
	if f.retries >= s.cfg.MaxRetries {
		s.failed = append(s.failed, f.abs)
		delete(s.frames, f.abs)
		s.pump()
		return
	}
	f.retries++
	s.transmit(f)
}

// Snapshot captures the full simulator state, including per-frame deadlines
// and retry counts and the pending event queue.
type Snapshot struct {
	now        int
	window     int
	queue      []string
	frames     []frame
	next       int
	expect     int
	recvBuf    map[int]string
	delivered  []string
	trajectory []Transmission
	failed     []int
	events     []event
	order      uint64
}

// Snapshot returns a deep copy of the simulator state.
func (s *Sim) Snapshot() Snapshot {
	snap := Snapshot{
		now:        s.now,
		window:     s.window,
		next:       s.next,
		expect:     s.expect,
		order:      s.order,
		queue:      append([]string(nil), s.queue...),
		delivered:  append([]string(nil), s.delivered...),
		trajectory: append([]Transmission(nil), s.trajectory...),
		failed:     append([]int(nil), s.failed...),
		events:     append([]event(nil), s.events...),
		recvBuf:    make(map[int]string, len(s.recvBuf)),
	}
	for abs, data := range s.recvBuf {
		snap.recvBuf[abs] = data
	}
	absKeys := make([]int, 0, len(s.frames))
	for abs := range s.frames {
		absKeys = append(absKeys, abs)
	}
	sort.Ints(absKeys)
	for _, abs := range absKeys {
		snap.frames = append(snap.frames, *s.frames[abs])
	}
	return snap
}

// Restore replaces the simulator state with a deep copy of snap.
func (s *Sim) Restore(snap Snapshot) {
	s.now = snap.now
	s.window = snap.window
	s.next = snap.next
	s.expect = snap.expect
	s.order = snap.order
	s.queue = append([]string(nil), snap.queue...)
	s.delivered = append([]string(nil), snap.delivered...)
	s.trajectory = append([]Transmission(nil), snap.trajectory...)
	s.failed = append([]int(nil), snap.failed...)
	s.events = append(eventHeap(nil), snap.events...)
	heap.Init(&s.events)
	s.recvBuf = make(map[int]string, len(snap.recvBuf))
	for abs, data := range snap.recvBuf {
		s.recvBuf[abs] = data
	}
	s.frames = make(map[int]*frame, len(snap.frames))
	for _, f := range snap.frames {
		f := f
		s.frames[f.abs] = &f
	}
}

// Now returns the current tick.
func (s *Sim) Now() int { return s.now }

// Inflight returns the number of unacknowledged frames.
func (s *Sim) Inflight() int { return len(s.frames) }

// Complete reports whether every queued frame has been acknowledged.
func (s *Sim) Complete() bool { return len(s.queue) == 0 && len(s.frames) == 0 }

// Delivered returns the payloads delivered by the receiver, in order.
func (s *Sim) Delivered() []string { return append([]string(nil), s.delivered...) }

// Trajectory returns every physical transmission in order.
func (s *Sim) Trajectory() []Transmission {
	return append([]Transmission(nil), s.trajectory...)
}

// Failed returns the absolute numbers of frames that exhausted the retry limit.
func (s *Sim) Failed() []int { return append([]int(nil), s.failed...) }

// Frames returns the in-flight frames, sorted by absolute number.
func (s *Sim) Frames() []FrameState {
	absKeys := make([]int, 0, len(s.frames))
	for abs := range s.frames {
		absKeys = append(absKeys, abs)
	}
	sort.Ints(absKeys)
	out := make([]FrameState, 0, len(absKeys))
	for _, abs := range absKeys {
		f := s.frames[abs]
		out = append(out, FrameState{
			Abs: f.abs, Seq: f.seq, Data: f.data,
			Deadline: f.deadline, Retries: f.retries,
		})
	}
	return out
}
