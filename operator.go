package dataeng

import (
	"fmt"
	"math"
	"sort"
)

// Operator is an event-time window operator. It is not safe for concurrent
// use; serialize calls (or protect the operator with a mutex) from the stream
// task that owns the partition state.
//
// Watermarks are supplied per source via Heartbeat or AdvanceWatermark. A
// partition watermark is the minimum watermark over its non-idle sources.
// Records never establish or advance watermarks implicitly.
type Operator struct {
	cfg        Config
	partitions map[string]*partitionState
	fixed      map[fixedWindowKey]*fixedWindowState
	sessions   map[sessionKey][]*sessionWindowState

	// closedSessionEnd remembers, per session key, the furthest session end
	// that has been finalized. Records older than this must not resurrect a
	// session whose state was already discarded.
	closedSessionEnd map[sessionKey]int64
}

// WindowOperator is an alias kept for integrations that use the more explicit
// component name.
type WindowOperator = Operator

// NewOperator validates cfg and returns an empty operator.
func NewOperator(cfg Config) (*Operator, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Operator{
		cfg:              cfg,
		partitions:       make(map[string]*partitionState),
		fixed:            make(map[fixedWindowKey]*fixedWindowState),
		sessions:         make(map[sessionKey][]*sessionWindowState),
		closedSessionEnd: make(map[sessionKey]int64),
	}, nil
}

// New is an alias for NewOperator.
func New(cfg Config) (*Operator, error) {
	return NewOperator(cfg)
}

// NewWindowOperator is an alias for NewOperator.
func NewWindowOperator(cfg Config) (*Operator, error) {
	return NewOperator(cfg)
}

// NewTumbling returns an operator with a tumbling window specification.
func NewTumbling(size, allowedLateness int64) (*Operator, error) {
	return NewOperator(Config{Window: Tumbling(size), AllowedLateness: allowedLateness})
}

// NewSliding returns an operator with a sliding window specification.
func NewSliding(size, slide, allowedLateness int64) (*Operator, error) {
	return NewOperator(Config{Window: Sliding(size, slide), AllowedLateness: allowedLateness})
}

// NewSession returns an operator with a session window specification.
func NewSession(gap, allowedLateness int64) (*Operator, error) {
	return NewOperator(Config{Window: Session(gap), AllowedLateness: allowedLateness})
}

// Spec returns the operator's window specification.
func (o *Operator) Spec() WindowSpec {
	if o == nil {
		return WindowSpec{}
	}
	return o.cfg.Window
}

// AllowedLateness returns the configured lateness period.
func (o *Operator) AllowedLateness() int64 {
	if o == nil {
		return 0
	}
	return o.cfg.AllowedLateness
}

// Process ingests one record. It returns any window revisions the record
// produces immediately (initial emissions for already-ended windows and
// late revisions) and records routed to the side output.
func (o *Operator) Process(ev Event) ([]WindowResult, []SideOutput, error) {
	if o == nil {
		return nil, nil, ErrNilOperator
	}
	registerEventValue(ev.Value)
	ps := o.partitionState(ev.Partition)

	var results []WindowResult
	var sides []SideOutput

	switch o.cfg.Window.Kind {
	case KindTumbling, KindSliding:
		results, sides = o.processFixed(ps, ev)
	case KindSession:
		results, sides = o.processSession(ps, ev)
	default:
		return nil, nil, fmt.Errorf("%w: unknown kind %d", ErrInvalidConfig, uint8(o.cfg.Window.Kind))
	}

	sortResults(results)
	return results, sides, nil
}

// Add is an alias for Process.
func (o *Operator) Add(ev Event) ([]WindowResult, []SideOutput, error) {
	return o.Process(ev)
}

// ProcessEvent is an alias for Process.
func (o *Operator) ProcessEvent(ev Event) ([]WindowResult, []SideOutput, error) {
	return o.Process(ev)
}

// ProcessBatch ingests records in order. Window revisions from the whole batch
// are returned in the deterministic window order (end, start, partition, key,
// version); side outputs preserve record order.
func (o *Operator) ProcessBatch(events []Event) ([]WindowResult, []SideOutput, error) {
	if o == nil {
		return nil, nil, ErrNilOperator
	}
	var results []WindowResult
	var sides []SideOutput
	for _, ev := range events {
		r, s, err := o.Process(ev)
		if err != nil {
			return nil, nil, err
		}
		results = append(results, r...)
		sides = append(sides, s...)
	}
	sortResults(results)
	return results, sides, nil
}

func (o *Operator) processFixed(ps *partitionState, ev Event) ([]WindowResult, []SideOutput) {
	assigned := o.cfg.Window.Assign(ev.Timestamp)
	if len(assigned) == 0 {
		side := SideOutput{
			Event:     ev,
			Watermark: o.watermarkOrNo(ps),
			Reason:    SideOutputNoWindow,
		}
		return nil, []SideOutput{side}
	}

	var results []WindowResult
	var expired []Window
	for _, w := range assigned {
		if ps.hasWatermark && wmAtOrAfter(ps.watermark, w.End, o.cfg.AllowedLateness) {
			expired = append(expired, w)
			continue
		}

		key := fixedWindowKey{Partition: ev.Partition, Key: ev.Key, Start: w.Start, End: w.End}
		st := o.fixed[key]
		if st == nil {
			st = &fixedWindowState{
				partition: ev.Partition,
				key:       ev.Key,
				window:    w,
			}
			o.fixed[key] = st
		}
		st.events = append(st.events, ev)

		switch {
		case st.fired:
			st.version++
			results = append(results, o.fixedResult(ps, st, true))
		case ps.hasWatermark && ps.watermark >= w.End:
			// First emission caused by a record arriving after the end. It is
			// version 1, but still flagged as late.
			st.version = 1
			st.fired = true
			results = append(results, o.fixedResult(ps, st, true))
		}
	}

	var sides []SideOutput
	if len(expired) > 0 {
		sides = append(sides, SideOutput{
			Event:     ev,
			Windows:   expired,
			Watermark: o.watermarkOrNo(ps),
			Reason:    SideOutputAfterDeadline,
		})
	}
	return results, sides
}

func (o *Operator) processSession(ps *partitionState, ev Event) ([]WindowResult, []SideOutput) {
	sk := sessionKey{Partition: ev.Partition, Key: ev.Key}
	existing := o.sessions[sk]
	gap := o.cfg.Window.Gap

	matched := make([]bool, len(existing))
	matchedCount := 0
	for i, st := range existing {
		if st.matches(ev.Timestamp, gap) {
			matched[i] = true
			matchedCount++
		}
	}

	var results []WindowResult
	var sides []SideOutput

	if matchedCount == 0 {
		candidate := Window{Start: ev.Timestamp, End: ev.Timestamp + gap}
		if ps.hasWatermark {
			if closedEnd, ok := o.closedSessionEnd[sk]; ok && ev.Timestamp <= closedEnd {
				return nil, []SideOutput{{
					Event:     ev,
					Windows:   []Window{candidate},
					Watermark: ps.watermark,
					Reason:    SideOutputAfterDeadline,
				}}
			}
			if wmAtOrAfter(ps.watermark, candidate.End, o.cfg.AllowedLateness) {
				return nil, []SideOutput{{
					Event:     ev,
					Windows:   []Window{candidate},
					Watermark: ps.watermark,
					Reason:    SideOutputAfterDeadline,
				}}
			}
		}

		st := &sessionWindowState{
			window: candidate,
			events: []Event{ev},
		}
		if ps.hasWatermark && ps.watermark >= candidate.End {
			st.version = 1
			st.fired = true
			results = append(results, o.sessionResult(ps, ev.Key, st, true))
		}
		o.insertSession(sk, st)
		return results, sides
	}

	merged := Window{Start: ev.Timestamp, End: ev.Timestamp + gap}
	var mergedEvents []Event
	maxVersion := 0
	anyFired := false
	remaining := make([]*sessionWindowState, 0, len(existing)-matchedCount+1)
	for i, st := range existing {
		if !matched[i] {
			remaining = append(remaining, st)
			continue
		}
		if st.window.Start < merged.Start {
			merged.Start = st.window.Start
		}
		if st.window.End > merged.End {
			merged.End = st.window.End
		}
		mergedEvents = append(mergedEvents, st.events...)
		if st.fired {
			anyFired = true
			if st.version > maxVersion {
				maxVersion = st.version
			}
		}
	}
	mergedEvents = append(mergedEvents, ev)

	st := &sessionWindowState{
		window: merged,
		events: mergedEvents,
	}
	shouldEmit := false
	if anyFired {
		st.version = maxVersion + 1
		shouldEmit = true
	} else if ps.hasWatermark && ps.watermark >= merged.End {
		st.version = 1
		shouldEmit = true
	}
	if shouldEmit {
		st.fired = true
		results = append(results, o.sessionResult(ps, ev.Key, st, true))
	}

	remaining = append(remaining, st)
	o.sessions[sk] = remaining
	o.sortSessions(sk)
	return results, sides
}

func (o *Operator) insertSession(sk sessionKey, st *sessionWindowState) {
	o.sessions[sk] = append(o.sessions[sk], st)
	o.sortSessions(sk)
}

func (o *Operator) sortSessions(sk sessionKey) {
	list := o.sessions[sk]
	sort.Slice(list, func(i, j int) bool {
		if list[i].window.Start != list[j].window.Start {
			return list[i].window.Start < list[j].window.Start
		}
		return list[i].window.End < list[j].window.End
	})
}

func (o *Operator) fixedResult(ps *partitionState, st *fixedWindowState, late bool) WindowResult {
	events := cloneEvents(st.events)
	return WindowResult{
		Partition: st.partition,
		Key:       st.key,
		Window:    st.window,
		Version:   st.version,
		Late:      late,
		Watermark: o.watermarkOrNo(ps),
		Events:    events,
		Aggregate: o.aggregate(st.partition, st.key, st.window, events),
	}
}

func (o *Operator) sessionResult(ps *partitionState, key string, st *sessionWindowState, late bool) WindowResult {
	events := cloneEvents(st.events)
	return WindowResult{
		Partition: partitionOf(ps),
		Key:       key,
		Window:    st.window,
		Version:   st.version,
		Late:      late,
		Watermark: o.watermarkOrNo(ps),
		Events:    events,
		Aggregate: o.aggregate(partitionOf(ps), key, st.window, events),
	}
}

func (o *Operator) aggregate(partition, key string, w Window, events []Event) any {
	if o.cfg.Aggregate == nil {
		return nil
	}
	return o.cfg.Aggregate(
		WindowContext{Partition: partition, Key: key, Window: w},
		cloneEvents(events),
	)
}

func cloneEvents(events []Event) []Event {
	if len(events) == 0 {
		return nil
	}
	out := make([]Event, len(events))
	copy(out, events)
	return out
}

func (o *Operator) watermarkOrNo(ps *partitionState) int64 {
	if ps != nil && ps.hasWatermark {
		return ps.watermark
	}
	return NoWatermark
}

func (o *Operator) partitionState(partition string) *partitionState {
	ps := o.partitions[partition]
	if ps == nil {
		ps = &partitionState{id: partition, sources: make(map[string]*sourceState)}
		o.partitions[partition] = ps
	}
	return ps
}

// AdvanceWatermark is the common integration entry point: it advances one
// source's watermark and returns windows that became eligible because the
// partition watermark moved.
func (o *Operator) AdvanceWatermark(partition, source string, ts int64) ([]WindowResult, error) {
	if o == nil {
		return nil, ErrNilOperator
	}
	return o.Heartbeat(Heartbeat{Partition: partition, Source: source, Timestamp: ts})
}

// Advance is an alias for AdvanceWatermark.
func (o *Operator) Advance(partition, source string, ts int64) ([]WindowResult, error) {
	return o.AdvanceWatermark(partition, source, ts)
}

// Heartbeat applies a source watermark update. Idle sources are excluded from
// the partition minimum; excluding a low source can advance the partition
// watermark and therefore trigger windows.
func (o *Operator) Heartbeat(hb Heartbeat) ([]WindowResult, error) {
	if o == nil {
		return nil, ErrNilOperator
	}
	ps := o.partitionState(hb.Partition)
	ss := ps.sources[hb.Source]
	isNew := ss == nil
	if isNew {
		ss = &sourceState{}
		ps.sources[hb.Source] = ss
	}
	wasIdle := ss.idle

	if !ss.hasWatermark {
		ss.watermark = hb.Timestamp
		ss.hasWatermark = true
	} else if hb.Timestamp > ss.watermark {
		ss.watermark = hb.Timestamp
	}
	ss.idle = hb.Idle

	if !hb.Idle && (isNew || wasIdle) && ps.hasWatermark && ss.watermark < ps.watermark {
		// A source that joins or wakes up behind the partition watermark is
		// fast-forwarded. Otherwise the partition watermark and all trigger
		// ordering would regress.
		ss.watermark = ps.watermark
	}

	return o.refreshWatermark(ps), nil
}

// MarkIdle explicitly removes a source from its partition's active set. It is
// equivalent to sending an idle heartbeat without changing the source's
// watermark.
func (o *Operator) MarkIdle(partition, source string) ([]WindowResult, error) {
	if o == nil {
		return nil, ErrNilOperator
	}
	ps := o.partitionState(partition)
	ss := ps.sources[source]
	if ss == nil {
		ss = &sourceState{}
		ps.sources[source] = ss
	}
	ss.idle = true
	return o.refreshWatermark(ps), nil
}

func (o *Operator) refreshWatermark(ps *partitionState) []WindowResult {
	min, active := int64(math.MaxInt64), 0
	for _, ss := range ps.sources {
		if ss.idle || !ss.hasWatermark {
			continue
		}
		active++
		if ss.watermark < min {
			min = ss.watermark
		}
	}
	if active == 0 {
		return nil
	}

	changed := false
	if !ps.hasWatermark || min > ps.watermark {
		ps.watermark = min
		ps.hasWatermark = true
		changed = true
	}
	if !changed {
		return nil
	}
	return o.triggerPartition(ps, min)
}

func (o *Operator) triggerPartition(ps *partitionState, watermark int64) []WindowResult {
	switch o.cfg.Window.Kind {
	case KindTumbling, KindSliding:
		return o.triggerFixed(ps, watermark)
	case KindSession:
		return o.triggerSessions(ps, watermark)
	default:
		return nil
	}
}

func (o *Operator) triggerFixed(ps *partitionState, watermark int64) []WindowResult {
	var keys []fixedWindowKey
	for key, st := range o.fixed {
		if key.Partition != ps.id {
			continue
		}
		if !st.fired && st.window.End <= watermark {
			keys = append(keys, key)
		}
	}
	sortFixedKeys(keys)

	var results []WindowResult
	for _, key := range keys {
		st := o.fixed[key]
		if st == nil || st.fired {
			continue
		}
		st.version = 1
		st.fired = true
		results = append(results, o.fixedResult(ps, st, false))
	}

	// Finalization is independent of emission: a watermark may jump past
	// End+AllowedLateness in one step, in which case version 1 is emitted
	// above and the state is dropped now.
	for key, st := range o.fixed {
		if key.Partition != ps.id {
			continue
		}
		if wmAtOrAfter(watermark, st.window.End, o.cfg.AllowedLateness) {
			delete(o.fixed, key)
		}
	}
	return results
}

func (o *Operator) triggerSessions(ps *partitionState, watermark int64) []WindowResult {
	partition := ps.id
	type sessionRef struct {
		key sessionKey
		st  *sessionWindowState
	}
	var refs []sessionRef
	for sk, list := range o.sessions {
		if sk.Partition != partition {
			continue
		}
		for _, st := range list {
			if st.window.End <= watermark {
				refs = append(refs, sessionRef{key: sk, st: st})
			}
		}
	}
	sort.Slice(refs, func(i, j int) bool {
		a, b := refs[i], refs[j]
		if a.st.window.End != b.st.window.End {
			return a.st.window.End < b.st.window.End
		}
		if a.st.window.Start != b.st.window.Start {
			return a.st.window.Start < b.st.window.Start
		}
		if a.key.Partition != b.key.Partition {
			return a.key.Partition < b.key.Partition
		}
		return a.key.Key < b.key.Key
	})

	var results []WindowResult
	for _, ref := range refs {
		if ref.st.fired {
			continue
		}
		ref.st.version = 1
		ref.st.fired = true
		results = append(results, o.sessionResult(ps, ref.key.Key, ref.st, false))
	}

	for sk, list := range o.sessions {
		if sk.Partition != partition {
			continue
		}
		kept := list[:0]
		for _, st := range list {
			if wmAtOrAfter(watermark, st.window.End, o.cfg.AllowedLateness) {
				if st.window.End > o.closedSessionEnd[sk] {
					o.closedSessionEnd[sk] = st.window.End
				}
				continue
			}
			kept = append(kept, st)
		}
		if len(kept) == 0 {
			delete(o.sessions, sk)
		} else {
			o.sessions[sk] = kept
		}
	}
	return results
}

func partitionOf(ps *partitionState) string {
	if ps == nil {
		return ""
	}
	return ps.id
}

func wmAtOrAfter(watermark, end, lateness int64) bool {
	if lateness > 0 && end > math.MaxInt64-lateness {
		return false
	}
	return watermark >= end+lateness
}

// Watermark returns the current partition watermark and whether it is known.
func (o *Operator) Watermark(partition string) (int64, bool) {
	if o == nil {
		return NoWatermark, false
	}
	ps := o.partitions[partition]
	if ps == nil || !ps.hasWatermark {
		return NoWatermark, false
	}
	return ps.watermark, true
}

// Sources returns a sorted snapshot of the partition's source states.
func (o *Operator) Sources(partition string) []SourceInfo {
	if o == nil {
		return nil
	}
	ps := o.partitions[partition]
	if ps == nil {
		return nil
	}
	infos := make([]SourceInfo, 0, len(ps.sources))
	for id, ss := range ps.sources {
		infos = append(infos, SourceInfo{
			ID:           id,
			Watermark:    ss.watermark,
			HasWatermark: ss.hasWatermark,
			Idle:         ss.idle,
		})
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].ID < infos[j].ID })
	return infos
}
