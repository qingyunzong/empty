package formal

import (
	"fmt"
	"sync"
)

// Ledger is a concurrency-safe coordination ledger for terminal cleanup.
//
// All methods are linearizable with respect to one another. In particular, an
// in-flight confirmation racing with Delete can be ordered either way, but a
// key can never be removed before the confirmation has been durably recorded.
type Ledger struct {
	mu      sync.Mutex
	objects map[ObjectID]*objectState
	history []Event
}

type objectState struct {
	id            ObjectID
	keys          []*keyState
	byKey         map[KeyID]*keyState
	resources     map[ResourceID]*resourceState
	resourceOrder []ResourceID
	success       map[ResourceID]uint64
	cleaning      bool
	deleting      bool
	finished      bool
}

type keyState struct {
	id        KeyID
	resources []ResourceID
	members   map[ResourceID]struct{}
	removed   bool
	removals  uint64
}

type resourceState struct {
	id      ResourceID
	state   ResourceState
	attempt uint64
}

// NewLedger returns an empty ledger.
func NewLedger() *Ledger {
	return &Ledger{objects: make(map[ObjectID]*objectState)}
}

func newObjectState(id ObjectID) *objectState {
	return &objectState{
		id:        id,
		byKey:     make(map[KeyID]*keyState),
		resources: make(map[ResourceID]*resourceState),
		success:   make(map[ResourceID]uint64),
	}
}

func newKeyState(id KeyID) *keyState {
	return &keyState{id: id, members: make(map[ResourceID]struct{})}
}

// Apply atomically applies one event and returns the effects it produced.
//
// Invalid events leave the ledger untouched. Events that are valid but
// idempotent no-ops are retained in the history.
func (l *Ledger) Apply(ev Event) ([]Effect, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	effects, _, err := l.apply(ev)
	return effects, err
}

func (l *Ledger) apply(ev Event) ([]Effect, bool, error) {
	if err := validateEvent(ev); err != nil {
		return nil, false, err
	}

	effects, applied, err := l.mutate(ev)
	if err != nil {
		return nil, false, err
	}
	l.history = append(l.history, cloneEvent(ev))
	return effects, applied, nil
}

func (l *Ledger) mutate(ev Event) ([]Effect, bool, error) {
	applied := true

	switch ev.Kind {
	case EventRegister:
		obj := l.objects[ev.Object]
		if obj == nil {
			obj = newObjectState(ev.Object)
			l.objects[ev.Object] = obj
		}
		for _, spec := range ev.Keys {
			key := obj.byKey[spec.Key]
			if key == nil {
				key = newKeyState(spec.Key)
				obj.byKey[spec.Key] = key
				obj.keys = append(obj.keys, key)
			}
			key.removed = false
			for _, id := range spec.Resources {
				if _, ok := key.members[id]; !ok {
					key.members[id] = struct{}{}
					key.resources = append(key.resources, id)
				}
				if _, ok := obj.resources[id]; !ok {
					obj.resources[id] = &resourceState{id: id, state: ResourcePending}
					obj.resourceOrder = append(obj.resourceOrder, id)
				}
			}
		}
		obj.finished = false
		return nil, applied, nil

	case EventBeginCleanup:
		obj, err := l.object(ev.Object)
		if err != nil {
			return nil, false, err
		}
		obj.cleaning = true
		return nil, applied, nil

	case EventDelete:
		obj, err := l.object(ev.Object)
		if err != nil {
			return nil, false, err
		}
		obj.deleting = true
		obj.cleaning = true
		return nil, applied, nil

	case EventReconcile:
		obj, err := l.object(ev.Object)
		if err != nil {
			return nil, false, err
		}
		return obj.reconcile(), applied, nil

	case EventConfirm:
		obj, err := l.object(ev.Object)
		if err != nil {
			return nil, false, err
		}
		res := obj.resources[ev.Resource]
		if res == nil {
			return nil, false, fmt.Errorf("%w: %q", ErrUnknownResource, ev.Resource)
		}
		switch ev.Result {
		case ResultSucceeded:
			// Success is monotonic and shared by every key that names this
			// resource. Recording it from a stale attempt is deliberate: the
			// external side effect already occurred, so re-running it would be
			// duplicate cleanup.
			if res.state == ResourceSucceeded {
				applied = false
				break
			}
			res.state = ResourceSucceeded
			obj.success[ev.Resource]++
		case ResultFailed, ResultCancelled:
			if res.state != ResourceInFlight || res.attempt != ev.Attempt {
				applied = false
				break
			}
			if ev.Result == ResultFailed {
				res.state = ResourceFailed
			} else {
				res.state = ResourcePending
			}
		}
		return nil, applied, nil

	case EventRetry:
		obj, err := l.object(ev.Object)
		if err != nil {
			return nil, false, err
		}
		res := obj.resources[ev.Resource]
		if res == nil {
			return nil, false, fmt.Errorf("%w: %q", ErrUnknownResource, ev.Resource)
		}
		switch res.state {
		case ResourceSucceeded:
			applied = false
		case ResourceInFlight:
			return nil, false, fmt.Errorf("%w: %q attempt %d", ErrAttemptInFlight, ev.Resource, res.attempt)
		default:
			res.state = ResourcePending
		}
		return nil, applied, nil

	case EventCancel:
		obj, err := l.object(ev.Object)
		if err != nil {
			return nil, false, err
		}
		res := obj.resources[ev.Resource]
		if res == nil {
			return nil, false, fmt.Errorf("%w: %q", ErrUnknownResource, ev.Resource)
		}
		switch res.state {
		case ResourceInFlight, ResourceFailed:
			res.state = ResourcePending
		default:
			applied = false
		}
		return nil, applied, nil
	}

	panic("unreachable")
}

// Register adds terminal keys to an object in order.
//
// Registration is additive. If a key already exists, only resources not seen
// before are added; completed resources stay completed, and a key that was
// previously removed becomes present again. Registering a key during cleanup
// therefore never repeats a completed external cleanup.
func (l *Ledger) Register(obj ObjectID, keys ...KeySpec) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _, err := l.apply(Event{Kind: EventRegister, Object: obj, Keys: keys})
	return err
}

// BeginCleanup starts terminal cleanup without marking the object deleted.
// Cleanup may start before the delete event; key removal still waits for
// Delete.
func (l *Ledger) BeginCleanup(obj ObjectID) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _, err := l.apply(Event{Kind: EventBeginCleanup, Object: obj})
	return err
}

// Delete records the object deletion event and enables terminal key removal.
func (l *Ledger) Delete(obj ObjectID) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _, err := l.apply(Event{Kind: EventDelete, Object: obj})
	return err
}

// Reconcile releases pending cleanup work and removes every eligible key in
// registration order. It is idempotent; an empty result means no work is
// currently ready.
func (l *Ledger) Reconcile(obj ObjectID) ([]Effect, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	effects, _, err := l.apply(Event{Kind: EventReconcile, Object: obj})
	return effects, err
}

// Confirm records the terminal result of an external cleanup attempt. The
// returned bool reports whether the event changed the ledger. A duplicate
// success is reported as false and never increments the success record.
func (l *Ledger) Confirm(obj ObjectID, resource ResourceID, attempt uint64, result Result) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, applied, err := l.apply(Event{
		Kind:     EventConfirm,
		Object:   obj,
		Resource: resource,
		Attempt:  attempt,
		Result:   result,
	})
	return applied, err
}

// Retry requeues a resource whose attempt failed. It refuses to retry a
// completed resource and refuses to retry over an in-flight attempt; cancel or
// confirm that attempt first.
func (l *Ledger) Retry(obj ObjectID, resource ResourceID) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, applied, err := l.apply(Event{Kind: EventRetry, Object: obj, Resource: resource})
	return applied, err
}

// Cancel requeues a resource whose in-flight attempt was aborted without doing
// work, or a failed resource. A completed resource is never made runnable
// again.
func (l *Ledger) Cancel(obj ObjectID, resource ResourceID) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, applied, err := l.apply(Event{Kind: EventCancel, Object: obj, Resource: resource})
	return applied, err
}

// Snapshot returns a deep copy of one object's state.
func (l *Ledger) Snapshot(obj ObjectID) (Snapshot, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	state := l.objects[obj]
	if state == nil {
		return Snapshot{}, false
	}
	return state.snapshot(), true
}

// EventLog returns a deep copy of every event durably applied by the ledger.
func (l *Ledger) EventLog() []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Event, len(l.history))
	for i, ev := range l.history {
		out[i] = cloneEvent(ev)
	}
	return out
}

// Clone returns an independent copy of the ledger. It is primarily useful for
// deterministic fault-point exploration.
func (l *Ledger) Clone() *Ledger {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := NewLedger()
	for id, obj := range l.objects {
		out.objects[id] = obj.clone()
	}
	out.history = make([]Event, len(l.history))
	for i, ev := range l.history {
		out.history[i] = cloneEvent(ev)
	}
	return out
}

func (l *Ledger) object(id ObjectID) (*objectState, error) {
	obj := l.objects[id]
	if obj == nil {
		return nil, fmt.Errorf("%w: %q", ErrUnknownObject, id)
	}
	return obj, nil
}

func (o *objectState) reconcile() []Effect {
	if !o.cleaning {
		return nil
	}

	var effects []Effect
	for _, key := range o.keys {
		if key.removed {
			continue
		}

		// Only the first non-removed key may make progress. This preserves the
		// registration order across both starts and removals.
		for _, id := range key.resources {
			res := o.resources[id]
			if res.state != ResourcePending {
				continue
			}
			res.attempt++
			res.state = ResourceInFlight
			effects = append(effects, Effect{
				Kind:     EffectStartCleanup,
				Object:   o.id,
				Key:      key.id,
				Resource: id,
				Attempt:  res.attempt,
			})
		}

		if o.deleting && key.allSucceeded(o.resources) {
			key.removed = true
			key.removals++
			effects = append(effects, Effect{
				Kind:   EffectRemoveKey,
				Object: o.id,
				Key:    key.id,
			})
			continue
		}
		break
	}

	if o.deleting && !o.finished && o.allKeysRemoved() {
		o.finished = true
		effects = append(effects, Effect{Kind: EffectFinishObject, Object: o.id})
	}
	return effects
}

func (k *keyState) allSucceeded(resources map[ResourceID]*resourceState) bool {
	for _, id := range k.resources {
		if resources[id].state != ResourceSucceeded {
			return false
		}
	}
	return true
}

func (o *objectState) allKeysRemoved() bool {
	for _, key := range o.keys {
		if !key.removed {
			return false
		}
	}
	return true
}

func (o *objectState) snapshot() Snapshot {
	s := Snapshot{
		Object:         o.id,
		Cleaning:       o.cleaning,
		Deleting:       o.deleting,
		Finished:       o.finished,
		Keys:           make([]KeySnapshot, 0, len(o.keys)),
		Resources:      make([]ResourceSnapshot, 0, len(o.resourceOrder)),
		SuccessRecords: make(map[ResourceID]uint64, len(o.success)),
	}
	for _, key := range o.keys {
		ks := KeySnapshot{
			Key:       key.id,
			Resources: append([]ResourceID(nil), key.resources...),
			Removed:   key.removed,
			Removals:  key.removals,
		}
		s.Keys = append(s.Keys, ks)
	}
	for _, id := range o.resourceOrder {
		res := o.resources[id]
		s.Resources = append(s.Resources, ResourceSnapshot{
			Resource: id,
			State:    res.state,
			Attempt:  res.attempt,
		})
	}
	for id, count := range o.success {
		s.SuccessRecords[id] = count
	}
	return s
}

func (o *objectState) clone() *objectState {
	out := newObjectState(o.id)
	out.cleaning = o.cleaning
	out.deleting = o.deleting
	out.finished = o.finished
	for _, key := range o.keys {
		kc := newKeyState(key.id)
		kc.resources = append([]ResourceID(nil), key.resources...)
		kc.removed = key.removed
		kc.removals = key.removals
		for id := range key.members {
			kc.members[id] = struct{}{}
		}
		out.keys = append(out.keys, kc)
		out.byKey[kc.id] = kc
	}
	for id, res := range o.resources {
		out.resources[id] = &resourceState{id: res.id, state: res.state, attempt: res.attempt}
	}
	out.resourceOrder = append([]ResourceID(nil), o.resourceOrder...)
	for id, count := range o.success {
		out.success[id] = count
	}
	return out
}

func cloneEvent(ev Event) Event {
	ev.Keys = append([]KeySpec(nil), ev.Keys...)
	for i := range ev.Keys {
		ev.Keys[i].Resources = append([]ResourceID(nil), ev.Keys[i].Resources...)
	}
	return ev
}

func validateEvent(ev Event) error {
	if ev.Object == "" {
		return fmt.Errorf("%w: empty object", ErrInvalidEvent)
	}
	switch ev.Kind {
	case EventRegister:
		if len(ev.Keys) == 0 {
			return fmt.Errorf("%w: register without keys", ErrInvalidEvent)
		}
		for _, spec := range ev.Keys {
			if spec.Key == "" {
				return fmt.Errorf("%w: empty key", ErrInvalidEvent)
			}
			for _, id := range spec.Resources {
				if id == "" {
					return fmt.Errorf("%w: empty resource", ErrInvalidEvent)
				}
			}
		}
	case EventBeginCleanup, EventDelete, EventReconcile:
	case EventConfirm:
		if ev.Resource == "" {
			return fmt.Errorf("%w: empty resource", ErrInvalidEvent)
		}
		if ev.Attempt == 0 {
			return fmt.Errorf("%w: confirm requires an attempt", ErrInvalidEvent)
		}
		if ev.Result != ResultSucceeded && ev.Result != ResultFailed && ev.Result != ResultCancelled {
			return fmt.Errorf("%w: unknown result %d", ErrInvalidEvent, ev.Result)
		}
	case EventRetry, EventCancel:
		if ev.Resource == "" {
			return fmt.Errorf("%w: empty resource", ErrInvalidEvent)
		}
	default:
		return fmt.Errorf("%w: unknown kind %d", ErrInvalidEvent, ev.Kind)
	}
	return nil
}
