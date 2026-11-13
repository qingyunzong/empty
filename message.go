package dataeng

import (
	"fmt"
	"math"
	"sort"
	"sync"
)

// Message reassembles BODY sections belonging to one IMAP message. The zero
// value is ready to use. Different sections have independent state and locks,
// so concurrent fetches for different sections do not block each other.
//
// A byte conflict permanently fails the message: SectionStatus reports the
// conflict, Err returns it, and Assemble refuses to produce the message.
// Unrelated sections remain readable so that already fetched data is not lost.
type Message struct {
	mu       sync.RWMutex
	sections map[Section]*sectionState
	failure  error
}

// Reassembler is an alias for Message.
type Reassembler = Message

// Assembler is an alias for Message.
type Assembler = Message

// New returns an empty message.
func New() *Message { return &Message{} }

// NewMessage returns an empty message.
func NewMessage() *Message { return &Message{} }

// NewReassembler returns an empty message.
func NewReassembler() *Message { return &Message{} }

// NewAssembler returns an empty message.
func NewAssembler() *Message { return &Message{} }

type chunk struct {
	start int64
	data  []byte
}

type shortLiteral struct {
	origin    int64
	requested int64
	received  int64
}

type sectionState struct {
	mu            sync.Mutex
	expected      int64
	expectedKnown bool
	chunks        []chunk
	received      int64
	adds          int
	short         []shortLiteral
	truncated     bool
	truncations   []Truncation
	conflict      error
}

func (m *Message) section(name Section) *sectionState {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sections == nil {
		m.sections = make(map[Section]*sectionState)
	}
	state := m.sections[name]
	if state == nil {
		state = &sectionState{}
		m.sections[name] = state
	}
	return state
}

func (m *Message) lookupSection(name Section) *sectionState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sections[name]
}

func (m *Message) fail(err error) error {
	m.mu.Lock()
	if m.failure == nil {
		m.failure = err
	}
	m.mu.Unlock()
	return err
}

// Err returns the first fatal message error, if any. It returns nil for a
// message that is merely incomplete.
func (m *Message) Err() error {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.failure
}

// Failed reports whether a conflict or other fatal inconsistency has failed
// the message.
func (m *Message) Failed() bool { return m.Err() != nil }

// Add commits one literal fragment. It reports conflicts, out-of-bounds data
// and invalid input, but a short literal is not an error: it is recorded in
// the section status and can be retried.
//
// Adding the same bytes twice is idempotent. Adding different bytes in an
// overlapping range returns a *ConflictError and fails the message.
func (m *Message) Add(seg Segment) error {
	_, err := m.Accept(seg)
	return err
}

// AddBytes is a convenience form of Add with an unknown requested length.
func (m *Message) AddBytes(section Section, origin int64, data []byte) error {
	return m.Add(Segment{Section: section, Origin: origin, Data: data})
}

// AddPartial records a literal together with the length requested by the FETCH
// BODY[section]<origin.length> command. A requested value of zero means that
// the request length is unknown; negative values are invalid.
func (m *Message) AddPartial(section Section, origin, requested int64, data []byte) error {
	_, err := m.Accept(Segment{
		Section:         section,
		Origin:          origin,
		Data:            data,
		RequestedLength: requested,
	})
	return err
}

// Submit accepts seg and returns details about the merge.
func (m *Message) Submit(seg Segment) (AddResult, error) {
	return m.Accept(seg)
}

// Accept commits one literal fragment and returns details about the merge.
func (m *Message) Accept(seg Segment) (AddResult, error) {
	actual := int64(len(seg.Data))
	if seg.Origin < 0 {
		return AddResult{}, fmt.Errorf("%w: negative origin %d", ErrInvalidSegment, seg.Origin)
	}
	if seg.RequestedLength < 0 {
		return AddResult{}, fmt.Errorf("%w: negative requested length %d", ErrInvalidSegment, seg.RequestedLength)
	}
	if seg.RequestedLength > 0 && actual > seg.RequestedLength {
		return AddResult{}, fmt.Errorf(
			"%w: section %q origin %d returned %d octets for a %d-octet request",
			ErrLiteralTooLong, seg.Section, seg.Origin, actual, seg.RequestedLength,
		)
	}
	if seg.Origin > math.MaxInt64-actual {
		return AddResult{}, fmt.Errorf("%w: origin overflows int64", ErrInvalidSegment)
	}
	end := seg.Origin + actual

	state := m.section(seg.Section)
	state.mu.Lock()
	defer state.mu.Unlock()

	result := AddResult{Section: seg.Section}
	if state.conflict != nil {
		return result, state.conflict
	}

	if state.expectedKnown {
		if end > state.expected {
			err := &OutOfBoundsError{
				Section:  seg.Section,
				Origin:   seg.Origin,
				End:      end,
				Expected: state.expected,
			}
			if actual > 0 {
				state.conflict = err
				m.fail(err)
			}
			return result, err
		}
	}

	incoming := chunk{start: seg.Origin, data: append([]byte(nil), seg.Data...)}
	merged, added, overlapped, conflict := mergeChunk(state.chunks, incoming, seg.Section, seg.Origin)
	if conflict != nil {
		conflict.Origin = seg.Origin
		if conflict.Offset >= seg.Origin && conflict.Offset < end {
			conflict.Incoming = incoming.data[conflict.Offset-seg.Origin]
			for _, old := range state.chunks {
				oldEnd := old.start + int64(len(old.data))
				if conflict.Offset >= old.start && conflict.Offset < oldEnd {
					conflict.Existing = old.data[conflict.Offset-old.start]
					break
				}
			}
		}
		state.conflict = conflict
		m.fail(conflict)
		return result, conflict
	}

	state.chunks = merged
	state.received += added
	state.adds++
	result.Added = added
	result.Overlapped = overlapped
	result.Received = state.received

	if seg.RequestedLength > 0 && actual < seg.RequestedLength {
		state.short = append(state.short, shortLiteral{
			origin:    seg.Origin,
			requested: seg.RequestedLength,
			received:  actual,
		})
		state.recomputeTruncations()
		result.Truncated = state.literalTruncated(seg.Origin, seg.RequestedLength, actual)
	}

	result.Complete = state.complete()
	return result, nil
}

func (st *sectionState) literalTruncated(origin, requested, received int64) bool {
	end := st.knownEnd()
	if end <= origin+received {
		// Without an expected size there is no evidence that the section
		// continues; a short final literal is a normal end-of-section.
		return false
	}
	needed := requested
	if remaining := end - origin; needed > remaining {
		needed = remaining
	}
	return needed >= 0 && received < needed
}

func (st *sectionState) recomputeTruncations() {
	st.truncated = false
	st.truncations = st.truncations[:0]
	end := st.knownEnd()
	if end == 0 {
		return
	}
	for _, literal := range st.short {
		if end <= literal.origin+literal.received {
			continue
		}
		needed := literal.requested
		if remaining := end - literal.origin; needed > remaining {
			needed = remaining
		}
		if needed < 0 {
			needed = 0
		}
		if literal.received < needed {
			st.truncated = true
			st.truncations = append(st.truncations, Truncation{
				Origin:    literal.origin,
				Requested: literal.requested,
				Received:  literal.received,
				Needed:    needed,
			})
		}
	}
}

func (st *sectionState) knownEnd() int64 {
	if st.expectedKnown {
		return st.expected
	}
	if len(st.chunks) == 0 {
		return 0
	}
	last := st.chunks[len(st.chunks)-1]
	return last.start + int64(len(last.data))
}

// mergeChunk inserts incoming into the sorted, disjoint chunk list. Overlap is
// accepted only when the overlapping octets are identical. Adjacent chunks
// are coalesced. It returns the first conflicting octet, if any.
func mergeChunk(existing []chunk, incoming chunk, section Section, fragmentOrigin int64) ([]chunk, int64, int64, *ConflictError) {
	if len(incoming.data) == 0 {
		return existing, 0, 0, nil
	}
	end := incoming.start + int64(len(incoming.data))

	var overlapped int64
	for _, old := range existing {
		oldEnd := old.start + int64(len(old.data))
		start := max64(incoming.start, old.start)
		stop := min64(end, oldEnd)
		if stop > start {
			overlapped += stop - start
		}
	}
	added := int64(len(incoming.data)) - overlapped

	if len(existing) == 0 {
		return []chunk{incoming}, added, overlapped, nil
	}

	all := make([]chunk, 0, len(existing)+1)
	inserted := false
	for _, old := range existing {
		if !inserted && incoming.start < old.start {
			all = append(all, incoming)
			inserted = true
		}
		all = append(all, old)
	}
	if !inserted {
		all = append(all, incoming)
	}

	out := make([]chunk, 0, len(all))
	cur := all[0]
	curEnd := cur.start + int64(len(cur.data))
	for _, next := range all[1:] {
		if next.start > curEnd {
			out = append(out, cur)
			cur = next
			curEnd = cur.start + int64(len(cur.data))
			continue
		}

		nextEnd := next.start + int64(len(next.data))
		overlapStart := max64(next.start, cur.start)
		overlapEnd := min64(nextEnd, curEnd)
		for pos := overlapStart; pos < overlapEnd; pos++ {
			a := cur.data[pos-cur.start]
			b := next.data[pos-next.start]
			if a != b {
				return nil, 0, 0, &ConflictError{
					Section:  section,
					Origin:   fragmentOrigin,
					Offset:   pos,
					Existing: a,
					Incoming: b,
				}
			}
		}

		newEnd := max64(curEnd, nextEnd)
		merged := make([]byte, newEnd-cur.start)
		// Overlapping bytes were verified equal, so either copy order works.
		copy(merged, cur.data)
		copy(merged[next.start-cur.start:], next.data)
		cur = chunk{start: cur.start, data: merged}
		curEnd = newEnd
	}
	out = append(out, cur)
	return out, added, overlapped, nil
}

func (st *sectionState) complete() bool {
	if st.conflict != nil {
		return false
	}
	if !st.expectedKnown || st.expected != st.received {
		return false
	}
	if len(st.chunks) == 0 {
		return st.expected == 0
	}
	var expectedEnd int64
	for _, c := range st.chunks {
		if c.start != expectedEnd {
			return false
		}
		expectedEnd = c.start + int64(len(c.data))
	}
	return expectedEnd == st.expected
}

func (st *sectionState) gaps() []Range {
	var gaps []Range
	var cursor int64
	for _, c := range st.chunks {
		if c.start > cursor {
			gaps = append(gaps, Range{Start: cursor, End: c.start})
		}
		cursor = c.start + int64(len(c.data))
	}
	if st.expectedKnown && cursor < st.expected {
		gaps = append(gaps, Range{Start: cursor, End: st.expected})
	}
	return gaps
}

// Expect declares the expected total size of a section, normally obtained from
// RFC822.SIZE or BODYSTRUCTURE. It may be called before or after fragments.
// Repeating the same size is idempotent; a different size is rejected.
func (m *Message) Expect(section Section, size int64) error {
	if size < 0 {
		return fmt.Errorf("%w: negative expected size %d", ErrInvalidSegment, size)
	}
	state := m.section(section)
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.conflict != nil {
		return state.conflict
	}
	if state.expectedKnown {
		if state.expected == size {
			return nil
		}
		return &ExpectedSizeError{
			Section:  section,
			Existing: state.expected,
			Incoming: size,
			Reason:   "an earlier declaration",
		}
	}
	var recordedEnd int64
	if len(state.chunks) > 0 {
		last := state.chunks[len(state.chunks)-1]
		recordedEnd = last.start + int64(len(last.data))
	}
	if size < state.received || size < recordedEnd {
		existing := state.received
		if recordedEnd > existing {
			existing = recordedEnd
		}
		return &ExpectedSizeError{
			Section:  section,
			Existing: existing,
			Incoming: size,
			Reason:   "recorded data",
		}
	}
	state.expected = size
	state.expectedKnown = true
	state.recomputeTruncations()
	return nil
}

// SetExpectedSize is an alias for Expect.
func (m *Message) SetExpectedSize(section Section, size int64) error {
	return m.Expect(section, size)
}

// ExpectSections declares expected sizes for several sections.
func (m *Message) ExpectSections(sizes map[Section]int64) error {
	names := make([]string, 0, len(sizes))
	for name := range sizes {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := m.Expect(name, sizes[name]); err != nil {
			return err
		}
	}
	return nil
}

// ExpectedSize returns the declared section size, if known.
func (m *Message) ExpectedSize(section Section) (int64, bool) {
	state := m.lookupSection(section)
	if state == nil {
		return 0, false
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.expected, state.expectedKnown
}

// SectionComplete reports whether a section has exactly [0, expected) of
// verified bytes. A section with an unknown expected size is never complete.
func (m *Message) SectionComplete(section Section) bool {
	state := m.lookupSection(section)
	if state == nil {
		return false
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.complete()
}

// Complete is an alias for SectionComplete.
func (m *Message) Complete(section Section) bool { return m.SectionComplete(section) }

// IsComplete is an alias for SectionComplete.
func (m *Message) IsComplete(section Section) bool { return m.SectionComplete(section) }

// Status returns a snapshot of one section.
func (m *Message) Status(section Section) (SectionStatus, bool) {
	state := m.lookupSection(section)
	if state == nil {
		return SectionStatus{}, false
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	status := SectionStatus{
		Section:       section,
		Expected:      state.expected,
		ExpectedKnown: state.expectedKnown,
		Received:      state.received,
		Chunks:        len(state.chunks),
		Adds:          state.adds,
		Complete:      state.complete(),
		Truncated:     state.truncated,
		ShortLiterals: len(state.short),
		Conflict:      state.conflict,
	}
	status.Gaps = state.gaps()
	status.Truncations = append([]Truncation(nil), state.truncations...)
	return status, true
}

// SectionStatus returns a snapshot of one section. It is an alias for Status.
func (m *Message) SectionStatus(section Section) (SectionStatus, bool) {
	return m.Status(section)
}

// Gaps returns missing ranges in a section. When the expected size is known,
// the returned ranges always extend to the end of the section.
func (m *Message) Gaps(section Section) []Range {
	status, ok := m.Status(section)
	if !ok {
		return nil
	}
	return status.Gaps
}

// Truncations returns short literals that are provably truncated.
func (m *Message) Truncations(section Section) []Truncation {
	status, ok := m.Status(section)
	if !ok {
		return nil
	}
	return status.Truncations
}

// Truncated reports whether the section has at least one literal that is
// provably shorter than the server's available section data.
func (m *Message) Truncated(section Section) bool {
	status, ok := m.Status(section)
	return ok && status.Truncated
}

// Check reports why a section cannot be materialized yet. It returns a
// *TruncatedError for a provably truncated incomplete section, an
// *IncompleteError for gaps or an unknown expected size, a *ConflictError for
// a conflicting overlap, and nil for a complete section.
func (m *Message) Check(section Section) error {
	state := m.lookupSection(section)
	if state == nil {
		return fmt.Errorf("%w: %q", ErrUnknownSection, section)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.conflict != nil {
		return state.conflict
	}
	if state.complete() {
		return nil
	}
	if state.truncated && len(state.truncations) > 0 {
		truncation := state.truncations[0]
		return &TruncatedError{
			Section:   section,
			Origin:    truncation.Origin,
			Requested: truncation.Requested,
			Received:  truncation.Received,
			Needed:    truncation.Needed,
		}
	}
	return &IncompleteError{
		Section:       section,
		ExpectedKnown: state.expectedKnown,
		Expected:      state.expected,
		Received:      state.received,
		Missing:       state.gaps(),
	}
}

// SectionBytes returns the fully reassembled bytes of a section. It fails
// with *IncompleteError while any octet is missing and with *ConflictError if
// the section had a conflicting overlap.
func (m *Message) SectionBytes(section Section) ([]byte, error) {
	state := m.lookupSection(section)
	if state == nil {
		return nil, fmt.Errorf("%w: %q", ErrUnknownSection, section)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.conflict != nil {
		return nil, state.conflict
	}
	if !state.complete() {
		return nil, &IncompleteError{
			Section:       section,
			ExpectedKnown: state.expectedKnown,
			Expected:      state.expected,
			Received:      state.received,
			Missing:       state.gaps(),
		}
	}
	if state.expected == 0 {
		return []byte{}, nil
	}
	data := make([]byte, state.expected)
	for _, c := range state.chunks {
		copy(data[c.start:], c.data)
	}
	return data, nil
}

// Bytes is an alias for SectionBytes for one section.
func (m *Message) Bytes(section Section) ([]byte, error) { return m.SectionBytes(section) }

// Sections returns the section names seen by the message, sorted.
func (m *Message) Sections() []Section {
	_, states, _ := m.snapshot()
	names := make([]Section, 0, len(states))
	for name := range states {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (m *Message) snapshot() ([]Section, map[Section]*sectionState, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	failure := m.failure
	states := make(map[Section]*sectionState, len(m.sections))
	names := make([]Section, 0, len(m.sections))
	for name, state := range m.sections {
		names = append(names, name)
		states[name] = state
	}
	sort.Strings(names)
	return names, states, failure
}

// MessageComplete reports whether every known section has a declared size and
// complete coverage, and no section has failed the message.
func (m *Message) MessageComplete() bool {
	names, states, failure := m.snapshot()
	if failure != nil || len(names) == 0 {
		return false
	}
	for _, name := range names {
		state := states[name]
		state.mu.Lock()
		ok := state.complete()
		state.mu.Unlock()
		if !ok {
			return false
		}
	}
	return true
}

// Done is an alias for MessageComplete.
func (m *Message) Done() bool { return m.MessageComplete() }

// Assemble returns all complete sections. It fails if the message has a
// conflict or any section is incomplete or has an unknown expected size.
func (m *Message) Assemble() (map[Section][]byte, error) {
	names, states, failure := m.snapshot()
	if failure != nil {
		return nil, &MessageFailedError{Cause: failure}
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("%w: message has no sections", ErrIncomplete)
	}
	bodies := make(map[Section][]byte, len(names))
	for _, name := range names {
		state := states[name]
		state.mu.Lock()
		if state.conflict != nil {
			err := state.conflict
			state.mu.Unlock()
			return nil, err
		}
		if !state.complete() {
			err := &IncompleteError{
				Section:       name,
				ExpectedKnown: state.expectedKnown,
				Expected:      state.expected,
				Received:      state.received,
				Missing:       state.gaps(),
			}
			state.mu.Unlock()
			return nil, err
		}
		if state.expected == 0 {
			bodies[name] = []byte{}
		} else {
			data := make([]byte, state.expected)
			for _, c := range state.chunks {
				copy(data[c.start:], c.data)
			}
			bodies[name] = data
		}
		state.mu.Unlock()
	}
	if err := m.Err(); err != nil {
		return nil, &MessageFailedError{Cause: err}
	}
	return bodies, nil
}

// Reassemble is an alias for Assemble.
func (m *Message) Reassemble() (map[Section][]byte, error) { return m.Assemble() }

// BodyBytes is an alias for Assemble.
func (m *Message) BodyBytes() (map[Section][]byte, error) { return m.Assemble() }

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
