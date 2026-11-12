package dataeng

import "errors"

// Op is a boolean binary operator applied row-wise to two columns.
type Op int

const (
	OpAnd Op = iota
	OpOr
	OpXor
)

// ErrLengthMismatch is returned when the two input streams do not cover
// the same number of rows.
var ErrLengthMismatch = errors.New("dataeng: input streams have different lengths")

func (op Op) apply(a, b bool) bool {
	switch op {
	case OpAnd:
		return a && b
	case OpOr:
		return a || b
	case OpXor:
		return a != b
	}
	return false
}

// Apply combines two encoded boolean columns row-wise with op and returns
// the result normalized into maximal same-value run segments, without
// expanding either input in full.
//
// Both inputs are fully validated before any output is produced: on any
// error (malformed segment, length overflow, or length mismatch) the
// returned slice is nil and no partial result is exposed.
func Apply(op Op, a, b []Segment) ([]Segment, error) {
	la, err := validateStream(a)
	if err != nil {
		return nil, err
	}
	lb, err := validateStream(b)
	if err != nil {
		return nil, err
	}
	if la != lb {
		return nil, ErrLengthMismatch
	}

	ca, cb := cursor{segs: a}, cursor{segs: b}
	var out []Segment
	for {
		av, an, aok := ca.current()
		bv, bn, bok := cb.current()
		if !aok || !bok {
			break
		}
		n := an
		if bn < n {
			n = bn
		}
		out = appendRun(out, op.apply(av, bv), n)
		ca.advance(n)
		cb.advance(n)
	}
	return out, nil
}

// And returns the row-wise conjunction of a and b as normalized runs.
func And(a, b []Segment) ([]Segment, error) { return Apply(OpAnd, a, b) }

// Or returns the row-wise disjunction of a and b as normalized runs.
func Or(a, b []Segment) ([]Segment, error) { return Apply(OpOr, a, b) }

// Xor returns the row-wise exclusive-or of a and b as normalized runs.
func Xor(a, b []Segment) ([]Segment, error) { return Apply(OpXor, a, b) }

// appendRun appends n copies of value, merging into the trailing run when
// it has the same value so the output stays maximally coalesced. The sum
// of all appended counts never exceeds the (already validated) total
// input length, so the count addition cannot overflow.
func appendRun(out []Segment, value bool, n uint64) []Segment {
	if n == 0 {
		return out
	}
	if last := len(out) - 1; last >= 0 && out[last].Value == value {
		out[last].Count += n
		return out
	}
	return append(out, Run(value, n))
}

// cursor walks a segment stream without materializing it.
type cursor struct {
	segs []Segment
	seg  int
	off  uint64
}

// current returns the value and remaining length of the piece under the
// cursor, skipping zero-length segments. ok is false once the stream is
// exhausted.
func (c *cursor) current() (value bool, remaining uint64, ok bool) {
	for c.seg < len(c.segs) {
		s := c.segs[c.seg]
		switch s.Kind {
		case RunKind:
			if c.off < s.Count {
				return s.Value, s.Count - c.off, true
			}
		case LiteralKind:
			if c.off < s.ValidBits {
				v, n := s.runFrom(c.off)
				return v, n, true
			}
		}
		c.seg++
		c.off = 0
	}
	return false, 0, false
}

// advance consumes n rows; n never exceeds the remaining length reported
// by current.
func (c *cursor) advance(n uint64) {
	c.off += n
}
