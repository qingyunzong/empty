package formal

import (
	"bytes"
	"errors"
	"fmt"
	"sync"
	"time"
)

const (
	defaultMaxMemory = 4 << 20
	defaultMaxPacket = 1 << 20
	defaultTimeout   = 30 * time.Second
	maxInt           = int(^uint(0) >> 1)
)

var (
	// ErrInvalidFragment reports a malformed fragment description, such as a
	// negative offset or a total length shorter than the fragment itself.
	ErrInvalidFragment = errors.New("reassembly: invalid fragment")

	// ErrOverlapConflict reports a fragment whose bytes disagree with an
	// already stored fragment. The affected datagram is discarded.
	ErrOverlapConflict = errors.New("reassembly: conflicting overlap")

	// ErrTotalMismatch reports a fragment that declares a different total
	// length than the one already established for its datagram.
	ErrTotalMismatch = errors.New("reassembly: inconsistent total length")

	// ErrFragmentOutOfBounds reports a fragment that extends beyond the
	// datagram's established total length.
	ErrFragmentOutOfBounds = errors.New("reassembly: fragment outside datagram")

	// ErrPacketTooLarge reports a fragment or datagram larger than
	// Config.MaxPacketSize.
	ErrPacketTooLarge = errors.New("reassembly: packet exceeds size limit")

	// ErrMemoryLimit reports that accepting the fragment would exceed
	// Config.MaxMemory, even after evicting other datagrams.
	ErrMemoryLimit = errors.New("reassembly: memory limit exceeded")
)

// Key identifies one datagram being reassembled on one tunnel.
type Key struct {
	TunnelID uint64
	PacketID uint32
}

func (k Key) String() string {
	return fmt.Sprintf("tunnel=%d packet=%d", k.TunnelID, k.PacketID)
}

// Fragment is one piece of a tunnel datagram.
//
// Offset is the byte offset of Data in the complete datagram. Data is copied
// before Add returns, so the caller may reuse the receive buffer immediately.
//
// Last marks the fragment that ends the datagram and establishes the total
// length as Offset+len(Data). Total is an alternative way to establish the
// length when the tunnel protocol carries it explicitly; zero means unknown.
// If both are supplied they must agree.
type Fragment struct {
	Key    Key
	Offset int
	Data   []byte
	Last   bool
	Total  int
}

// Config controls limits and expiry. Zero values select the defaults:
// 4 MiB of payload memory, 1 MiB per datagram, and a 30 second timeout.
// A negative value is rejected by New.
type Config struct {
	// MaxMemory is the maximum number of fragment payload bytes retained
	// across all incomplete datagrams.
	MaxMemory int64

	// MaxPacketSize is the maximum total length of one datagram.
	MaxPacketSize int

	// Timeout is measured from the arrival of the first fragment. Duplicates
	// and later fragments do not extend the deadline.
	Timeout time.Duration

	// Clock supplies the current time. It is only used by Add and Expire;
	// the AddAt and ExpireAt variants take an explicit time. A nil Clock uses
	// time.Now.
	Clock func() time.Time
}

// Result describes the effect of one Add call.
type Result struct {
	// Complete is true when this fragment completed the datagram. Data owns
	// the assembled bytes and must not be modified by the reassembler anymore.
	Complete bool
	Data     []byte

	// Duplicate is true when Data introduced no new byte ranges.
	Duplicate bool

	// NewBytes is the number of payload bytes newly charged by this call.
	NewBytes int64

	// Expired and Evicted list datagrams removed before or while accepting the
	// fragment. They are ordered by the eviction policy: earliest deadline
	// first, then oldest arrival sequence.
	Expired []Key
	Evicted []Key
}

// Stats is a snapshot of reassembler state and counters.
type Stats struct {
	MemoryUsed int64
	Packets    int
	Completed  uint64
	Duplicates uint64
	Conflicts  uint64
	Expired    uint64
	Evicted    uint64
	Rejected   uint64
}

// FragmentError adds the datagram identity and an optional detail to a
// classification error. Use errors.Is to test the classification.
type FragmentError struct {
	Kind   error
	Key    Key
	Detail string
}

func (e *FragmentError) Error() string {
	if e.Detail == "" {
		return fmt.Sprintf("%v: %s", e.Kind, e.Key)
	}
	return fmt.Sprintf("%v: %s: %s", e.Kind, e.Key, e.Detail)
}

func (e *FragmentError) Unwrap() error { return e.Kind }

// Reassembler collects out-of-order fragments. It is safe for concurrent use.
// It never blocks on packet-sized I/O and never starts a goroutine.
type Reassembler struct {
	mu sync.Mutex

	maxMemory int64
	maxPacket int
	timeout   time.Duration
	clock     func() time.Time

	packets map[Key]*packet
	heap    packetHeap
	used    int64
	nextSeq uint64

	completed  uint64
	duplicates uint64
	conflicts  uint64
	expired    uint64
	evicted    uint64
	rejected   uint64
}

// New creates a reassembler. It returns an error for negative limits or a
// negative timeout.
func New(cfg Config) (*Reassembler, error) {
	if cfg.MaxMemory < 0 {
		return nil, fmt.Errorf("reassembly: negative MaxMemory %d", cfg.MaxMemory)
	}
	if cfg.MaxPacketSize < 0 {
		return nil, fmt.Errorf("reassembly: negative MaxPacketSize %d", cfg.MaxPacketSize)
	}
	if cfg.Timeout < 0 {
		return nil, fmt.Errorf("reassembly: negative Timeout %s", cfg.Timeout)
	}
	if cfg.MaxMemory == 0 {
		cfg.MaxMemory = defaultMaxMemory
	}
	if cfg.MaxPacketSize == 0 {
		cfg.MaxPacketSize = defaultMaxPacket
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = defaultTimeout
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	return &Reassembler{
		maxMemory: cfg.MaxMemory,
		maxPacket: cfg.MaxPacketSize,
		timeout:   cfg.Timeout,
		clock:     cfg.Clock,
		packets:   make(map[Key]*packet),
	}, nil
}

// Add processes a fragment using the configured clock.
func (r *Reassembler) Add(f Fragment) (Result, error) {
	return r.AddAt(f, time.Time{})
}

// AddAt processes a fragment at an explicit time. A zero time means "use the
// configured clock". Datagrams whose deadline is at or before now are expired
// first.
func (r *Reassembler) AddAt(f Fragment, now time.Time) (Result, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	now = r.nowLocked(now)
	res := Result{Expired: r.expireLocked(now)}

	end, total, totalKnown, kind, detail := r.validate(f)
	if kind != nil {
		r.rejected++
		return res, r.fragmentError(kind, f.Key, detail)
	}

	p := r.packets[f.Key]
	if p != nil {
		if p.totalKnown && totalKnown && p.total != total {
			r.conflicts++
			r.rejected++
			r.discardLocked(p)
			return res, r.fragmentError(ErrTotalMismatch, f.Key,
				fmt.Sprintf("have %d, got %d", p.total, total))
		}
		if p.totalKnown && end > p.total {
			r.conflicts++
			r.rejected++
			r.discardLocked(p)
			return res, r.fragmentError(ErrFragmentOutOfBounds, f.Key,
				fmt.Sprintf("end %d beyond total %d", end, p.total))
		}
		if totalKnown && !p.totalKnown && p.maxEnd() > total {
			r.conflicts++
			r.rejected++
			r.discardLocked(p)
			return res, r.fragmentError(ErrFragmentOutOfBounds, f.Key,
				fmt.Sprintf("stored data extends beyond total %d", total))
		}
		if p.conflictsWith(f.Offset, f.Data) {
			r.conflicts++
			r.rejected++
			r.discardLocked(p)
			return res, r.fragmentError(ErrOverlapConflict, f.Key,
				fmt.Sprintf("offset=%d length=%d", f.Offset, len(f.Data)))
		}
	}

	base := int64(0)
	if p != nil {
		base = p.bytes
	}
	newBytes := int64(len(f.Data))
	if p != nil {
		newBytes -= p.coveredBytes(f.Offset, len(f.Data))
	}
	if newBytes < 0 {
		newBytes = 0
	}
	if newBytes > r.maxMemory || newBytes > r.maxMemory-base {
		r.rejected++
		return res, r.fragmentError(ErrMemoryLimit, f.Key,
			fmt.Sprintf("need %d bytes, %d of %d in use", newBytes, r.used, r.maxMemory))
	}

	res.Evicted = r.makeRoomLocked(p, newBytes)

	if p == nil {
		p = &packet{
			key:        f.Key,
			deadline:   now.Add(r.timeout),
			seq:        r.nextSeq,
			total:      total,
			totalKnown: totalKnown,
		}
		r.nextSeq++
		r.packets[f.Key] = p
		heapPush(&r.heap, p)
	} else if totalKnown && !p.totalKnown {
		p.total = total
		p.totalKnown = true
	}

	if len(f.Data) > 0 {
		added, duplicate := p.insert(f.Offset, f.Data)
		p.bytes += int64(added)
		r.used += int64(added)
		res.NewBytes = int64(added)
		if duplicate {
			res.Duplicate = true
			r.duplicates++
		}
	}

	if data, ok := p.assemble(); ok {
		res.Complete = true
		res.Data = data
		r.discardLocked(p)
		r.completed++
	}
	return res, nil
}

// Expire removes datagrams at or past their deadline using the configured
// clock. It returns the removed keys in deadline/arrival order.
func (r *Reassembler) Expire() []Key {
	return r.ExpireAt(time.Time{})
}

// ExpireAt is Expire with an explicit time. A zero time means "use the
// configured clock".
func (r *Reassembler) ExpireAt(now time.Time) []Key {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.expireLocked(r.nowLocked(now))
}

// Remove discards one incomplete datagram and releases all of its accounting.
func (r *Reassembler) Remove(key Key) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.packets[key]
	if p == nil {
		return false
	}
	r.discardLocked(p)
	return true
}

// MemoryUsed returns the currently charged payload bytes.
func (r *Reassembler) MemoryUsed() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.used
}

// Pending returns the number of incomplete datagrams.
func (r *Reassembler) Pending() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.packets)
}

// Stats returns a consistent snapshot.
func (r *Reassembler) Stats() Stats {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Stats{
		MemoryUsed: r.used,
		Packets:    len(r.packets),
		Completed:  r.completed,
		Duplicates: r.duplicates,
		Conflicts:  r.conflicts,
		Expired:    r.expired,
		Evicted:    r.evicted,
		Rejected:   r.rejected,
	}
}

// Reset discards all state, releases all accounting, and clears counters.
func (r *Reassembler) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.packets = make(map[Key]*packet)
	r.heap = nil
	r.used = 0
	r.nextSeq = 0
	r.completed = 0
	r.duplicates = 0
	r.conflicts = 0
	r.expired = 0
	r.evicted = 0
	r.rejected = 0
}

func (r *Reassembler) nowLocked(now time.Time) time.Time {
	if now.IsZero() {
		return r.clock()
	}
	return now
}

func (r *Reassembler) validate(f Fragment) (end, total int, totalKnown bool, kind error, detail string) {
	if f.Offset < 0 {
		return 0, 0, false, ErrInvalidFragment, fmt.Sprintf("negative offset %d", f.Offset)
	}
	if f.Total < 0 {
		return 0, 0, false, ErrInvalidFragment, fmt.Sprintf("negative total %d", f.Total)
	}
	if len(f.Data) > maxInt-f.Offset {
		return 0, 0, false, ErrInvalidFragment, "offset plus length overflows int"
	}
	end = f.Offset + len(f.Data)
	if end > r.maxPacket {
		return 0, 0, false, ErrPacketTooLarge,
			fmt.Sprintf("fragment end %d exceeds limit %d", end, r.maxPacket)
	}

	switch {
	case f.Total > 0:
		total = f.Total
		totalKnown = true
		if total < end {
			return 0, 0, false, ErrInvalidFragment,
				fmt.Sprintf("total %d shorter than fragment end %d", total, end)
		}
		if f.Last && total != end {
			return 0, 0, false, ErrInvalidFragment,
				fmt.Sprintf("last fragment ends at %d but total is %d", end, total)
		}
	case f.Last:
		total = end
		totalKnown = true
	}
	if totalKnown && total > r.maxPacket {
		return 0, 0, false, ErrPacketTooLarge,
			fmt.Sprintf("total %d exceeds limit %d", total, r.maxPacket)
	}
	return end, total, totalKnown, nil, ""
}

func (r *Reassembler) fragmentError(kind error, key Key, detail string) error {
	return &FragmentError{Kind: kind, Key: key, Detail: detail}
}

func (r *Reassembler) expireLocked(now time.Time) []Key {
	var expired []Key
	for len(r.heap) > 0 && !r.heap[0].deadline.After(now) {
		p := heapPop(&r.heap)
		r.discardPoppedLocked(p)
		r.expired++
		expired = append(expired, p.key)
	}
	return expired
}

// makeRoomLocked evicts incomplete datagrams until need additional bytes fit.
// exclude, when non-nil, is the datagram being updated and is never evicted.
// The caller has already checked that exclude's own bytes plus need fit.
func (r *Reassembler) makeRoomLocked(exclude *packet, need int64) []Key {
	if need <= r.maxMemory-r.used {
		return nil
	}

	excluded := false
	if exclude != nil {
		heapRemove(&r.heap, exclude)
		excluded = true
	}

	var evicted []Key
	for need > r.maxMemory-r.used && len(r.heap) > 0 {
		victim := heapPop(&r.heap)
		r.discardPoppedLocked(victim)
		r.evicted++
		evicted = append(evicted, victim.key)
	}

	if excluded {
		heapPush(&r.heap, exclude)
	}
	return evicted
}

func (r *Reassembler) discardLocked(p *packet) {
	if p.index >= 0 {
		heapRemove(&r.heap, p)
	}
	r.discardPoppedLocked(p)
}

func (r *Reassembler) discardPoppedLocked(p *packet) {
	if r.packets[p.key] == p {
		delete(r.packets, p.key)
		r.used -= p.bytes
	}
}

type segment struct {
	start int
	data  []byte
}

func (s segment) end() int { return s.start + len(s.data) }

type packet struct {
	key        Key
	deadline   time.Time
	seq        uint64
	index      int
	total      int
	totalKnown bool
	segs       []segment
	bytes      int64
}

func (p *packet) maxEnd() int {
	if len(p.segs) == 0 {
		return 0
	}
	return p.segs[len(p.segs)-1].end()
}

// conflictsWith reports whether data disagrees with bytes already stored.
func (p *packet) conflictsWith(start int, data []byte) bool {
	end := start + len(data)
	for _, s := range p.segs {
		lo := max(start, s.start)
		hi := min(end, s.end())
		if lo >= hi {
			continue
		}
		if !bytes.Equal(data[lo-start:hi-start], s.data[lo-s.start:hi-s.start]) {
			return true
		}
	}
	return false
}

// coveredBytes counts how many bytes of [start, start+length) are already
// present. Segments are disjoint, so no byte is counted twice.
func (p *packet) coveredBytes(start, length int) int64 {
	end := start + length
	var covered int
	for _, s := range p.segs {
		lo := max(start, s.start)
		hi := min(end, s.end())
		if lo < hi {
			covered += hi - lo
		}
	}
	return int64(covered)
}

// insert stores only the ranges that are not already present. Existing
// segments are never rewritten, so sequential fragments do not cause repeated
// copies of earlier data. Overlap has already been verified to be
// byte-identical. It returns the newly charged bytes and whether the fragment
// added no new byte range.
func (p *packet) insert(start int, data []byte) (added int, duplicate bool) {
	if len(data) == 0 {
		return 0, true
	}
	end := start + len(data)
	duplicate = p.coveredBytes(start, len(data)) == int64(len(data))
	if duplicate {
		return 0, true
	}

	var fresh []segment
	cursor := start
	i := 0
	for i < len(p.segs) && p.segs[i].end() <= start {
		i++
	}
	for ; i < len(p.segs) && p.segs[i].start < end; i++ {
		s := p.segs[i]
		if s.start > cursor {
			gapEnd := min(s.start, end)
			if cursor < gapEnd {
				fresh = append(fresh, segment{
					start: cursor,
					data:  append([]byte(nil), data[cursor-start:gapEnd-start]...),
				})
				cursor = gapEnd
			}
		}
		if s.end() > cursor {
			cursor = s.end()
		}
		if cursor >= end {
			break
		}
	}
	if cursor < end {
		fresh = append(fresh, segment{
			start: cursor,
			data:  append([]byte(nil), data[cursor-start:]...),
		})
	}

	merged := make([]segment, 0, len(p.segs)+len(fresh))
	i, j := 0, 0
	for i < len(p.segs) || j < len(fresh) {
		if j == len(fresh) || (i < len(p.segs) && p.segs[i].start < fresh[j].start) {
			merged = append(merged, p.segs[i])
			i++
			continue
		}
		merged = append(merged, fresh[j])
		added += len(fresh[j].data)
		j++
	}
	p.segs = merged
	return added, false
}

func (p *packet) assemble() ([]byte, bool) {
	if !p.totalKnown {
		return nil, false
	}
	if p.total == 0 {
		return []byte{}, true
	}

	pos := 0
	for _, s := range p.segs {
		if s.start != pos {
			return nil, false
		}
		pos = s.end()
		if pos >= p.total {
			break
		}
	}
	if pos != p.total {
		return nil, false
	}

	if len(p.segs) == 1 {
		return p.segs[0].data, true
	}
	out := make([]byte, p.total)
	for _, s := range p.segs {
		hi := min(s.end(), p.total)
		copy(out[s.start:hi], s.data[:hi-s.start])
	}
	return out, true
}
