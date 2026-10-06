package srx

// Receiver is the receiving endpoint: it buffers out-of-order frames and
// delivers every frame's payload to the application exactly once, in order.
type Receiver struct {
	Modulus int
	Window  int

	expect     int            // next absolute sequence number to deliver
	buf        map[int][]byte // buffered out-of-order frames
	Delivered  [][]byte       // payloads delivered in order
	Duplicates int            // frames received more than once
}

func NewReceiver(modulus, window int) (*Receiver, error) {
	if err := checkWindow(modulus, window); err != nil {
		return nil, err
	}
	return &Receiver{Modulus: modulus, Window: window, buf: map[int][]byte{}}, nil
}

// Receive processes one incoming frame carrying the given wire sequence
// number. It returns the absolute sequence numbers to put in the cumulative
// acknowledgement (every frame up to and including it is received) and the
// selective acknowledgement; the selective return is -1 when the frame fell
// outside the receive window.
func (r *Receiver) Receive(wire int, data []byte) (cum, sack int) {
	abs := resolveSeq(wire, r.expect, r.Modulus)
	switch {
	case abs < r.expect:
		// Already delivered: duplicate, acknowledge again but never
		// deliver twice.
		r.Duplicates++
	case abs >= r.expect+r.Window:
		return r.expect - 1, -1
	default:
		if _, ok := r.buf[abs]; ok {
			r.Duplicates++
		} else {
			r.buf[abs] = append([]byte(nil), data...)
		}
		for {
			d, ok := r.buf[r.expect]
			if !ok {
				break
			}
			r.Delivered = append(r.Delivered, d)
			delete(r.buf, r.expect)
			r.expect++
		}
	}
	return r.expect - 1, abs
}

func (r *Receiver) clone() *Receiver {
	c := *r
	c.buf = make(map[int][]byte, len(r.buf))
	for k, v := range r.buf {
		c.buf[k] = append([]byte(nil), v...)
	}
	c.Delivered = make([][]byte, len(r.Delivered))
	for i, d := range r.Delivered {
		c.Delivered[i] = append([]byte(nil), d...)
	}
	return &c
}
