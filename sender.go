package srx

import "fmt"

// Frame is one in-flight frame tracked by the sender.
type Frame struct {
	Seq      int    // absolute sequence number
	Data     []byte // payload
	Deadline int    // absolute time of the current retransmission deadline
	Retries  int    // number of retransmissions so far
	Acked    bool   // acknowledged (cumulatively or selectively)
	Failed   bool   // retransmission limit reached, given up
}

// SendRecord is one transmission on the wire; the ordered list of records is
// the send trajectory of a simulation run.
type SendRecord struct {
	Time    int
	Seq     int // absolute sequence number
	Wire    int // sequence number on the wire (Seq % Modulus)
	Attempt int // 0 for the first transmission, k for the k-th retransmission
}

// Sender is the sending endpoint of the simulated link.
type Sender struct {
	Modulus    int // sequence number space size
	Window     int // send window, must satisfy 2*Window < Modulus
	MaxRetries int // retransmission limit per frame
	Timeout    int // retransmission timeout (in time units)

	base   int            // oldest unacknowledged absolute sequence number
	next   int            // next absolute sequence number to assign
	frames map[int]*Frame // in-flight frames by absolute sequence number
	queue  [][]byte       // payloads accepted but not yet sent
	Log    []SendRecord   // send trajectory
}

func NewSender(modulus, window, maxRetries, timeout int) (*Sender, error) {
	if err := checkWindow(modulus, window); err != nil {
		return nil, err
	}
	if maxRetries < 0 {
		return nil, fmt.Errorf("srx: maxRetries must be >= 0")
	}
	if timeout <= 0 {
		return nil, fmt.Errorf("srx: timeout must be > 0")
	}
	return &Sender{
		Modulus:    modulus,
		Window:     window,
		MaxRetries: maxRetries,
		Timeout:    timeout,
		frames:     map[int]*Frame{},
	}, nil
}

func checkWindow(modulus, window int) error {
	if modulus < 2 {
		return fmt.Errorf("srx: modulus must be >= 2")
	}
	if window < 1 || 2*window >= modulus {
		return fmt.Errorf("srx: window %d invalid: need 1 <= window and 2*window < modulus %d", window, modulus)
	}
	return nil
}

// SetWindow resizes the send window, possibly while frames are still
// unacknowledged. Shrinking never drops in-flight frames: it only stops new
// transmissions until the number of unacknowledged frames falls below the
// new window.
func (s *Sender) SetWindow(window int) error {
	if err := checkWindow(s.Modulus, window); err != nil {
		return err
	}
	s.Window = window
	return nil
}

// InFlight returns the number of outstanding (sent, not yet slid past)
// frames.
func (s *Sender) InFlight() int { return s.next - s.base }

func (s *Sender) canSend() bool {
	return len(s.queue) > 0 && s.next-s.base < s.Window
}

func (s *Sender) allocFrame() *Frame {
	f := &Frame{Seq: s.next, Data: s.queue[0]}
	s.queue = s.queue[1:]
	s.frames[f.Seq] = f
	s.next++
	return f
}

// slide advances the base past acknowledged and failed frames.
func (s *Sender) slide() {
	for {
		f, ok := s.frames[s.base]
		if !ok || (!f.Acked && !f.Failed) {
			return
		}
		delete(s.frames, s.base)
		s.base++
	}
}

func (s *Sender) clone() *Sender {
	c := *s
	c.frames = make(map[int]*Frame, len(s.frames))
	for k, f := range s.frames {
		fc := *f
		fc.Data = append([]byte(nil), f.Data...)
		c.frames[k] = &fc
	}
	c.queue = make([][]byte, len(s.queue))
	for i, d := range s.queue {
		c.queue[i] = append([]byte(nil), d...)
	}
	c.Log = append([]SendRecord(nil), s.Log...)
	return &c
}
