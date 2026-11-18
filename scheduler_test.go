package formal

import (
	"container/heap"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"testing"
	"time"
)

var testBase = time.Unix(1_700_000_000, 123_456_789).UTC()

func testConfig() Config {
	return Config{
		Tick:      time.Millisecond,
		WheelSize: 4,
		MaxLevels: 6,
	}
}

func newTestScheduler(t *testing.T, now time.Time) (*ManualClock, *Scheduler) {
	t.Helper()
	clock := NewManualClock(now)
	scheduler, err := New(clock, testConfig())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return clock, scheduler
}

func TestAdvanceOrdersByExactDeadlineAndSequence(t *testing.T) {
	clock, scheduler := newTestScheduler(t, testBase)

	inputs := []Message{
		{ID: "late", Due: testBase.Add(50 * time.Millisecond), Payload: "late"},
		{ID: "same-first", Due: testBase.Add(10*time.Millisecond + 250*time.Microsecond), Payload: 1},
		{ID: "mid", Due: testBase.Add(20 * time.Millisecond), Payload: "mid"},
		{ID: "same-second", Due: testBase.Add(10*time.Millisecond + 250*time.Microsecond), Payload: 2},
	}
	for _, msg := range inputs {
		if err := scheduler.Schedule(msg); err != nil {
			t.Fatalf("Schedule(%q): %v", msg.ID, err)
		}
	}

	clock.Set(testBase.Add(10 * time.Millisecond))
	if got := scheduler.Poll(); len(got) != 0 {
		t.Fatalf("emitted before deadline: %#v", got)
	}

	clock.Set(testBase.Add(10*time.Millisecond + 250*time.Microsecond))
	got := scheduler.Poll()
	assertEventIDs(t, got, []string{"same-first", "same-second"})
	if got[0].Payload != 1 || got[1].Payload != 2 {
		t.Fatalf("payloads not preserved: %#v", got)
	}
	for _, event := range got {
		if !event.FiredAt.Equal(clock.Now()) {
			t.Fatalf("FiredAt = %s, want %s", event.FiredAt, clock.Now())
		}
	}

	clock.Set(testBase.Add(20 * time.Millisecond))
	assertEventIDs(t, scheduler.Poll(), []string{"mid"})

	clock.Set(testBase.Add(time.Second))
	assertEventIDs(t, scheduler.Poll(), []string{"late"})
	if got := scheduler.Poll(); len(got) != 0 {
		t.Fatalf("message fired twice: %#v", got)
	}
	if scheduler.Len() != 0 {
		t.Fatalf("Len = %d, want 0", scheduler.Len())
	}
}

func TestCancelDetachesMessageFromWheel(t *testing.T) {
	clock, scheduler := newTestScheduler(t, testBase)

	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("m%d", i)
		if err := scheduler.ScheduleAfter(id, time.Duration(i+1)*time.Millisecond, i); err != nil {
			t.Fatalf("ScheduleAfter(%s): %v", id, err)
		}
	}
	before := scheduler.Stats()
	if before.Pending != 3 || before.Buckets == 0 {
		t.Fatalf("unexpected stats before cancel: %+v", before)
	}

	if !scheduler.Cancel("m1") {
		t.Fatal("Cancel(m1) = false, want true")
	}
	if scheduler.Cancel("m1") {
		t.Fatal("second Cancel(m1) = true, want false")
	}
	after := scheduler.Stats()
	if after.Pending != 2 || after.Cancelled != 1 || after.Buckets != before.Buckets-1 {
		t.Fatalf("unexpected stats after cancel: %+v", after)
	}

	// The cancelled entry must be unlinked immediately, not merely skipped at
	// emission time.
	for _, level := range scheduler.levels {
		for _, b := range level.buckets {
			for _, e := range b.entries {
				if e.id == "m1" {
					t.Fatal("cancelled message still occupies a wheel slot")
				}
			}
		}
	}

	// Reusing an ID after cancellation starts a fresh pending message.
	if err := scheduler.ScheduleAfter("m1", 5*time.Millisecond, "fresh"); err != nil {
		t.Fatalf("reschedule cancelled ID: %v", err)
	}

	clock.Set(testBase.Add(10 * time.Millisecond))
	got := scheduler.Poll()
	assertEventIDs(t, got, []string{"m0", "m2", "m1"})
	if got[2].Payload != "fresh" {
		t.Fatalf("fresh payload = %#v", got[2].Payload)
	}
	if scheduler.Cancel("m0") {
		t.Fatal("Cancel on fired message = true, want false")
	}
}

func TestLevelPromotionBeforeDeadline(t *testing.T) {
	clock, scheduler := newTestScheduler(t, testBase)

	// Tick=1ms and 4 slots make level 0 span 4ms, level 1 span 16ms and
	// level 2 span 64ms. This deadline initially belongs to level 2.
	due := testBase.Add(40 * time.Millisecond)
	if err := scheduler.ScheduleAt("far", due, nil); err != nil {
		t.Fatalf("ScheduleAt: %v", err)
	}

	// The level-2 bucket starts at an absolute 16ms boundary below the
	// deadline. Move past that boundary but not to the deadline itself.
	clock.Set(testBase.Add(38 * time.Millisecond))
	if got := scheduler.Poll(); len(got) != 0 {
		t.Fatalf("far message fired early: %#v", got)
	}
	stats := scheduler.Stats()
	if stats.Promotions == 0 {
		t.Fatalf("expected a level promotion, stats=%+v", stats)
	}

	clock.Set(due)
	assertEventIDs(t, scheduler.Poll(), []string{"far"})
	if got := scheduler.Poll(); len(got) != 0 {
		t.Fatalf("promoted message fired twice: %#v", got)
	}
}

func TestRestorePreservesAbsoluteDeadlinesAndTieOrder(t *testing.T) {
	clock, scheduler := newTestScheduler(t, testBase)
	tie := testBase.Add(140 * time.Millisecond)
	msgs := []Message{
		{ID: "soon", Due: testBase.Add(10 * time.Millisecond)},
		{ID: "tie-a", Due: tie, Payload: "a"},
		{ID: "tie-b", Due: tie, Payload: "b"},
		{ID: "far", Due: testBase.Add(500 * time.Millisecond)},
	}
	for _, msg := range msgs {
		if err := scheduler.Schedule(msg); err != nil {
			t.Fatalf("Schedule(%s): %v", msg.ID, err)
		}
	}

	clock.Set(testBase.Add(20 * time.Millisecond))
	assertEventIDs(t, scheduler.Poll(), []string{"soon"})
	snapshot := scheduler.Snapshot()
	if got := len(snapshot.Entries); got != 3 {
		t.Fatalf("snapshot entries = %d, want 3", got)
	}
	if !snapshot.TakenAt.Equal(clock.Now()) {
		t.Fatalf("snapshot time = %s, want %s", snapshot.TakenAt, clock.Now())
	}

	// Simulate downtime: the new process starts later, but deadlines remain the
	// same absolute instants.
	restartAt := testBase.Add(75 * time.Millisecond)
	restoredClock := NewManualClock(restartAt)
	restored, err := New(restoredClock, testConfig())
	if err != nil {
		t.Fatalf("New restored: %v", err)
	}
	if err := restored.Restore(snapshot); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restoredClock.Now().Equal(restoredClock.Now().Add(time.Nanosecond)) {
		t.Fatal("unreachable")
	}
	next, ok := restored.Next()
	if !ok || !next.Equal(tie) {
		t.Fatalf("Next after restore = %s, %v; want %s, true", next, ok, tie)
	}

	restoredClock.Set(restartAt.Add(24 * time.Millisecond))
	if got := restored.Poll(); len(got) != 0 {
		t.Fatalf("restored message fired early: %#v", got)
	}
	restoredClock.Set(tie)
	got := restored.Poll()
	assertEventIDs(t, got, []string{"tie-a", "tie-b"})
	if got[0].Payload != "a" || got[1].Payload != "b" {
		t.Fatalf("restored payload/order mismatch: %#v", got)
	}
	restoredClock.Set(testBase.Add(time.Second))
	assertEventIDs(t, restored.Poll(), []string{"far"})
}

func TestRestoreEmitsOverdueMessagesFromDowntime(t *testing.T) {
	clock, scheduler := newTestScheduler(t, testBase)
	if err := scheduler.ScheduleAfter("during-downtime", 10*time.Millisecond, 7); err != nil {
		t.Fatalf("ScheduleAfter: %v", err)
	}
	snapshot := scheduler.Snapshot()

	_ = clock
	restartClock := NewManualClock(testBase.Add(50 * time.Millisecond))
	restored, err := New(restartClock, testConfig())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := restored.Restore(snapshot); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	got := restored.Poll()
	assertEventIDs(t, got, []string{"during-downtime"})
}

func TestValidationAndErrorPaths(t *testing.T) {
	if _, err := New(nil, Config{}); err == nil {
		t.Fatal("New(nil) succeeded")
	}
	if _, err := New(NewManualClock(testBase), Config{Tick: -time.Nanosecond}); err == nil {
		t.Fatal("negative tick accepted")
	}
	if _, err := New(NewManualClock(testBase), Config{WheelSize: 1}); err == nil {
		t.Fatal("wheel size 1 accepted")
	}

	_, scheduler := newTestScheduler(t, testBase)
	if err := scheduler.ScheduleAt("", testBase, nil); !errors.Is(err, ErrEmptyID) {
		t.Fatalf("empty ID error = %v, want ErrEmptyID", err)
	}
	if err := scheduler.ScheduleAt("id", testBase.Add(time.Second), nil); err != nil {
		t.Fatalf("first ScheduleAt: %v", err)
	}
	if err := scheduler.ScheduleAt("id", testBase.Add(2*time.Second), nil); !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("duplicate ID error = %v, want ErrDuplicateID", err)
	}
	if _, err := scheduler.Advance(testBase); err != nil {
		t.Fatalf("Advance: %v", err)
	}
	if _, err := scheduler.Advance(testBase.Add(-time.Nanosecond)); !errors.Is(err, ErrClockBackwards) {
		t.Fatalf("backward clock error = %v, want ErrClockBackwards", err)
	}

	if err := scheduler.Restore(Snapshot{}); !errors.Is(err, ErrRestoreNotEmpty) {
		t.Fatalf("restore into non-empty scheduler error = %v", err)
	}

	empty, err := New(NewManualClock(testBase), testConfig())
	if err != nil {
		t.Fatalf("New empty: %v", err)
	}
	if err := empty.Restore(Snapshot{Version: 99}); !errors.Is(err, ErrSnapshotVersion) {
		t.Fatalf("bad version error = %v", err)
	}
	bad := Snapshot{Version: SnapshotVersion, Entries: []Record{
		{ID: "x", Due: testBase.Add(time.Second)},
		{ID: "x", Due: testBase.Add(2 * time.Second)},
	}}
	if err := empty.Restore(bad); !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("duplicate snapshot error = %v", err)
	}
	if empty.Len() != 0 {
		t.Fatalf("failed restore left %d messages behind", empty.Len())
	}
}

func TestSnapshotJSONRoundTrip(t *testing.T) {
	_, scheduler := newTestScheduler(t, testBase)
	if err := scheduler.ScheduleAt("json", testBase.Add(150*time.Millisecond), "payload"); err != nil {
		t.Fatalf("ScheduleAt: %v", err)
	}
	snapshot := scheduler.Snapshot()
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var decoded Snapshot
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	restartAt := testBase.Add(50 * time.Millisecond)
	restoredClock := NewManualClock(restartAt)
	restored, err := New(restoredClock, testConfig())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := restored.Restore(decoded); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	restoredClock.Set(restartAt.Add(100 * time.Millisecond))
	assertEventIDs(t, restored.Poll(), []string{"json"})
}

func TestConcurrentSubmitCancelSnapshotAndPoll(t *testing.T) {
	clock, scheduler := newTestScheduler(t, testBase)
	const (
		writers = 8
		perG    = 200
	)

	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for g := 0; g < writers; g++ {
		g := g
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				id := fmt.Sprintf("%d-%d", g, i)
				delay := time.Duration(i%50+1) * time.Millisecond
				if err := scheduler.ScheduleAfter(id, delay, id); err != nil {
					errs <- err
					return
				}
				if i%2 == 0 && !scheduler.Cancel(id) {
					errs <- fmt.Errorf("cancel %s failed", id)
					return
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			_ = scheduler.Snapshot()
			_ = scheduler.Poll()
		}
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	want := writers * perG / 2
	if got := scheduler.Len(); got != want {
		t.Fatalf("Len = %d, want %d", got, want)
	}
	clock.Set(testBase.Add(time.Second))
	events := scheduler.Poll()
	if len(events) != want {
		t.Fatalf("emitted %d events, want %d", len(events), want)
	}
	seen := make(map[string]struct{}, len(events))
	for _, event := range events {
		if _, ok := seen[event.ID]; ok {
			t.Fatalf("duplicate event %q", event.ID)
		}
		seen[event.ID] = struct{}{}
	}
	if scheduler.Len() != 0 {
		t.Fatalf("pending after drain = %d", scheduler.Len())
	}
}

type modelEntry struct {
	id     string
	due    time.Time
	dueNs  int64
	seq    uint64
	active bool
	index  int
}

type modelHeap []*modelEntry

func (h modelHeap) Len() int { return len(h) }
func (h modelHeap) Less(i, j int) bool {
	if h[i].dueNs != h[j].dueNs {
		return h[i].dueNs < h[j].dueNs
	}
	return h[i].seq < h[j].seq
}
func (h modelHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}
func (h *modelHeap) Push(x any) {
	e := x.(*modelEntry)
	e.index = len(*h)
	*h = append(*h, e)
}
func (h *modelHeap) Pop() any {
	old := *h
	n := len(old)
	e := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	e.index = -1
	return e
}

type naiveModel struct {
	pending map[string]*modelEntry
	queue   modelHeap
	seq     uint64
}

func newNaiveModel() *naiveModel {
	return &naiveModel{pending: make(map[string]*modelEntry)}
}

func (m *naiveModel) schedule(id string, due time.Time) {
	m.seq++
	e := &modelEntry{id: id, due: due, dueNs: due.UnixNano(), seq: m.seq, active: true}
	m.pending[id] = e
	heap.Push(&m.queue, e)
}

func (m *naiveModel) cancel(id string) bool {
	e, ok := m.pending[id]
	if !ok || !e.active {
		return false
	}
	e.active = false
	delete(m.pending, id)
	return true
}

func (m *naiveModel) advance(now time.Time) []modelEvent {
	nowNs := now.UnixNano()
	var due []*modelEntry
	for len(m.queue) > 0 && m.queue[0].dueNs <= nowNs {
		e := heap.Pop(&m.queue).(*modelEntry)
		if e.active {
			due = append(due, e)
		}
	}
	out := make([]modelEvent, 0, len(due))
	for _, e := range due {
		e.active = false
		delete(m.pending, e.id)
		out = append(out, modelEvent{id: e.id, dueNs: e.dueNs})
	}
	return out
}

type modelEvent struct {
	id    string
	dueNs int64
}

func eventModels(events []Event) []modelEvent {
	out := make([]modelEvent, len(events))
	for i, event := range events {
		out[i] = modelEvent{id: event.ID, dueNs: event.Due.UnixNano()}
	}
	return out
}

func assertModelEvents(t *testing.T, got, want []modelEvent) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("event count = %d, want %d\ngot:  %#v\nwant: %#v", len(got), len(want), got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("event %d = %#v, want %#v", i, got[i], want[i])
		}
	}
}

func TestRandomizedAgainstNaiveHeapWithRestarts(t *testing.T) {
	for _, seed := range []int64{1, 2, 3, 17, 99} {
		seed := seed
		t.Run(fmt.Sprintf("seed-%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			now := testBase
			clock := NewManualClock(now)
			scheduler, err := New(clock, testConfig())
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			model := newNaiveModel()
			pendingIDs := make(map[string]struct{})
			nextID := 0

			for step := 0; step < 2500; step++ {
				switch op := rng.Intn(100); {
				case op < 38:
					id := fmt.Sprintf("m%d", nextID)
					nextID++
					delay := time.Duration(rng.Int63n(int64(3 * time.Second)))
					if rng.Intn(10) == 0 {
						delay -= time.Duration(rng.Int63n(int64(50 * time.Millisecond)))
					}
					due := now.Add(delay)
					if err := scheduler.ScheduleAt(id, due, id); err != nil {
						t.Fatalf("step %d ScheduleAt(%s): %v", step, id, err)
					}
					model.schedule(id, due)
					pendingIDs[id] = struct{}{}
				case op < 55 && len(pendingIDs) > 0:
					index := rng.Intn(len(pendingIDs))
					var id string
					for candidate := range pendingIDs {
						if index == 0 {
							id = candidate
							break
						}
						index--
					}
					got := scheduler.Cancel(id)
					want := model.cancel(id)
					if got != want {
						t.Fatalf("step %d Cancel(%s) = %v, want %v", step, id, got, want)
					}
					delete(pendingIDs, id)
				case op < 82:
					delta := time.Duration(rng.Int63n(int64(30 * time.Millisecond)))
					if rng.Intn(20) == 0 {
						delta += time.Duration(rng.Int63n(int64(2 * time.Second)))
					}
					now = now.Add(delta)
					clock.Set(now)
					got := scheduler.Poll()
					want := model.advance(now)
					assertModelEvents(t, eventModels(got), want)
					for _, event := range want {
						delete(pendingIDs, event.id)
					}
				default:
					// Snapshot, spend time down, restore, and replay overdue
					// messages through the new scheduler.
					snapshot := scheduler.Snapshot()
					down := time.Duration(rng.Int63n(int64(100 * time.Millisecond)))
					now = now.Add(down)
					want := model.advance(now)
					for _, event := range want {
						delete(pendingIDs, event.id)
					}

					clock = NewManualClock(now)
					restored, err := New(clock, testConfig())
					if err != nil {
						t.Fatalf("step %d New after restart: %v", step, err)
					}
					if err := restored.Restore(snapshot); err != nil {
						t.Fatalf("step %d Restore: %v", step, err)
					}
					got := restored.Poll()
					assertModelEvents(t, eventModels(got), want)
					scheduler = restored
				}
			}

			now = now.Add(10 * time.Second)
			clock.Set(now)
			got := scheduler.Poll()
			want := model.advance(now)
			assertModelEvents(t, eventModels(got), want)
			if scheduler.Len() != 0 {
				t.Fatalf("pending after final drain = %d", scheduler.Len())
			}
		})
	}
}

func assertEventIDs(t *testing.T, events []Event, want []string) {
	t.Helper()
	if len(events) != len(want) {
		t.Fatalf("event count = %d, want %d: %#v", len(events), len(want), events)
	}
	for i := range want {
		if events[i].ID != want[i] {
			t.Fatalf("event[%d].ID = %q, want %q (all: %#v)", i, events[i].ID, want[i], events)
		}
	}
}
