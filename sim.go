// Package srx simulates a selective-repeat device transmission link.
//
// The sender numbers frames with wrap-around sequence numbers from a space
// of size Modulus and keeps at most Window frames in flight, with
// 2*Window < Modulus so wire sequence numbers can always be resolved
// unambiguously against the current window. The receiver acknowledges every
// frame both cumulatively (by frame number, covering all frames up to it)
// and selectively (that frame only); the sender retransmits only frames
// that are still unacknowledged, at most MaxRetries times each. When an
// acknowledgement and a retransmission timeout fall on the same simulated
// instant, the acknowledgement is processed first.
package srx

type eventKind int

const (
	evFrame   eventKind = iota // data frame arrives at the receiver
	evAck                      // acknowledgement arrives at the sender
	evTimeout                  // sender retransmission deadline
)

// event ordering at equal timestamps: frames first, then
// acknowledgements, then timeouts, so an acknowledgement always wins over
// a same-instant timeout.
type event struct {
	time     int
	kind     eventKind
	seq      int    // evFrame, evTimeout: absolute frame sequence number
	deadline int    // evTimeout: frame deadline this event was scheduled for
	data     []byte // evFrame: payload
	cum      bool   // evAck: cumulative (true) or selective (false)
	wire     int    // evAck: wire sequence number
	order    int    // insertion counter, stabilizes the queue
}

func (e event) less(o event) bool {
	if e.time != o.time {
		return e.time < o.time
	}
	if e.kind != o.kind {
		return e.kind < o.kind
	}
	return e.order < o.order
}

// LossFunc decides whether a transmission is dropped. n counts the
// transmissions of the same kind (data frames or acknowledgements) in
// order, starting at 0.
type LossFunc func(n int) bool

// Sim is a discrete-event simulation of one sender-receiver link.
type Sim struct {
	Time    int // current simulated time
	Latency int // one-way latency for frames and acknowledgements

	Sender   *Sender
	Receiver *Receiver

	dropFrame LossFunc
	dropAck   LossFunc

	events  []event
	order   int
	frameTx int
	ackTx   int
}

// NewSim creates a simulation and enqueues the given payloads at time 0.
// Either loss function may be nil (no losses).
func NewSim(latency int, sender *Sender, receiver *Receiver, dropFrame, dropAck LossFunc, data [][]byte) *Sim {
	if latency < 0 {
		panic("srx: negative latency")
	}
	s := &Sim{
		Latency:   latency,
		Sender:    sender,
		Receiver:  receiver,
		dropFrame: dropFrame,
		dropAck:   dropAck,
	}
	s.Enqueue(data...)
	return s
}

// Enqueue queues payloads for sending and transmits whatever the window
// currently allows.
func (s *Sim) Enqueue(data ...[]byte) {
	s.Sender.queue = append(s.Sender.queue, data...)
	s.pump()
}

// SetWindow resizes the send window and immediately resumes transmission
// if the window grew. In-flight frames are never dropped.
func (s *Sim) SetWindow(window int) error {
	if err := s.Sender.SetWindow(window); err != nil {
		return err
	}
	s.pump()
	return nil
}

func (s *Sim) pump() {
	for s.Sender.canSend() {
		s.transmit(s.Sender.allocFrame(), 0)
	}
}

// transmit puts one copy of f on the wire and arms its retransmission
// deadline.
func (s *Sim) transmit(f *Frame, attempt int) {
	sd := s.Sender
	sd.Log = append(sd.Log, SendRecord{
		Time:    s.Time,
		Seq:     f.Seq,
		Wire:    f.Seq % sd.Modulus,
		Attempt: attempt,
	})
	f.Deadline = s.Time + sd.Timeout
	n := s.frameTx
	s.frameTx++
	if s.dropFrame == nil || !s.dropFrame(n) {
		s.push(event{time: s.Time + s.Latency, kind: evFrame, seq: f.Seq, data: f.Data})
	}
	s.push(event{time: f.Deadline, kind: evTimeout, seq: f.Seq, deadline: f.Deadline})
}

func (s *Sim) push(ev event) {
	ev.order = s.order
	s.order++
	s.events = append(s.events, ev)
}

// Step processes the next event. It returns false when no events remain.
func (s *Sim) Step() bool {
	if len(s.events) == 0 {
		return false
	}
	best := 0
	for i := range s.events {
		if s.events[i].less(s.events[best]) {
			best = i
		}
	}
	ev := s.events[best]
	s.events = append(s.events[:best], s.events[best+1:]...)
	s.Time = ev.time
	switch ev.kind {
	case evFrame:
		s.onFrame(ev)
	case evAck:
		s.onAck(ev)
	case evTimeout:
		s.onTimeout(ev)
	}
	return true
}

// Run processes events until the simulation is quiescent.
func (s *Sim) Run() {
	for s.Step() {
	}
}

func (s *Sim) onFrame(ev event) {
	r := s.Receiver
	cum, sack := r.Receive(ev.seq%r.Modulus, ev.data)
	s.emitAck(true, cum)
	if sack >= 0 {
		s.emitAck(false, sack)
	}
}

func (s *Sim) emitAck(cum bool, abs int) {
	m := s.Sender.Modulus
	wire := ((abs % m) + m) % m
	n := s.ackTx
	s.ackTx++
	if s.dropAck != nil && s.dropAck(n) {
		return
	}
	s.push(event{time: s.Time + s.Latency, kind: evAck, cum: cum, wire: wire})
}

func (s *Sim) onAck(ev event) {
	sd := s.Sender
	if ev.cum {
		n := resolveSeq(ev.wire, sd.base, sd.Modulus)
		for seq := sd.base; seq <= n && seq < sd.next; seq++ {
			if f := sd.frames[seq]; f != nil {
				f.Acked = true
			}
		}
	} else {
		n := resolveSeq(ev.wire, sd.base, sd.Modulus)
		if f := sd.frames[n]; f != nil {
			f.Acked = true
		}
	}
	sd.slide()
	s.pump()
}

func (s *Sim) onTimeout(ev event) {
	sd := s.Sender
	f := sd.frames[ev.seq]
	if f == nil || f.Acked || f.Failed {
		return // already acknowledged (possibly at this same instant)
	}
	if f.Deadline != ev.deadline {
		return // stale deadline, a newer transmission superseded this one
	}
	if f.Retries >= sd.MaxRetries {
		f.Failed = true
		sd.slide()
		s.pump()
		return
	}
	f.Retries++
	s.transmit(f, f.Retries)
}

// Clone takes a deep snapshot of the whole simulation: endpoints, pending
// events and counters. Every in-flight frame keeps its original deadline
// and retransmission count, so resuming the clone replays the exact same
// send trajectory as the original.
func (s *Sim) Clone() *Sim {
	c := *s
	c.Sender = s.Sender.clone()
	c.Receiver = s.Receiver.clone()
	c.events = make([]event, len(s.events))
	for i, ev := range s.events {
		if ev.data != nil {
			ev.data = append([]byte(nil), ev.data...)
		}
		c.events[i] = ev
	}
	return &c
}
