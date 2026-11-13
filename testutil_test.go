package dataeng

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

func recordsFor(partition PartitionID, n int) []Record {
	records := make([]Record, n)
	for i := range records {
		records[i] = Record{
			Partition: partition,
			Offset:    Offset(i),
			Key:       []byte(fmt.Sprintf("k-%d-%d", partition, i)),
			Value:     []byte(fmt.Sprintf("v-%d-%d", partition, i)),
		}
	}
	return records
}

// testSource is an in-memory Kafka partition.
type testSource struct {
	mu        sync.Mutex
	records   map[PartitionID][]Record
	fetches   map[PartitionID]int
	limit     func(partition PartitionID, call int) int
	fetchGate <-chan struct{}
	gateAfter int
}

func newTestSource(parts map[PartitionID][]Record) *testSource {
	return &testSource{records: parts, fetches: make(map[PartitionID]int)}
}

func (s *testSource) Fetch(ctx context.Context, partition PartitionID, from Offset, max int) ([]Record, error) {
	s.mu.Lock()
	call := s.fetches[partition]
	s.fetches[partition]++
	records := s.records[partition]
	limit := max
	if s.limit != nil {
		limit = s.limit(partition, call)
	}
	gate := s.fetchGate
	gateAfter := s.gateAfter
	s.mu.Unlock()

	if gate != nil && call >= gateAfter {
		select {
		case <-gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if from >= Offset(len(records)) {
		return nil, nil
	}
	end := int(from) + limit
	if end > len(records) {
		end = len(records)
	}
	out := make([]Record, end-int(from))
	copy(out, records[from:end])
	return out, nil
}

func (s *testSource) fetchCount(partition PartitionID) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fetches[partition]
}

// recordingSink deduplicates batches by ID and counts which source offsets
// were covered by an accepted batch.
type recordingSink struct {
	mu       sync.Mutex
	seen     map[string]bool
	submits  map[string]int
	coverage map[PartitionID]map[Offset]int
}

func newRecordingSink() *recordingSink {
	return &recordingSink{
		seen:     make(map[string]bool),
		submits:  make(map[string]int),
		coverage: make(map[PartitionID]map[Offset]int),
	}
}

func (s *recordingSink) Submit(_ context.Context, b Batch, done func(Receipt, error)) error {
	s.mu.Lock()
	s.submits[b.ID]++
	if !s.seen[b.ID] {
		s.seen[b.ID] = true
		if s.coverage[b.Partition] == nil {
			s.coverage[b.Partition] = make(map[Offset]int)
		}
		for offset := b.FirstOffset; offset < b.NextOffset; offset++ {
			s.coverage[b.Partition][offset]++
		}
	}
	s.mu.Unlock()
	done(Receipt{Token: b.ID}, nil)
	return nil
}

func (s *recordingSink) submitCount(id string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.submits[id]
}

func (s *recordingSink) assertCoverage(t *testing.T, partition PartitionID, n int) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	coverage := s.coverage[partition]
	for offset := Offset(0); offset < Offset(n); offset++ {
		if coverage[offset] != 1 {
			t.Fatalf("partition %d offset %d committed %d times; want exactly once", partition, offset, coverage[offset])
		}
	}
}

// recordingCommitter tracks the highest committed next offset.
type recordingCommitter struct {
	mu      sync.Mutex
	next    map[PartitionID]Offset
	commits map[PartitionID]int
}

func newRecordingCommitter() *recordingCommitter {
	return &recordingCommitter{next: make(map[PartitionID]Offset), commits: make(map[PartitionID]int)}
}

func (c *recordingCommitter) CommitOffset(_ context.Context, partition PartitionID, next Offset) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.commits[partition]++
	if next > c.next[partition] {
		c.next[partition] = next
	}
	return nil
}

func (c *recordingCommitter) offset(partition PartitionID) Offset {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.next[partition]
}

// blockingSink holds callbacks for selected batch IDs. It models an external
// sink whose durable commit completes asynchronously.
type blockingSink struct {
	mu        sync.Mutex
	blockIDs  map[string]bool
	pending   map[string]func(Receipt, error)
	submitted chan Batch
	committed map[string]int
}

func newBlockingSink(ids ...string) *blockingSink {
	block := make(map[string]bool, len(ids))
	for _, id := range ids {
		block[id] = true
	}
	return &blockingSink{
		blockIDs:  block,
		pending:   make(map[string]func(Receipt, error)),
		submitted: make(chan Batch, 32),
		committed: make(map[string]int),
	}
}

func (s *blockingSink) Submit(_ context.Context, b Batch, done func(Receipt, error)) error {
	s.mu.Lock()
	block := s.blockIDs[b.ID]
	if block {
		delete(s.blockIDs, b.ID)
		s.pending[b.ID] = done
	}
	s.mu.Unlock()
	s.submitted <- b
	if !block {
		s.complete(b.ID, done)
	}
	return nil
}

func (s *blockingSink) complete(id string, done func(Receipt, error)) {
	s.mu.Lock()
	s.committed[id]++
	s.mu.Unlock()
	done(Receipt{Token: id}, nil)
}

func (s *blockingSink) release(id string) bool {
	s.mu.Lock()
	done := s.pending[id]
	delete(s.pending, id)
	s.mu.Unlock()
	if done == nil {
		return false
	}
	s.complete(id, done)
	return true
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func waitWatermark(t *testing.T, c *Coordinator, partition PartitionID, want Offset) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		status, ok := c.Status(partition)
		if ok && status.LastError != nil {
			t.Fatalf("partition %d failed: %v", partition, status.LastError)
		}
		if ok && status.Watermark >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for partition %d watermark %d; status=%+v", partition, want, status)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func mustNew(t *testing.T, cfg Config) *Coordinator {
	t.Helper()
	c, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func closeCoordinator(t *testing.T, c *Coordinator) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
}
