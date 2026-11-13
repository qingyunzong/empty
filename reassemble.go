package dataeng

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Clock supplies the current time. Assemblers use it only for fragments and
// expiry sweeps that do not carry an explicit timestamp.
type Clock func() time.Time

// Sentence is one fragment of a multi-sentence message.
type Sentence struct {
	// MessageID identifies the message this fragment belongs to. The caller
	// chooses it; an empty identifier is a valid identifier.
	MessageID string
	// Total is the total number of sentences in the message.
	Total int
	// Number is this sentence's one-based position in the message.
	Number int
	// FillBits is the number of trailing padding bits in Bits. It may be
	// nonzero only when Number equals Total.
	FillBits int
	// Bits is the fragment payload. Every element must be 0 or 1; bit 0 is
	// the first transmitted bit.
	Bits []byte
	// Err optionally records an earlier validation failure, such as a bad
	// checksum. A non-nil Err makes the sentence invalid.
	Err error
}

// Message is a successfully reassembled message.
type Message struct {
	MessageID string
	// Bits is the concatenation of sentences 1 through Total with the
	// final sentence's FillBits removed. Every byte is 0 or 1.
	Bits []byte
}

// BitString renders Bits as a string of '0' and '1' characters.
func (m *Message) BitString() string {
	if m == nil {
		return ""
	}
	var b strings.Builder
	b.Grow(len(m.Bits))
	for _, bit := range m.Bits {
		if bit == 0 {
			b.WriteByte('0')
		} else {
			b.WriteByte('1')
		}
	}
	return b.String()
}

// Status describes the outcome of an Add or Expire call.
type Status uint8

const (
	// StatusAccepted means the fragment was stored but the message is
	// still incomplete.
	StatusAccepted Status = iota
	// StatusComplete means this fragment completed a valid message.
	StatusComplete
	// StatusFailed means a fragment was rejected and its message failed.
	StatusFailed
	// StatusExpired means an incomplete message missed its deadline.
	StatusExpired
)

// Result reports one assembler event.
type Result struct {
	Status    Status
	MessageID string
	Message   *Message
	// Missing lists the sentence numbers that were still absent when a
	// message expired. It is nil for other statuses.
	Missing []int
	// Err describes a failure or expiry. It is nil for accepted and
	// completed fragments.
	Err error
}

// Pending is a snapshot of an incomplete message.
type Pending struct {
	MessageID string
	Total     int
	Received  []int
	Missing   []int
	FillBits  int
	FirstSeen time.Time
}

type partialMessage struct {
	total     int
	firstSeen time.Time
	fragments map[int][]byte
	fillBits  int
}

// Assembler reassembles fragments into multi-sentence messages.
//
// An Assembler is safe for concurrent use. All time-dependent decisions use
// the time supplied to Add or Expire, or the Clock passed to NewAssembler.
// The Assembler itself never runs a timer.
type Assembler struct {
	mu      sync.Mutex
	timeout time.Duration
	clock   Clock
	partial map[string]*partialMessage
	failed  map[string]time.Time
}

// NewAssembler creates an assembler. If timeout is positive, incomplete
// messages expire when the caller's time reaches FirstSeen+timeout. A
// non-positive timeout disables expiry.
//
// The optional clock is used when Add or Expire is called without an explicit
// timestamp. If no clock is supplied, time.Now is used for those calls.
func NewAssembler(timeout time.Duration, clock ...Clock) *Assembler {
	a := &Assembler{
		timeout: timeout,
		partial: make(map[string]*partialMessage),
		failed:  make(map[string]time.Time),
	}
	if len(clock) > 0 {
		a.clock = clock[0]
	}
	return a
}

// New is an alias for NewAssembler.
func New(timeout time.Duration, clock ...Clock) *Assembler {
	return NewAssembler(timeout, clock...)
}

// Add submits one sentence. The optional timestamp is the caller's current
// time. If it is omitted, the assembler's clock (or time.Now) is used.
//
// Add stores an out-of-order fragment without waiting. If the fragment is
// invalid, it is discarded and its message is failed. A failed message ID is
// remembered until its timeout elapses; use Forget to release it sooner.
func (a *Assembler) Add(s Sentence, at ...time.Time) Result {
	now := a.now(at)
	a.mu.Lock()
	defer a.mu.Unlock()

	id := s.MessageID
	a.evictExpiredLocked(id, now)

	if _, ok := a.failed[id]; ok {
		return Result{
			Status:    StatusFailed,
			MessageID: id,
			Err:       fmt.Errorf("%w: %s", ErrMessageFailed, id),
		}
	}

	if err := validateSentence(s); err != nil {
		a.failLocked(id, now)
		return Result{Status: StatusFailed, MessageID: id, Err: err}
	}

	p, ok := a.partial[id]
	if !ok {
		p = &partialMessage{
			total:     s.Total,
			firstSeen: now,
			fragments: make(map[int][]byte),
		}
		a.partial[id] = p
	}

	if p.total != s.Total {
		err := fmt.Errorf("%w: message %q first reported %d, sentence %d reported %d",
			ErrInconsistentTotal, id, p.total, s.Number, s.Total)
		a.failLocked(id, now)
		return Result{Status: StatusFailed, MessageID: id, Err: err}
	}
	if _, exists := p.fragments[s.Number]; exists {
		err := fmt.Errorf("%w: message %q sentence %d", ErrDuplicateNumber, id, s.Number)
		a.failLocked(id, now)
		return Result{Status: StatusFailed, MessageID: id, Err: err}
	}

	p.fragments[s.Number] = append([]byte(nil), s.Bits...)
	if s.Number == s.Total {
		p.fillBits = s.FillBits
	}

	if len(p.fragments) != p.total {
		return Result{Status: StatusAccepted, MessageID: id}
	}

	bits, err := p.assemble()
	if err != nil {
		a.failLocked(id, now)
		return Result{Status: StatusFailed, MessageID: id, Err: err}
	}

	delete(a.partial, id)
	return Result{
		Status:    StatusComplete,
		MessageID: id,
		Message:   &Message{MessageID: id, Bits: bits},
	}
}

// Feed is an alias for Add.
func (a *Assembler) Feed(s Sentence, at ...time.Time) Result {
	return a.Add(s, at...)
}

// Expire removes incomplete messages whose first fragment is at least the
// configured timeout old according to the supplied time (or the assembler's
// clock). It returns one expired result per message, ordered by message ID.
//
// Expire never removes a message before its deadline. A non-positive timeout
// means nothing expires. Already-failed message IDs are forgotten once their
// own timeout elapses.
func (a *Assembler) Expire(at ...time.Time) []Result {
	now := a.now(at)
	a.mu.Lock()
	defer a.mu.Unlock()

	var out []Result
	for id, p := range a.partial {
		if a.deadlineReached(p.firstSeen, now) {
			out = append(out, Result{
				Status:    StatusExpired,
				MessageID: id,
				Missing:   missingNumbers(p),
				Err:       fmt.Errorf("%w: %s", ErrMessageExpired, id),
			})
			delete(a.partial, id)
		}
	}
	for id, failedAt := range a.failed {
		if a.deadlineReached(failedAt, now) {
			delete(a.failed, id)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MessageID < out[j].MessageID })
	return out
}

// Pending returns a snapshot of incomplete messages, ordered by message ID.
func (a *Assembler) Pending() []Pending {
	a.mu.Lock()
	defer a.mu.Unlock()

	out := make([]Pending, 0, len(a.partial))
	for id, p := range a.partial {
		received := make([]int, 0, len(p.fragments))
		for number := range p.fragments {
			received = append(received, number)
		}
		sort.Ints(received)
		out = append(out, Pending{
			MessageID: id,
			Total:     p.total,
			Received:  received,
			Missing:   missingNumbers(p),
			FillBits:  p.fillBits,
			FirstSeen: p.firstSeen,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MessageID < out[j].MessageID })
	return out
}

// Forget removes all state for a message ID, including a failure tombstone.
// It is useful when an application knows that the identifier has been reused.
func (a *Assembler) Forget(messageID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.partial, messageID)
	delete(a.failed, messageID)
}

// Reset drops all incomplete and failed message state.
func (a *Assembler) Reset() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.partial = make(map[string]*partialMessage)
	a.failed = make(map[string]time.Time)
}

func (a *Assembler) now(at []time.Time) time.Time {
	if len(at) > 0 {
		return at[0]
	}
	if a.clock != nil {
		return a.clock()
	}
	return time.Now()
}

func (a *Assembler) deadlineReached(since, now time.Time) bool {
	return a.timeout > 0 && !now.Before(since.Add(a.timeout))
}

// evictExpiredLocked discards stale state before accepting a new fragment.
// Expiry events are deliberately not synthesized here: callers that need to
// observe missing sentences call Expire.
func (a *Assembler) evictExpiredLocked(id string, now time.Time) {
	if p, ok := a.partial[id]; ok && a.deadlineReached(p.firstSeen, now) {
		delete(a.partial, id)
	}
	if failedAt, ok := a.failed[id]; ok && a.deadlineReached(failedAt, now) {
		delete(a.failed, id)
	}
}

func (a *Assembler) failLocked(id string, now time.Time) {
	delete(a.partial, id)
	a.failed[id] = now
}

func validateSentence(s Sentence) error {
	if s.Err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidSentence, s.Err)
	}
	if s.Total <= 0 {
		return fmt.Errorf("%w: total sentence count must be positive", ErrInvalidSentence)
	}
	if s.Number < 1 || s.Number > s.Total {
		return fmt.Errorf("%w: sentence number %d is outside 1..%d",
			ErrInvalidSentence, s.Number, s.Total)
	}
	if s.FillBits < 0 {
		return fmt.Errorf("%w: fill bit count must not be negative", ErrInvalidSentence)
	}
	if s.Number != s.Total && s.FillBits != 0 {
		return fmt.Errorf("%w: sentence %d of %d declares %d fill bits",
			ErrFillBitsNotLast, s.Number, s.Total, s.FillBits)
	}
	if s.FillBits > len(s.Bits) {
		return fmt.Errorf("%w: %d fill bits for %d payload bits",
			ErrFillExceedsPayload, s.FillBits, len(s.Bits))
	}
	for i, bit := range s.Bits {
		if bit > 1 {
			return fmt.Errorf("%w: bit %d has value %d", ErrNonBitPayload, i, bit)
		}
	}
	return nil
}

func (p *partialMessage) assemble() ([]byte, error) {
	length := 0
	for number := 1; number <= p.total; number++ {
		fragment, ok := p.fragments[number]
		if !ok {
			return nil, fmt.Errorf("%w: message is missing sentence %d", ErrMessageFailed, number)
		}
		length += len(fragment)
	}
	if p.fillBits > length {
		return nil, fmt.Errorf("%w: %d fill bits for %d payload bits",
			ErrFillExceedsPayload, p.fillBits, length)
	}
	length -= p.fillBits
	if length%6 != 0 {
		return nil, fmt.Errorf("%w: %d data bits", ErrBitCountNotMultipleOfSix, length)
	}

	bits := make([]byte, 0, length)
	for number := 1; number <= p.total; number++ {
		bits = append(bits, p.fragments[number]...)
	}
	bits = bits[:length]
	return bits, nil
}

func missingNumbers(p *partialMessage) []int {
	missing := make([]int, 0, p.total-len(p.fragments))
	for number := 1; number <= p.total; number++ {
		if _, ok := p.fragments[number]; !ok {
			missing = append(missing, number)
		}
	}
	return missing
}
