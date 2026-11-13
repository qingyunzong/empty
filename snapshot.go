package dataeng

import (
	"bytes"
	"encoding/gob"
	"reflect"
	"sort"
	"sync"
)

const (
	snapshotMagic = "dataeng.event-time-window"
	// SnapshotVersion is the format version written into snapshots.
	SnapshotVersion = 1
)

// RegisterEventValue makes a concrete value type usable by Snapshot/Restore
// when Event.Value holds that type. Primitive scalar values are handled by
// encoding/gob without registration; structs, maps, slices, and other user
// types must be registered before Snapshot (or before Restore in a fresh
// process). Registering the same type repeatedly is safe.
func RegisterEventValue(v any) {
	registerEventValue(v)
}

// RegisterEventValue is the operator-scoped convenience form; registration is
// process-wide because it feeds encoding/gob.
func (o *Operator) RegisterEventValue(v any) {
	registerEventValue(v)
}

var registeredValueTypes sync.Map

func registerEventValue(v any) {
	if v == nil {
		return
	}
	t := reflect.TypeOf(v)
	if _, loaded := registeredValueTypes.LoadOrStore(t, struct{}{}); loaded {
		return
	}
	func() {
		defer func() {
			// gob.Register panics if the type name is already bound to a
			// different type. Keep the first registration and let Snapshot
			// report an encoding error if that makes the value unusable.
			_ = recover()
		}()
		gob.Register(v)
	}()
}

type snapshotData struct {
	Magic           string
	Version         int
	Kind            uint8
	Size            int64
	Slide           int64
	Gap             int64
	AllowedLateness int64
	Partitions      []partitionSnapshot
	Fixed           []fixedWindowSnapshot
	Sessions        []sessionWindowSnapshot
	ClosedSessions  []closedSessionSnapshot
}

type partitionSnapshot struct {
	ID           string
	Watermark    int64
	HasWatermark bool
	Sources      []sourceSnapshot
}

type sourceSnapshot struct {
	ID           string
	Watermark    int64
	HasWatermark bool
	Idle         bool
}

type fixedWindowSnapshot struct {
	Partition string
	Key       string
	Start     int64
	End       int64
	Version   int
	Fired     bool
	Events    []Event
}

type sessionWindowSnapshot struct {
	Partition string
	Key       string
	Start     int64
	End       int64
	Version   int
	Fired     bool
	Events    []Event
}

type closedSessionSnapshot struct {
	Partition string
	Key       string
	End       int64
}

// RestoreOperator creates an operator with cfg and restores a snapshot into
// it. It is a convenience wrapper for cold-start recovery.
func RestoreOperator(cfg Config, data []byte) (*Operator, error) {
	op, err := NewOperator(cfg)
	if err != nil {
		return nil, err
	}
	if err := op.Restore(data); err != nil {
		return nil, err
	}
	return op, nil
}

// Snapshot serializes all state needed for deterministic recovery. The
// snapshot is taken between calls; outputs are returned synchronously and are
// therefore not part of the snapshot. Slice ordering is normalized so repeated
// snapshots of the same state produce identical bytes (subject to gob's
// encoding of user-provided Event.Value values).
func (o *Operator) Snapshot() ([]byte, error) {
	if o == nil {
		return nil, ErrNilOperator
	}
	data := snapshotData{
		Magic:           snapshotMagic,
		Version:         SnapshotVersion,
		Kind:            uint8(o.cfg.Window.Kind),
		Size:            o.cfg.Window.Size,
		Slide:           o.cfg.Window.Slide,
		Gap:             o.cfg.Window.Gap,
		AllowedLateness: o.cfg.AllowedLateness,
	}

	partitionIDs := make([]string, 0, len(o.partitions))
	for id := range o.partitions {
		partitionIDs = append(partitionIDs, id)
	}
	sort.Strings(partitionIDs)
	for _, id := range partitionIDs {
		ps := o.partitions[id]
		p := partitionSnapshot{
			ID:           id,
			Watermark:    ps.watermark,
			HasWatermark: ps.hasWatermark,
		}
		sourceIDs := make([]string, 0, len(ps.sources))
		for source := range ps.sources {
			sourceIDs = append(sourceIDs, source)
		}
		sort.Strings(sourceIDs)
		for _, source := range sourceIDs {
			ss := ps.sources[source]
			p.Sources = append(p.Sources, sourceSnapshot{
				ID:           source,
				Watermark:    ss.watermark,
				HasWatermark: ss.hasWatermark,
				Idle:         ss.idle,
			})
		}
		data.Partitions = append(data.Partitions, p)
	}

	keys := make([]fixedWindowKey, 0, len(o.fixed))
	for key := range o.fixed {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.Partition != b.Partition {
			return a.Partition < b.Partition
		}
		if a.Key != b.Key {
			return a.Key < b.Key
		}
		if a.Start != b.Start {
			return a.Start < b.Start
		}
		return a.End < b.End
	})
	for _, key := range keys {
		st := o.fixed[key]
		data.Fixed = append(data.Fixed, fixedWindowSnapshot{
			Partition: key.Partition,
			Key:       key.Key,
			Start:     key.Start,
			End:       key.End,
			Version:   st.version,
			Fired:     st.fired,
			Events:    cloneEvents(st.events),
		})
	}

	sessionKeys := make([]sessionKey, 0, len(o.sessions))
	for sk := range o.sessions {
		sessionKeys = append(sessionKeys, sk)
	}
	sort.Slice(sessionKeys, func(i, j int) bool {
		if sessionKeys[i].Partition != sessionKeys[j].Partition {
			return sessionKeys[i].Partition < sessionKeys[j].Partition
		}
		return sessionKeys[i].Key < sessionKeys[j].Key
	})
	for _, sk := range sessionKeys {
		for _, st := range o.sessions[sk] {
			data.Sessions = append(data.Sessions, sessionWindowSnapshot{
				Partition: sk.Partition,
				Key:       sk.Key,
				Start:     st.window.Start,
				End:       st.window.End,
				Version:   st.version,
				Fired:     st.fired,
				Events:    cloneEvents(st.events),
			})
		}
	}

	closedKeys := make([]sessionKey, 0, len(o.closedSessionEnd))
	for sk := range o.closedSessionEnd {
		closedKeys = append(closedKeys, sk)
	}
	sort.Slice(closedKeys, func(i, j int) bool {
		if closedKeys[i].Partition != closedKeys[j].Partition {
			return closedKeys[i].Partition < closedKeys[j].Partition
		}
		return closedKeys[i].Key < closedKeys[j].Key
	})
	for _, sk := range closedKeys {
		data.ClosedSessions = append(data.ClosedSessions, closedSessionSnapshot{
			Partition: sk.Partition,
			Key:       sk.Key,
			End:       o.closedSessionEnd[sk],
		})
	}

	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(data); err != nil {
		return nil, wrapError(ErrSnapshotFormat, "encode: %v", err)
	}
	return buf.Bytes(), nil
}

// Restore replaces the operator's state with a snapshot previously produced by
// Snapshot. The operator's configuration must match the snapshot's window kind,
// size/slide/gap, and allowed lateness. If the snapshot contains custom
// Event.Value types, register them first with RegisterEventValue.
func (o *Operator) Restore(data []byte) error {
	if o == nil {
		return ErrNilOperator
	}
	if len(data) == 0 {
		return wrapError(ErrSnapshotFormat, "empty snapshot")
	}
	var snap snapshotData
	if err := gob.NewDecoder(bytes.NewReader(data)).Decode(&snap); err != nil {
		return wrapError(ErrSnapshotFormat, "decode: %v", err)
	}
	if snap.Magic != snapshotMagic {
		return wrapError(ErrSnapshotFormat, "unexpected magic %q", snap.Magic)
	}
	if snap.Version != SnapshotVersion {
		return wrapError(ErrSnapshotFormat, "unsupported snapshot version %d", snap.Version)
	}

	spec := WindowSpec{Kind: WindowKind(snap.Kind), Size: snap.Size, Slide: snap.Slide, Gap: snap.Gap}
	if !windowSpecsEqual(spec, o.cfg.Window) || snap.AllowedLateness != o.cfg.AllowedLateness {
		return wrapError(ErrSnapshotConfigMismatch,
			"snapshot has %s lateness=%d, operator has %s lateness=%d",
			spec, snap.AllowedLateness, o.cfg.Window, o.cfg.AllowedLateness)
	}
	if err := spec.Validate(); err != nil {
		return err
	}

	partitions := make(map[string]*partitionState, len(snap.Partitions))
	for _, p := range snap.Partitions {
		ps := &partitionState{
			id:           p.ID,
			sources:      make(map[string]*sourceState, len(p.Sources)),
			watermark:    p.Watermark,
			hasWatermark: p.HasWatermark,
		}
		for _, s := range p.Sources {
			ps.sources[s.ID] = &sourceState{
				watermark:    s.Watermark,
				hasWatermark: s.HasWatermark,
				idle:         s.Idle,
			}
		}
		partitions[p.ID] = ps
	}

	fixed := make(map[fixedWindowKey]*fixedWindowState, len(snap.Fixed))
	for _, f := range snap.Fixed {
		if f.End <= f.Start {
			return wrapError(ErrSnapshotFormat, "invalid fixed window %s/%s [%d,%d)", f.Partition, f.Key, f.Start, f.End)
		}
		if f.Version < 0 || (f.Fired && f.Version == 0) || (!f.Fired && f.Version != 0) {
			return wrapError(ErrSnapshotFormat, "invalid fixed window version %d (fired=%v)", f.Version, f.Fired)
		}
		key := fixedWindowKey{Partition: f.Partition, Key: f.Key, Start: f.Start, End: f.End}
		if _, exists := fixed[key]; exists {
			return wrapError(ErrSnapshotFormat, "duplicate fixed window %s/%s %s", f.Partition, f.Key, key.window())
		}
		fixed[key] = &fixedWindowState{
			partition: f.Partition,
			key:       f.Key,
			window:    Window{Start: f.Start, End: f.End},
			version:   f.Version,
			fired:     f.Fired,
			events:    cloneEvents(f.Events),
		}
	}

	sessions := make(map[sessionKey][]*sessionWindowState, len(snap.Sessions))
	for _, s := range snap.Sessions {
		if s.End <= s.Start {
			return wrapError(ErrSnapshotFormat, "invalid session %s/%s [%d,%d)", s.Partition, s.Key, s.Start, s.End)
		}
		if s.Version < 0 || (s.Fired && s.Version == 0) || (!s.Fired && s.Version != 0) {
			return wrapError(ErrSnapshotFormat, "invalid session version %d (fired=%v)", s.Version, s.Fired)
		}
		sk := sessionKey{Partition: s.Partition, Key: s.Key}
		sessions[sk] = append(sessions[sk], &sessionWindowState{
			window:  Window{Start: s.Start, End: s.End},
			version: s.Version,
			fired:   s.Fired,
			events:  cloneEvents(s.Events),
		})
	}
	for sk := range sessions {
		list := sessions[sk]
		sort.Slice(list, func(i, j int) bool {
			if list[i].window.Start != list[j].window.Start {
				return list[i].window.Start < list[j].window.Start
			}
			return list[i].window.End < list[j].window.End
		})
	}

	closed := make(map[sessionKey]int64, len(snap.ClosedSessions))
	for _, c := range snap.ClosedSessions {
		sk := sessionKey{Partition: c.Partition, Key: c.Key}
		if c.End > closed[sk] {
			closed[sk] = c.End
		}
	}

	o.partitions = partitions
	o.fixed = fixed
	o.sessions = sessions
	o.closedSessionEnd = closed
	return nil
}

func (k fixedWindowKey) window() Window {
	return Window{Start: k.Start, End: k.End}
}
