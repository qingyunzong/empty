package dataeng

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func digestOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type fakeClient struct {
	mu          sync.Mutex
	createFn    func(CreateRequest) (string, error)
	findFn      func(key string) (string, bool, error)
	statusFn    func(jobID string, call int) (JobStatus, error)
	shardData   map[int][]byte
	createCalls int
	findCalls   int
	statusCalls map[string]int
	cancelCalls int
}

func newFakeClient() *fakeClient {
	return &fakeClient{
		createFn:    func(CreateRequest) (string, error) { return "job-1", nil },
		findFn:      func(string) (string, bool, error) { return "", false, nil },
		statusFn:    func(string, int) (JobStatus, error) { return JobStatus{State: RemoteReady}, nil },
		shardData:   map[int][]byte{},
		statusCalls: map[string]int{},
	}
}

func (f *fakeClient) CreateExport(_ context.Context, req CreateRequest) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCalls++
	return f.createFn(req)
}

func (f *fakeClient) FindByIdempotencyKey(_ context.Context, key string) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.findCalls++
	return f.findFn(key)
}

func (f *fakeClient) Status(_ context.Context, jobID string) (JobStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statusCalls[jobID]++
	return f.statusFn(jobID, f.statusCalls[jobID])
}

func (f *fakeClient) DownloadShard(_ context.Context, _ string, index int) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return io.NopCloser(strings.NewReader(string(f.shardData[index]))), nil
}

func (f *fakeClient) Cancel(_ context.Context, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancelCalls++
	return nil
}

func (f *fakeClient) creates() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.createCalls
}

func (f *fakeClient) cancels() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cancelCalls
}

// testRunner builds a Runner with an instant, recording sleep.
func testRunner(client ExportClient, store Store, delays *[]time.Duration) *Runner {
	cfg := Config{
		PollBackoff:   Backoff{Initial: time.Second, Max: 10 * time.Second, Factor: 2},
		CreateBackoff: Backoff{Initial: time.Second, Max: 10 * time.Second, Factor: 2},
	}
	cfg.sleep = func(_ context.Context, d time.Duration) error {
		if delays != nil {
			*delays = append(*delays, d)
		}
		return nil
	}
	return NewRunner(client, store, cfg)
}

func readyWithShards(shards ...Shard) func(string, int) (JobStatus, error) {
	return func(jobID string, _ int) (JobStatus, error) {
		return JobStatus{JobID: jobID, State: RemoteReady, Shards: shards}, nil
	}
}

func TestRunHappyPathCommitsAfterAllShardsPersisted(t *testing.T) {
	client := newFakeClient()
	client.shardData = map[int][]byte{0: []byte("aaa"), 1: []byte("bbb")}
	client.statusFn = readyWithShards(
		Shard{Index: 0, Digest: digestOf([]byte("aaa"))},
		Shard{Index: 1, Digest: digestOf([]byte("bbb"))},
	)
	store := NewMemoryStore()
	runner := testRunner(client, store, nil)

	task := Task{ID: "t1", IdempotencyKey: "key-1"}
	if err := runner.Run(context.Background(), task); err != nil {
		t.Fatalf("Run: %v", err)
	}
	state, _ := store.State(context.Background(), "t1")
	if state != TaskSucceeded {
		t.Fatalf("state = %s, want succeeded", state)
	}
	if got := store.ShardCount("t1"); got != 2 {
		t.Fatalf("persisted shards = %d, want 2", got)
	}
	jobID, ok, _ := store.LoadJob(context.Background(), "key-1")
	if !ok || jobID != "job-1" {
		t.Fatalf("idempotency mapping = %q,%v", jobID, ok)
	}
}

func TestCreateTimeoutResolvedByIdempotencyKey(t *testing.T) {
	client := newFakeClient()
	client.createFn = func(CreateRequest) (string, error) { return "", ErrCreateTimeout }
	client.findFn = func(key string) (string, bool, error) {
		if key != "key-1" {
			t.Errorf("lookup key = %q, want key-1", key)
		}
		return "job-recovered", true, nil
	}
	store := NewMemoryStore()
	runner := testRunner(client, store, nil)

	if err := runner.Run(context.Background(), Task{ID: "t1", IdempotencyKey: "key-1"}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := client.creates(); got != 1 {
		t.Fatalf("create calls = %d, want 1 (no duplicate export)", got)
	}
	if _, ok := client.statusCalls["job-recovered"]; !ok {
		t.Fatalf("recovered job was never polled: %v", client.statusCalls)
	}
	jobID, ok, _ := store.LoadJob(context.Background(), "key-1")
	if !ok || jobID != "job-recovered" {
		t.Fatalf("mapping = %q,%v, want job-recovered", jobID, ok)
	}
}

func TestCreateTimeoutNotFoundRetriesWithSameKey(t *testing.T) {
	client := newFakeClient()
	attempt := 0
	client.createFn = func(CreateRequest) (string, error) {
		attempt++
		if attempt == 1 {
			return "", ErrCreateTimeout
		}
		return "job-2", nil
	}
	// findFn default: not found.
	store := NewMemoryStore()
	runner := testRunner(client, store, nil)

	if err := runner.Run(context.Background(), Task{ID: "t1", IdempotencyKey: "key-1"}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := client.creates(); got != 2 {
		t.Fatalf("create calls = %d, want 2", got)
	}
}

func TestResumeSkipsCreateWhenMappingPersisted(t *testing.T) {
	client := newFakeClient()
	store := NewMemoryStore()
	ctx := context.Background()
	if err := store.SaveJob(ctx, "t1", "key-1", "job-existing"); err != nil {
		t.Fatal(err)
	}
	runner := testRunner(client, store, nil)

	if err := runner.Run(ctx, Task{ID: "t1", IdempotencyKey: "key-1"}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := client.creates(); got != 0 {
		t.Fatalf("create calls = %d, want 0 on resume", got)
	}
	if _, ok := client.statusCalls["job-existing"]; !ok {
		t.Fatalf("existing job was never polled: %v", client.statusCalls)
	}
}

func TestDigestMismatchFailsWithoutCommit(t *testing.T) {
	client := newFakeClient()
	client.shardData = map[int][]byte{0: []byte("corrupted")}
	client.statusFn = readyWithShards(Shard{Index: 0, Digest: digestOf([]byte("expected"))})
	store := NewMemoryStore()
	runner := testRunner(client, store, nil)

	err := runner.Run(context.Background(), Task{ID: "t1", IdempotencyKey: "key-1"})
	if !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("err = %v, want ErrDigestMismatch", err)
	}
	state, _ := store.State(context.Background(), "t1")
	if state != TaskFailed {
		t.Fatalf("state = %s, want failed", state)
	}
	if got := store.ShardCount("t1"); got != 0 {
		t.Fatalf("corrupt shard was persisted: %d shards", got)
	}
}

func TestPollBackoffAndExpiry(t *testing.T) {
	client := newFakeClient()
	client.statusFn = func(jobID string, call int) (JobStatus, error) {
		if call < 3 {
			return JobStatus{JobID: jobID, State: RemoteRunning}, nil
		}
		return JobStatus{JobID: jobID, State: RemoteReady}, nil
	}
	store := NewMemoryStore()
	var delays []time.Duration
	runner := testRunner(client, store, &delays)

	if err := runner.Run(context.Background(), Task{ID: "t1", IdempotencyKey: "key-1"}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	want := []time.Duration{time.Second, 2 * time.Second}
	if len(delays) != len(want) {
		t.Fatalf("delays = %v, want %v", delays, want)
	}
	for i := range want {
		if delays[i] != want[i] {
			t.Fatalf("delays = %v, want %v", delays, want)
		}
	}
}

func TestExpiredJobFails(t *testing.T) {
	client := newFakeClient()
	client.statusFn = func(jobID string, _ int) (JobStatus, error) {
		return JobStatus{
			JobID:     jobID,
			State:     RemoteRunning,
			ExpiresAt: time.Now().Add(-time.Minute),
		}, nil
	}
	store := NewMemoryStore()
	runner := testRunner(client, store, nil)

	err := runner.Run(context.Background(), Task{ID: "t1", IdempotencyKey: "key-1"})
	if !errors.Is(err, ErrJobExpired) {
		t.Fatalf("err = %v, want ErrJobExpired", err)
	}
	state, _ := store.State(context.Background(), "t1")
	if state != TaskFailed {
		t.Fatalf("state = %s, want failed", state)
	}
}

func TestCancelWinsDuringPoll(t *testing.T) {
	client := newFakeClient()
	client.statusFn = func(jobID string, _ int) (JobStatus, error) {
		return JobStatus{JobID: jobID, State: RemoteRunning}, nil
	}
	store := NewMemoryStore()

	var runner *Runner
	cfg := Config{}
	cfg.sleep = func(context.Context, time.Duration) error {
		go runner.Cancel(context.Background(), "t1")
		time.Sleep(10 * time.Millisecond)
		return nil
	}
	runner = NewRunner(client, store, cfg)

	err := runner.Run(context.Background(), Task{ID: "t1", IdempotencyKey: "key-1"})
	if !errors.Is(err, ErrCancelled) {
		t.Fatalf("err = %v, want ErrCancelled", err)
	}
	state, _ := store.State(context.Background(), "t1")
	if state != TaskCancelled {
		t.Fatalf("state = %s, want cancelled", state)
	}
	if got := client.cancels(); got != 1 {
		t.Fatalf("remote cancel calls = %d, want 1", got)
	}
}

func TestCancelAndCommitRaceExactlyOneWinner(t *testing.T) {
	for i := 0; i < 50; i++ {
		store := NewMemoryStore()
		ctx := context.Background()
		if err := store.RegisterTask(ctx, "t1"); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveShard(ctx, "t1", PersistedShard{Index: 0}); err != nil {
			t.Fatal(err)
		}

		var wg sync.WaitGroup
		results := make(chan bool, 2)
		for _, op := range []func() (bool, error){
			func() (bool, error) { return store.TryCommit(ctx, "t1", 1) },
			func() (bool, error) { return store.TryCancel(ctx, "t1") },
		} {
			wg.Add(1)
			go func(op func() (bool, error)) {
				defer wg.Done()
				won, err := op()
				if err != nil {
					t.Error(err)
					return
				}
				results <- won
			}(op)
		}
		wg.Wait()
		close(results)

		wins := 0
		for won := range results {
			if won {
				wins++
			}
		}
		if wins != 1 {
			t.Fatalf("iteration %d: %d winners, want exactly 1", i, wins)
		}
	}
}

func TestCommitRequiresAllShardsPersisted(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	if err := store.RegisterTask(ctx, "t1"); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveShard(ctx, "t1", PersistedShard{Index: 0}); err != nil {
		t.Fatal(err)
	}
	won, err := store.TryCommit(ctx, "t1", 2)
	if err != nil {
		t.Fatal(err)
	}
	if won {
		t.Fatal("commit succeeded with only 1 of 2 shards persisted")
	}
	state, _ := store.State(ctx, "t1")
	if state != TaskActive {
		t.Fatalf("state = %s, want still active", state)
	}
}
