package formal

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// Part is one named section of a configuration revision. Values must be
// treated as immutable once they have been handed to a Manager.
type Part struct {
	Name  string
	Value any
}

// Validator checks one part of a candidate revision. Returning a non-nil error
// rejects the whole candidate; the currently published version is retained.
type Validator func(Part) error

// ConfigValidator checks the complete candidate after every part validator has
// passed. It is the place to enforce cross-part invariants or required parts.
// The candidate has not been published yet and its ID is 0.
type ConfigValidator func(*Version) error

var (
	// ErrEmptyPartName is reported when a candidate contains a part without a
	// name.
	ErrEmptyPartName = errors.New("part name is empty")

	// ErrDuplicatePart is reported when a candidate contains two parts with the
	// same name.
	ErrDuplicatePart = errors.New("duplicate part name")
)

// PartError describes a validation failure for one part.
type PartError struct {
	Part string
	Err  error
}

func (e *PartError) Error() string {
	return fmt.Sprintf("part %q: %v", e.Part, e.Err)
}

func (e *PartError) Unwrap() error {
	return e.Err
}

// ValidationError is returned when a candidate revision is rejected. Every
// part-level failure is collected, so a partially broken revision reports all
// of its broken parts rather than only the first one.
type ValidationError struct {
	Failures []PartError
}

func (e *ValidationError) Error() string {
	if len(e.Failures) == 0 {
		return "configuration rejected"
	}
	msgs := make([]string, len(e.Failures))
	for i := range e.Failures {
		msgs[i] = e.Failures[i].Error()
	}
	return "configuration rejected: " + strings.Join(msgs, "; ")
}

// Unwrap exposes the individual failures to errors.Is and errors.As.
func (e *ValidationError) Unwrap() []error {
	out := make([]error, len(e.Failures))
	for i := range e.Failures {
		out[i] = &e.Failures[i]
	}
	return out
}

// Version is an immutable, fully validated configuration revision. A Version
// is built and validated off to the side and only becomes reachable through a
// single atomic pointer publication, so readers can never observe a version
// containing a mixture of old and new parts.
type Version struct {
	id    uint64
	parts []Part
	index map[string]any
}

// ID returns the monotonically increasing publication number. The initial
// version is 1; rejected candidates do not consume an ID.
func (v *Version) ID() uint64 {
	return v.id
}

// Get returns the value of a named part.
func (v *Version) Get(name string) (any, bool) {
	value, ok := v.index[name]
	return value, ok
}

// Lookup is a typed convenience wrapper around Get.
func Lookup[T any](v *Version, name string) (T, bool) {
	var zero T
	value, ok := v.Get(name)
	if !ok {
		return zero, false
	}
	typed, ok := value.(T)
	return typed, ok
}

// Len returns the number of parts in the version.
func (v *Version) Len() int {
	return len(v.parts)
}

// Parts returns a copy of the version's parts sorted by name. The returned
// slice may be modified without affecting the version.
func (v *Version) Parts() []Part {
	out := make([]Part, len(v.parts))
	copy(out, v.parts)
	return out
}

// Names returns the part names sorted lexicographically.
func (v *Version) Names() []string {
	names := make([]string, len(v.parts))
	for i := range v.parts {
		names[i] = v.parts[i].Name
	}
	return names
}

// String implements fmt.Stringer.
func (v *Version) String() string {
	return fmt.Sprintf("config v%d (%d parts)", v.id, len(v.parts))
}

func buildVersion(id uint64, parts []Part) (*Version, error) {
	index := make(map[string]any, len(parts))
	copied := make([]Part, len(parts))
	var failures []PartError

	for i, part := range parts {
		if part.Name == "" {
			failures = append(failures, PartError{Part: part.Name, Err: ErrEmptyPartName})
			continue
		}
		if _, exists := index[part.Name]; exists {
			failures = append(failures, PartError{Part: part.Name, Err: ErrDuplicatePart})
			continue
		}
		index[part.Name] = part.Value
		copied[i] = part
	}
	if len(failures) > 0 {
		return nil, &ValidationError{Failures: failures}
	}

	sort.Slice(copied, func(i, j int) bool {
		return copied[i].Name < copied[j].Name
	})

	return &Version{id: id, parts: copied, index: index}, nil
}

// Option configures a Manager during construction.
type Option func(*Manager) error

// WithValidator registers a validator for one part name.
func WithValidator(name string, validate Validator) Option {
	return func(m *Manager) error {
		if name == "" {
			return ErrEmptyPartName
		}
		if validate == nil {
			return fmt.Errorf("validator for part %q is nil", name)
		}
		if _, exists := m.validators[name]; exists {
			return fmt.Errorf("validator for part %q already registered", name)
		}
		m.validators[name] = validate
		return nil
	}
}

// WithValidators registers a set of part validators.
func WithValidators(validators map[string]Validator) Option {
	return func(m *Manager) error {
		names := make([]string, 0, len(validators))
		for name := range validators {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if err := WithValidator(name, validators[name])(m); err != nil {
				return err
			}
		}
		return nil
	}
}

// WithConfigValidator registers a validator for the complete revision.
func WithConfigValidator(validate ConfigValidator) Option {
	return func(m *Manager) error {
		if validate == nil {
			return errors.New("config validator is nil")
		}
		m.configValidators = append(m.configValidators, validate)
		return nil
	}
}

// Change describes a successful atomic switch.
type Change struct {
	Previous *Version
	Current  *Version
}

// Rejection describes a candidate that failed validation or could not be read.
// The published version is unchanged when a rejection is reported.
type Rejection struct {
	Candidate []Part
	Err       error
}

type listener struct {
	active   atomic.Bool
	onChange func(Change)
	onReject func(Rejection)
}

type slot struct {
	version *Version
	refs    atomic.Int64
}

// Manager owns the currently published configuration version. Writers are
// serialized, while readers acquire immutable snapshots without taking a lock.
type Manager struct {
	writeMu sync.Mutex

	current atomic.Pointer[slot]

	validators       map[string]Validator
	configValidators []ConfigValidator

	mu        sync.Mutex
	nextID    uint64
	published uint64
	rejected  uint64
	listeners []*listener
	retained  map[*slot]struct{}
	inFlight  atomic.Int64
}

// NewManager creates a manager and atomically publishes initial as version 1.
// The initial revision is validated with the same rules as every later
// revision; if it is invalid, no manager is created.
func NewManager(initial []Part, opts ...Option) (*Manager, error) {
	m := &Manager{
		validators: make(map[string]Validator),
		retained:   make(map[*slot]struct{}),
		nextID:     1,
	}
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		if err := opt(m); err != nil {
			return nil, err
		}
	}

	version, err := buildVersion(0, initial)
	if err != nil {
		return nil, err
	}
	if err := m.validate(version); err != nil {
		return nil, err
	}
	version.id = 1

	initialSlot := &slot{version: version}
	initialSlot.refs.Store(1)
	m.current.Store(initialSlot)
	m.nextID = 2
	return m, nil
}

func (m *Manager) validate(version *Version) error {
	var failures []PartError

	for _, part := range version.parts {
		validate := m.validators[part.Name]
		if validate == nil {
			continue
		}
		if err := validate(part); err != nil {
			failures = append(failures, PartError{Part: part.Name, Err: err})
		}
	}
	if len(failures) == 0 {
		for _, validate := range m.configValidators {
			if err := validate(version); err != nil {
				failures = append(failures, PartError{Part: "<config>", Err: err})
			}
		}
	}
	if len(failures) > 0 {
		return &ValidationError{Failures: failures}
	}
	return nil
}

// Current returns the currently published version. The returned Version is
// immutable and remains readable forever, but a request that needs to pin the
// version it entered with should use Acquire instead.
func (m *Manager) Current() *Version {
	return m.current.Load().version
}

// Snapshot pins the version that was current when the snapshot was acquired.
// It remains valid after any number of later switches until Release is called.
type Snapshot struct {
	Version *Version

	manager *Manager
	slot    *slot
	once    sync.Once
}

// Acquire pins the current version for one unit of work. The caller must call
// Release when the work is done. Acquire is lock-free with respect to writers,
// so an atomic switch never interrupts an in-flight request.
func (m *Manager) Acquire() *Snapshot {
	for {
		current := m.current.Load()
		for {
			refs := current.refs.Load()
			if refs <= 0 {
				// A writer retired this slot between our load and our
				// increment. Retry against the new current version instead of
				// resurrecting a slot that is already being reclaimed.
				break
			}
			if current.refs.CompareAndSwap(refs, refs+1) {
				m.inFlight.Add(1)
				return &Snapshot{
					Version: current.version,
					manager: m,
					slot:    current,
				}
			}
		}
	}
}

// Release drops the snapshot's reference. It is safe to call Release more than
// once and on a nil snapshot.
func (s *Snapshot) Release() {
	if s == nil {
		return
	}
	s.once.Do(func() {
		s.manager.inFlight.Add(-1)
		if s.slot.refs.Add(-1) == 0 {
			s.manager.forget(s.slot)
		}
	})
}

// Apply validates a complete candidate revision and, only if every validation
// passes, publishes it with a single atomic pointer swap. On any error the
// currently published version is retained untouched, which is the rollback
// behaviour: there is no partially applied intermediate state to undo.
func (m *Manager) Apply(parts []Part) (*Version, error) {
	m.writeMu.Lock()
	defer m.writeMu.Unlock()

	candidate, err := buildVersion(0, parts)
	if err != nil {
		m.rejectLocked(parts, err)
		return nil, err
	}
	if err := m.validate(candidate); err != nil {
		m.rejectLocked(parts, err)
		return nil, err
	}

	candidate.id = m.nextID
	m.nextID++

	next := &slot{version: candidate}
	next.refs.Store(1)

	// Publish and update the counter under the stats lock so Stats never
	// observes a new CurrentVersion paired with the previous Published count.
	m.mu.Lock()
	previous := m.current.Swap(next)
	m.published++
	m.mu.Unlock()

	if previous.refs.Add(-1) > 0 {
		m.retain(previous)
	}

	m.notifyChange(Change{Previous: previous.version, Current: candidate})
	return candidate, nil
}

// Validate checks a candidate without publishing it.
func (m *Manager) Validate(parts []Part) error {
	candidate, err := buildVersion(0, parts)
	if err != nil {
		return err
	}
	return m.validate(candidate)
}

// ReportRejection records an out-of-band source or decode failure without
// changing the published version. Watch uses it for update.Err values.
func (m *Manager) ReportRejection(parts []Part, err error) {
	if err == nil {
		err = errors.New("configuration update rejected")
	}
	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	m.rejectLocked(parts, err)
}

func (m *Manager) rejectLocked(parts []Part, err error) {
	m.mu.Lock()
	m.rejected++
	m.mu.Unlock()

	candidate := make([]Part, len(parts))
	copy(candidate, parts)
	m.notifyReject(Rejection{Candidate: candidate, Err: err})
}

func (m *Manager) retain(s *slot) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s.refs.Load() > 0 {
		m.retained[s] = struct{}{}
	}
}

func (m *Manager) forget(s *slot) {
	m.mu.Lock()
	delete(m.retained, s)
	m.mu.Unlock()
}

// Stats is a point-in-time view of manager activity.
type Stats struct {
	// CurrentVersion is the ID of the published version.
	CurrentVersion uint64
	// Published counts successful switches after the initial version.
	Published uint64
	// Rejected counts candidates that failed validation or decoding.
	Rejected uint64
	// InFlight counts snapshots that have been acquired but not released.
	InFlight int64
	// RetainedVersions counts superseded versions still pinned by in-flight
	// snapshots.
	RetainedVersions int
}

// Stats returns counters for observability and tests.
func (m *Manager) Stats() Stats {
	m.mu.Lock()
	defer m.mu.Unlock()
	return Stats{
		CurrentVersion:   m.current.Load().version.ID(),
		Published:        m.published,
		Rejected:         m.rejected,
		InFlight:         m.inFlight.Load(),
		RetainedVersions: len(m.retained),
	}
}

// OnChange registers a callback that runs synchronously after a successful
// switch. The callback must not call Apply; it may call Acquire and Current.
func (m *Manager) OnChange(fn func(Change)) (unsubscribe func()) {
	if fn == nil {
		return func() {}
	}
	entry := &listener{onChange: fn}
	entry.active.Store(true)
	m.mu.Lock()
	m.listeners = append(m.listeners, entry)
	m.mu.Unlock()
	return func() {
		entry.active.Store(false)
		m.removeListener(entry)
	}
}

// OnReject registers a callback that runs synchronously when a candidate or
// source update is rejected. The callback must not call Apply.
func (m *Manager) OnReject(fn func(Rejection)) (unsubscribe func()) {
	if fn == nil {
		return func() {}
	}
	entry := &listener{onReject: fn}
	entry.active.Store(true)
	m.mu.Lock()
	m.listeners = append(m.listeners, entry)
	m.mu.Unlock()
	return func() {
		entry.active.Store(false)
		m.removeListener(entry)
	}
}

func (m *Manager) removeListener(entry *listener) {
	m.mu.Lock()
	for i, candidate := range m.listeners {
		if candidate == entry {
			m.listeners = append(m.listeners[:i], m.listeners[i+1:]...)
			break
		}
	}
	m.mu.Unlock()
}

func (m *Manager) listenerSnapshot() []*listener {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*listener, len(m.listeners))
	copy(out, m.listeners)
	return out
}

func (m *Manager) notifyChange(change Change) {
	for _, entry := range m.listenerSnapshot() {
		if entry.active.Load() && entry.onChange != nil {
			entry.onChange(change)
		}
	}
}

func (m *Manager) notifyReject(rejection Rejection) {
	for _, entry := range m.listenerSnapshot() {
		if entry.active.Load() && entry.onReject != nil {
			entry.onReject(rejection)
		}
	}
}
