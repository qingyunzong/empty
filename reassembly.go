// Package q212 reassembles captured TCP payloads per direction.
//
// Sequence numbers are handled modulo 2^32 exactly like TCP. The caller
// supplies the initial sequence number of every direction; all offsets
// reported by this package are stream-relative byte offsets starting at zero.
// The active receive window must stay strictly smaller than 2^31: a segment
// whose forward distance from the next expected byte is 2^31 or more cannot be
// told apart from ancient data and is rejected.
//
// Only the contiguous prefix is delivered. Overlapping bytes are merged when
// identical; the first disagreement freezes the whole connection.
package q212

import (
	"errors"
	"strconv"
	"sync"
)

// Direction identifies one of the two unidirectional byte streams carried by a
// TCP connection.
type Direction int

const (
	// ClientToServer is the direction initiated by the caller that owns the
	// connection's first initial sequence number.
	ClientToServer Direction = iota
	// ServerToClient is the opposite direction.
	ServerToClient
)

const (
	defaultMaxBuffered  = 1 << 20
	defaultHistoryBytes = 1 << 16
	halfSeqSpace        = int64(1) << 31
)

// Sentinel errors returned by Conn.Push.
var (
	// ErrFrozen means the connection was frozen earlier by a data conflict.
	ErrFrozen = errors.New("q212: connection frozen due to conflicting retransmission")
	// ErrClosed means the pushed packet arrives after the stream's FIN was
	// delivered, i.e. a late packet behind the end of stream.
	ErrClosed = errors.New("q212: packet arrives after stream closure")
	// ErrBackpressure means the per-connection buffered-byte limit would be
	// exceeded. The packet is not consumed and no state changes.
	ErrBackpressure = errors.New("q212: buffered byte limit exceeded, apply backpressure")
	// ErrOutsideWindow means the segment is not within the half-circle window
	// around the next expected sequence number.
	ErrOutsideWindow = errors.New("q212: segment lies outside the receive window")
)

// Options configures a reassembling connection. Zero values are replaced with
// sane defaults.
type Options struct {
	// MaxBufferedBytes caps the total undelivered (hole-buffered) bytes held
	// across both directions. A packet that would exceed the cap is rejected
	// with ErrBackpressure and remains unconsumed.
	MaxBufferedBytes int
	// HistoryBytes caps how many already-delivered bytes per direction are
	// retained so that later retransmissions can still be verified against
	// them. Bytes older than the retained suffix cannot be checked and are
	// accepted as duplicates.
	HistoryBytes int
}

// Conflict describes the first pair of packets whose overlapping bytes
// disagree. Offsets are stream-relative offsets from the direction's initial
// sequence number.
type Conflict struct {
	Direction  Direction
	At         uint64 // absolute stream offset of the first differing byte
	FirstOff   uint64 // starting offset of the earlier packet
	SecondOff  uint64 // starting offset of the conflicting packet
	FirstByte  byte
	SecondByte byte
}

func (c *Conflict) Error() string {
	return "q212: conflicting bytes at stream offset " + strconv.FormatUint(c.At, 10) +
		": packet at " + strconv.FormatUint(c.FirstOff, 10) +
		" and packet at " + strconv.FormatUint(c.SecondOff, 10)
}

// Result is the outcome of a Push call.
type Result struct {
	// Delivered holds the newly delivered contiguous prefix bytes. The slice
	// is owned by the caller and may be retained.
	Delivered []byte
	// Consumed reports whether the packet was consumed. It is false for
	// backpressure, window, frozen, closed and conflict rejections.
	Consumed bool
	// Closed is true when this push delivers the FIN and the stream ends.
	Closed bool
}

// Conn reassembles both directions of one TCP connection.
type Conn struct {
	mu       sync.Mutex
	streams  [2]*stream
	maxBuf   int
	frozen   bool
	conflict *Conflict
}

// NewConn creates a connection. initialSeq[ClientToServer] and
// initialSeq[ServerToClient] are the 32-bit sequence numbers of byte offset
// zero in each direction (typically the SYN sequence plus one).
func NewConn(initialSeq [2]uint32, opts *Options) *Conn {
	maxBuf := defaultMaxBuffered
	history := defaultHistoryBytes
	if opts != nil {
		if opts.MaxBufferedBytes > 0 {
			maxBuf = opts.MaxBufferedBytes
		}
		if opts.HistoryBytes > 0 {
			history = opts.HistoryBytes
		}
	}
	return &Conn{
		streams: [2]*stream{
			newStream(initialSeq[ClientToServer], history),
			newStream(initialSeq[ServerToClient], history),
		},
		maxBuf: maxBuf,
	}
}

// Push feeds one captured segment. seq is the TCP sequence number of the first
// payload byte (or of the FIN for an empty FIN segment), payload is the
// segment's data and fin is the FIN flag.
func (c *Conn) Push(dir Direction, seq uint32, payload []byte, fin bool) (Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if dir != ClientToServer && dir != ServerToClient {
		return Result{}, errors.New("q212: unknown direction")
	}
	if c.frozen {
		return Result{}, ErrFrozen
	}
	s := c.streams[dir]

	// Empty non-FIN packets (pure ACKs) carry no sequence-space information.
	if len(payload) == 0 && !fin {
		if s.closed {
			return Result{}, ErrClosed
		}
		return Result{Consumed: true}, nil
	}

	startDelta := seqDelta(seq, s.initialSeq)
	endDelta := startDelta + int64(len(payload))
	if fin {
		endDelta++ // FIN occupies one sequence number.
	}

	// Modular window check: the occupied sequence range must lie inside the
	// open half-circle around the next expected byte.
	nextDelta := int64(s.delivered)
	if startDelta > nextDelta && startDelta-nextDelta >= halfSeqSpace {
		return Result{}, ErrOutsideWindow
	}
	if endDelta > nextDelta && endDelta-nextDelta > halfSeqSpace {
		return Result{}, ErrOutsideWindow
	}

	if fin {
		finOffset := startDelta + int64(len(payload))
		if s.haveFin && s.finOffset != finOffset {
			cf := &Conflict{Direction: dir, At: uint64(minInt64(s.finOffset, finOffset))}
			if s.finOffset < finOffset {
				cf.FirstOff, cf.SecondOff = uint64(s.finOffset), uint64(finOffset)
			} else {
				cf.FirstOff, cf.SecondOff = uint64(finOffset), uint64(s.finOffset)
			}
			return Result{}, c.freeze(cf)
		}
		s.haveFin = true
		s.finOffset = finOffset
	}

	if s.closed {
		return Result{}, ErrClosed
	}

	// Data entirely before the stream start is stale.
	if endDelta <= 0 {
		return Result{}, ErrOutsideWindow
	}

	trim := int64(0)
	if startDelta < 0 {
		trim = -startDelta
	}
	trimmedStart := startDelta + trim
	trimmed := payload[trim:]

	// Split the segment into already-delivered bytes (verified via history)
	// and fresh bytes (checked against buffered segments, then stored).
	if uint64(trimmedStart) < s.delivered {
		overlap := int64(s.delivered) - trimmedStart
		if overlap > int64(len(trimmed)) {
			overlap = int64(len(trimmed))
		}
		if cf := s.history.compare(dir, uint64(trimmedStart), trimmed[:overlap]); cf != nil {
			return Result{}, c.freeze(cf)
		}
		trimmed = trimmed[overlap:]
		trimmedStart += overlap
	}

	res := Result{}
	if len(trimmed) > 0 {
		if cf := s.conflictPending(dir, uint64(trimmedStart), trimmed); cf != nil {
			return Result{}, c.freeze(cf)
		}

		saved := s.snapshot()
		s.insertPending(uint64(trimmedStart), trimmed)
		if s.pendingAfterDrainTotal()+c.otherPendingAfterDrain(dir) > c.maxBuf {
			s.restore(saved)
			return Result{}, ErrBackpressure
		}
	}

	res.Consumed = true
	out := s.drain()
	if len(out) > 0 {
		res.Delivered = out
	}
	res.Closed = s.closed
	return res, nil
}

func (c *Conn) freeze(cf *Conflict) error {
	c.frozen = true
	c.conflict = cf
	return ErrFrozen
}

func (c *Conn) otherPendingAfterDrain(dir Direction) int {
	return c.streams[dir^1].pendingAfterDrainTotal()
}

// Frozen reports whether the connection has been stopped by a conflict.
func (c *Conn) Frozen() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.frozen
}

// Conflict returns the conflict that froze the connection, or nil.
func (c *Conn) Conflict() *Conflict {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conflict
}

// Delivered returns the number of contiguous bytes delivered in a direction.
func (c *Conn) Delivered(dir Direction) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.streams[dir].delivered
}

// Buffered returns the undelivered bytes currently held for a direction.
func (c *Conn) Buffered(dir Direction) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.streams[dir].pendingTotal()
}

// Closed reports whether the FIN of a direction has been delivered.
func (c *Conn) Closed(dir Direction) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.streams[dir].closed
}

// seqDelta returns seq-isn as a signed 32-bit modular difference. Values in
// [0, 2^31) mean "ahead"; values in [-2^31+1, -1] mean "behind". -2^31 is
// ambiguous modulo 2^32 and callers reject it as outside the half-circle.
func seqDelta(seq, isn uint32) int64 {
	return int64(int32(seq - isn))
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func minUint64(a, b uint64) uint64 {
	if a < b {
		return a
	}
	return b
}

func maxUint64(a, b uint64) uint64 {
	if a > b {
		return a
	}
	return b
}
