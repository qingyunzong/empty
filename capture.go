package executor

// Stats summarizes how a captured stream was retained.
type Stats struct {
	Total    int64 // bytes seen on the stream
	Retained int   // bytes kept (prefix + tail)
	Dropped  int64 // middle bytes counted but not kept
}

// Capture is an io.Writer that retains the head and tail of a stream within
// a fixed byte budget. Bytes in the middle that do not fit the budget are
// dropped and only counted. Capture is not safe for concurrent use; Run
// feeds each Capture from a single goroutine.
type Capture struct {
	prefixLimit int
	tailLimit   int
	prefix      []byte
	tail        []byte // ring buffer of the most recent tailLimit bytes
	tailStart   int    // ring position of the oldest retained byte
	tailLen     int    // number of valid bytes in the ring
	total       int64
}

// NewCapture returns a Capture that keeps at most budget bytes, split
// between a prefix (first half) and a tail (second half).
func NewCapture(budget int) *Capture {
	if budget < 0 {
		budget = 0
	}
	prefixLimit := budget / 2
	return &Capture{
		prefixLimit: prefixLimit,
		tailLimit:   budget - prefixLimit,
		tail:        make([]byte, budget-prefixLimit),
	}
}

// Write implements io.Writer. It never fails and always consumes p fully.
func (c *Capture) Write(p []byte) (int, error) {
	n := len(p)
	c.total += int64(n)
	if n := c.prefixLimit - len(c.prefix); n > 0 {
		if n > len(p) {
			n = len(p)
		}
		c.prefix = append(c.prefix, p[:n]...)
		p = p[n:]
	}
	c.writeTail(p)
	return n, nil
}

func (c *Capture) writeTail(p []byte) {
	if c.tailLimit == 0 || len(p) == 0 {
		return
	}
	if len(p) >= c.tailLimit {
		copy(c.tail, p[len(p)-c.tailLimit:])
		c.tailStart = 0
		c.tailLen = c.tailLimit
		return
	}
	for len(p) > 0 {
		if c.tailLen < c.tailLimit {
			pos := (c.tailStart + c.tailLen) % c.tailLimit
			n := c.tailLimit - pos
			if n > len(p) {
				n = len(p)
			}
			copy(c.tail[pos:pos+n], p[:n])
			c.tailLen += n
			p = p[n:]
		} else {
			n := c.tailLimit - c.tailStart
			if n > len(p) {
				n = len(p)
			}
			copy(c.tail[c.tailStart:c.tailStart+n], p[:n])
			c.tailStart = (c.tailStart + n) % c.tailLimit
			p = p[n:]
		}
	}
}

// Prefix returns the retained head of the stream.
func (c *Capture) Prefix() []byte {
	out := make([]byte, len(c.prefix))
	copy(out, c.prefix)
	return out
}

// Tail returns the retained tail of the stream, oldest byte first.
func (c *Capture) Tail() []byte {
	out := make([]byte, c.tailLen)
	n := copy(out, c.tail[c.tailStart:])
	copy(out[n:], c.tail[:c.tailStart])
	return out
}

// Stats reports total, retained and dropped byte counts.
func (c *Capture) Stats() Stats {
	return Stats{
		Total:    c.total,
		Retained: len(c.prefix) + c.tailLen,
		Dropped:  c.total - int64(len(c.prefix)) - int64(c.tailLen),
	}
}

// Truncated reports whether any middle bytes were dropped.
func (c *Capture) Truncated() bool {
	return c.Stats().Dropped > 0
}
