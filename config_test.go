package formal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func rejectBadB(part Part) error {
	if part.Name == "b" && part.Value == "BAD" {
		return errors.New("b must not be BAD")
	}
	return nil
}

func newTestManager(t *testing.T) *Manager {
	t.Helper()
	m, err := NewManager(
		[]Part{{Name: "b", Value: "B0"}, {Name: "a", Value: "A0"}},
		WithValidator("b", rejectBadB),
	)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	return m
}

func partString(t *testing.T, version *Version, name string) string {
	t.Helper()
	value, ok := version.Get(name)
	if !ok {
		t.Fatalf("version %d has no part %q", version.ID(), name)
	}
	text, ok := value.(string)
	if !ok {
		t.Fatalf("part %q has type %T, want string", name, value)
	}
	return text
}

func TestApplyPublishesWholeVersion(t *testing.T) {
	m := newTestManager(t)

	initial := m.Current()
	if initial.ID() != 1 {
		t.Fatalf("initial ID = %d, want 1", initial.ID())
	}
	if got := partString(t, initial, "a"); got != "A0" {
		t.Fatalf("initial a = %q, want A0", got)
	}

	next, err := m.Apply([]Part{{Name: "b", Value: "B1"}, {Name: "a", Value: "A1"}})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if next.ID() != 2 {
		t.Fatalf("new ID = %d, want 2", next.ID())
	}
	if m.Current() != next {
		t.Fatal("Current did not switch to the applied version")
	}
	if got, ok := Lookup[string](next, "a"); !ok || got != "A1" {
		t.Fatalf("a = %q, %v; want A1", got, ok)
	}
	if got, ok := Lookup[string](next, "b"); !ok || got != "B1" {
		t.Fatalf("b = %q, %v; want B1", got, ok)
	}
	if names := next.Names(); len(names) != 2 || names[0] != "a" || names[1] != "b" {
		t.Fatalf("Names = %v, want [a b]", names)
	}
	if parts := next.Parts(); len(parts) != 2 || parts[0].Name != "a" || parts[1].Name != "b" {
		t.Fatalf("Parts = %#v", parts)
	}
	if got := next.String(); got != "config v2 (2 parts)" {
		t.Fatalf("String = %q", got)
	}

	stats := m.Stats()
	if stats.Published != 1 || stats.Rejected != 0 || stats.CurrentVersion != 2 {
		t.Fatalf("Stats = %+v", stats)
	}
}

func TestOptionsAndValidationErrors(t *testing.T) {
	sentinel := errors.New("a rejected")
	m, err := NewManager(
		[]Part{{Name: "a", Value: "A0"}, {Name: "b", Value: "B0"}},
		WithValidators(map[string]Validator{
			"a": func(part Part) error {
				if part.Value == "BAD-A" {
					return sentinel
				}
				return nil
			},
			"b": rejectBadB,
		}),
	)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	_, err = m.Apply([]Part{{Name: "a", Value: "BAD-A"}, {Name: "b", Value: "BAD"}})
	if err == nil {
		t.Fatal("Apply accepted two invalid parts")
	}
	if !errors.Is(err, sentinel) {
		t.Fatalf("errors.Is did not find the part error: %v", err)
	}
	var validation *ValidationError
	if !errors.As(err, &validation) || len(validation.Failures) != 2 {
		t.Fatalf("validation error = %#v (%v)", validation, err)
	}
	if got := validation.Error(); !strings.Contains(got, "part \"a\"") || !strings.Contains(got, "part \"b\"") {
		t.Fatalf("ValidationError.Error = %q", got)
	}
	if unwrapped := validation.Unwrap(); len(unwrapped) != 2 || unwrapped[0].Error() == "" {
		t.Fatalf("ValidationError.Unwrap = %v", unwrapped)
	}
	for _, failure := range validation.Failures {
		if failure.Unwrap() == nil {
			t.Fatalf("PartError %q has nil Unwrap", failure.Part)
		}
	}

	if _, err := NewManager(
		[]Part{{Name: "a", Value: "A0"}},
		WithValidator("a", func(Part) error { return nil }),
		WithValidator("a", func(Part) error { return nil }),
	); err == nil {
		t.Fatal("duplicate validator registration succeeded")
	}
}

func TestUnsubscribeStopsListener(t *testing.T) {
	m := newTestManager(t)
	changes := 0
	rejections := 0
	unsubscribeChange := m.OnChange(func(Change) { changes++ })
	unsubscribeReject := m.OnReject(func(Rejection) { rejections++ })
	unsubscribeChange()
	unsubscribeReject()

	if _, err := m.Apply([]Part{{Name: "a", Value: "A1"}, {Name: "b", Value: "B1"}}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if _, err := m.Apply([]Part{{Name: "a", Value: "A2"}, {Name: "b", Value: "BAD"}}); err == nil {
		t.Fatal("invalid candidate accepted")
	}
	if changes != 0 || rejections != 0 {
		t.Fatalf("unsubscribed listeners fired: changes=%d rejections=%d", changes, rejections)
	}
}

func TestValidateDoesNotPublish(t *testing.T) {
	m := newTestManager(t)
	before := m.Current()

	if err := m.Validate([]Part{{Name: "a", Value: "A9"}, {Name: "b", Value: "B9"}}); err != nil {
		t.Fatalf("Validate valid candidate: %v", err)
	}
	if m.Current() != before {
		t.Fatal("Validate changed the published version")
	}
	if err := m.Validate([]Part{{Name: "a", Value: "A9"}, {Name: "b", Value: "BAD"}}); err == nil {
		t.Fatal("Validate accepted an invalid candidate")
	}
}

func TestPartialFailureKeepsOldVersion(t *testing.T) {
	m, err := NewManager(
		[]Part{{Name: "a", Value: "A0"}, {Name: "b", Value: "B0"}},
		WithValidator("a", func(part Part) error {
			if part.Value == "BAD-A" {
				return errors.New("a rejected")
			}
			return nil
		}),
		WithValidator("b", func(part Part) error {
			if part.Value == "BAD-B" {
				return errors.New("b rejected")
			}
			return nil
		}),
	)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	before := m.Current()
	var changes, rejections int
	m.OnChange(func(Change) { changes++ })
	m.OnReject(func(Rejection) { rejections++ })

	_, err = m.Apply([]Part{
		{Name: "a", Value: "BAD-A"},
		{Name: "b", Value: "BAD-B"},
		{Name: "c", Value: "new-and-valid"},
	})
	if err == nil {
		t.Fatal("Apply accepted a partially invalid revision")
	}
	var validation *ValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("error type = %T, want *ValidationError", err)
	}
	if len(validation.Failures) != 2 {
		t.Fatalf("Failures = %d, want 2: %v", len(validation.Failures), err)
	}

	if m.Current() != before {
		t.Fatal("published version changed after a rejected candidate")
	}
	if got := partString(t, m.Current(), "a"); got != "A0" {
		t.Fatalf("a = %q after rejection, want A0", got)
	}
	if _, ok := m.Current().Get("c"); ok {
		t.Fatal("part from rejected candidate became visible")
	}
	if changes != 0 {
		t.Fatalf("OnChange called %d times, want 0", changes)
	}
	if rejections != 1 {
		t.Fatalf("OnReject called %d times, want 1", rejections)
	}
	stats := m.Stats()
	if stats.Rejected != 1 || stats.Published != 0 || stats.CurrentVersion != before.ID() {
		t.Fatalf("Stats = %+v", stats)
	}
}

func TestDuplicateAndEmptyPartNamesAreRejected(t *testing.T) {
	m := newTestManager(t)
	before := m.Current()

	for _, parts := range [][]Part{
		{{Name: "a", Value: "A1"}, {Name: "a", Value: "A2"}},
		{{Name: "", Value: "x"}, {Name: "a", Value: "A1"}},
	} {
		if _, err := m.Apply(parts); err == nil {
			t.Fatalf("Apply(%v) succeeded, want rejection", parts)
		}
		if m.Current() != before {
			t.Fatalf("Apply(%v) changed the published version", parts)
		}
	}
	if got := m.Stats().Rejected; got != 2 {
		t.Fatalf("Rejected = %d, want 2", got)
	}
}

func TestConfigValidatorRejectsIncompleteRevision(t *testing.T) {
	configChecks := 0
	m, err := NewManager(
		[]Part{{Name: "a", Value: "A0"}, {Name: "b", Value: "B0"}},
		WithValidator("b", rejectBadB),
		WithConfigValidator(func(version *Version) error {
			configChecks++
			if _, ok := version.Get("b"); !ok {
				return errors.New("part b is required")
			}
			return nil
		}),
	)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	if configChecks != 1 {
		t.Fatalf("config validator ran %d times for initial version, want 1", configChecks)
	}

	before := m.Current()
	if _, err := m.Apply([]Part{{Name: "a", Value: "A1"}}); err == nil {
		t.Fatal("Apply accepted a revision missing part b")
	}
	if m.Current() != before {
		t.Fatal("incomplete revision changed the published version")
	}
	if configChecks != 2 {
		t.Fatalf("config validator ran %d times, want 2", configChecks)
	}

	// A part failure stops before the whole-configuration phase.
	configChecks = 0
	if _, err := m.Apply([]Part{{Name: "b", Value: "BAD"}}); err == nil {
		t.Fatal("Apply accepted an invalid part")
	}
	if configChecks != 0 {
		t.Fatalf("config validator ran %d times after a part failure, want 0", configChecks)
	}
}

func TestFailedValidationNeverExposesCandidate(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var enteredOnce sync.Once

	m, err := NewManager(
		[]Part{{Name: "a", Value: "A0"}, {Name: "b", Value: "B0"}},
		WithValidator("b", func(part Part) error {
			if part.Value == "B-pending" {
				enteredOnce.Do(func() { close(entered) })
				<-release
				return errors.New("candidate rejected after pause")
			}
			return nil
		}),
	)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	before := m.Current()

	applyDone := make(chan error, 1)
	go func() {
		_, err := m.Apply([]Part{
			{Name: "a", Value: "A-pending"},
			{Name: "b", Value: "B-pending"},
		})
		applyDone <- err
	}()

	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("validator was not entered")
	}

	// Apply is paused inside validation. The candidate has not been published.
	snapshot := m.Acquire()
	if snapshot.Version != before {
		t.Fatal("request entering during validation saw the candidate")
	}
	if got := partString(t, snapshot.Version, "a"); got != "A0" {
		t.Fatalf("a during validation = %q, want A0", got)
	}
	if got := partString(t, snapshot.Version, "b"); got != "B0" {
		t.Fatalf("b during validation = %q, want B0", got)
	}
	snapshot.Release()

	close(release)
	if err := <-applyDone; err == nil {
		t.Fatal("Apply accepted the paused candidate")
	}
	if m.Current() != before {
		t.Fatal("failed Apply changed the published version")
	}
	if got := partString(t, m.Current(), "a"); got != "A0" {
		t.Fatalf("a after failed Apply = %q, want A0", got)
	}
}

func TestSuccessfulValidationDoesNotBlockReaders(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var enteredOnce sync.Once

	m, err := NewManager(
		[]Part{{Name: "a", Value: "A0"}, {Name: "b", Value: "B0"}},
		WithValidator("b", func(part Part) error {
			if part.Value == "B-next" {
				enteredOnce.Do(func() { close(entered) })
				<-release
			}
			return nil
		}),
	)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	before := m.Current()

	applyDone := make(chan *Version, 1)
	applyErr := make(chan error, 1)
	go func() {
		version, err := m.Apply([]Part{
			{Name: "a", Value: "A-next"},
			{Name: "b", Value: "B-next"},
		})
		applyDone <- version
		applyErr <- err
	}()

	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("validator was not entered")
	}

	during := m.Acquire()
	if during.Version != before {
		t.Fatal("reader saw the new version before validation completed")
	}
	if got := partString(t, during.Version, "a"); got != "A0" {
		t.Fatalf("a while validation is paused = %q, want A0", got)
	}

	close(release)
	next := <-applyDone
	if err := <-applyErr; err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if next.ID() != 2 {
		t.Fatalf("next ID = %d, want 2", next.ID())
	}

	if during.Version != before {
		t.Fatal("in-flight snapshot switched after publication")
	}
	if got := partString(t, during.Version, "a"); got != "A0" {
		t.Fatalf("in-flight a after publication = %q, want A0", got)
	}
	during.Release()

	after := m.Acquire()
	if after.Version != next {
		t.Fatal("request entering after publication did not see the new version")
	}
	if got := partString(t, after.Version, "a"); got != "A-next" {
		t.Fatalf("new a = %q, want A-next", got)
	}
	after.Release()
}

func TestSnapshotPinsEntryVersion(t *testing.T) {
	m := newTestManager(t)

	first := m.Acquire()
	entry := first.Version
	if entry.ID() != 1 {
		t.Fatalf("entry ID = %d, want 1", entry.ID())
	}

	secondVersion, err := m.Apply([]Part{{Name: "a", Value: "A1"}, {Name: "b", Value: "B1"}})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}

	if first.Version != entry {
		t.Fatal("in-flight snapshot changed version after a switch")
	}
	if got := partString(t, first.Version, "a"); got != "A0" {
		t.Fatalf("in-flight a = %q, want A0", got)
	}
	if got := partString(t, first.Version, "b"); got != "B0" {
		t.Fatalf("in-flight b = %q, want B0", got)
	}

	second := m.Acquire()
	if second.Version != secondVersion {
		t.Fatal("new snapshot did not observe the new version")
	}
	if got := partString(t, second.Version, "a"); got != "A1" {
		t.Fatalf("new snapshot a = %q, want A1", got)
	}

	stats := m.Stats()
	if stats.InFlight != 2 {
		t.Fatalf("InFlight = %d, want 2", stats.InFlight)
	}
	if stats.RetainedVersions != 1 {
		t.Fatalf("RetainedVersions = %d, want 1", stats.RetainedVersions)
	}

	first.Release()
	first.Release()
	stats = m.Stats()
	if stats.InFlight != 1 {
		t.Fatalf("InFlight after first release = %d, want 1", stats.InFlight)
	}
	if stats.RetainedVersions != 0 {
		t.Fatalf("RetainedVersions after first release = %d, want 0", stats.RetainedVersions)
	}

	second.Release()
	stats = m.Stats()
	if stats.InFlight != 0 || stats.RetainedVersions != 0 {
		t.Fatalf("Stats after all releases = %+v", stats)
	}
}

type channelSource struct {
	updates <-chan Update
}

func (s channelSource) Watch(context.Context) (<-chan Update, error) {
	return s.updates, nil
}

func waitChange(t *testing.T, changes <-chan Change) Change {
	t.Helper()
	select {
	case change := <-changes:
		return change
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for a configuration change")
		return Change{}
	}
}

func waitRejection(t *testing.T, rejections <-chan Rejection) Rejection {
	t.Helper()
	select {
	case rejection := <-rejections:
		return rejection
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for a configuration rejection")
		return Rejection{}
	}
}

func TestWatchPinsInFlightAndContinuesAfterFailure(t *testing.T) {
	m := newTestManager(t)
	changes := make(chan Change, 16)
	rejections := make(chan Rejection, 16)
	m.OnChange(func(change Change) { changes <- change })
	m.OnReject(func(rejection Rejection) { rejections <- rejection })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	updates := make(chan Update, 16)
	done := make(chan error, 1)
	go func() {
		done <- m.Watch(ctx, channelSource{updates: updates})
	}()

	pinned := m.Acquire()
	entryVersion := pinned.Version

	updates <- Update{Token: "t1", Parts: []Part{{Name: "a", Value: "A1"}, {Name: "b", Value: "B1"}}}
	change := waitChange(t, changes)
	if change.Current.ID() != 2 {
		t.Fatalf("first change ID = %d, want 2", change.Current.ID())
	}

	// The duplicate token must be skipped, so the next change is still ID 3 and
	// must carry t2's parts rather than the duplicate's parts.
	updates <- Update{Token: "t1", Parts: []Part{{Name: "a", Value: "DUPLICATE"}, {Name: "b", Value: "B1"}}}
	updates <- Update{Token: "t2", Parts: []Part{{Name: "a", Value: "A2"}, {Name: "b", Value: "B2"}}}
	change = waitChange(t, changes)
	if change.Current.ID() != 3 {
		t.Fatalf("second change ID = %d, want 3 (duplicate token was applied)", change.Current.ID())
	}
	if got := partString(t, change.Current, "a"); got != "A2" {
		t.Fatalf("second change a = %q, want A2", got)
	}

	updates <- Update{Token: "t3", Parts: []Part{{Name: "a", Value: "A3"}, {Name: "b", Value: "BAD"}}}
	rejection := waitRejection(t, rejections)
	if rejection.Err == nil {
		t.Fatal("rejection has nil error")
	}
	if m.Current().ID() != 3 {
		t.Fatalf("current ID after rejection = %d, want 3", m.Current().ID())
	}

	updates <- Update{Err: errors.New("decode failed")}
	rejection = waitRejection(t, rejections)
	if rejection.Err == nil || !strings.Contains(rejection.Err.Error(), "decode failed") {
		t.Fatalf("source rejection error = %v", rejection.Err)
	}
	if m.Current().ID() != 3 {
		t.Fatalf("current ID after source error = %d, want 3", m.Current().ID())
	}

	updates <- Update{Token: "t4", Parts: []Part{{Name: "a", Value: "A4"}, {Name: "b", Value: "B4"}}}
	change = waitChange(t, changes)
	if change.Current.ID() != 4 {
		t.Fatalf("change after recovery ID = %d, want 4", change.Current.ID())
	}

	if pinned.Version != entryVersion {
		t.Fatal("pinned snapshot switched versions")
	}
	if got := partString(t, pinned.Version, "a"); got != "A0" {
		t.Fatalf("pinned snapshot a = %q, want A0", got)
	}
	if got := partString(t, pinned.Version, "b"); got != "B0" {
		t.Fatalf("pinned snapshot b = %q, want B0", got)
	}
	pinned.Release()

	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Watch returned %v, want context.Canceled", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Watch did not stop after cancellation")
	}
}

func writeFileAtomically(t *testing.T, path string, data []byte) {
	t.Helper()
	tmp, err := os.CreateTemp(filepath.Dir(path), ".config-*")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		t.Fatalf("write temp file: %v", err)
	}
	if err := tmp.Close(); err != nil {
		t.Fatalf("close temp file: %v", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		t.Fatalf("rename config: %v", err)
	}
}

func waitForVersion(t *testing.T, m *Manager, want uint64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := m.Current().ID(); got == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("current ID = %d, want %d", m.Current().ID(), want)
}

func waitForRejections(t *testing.T, m *Manager, want uint64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := m.Stats().Rejected; got >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("rejections = %d, want at least %d", m.Stats().Rejected, want)
}

func TestFileSourceHotReload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	writeFileAtomically(t, path, []byte(`{"a":"A1","b":"B1"}`))

	m := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	source := &FileSource{Path: path, Interval: 10 * time.Millisecond}
	go func() {
		done <- m.Watch(ctx, source)
	}()

	waitForVersion(t, m, 2)
	if got := partString(t, m.Current(), "a"); got != "A1" {
		t.Fatalf("a after initial load = %q, want A1", got)
	}

	writeFileAtomically(t, path, []byte(`{"a":"A2","b":"B2"}`))
	waitForVersion(t, m, 3)

	writeFileAtomically(t, path, []byte(`{"a":"A3","b":"BAD"}`))
	waitForRejections(t, m, 1)
	if m.Current().ID() != 3 {
		t.Fatalf("current ID after invalid file = %d, want 3", m.Current().ID())
	}
	if got := partString(t, m.Current(), "a"); got != "A2" {
		t.Fatalf("a after invalid file = %q, want A2", got)
	}

	writeFileAtomically(t, path, []byte(`{"a":"A4","b":"B4"}`))
	waitForVersion(t, m, 4)
	if got := partString(t, m.Current(), "b"); got != "B4" {
		t.Fatalf("b after recovery = %q, want B4", got)
	}

	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Watch returned %v, want context.Canceled", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Watch did not stop after cancellation")
	}
}

func TestConcurrentReadersNeverSeeMixedVersions(t *testing.T) {
	m, err := NewManager(
		[]Part{{Name: "a", Value: "0"}, {Name: "b", Value: "0"}},
		WithValidator("b", func(part Part) error {
			if strings.Contains(part.Value.(string), "bad") {
				return errors.New("bad generation")
			}
			return nil
		}),
	)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	const readers = 8
	stop := make(chan struct{})
	started := make(chan struct{}, readers)
	errorsSeen := make(chan error, readers)
	var reads atomic.Int64
	var wg sync.WaitGroup

	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}

				snapshot := m.Acquire()
				a, _ := Lookup[string](snapshot.Version, "a")
				for j := 0; j < 16; j++ {
					b, _ := Lookup[string](snapshot.Version, "b")
					if a != b {
						errorsSeen <- fmt.Errorf("mixed version: a=%q b=%q", a, b)
						snapshot.Release()
						return
					}
					runtime.Gosched()
				}
				reads.Add(1)
				snapshot.Release()
				select {
				case started <- struct{}{}:
				default:
				}
			}
		}()
	}

	for i := 0; i < readers; i++ {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("reader did not complete an initial snapshot")
		}
	}

	for generation := 1; generation <= 200; generation++ {
		value := strconv.Itoa(generation)
		if _, err := m.Apply([]Part{{Name: "a", Value: value}, {Name: "b", Value: value}}); err != nil {
			t.Fatalf("Apply generation %s: %v", value, err)
		}
		if _, err := m.Apply([]Part{{Name: "a", Value: "new-" + value}, {Name: "b", Value: "bad-" + value}}); err == nil {
			t.Fatalf("Apply invalid generation %s succeeded", value)
		}
	}

	close(stop)
	wg.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Error(err)
	}
	if reads.Load() == 0 {
		t.Fatal("readers did not complete any snapshots")
	}

	stats := m.Stats()
	if stats.CurrentVersion != 201 {
		t.Fatalf("CurrentVersion = %d, want 201", stats.CurrentVersion)
	}
	if stats.Published != 200 {
		t.Fatalf("Published = %d, want 200", stats.Published)
	}
	if stats.Rejected != 200 {
		t.Fatalf("Rejected = %d, want 200", stats.Rejected)
	}
	if stats.InFlight != 0 {
		t.Fatalf("InFlight = %d, want 0", stats.InFlight)
	}
	if stats.RetainedVersions != 0 {
		t.Fatalf("RetainedVersions = %d, want 0", stats.RetainedVersions)
	}

	if got := partString(t, m.Current(), "a"); got != "200" {
		t.Fatalf("final a = %q, want 200", got)
	}
	if got := partString(t, m.Current(), "b"); got != "200" {
		t.Fatalf("final b = %q, want 200", got)
	}
}
