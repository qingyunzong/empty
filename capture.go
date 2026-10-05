package executor

// StreamSummary describes a captured stream: the retained prefix and tail,
// plus counts for everything that was only counted, not stored.
type StreamSummary struct {
	Prefix  []byte
	Tail    []byte
	Total   int64
	Dropped int64
}

// capture retains at most prefixBudget leading bytes and tailBudget trailing
// bytes of a stream. Everything in between is counted but not stored.
type capture struct {
	prefixBudget int
	tailBudget   int
	prefix       []byte
	tail         []byte
	total        int64
}

func newCapture(prefixBudget, tailBudget int) *capture {
	if prefixBudget < 0 {
		prefixBudget = 0
	}
	if tailBudget < 0 {
		tailBudget = 0
	}
	return &capture{prefixBudget: prefixBudget, tailBudget: tailBudget}
}

func (c *capture) Write(p []byte) (int, error) {
	n := len(p)
	c.total += int64(n)

	if rest := c.prefixBudget - len(c.prefix); rest > 0 {
		if rest > len(p) {
			rest = len(p)
		}
		c.prefix = append(c.prefix, p[:rest]...)
		p = p[rest:]
	}

	if c.tailBudget > 0 && len(p) > 0 {
		if len(p) >= c.tailBudget {
			c.tail = append(c.tail[:0], p[len(p)-c.tailBudget:]...)
		} else {
			c.tail = append(c.tail, p...)
			if len(c.tail) > c.tailBudget {
				c.tail = c.tail[len(c.tail)-c.tailBudget:]
			}
		}
	}
	return n, nil
}

func (c *capture) summary() StreamSummary {
	return StreamSummary{
		Prefix:  c.prefix,
		Tail:    c.tail,
		Total:   c.total,
		Dropped: c.total - int64(len(c.prefix)) - int64(len(c.tail)),
	}
}
