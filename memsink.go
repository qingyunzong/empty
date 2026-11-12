package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// queuedFault is one injected failure. When applied=true the transaction still
// takes effect before ErrCommitAmbiguous is returned, modelling an outcome the
// client cannot observe directly.
type queuedFault struct {
	err     error
	applied bool
}

// MemSink is an in-memory Sink used for tests and local runs. Failures can be
// queued for every sink/txn operation, and stored chunks can be corrupted to
// simulate staging damage. It is safe for concurrent use.
type MemSink struct {
	mu sync.Mutex

	chunks  map[int][]byte
	markers map[int]bool

	published     bool
	publishedData []byte

	handles int

	beginFaults         []error
	putFaults           []error
	markFaults          []error
	removeFaults        []error
	stageCommitFaults   []queuedFault
	publishStageFaults  []error
	publishCommitFaults []queuedFault
	readFaults          []error
	markerReadFaults    []error

	publishAttempts int
}

// NewMemSink creates a sink holding one open handle. Call Retain before sharing
// the sink with another collector that will call Cancel/Release.
func NewMemSink() *MemSink {
	return &MemSink{
		chunks:  make(map[int][]byte),
		markers: make(map[int]bool),
		handles: 1,
	}
}

// Retain adds one handle so an extra Release call is required before reaching zero.
func (s *MemSink) Retain() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handles++
}

// Release decrements the open handle count. Persisted chunks and markers remain.
func (s *MemSink) Release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.handles > 0 {
		s.handles--
	}
}

// Handles reports the number of currently open handles.
func (s *MemSink) Handles() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.handles
}

// CorruptChunk overwrites stored chunk bytes while leaving the marker intact,
// simulating staging corruption discovered during recovery.
func (s *MemSink) CorruptChunk(index int, replacement []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	copied := append([]byte(nil), replacement...)
	s.chunks[index] = copied
}

// DropChunk deletes stored chunk bytes while leaving the marker intact.
func (s *MemSink) DropChunk(index int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.chunks, index)
}

// HasChunk reports whether chunk bytes are currently stored for the index.
func (s *MemSink) HasChunk(index int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.chunks[index]
	return ok
}

// IsMarked is the test-side counterpart of IsMarkedReceived.
func (s *MemSink) IsMarked(index int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.markers[index]
}

// StoredChunk returns a copy of the stored chunk bytes, if any.
func (s *MemSink) StoredChunk(index int) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, ok := s.chunks[index]
	if !ok {
		return nil, false
	}
	return append([]byte(nil), data...), true
}

// IsPublished reports whether the final file has been published.
func (s *MemSink) IsPublished() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.published
}

// PublishedFile returns a copy of the published file bytes.
func (s *MemSink) PublishedFile() ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.published {
		return nil, false
	}
	return append([]byte(nil), s.publishedData...), true
}

// PublishAttempts reports how many publish transaction commits were attempted.
func (s *MemSink) PublishAttempts() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.publishAttempts
}

// FailBeginTxn queues a failure for the next BeginTxn call.
func (s *MemSink) FailBeginTxn(err error) { s.beginFaults = append(s.beginFaults, err) }

// FailPutChunk queues a failure for the next staging PutChunk call.
func (s *MemSink) FailPutChunk(err error) { s.putFaults = append(s.putFaults, err) }

// FailMarkReceived queues a failure for the next MarkReceived call.
func (s *MemSink) FailMarkReceived(err error) { s.markFaults = append(s.markFaults, err) }

// FailRemoveChunk queues a failure for the next RemoveChunk call.
func (s *MemSink) FailRemoveChunk(err error) { s.removeFaults = append(s.removeFaults, err) }

// FailStageCommit queues a hard staging commit failure; nothing is applied.
func (s *MemSink) FailStageCommit(err error) {
	s.stageCommitFaults = append(s.stageCommitFaults, queuedFault{err: err})
}

// AmbiguousStageCommit queues a staging commit whose result is unknown. When
// committed is true the change is applied before the error is returned.
func (s *MemSink) AmbiguousStageCommit(committed bool) {
	s.stageCommitFaults = append(s.stageCommitFaults,
		queuedFault{err: ErrCommitAmbiguous, applied: committed})
}

// FailPublishStage queues a failure for the next publish PublishFile call.
func (s *MemSink) FailPublishStage(err error) {
	s.publishStageFaults = append(s.publishStageFaults, err)
}

// FailPublishCommit queues a hard publish commit failure; nothing is applied.
func (s *MemSink) FailPublishCommit(err error) {
	s.publishCommitFaults = append(s.publishCommitFaults, queuedFault{err: err})
}

// AmbiguousPublishCommit queues a publish commit whose result is unknown. When
// committed is true the file is published before the error is returned.
func (s *MemSink) AmbiguousPublishCommit(committed bool) {
	s.publishCommitFaults = append(s.publishCommitFaults,
		queuedFault{err: ErrCommitAmbiguous, applied: committed})
}

// FailReadChunk queues a failure for the next ReadChunk call.
func (s *MemSink) FailReadChunk(err error) { s.readFaults = append(s.readFaults, err) }

// FailMarkerRead queues a failure for the next IsMarkedReceived call.
func (s *MemSink) FailMarkerRead(err error) {
	s.markerReadFaults = append(s.markerReadFaults, err)
}

func popFault(queue *[]error) error {
	if len(*queue) == 0 {
		return nil
	}
	err := (*queue)[0]
	*queue = (*queue)[1:]
	return err
}

func popQueuedFault(queue *[]queuedFault) (queuedFault, bool) {
	if len(*queue) == 0 {
		return queuedFault{}, false
	}
	fault := (*queue)[0]
	*queue = (*queue)[1:]
	return fault, true
}

// BeginTxn implements Sink.
func (s *MemSink) BeginTxn(_ context.Context, publish bool) (Txn, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := popFault(&s.beginFaults); err != nil {
		return nil, err
	}
	return &memTxn{
		sink:         s,
		publish:      publish,
		chunkWrites:  make(map[int][]byte),
		chunkRemoves: make(map[int]bool),
		markWrites:   make(map[int]bool),
	}, nil
}

// ReadChunk implements Sink.
func (s *MemSink) ReadChunk(_ context.Context, index int) ([]byte, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := popFault(&s.readFaults); err != nil {
		return nil, false, err
	}
	data, ok := s.chunks[index]
	if !ok {
		return nil, false, nil
	}
	return append([]byte(nil), data...), true, nil
}

// IsMarkedReceived implements Sink.
func (s *MemSink) IsMarkedReceived(_ context.Context, index int) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := popFault(&s.markerReadFaults); err != nil {
		return false, err
	}
	return s.markers[index], nil
}

// Published implements Sink.
func (s *MemSink) Published(_ context.Context) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.published, nil
}

// memTxn is the transaction implementation backing MemSink. Changes are held
// privately until Commit and applied together under the sink lock.
type memTxn struct {
	sink    *MemSink
	publish bool
	closed  bool

	chunkWrites  map[int][]byte
	chunkRemoves map[int]bool
	markWrites   map[int]bool

	publishStaged bool
	publishData   []byte
}

func (t *memTxn) requireStaging(op string) error {
	if t.publish {
		return fmt.Errorf("%s is not allowed on a publish transaction", op)
	}
	return nil
}

func (t *memTxn) requirePublish(op string) error {
	if !t.publish {
		return fmt.Errorf("%s is only allowed on a publish transaction", op)
	}
	return nil
}

// PutChunk implements Txn.
func (t *memTxn) PutChunk(_ context.Context, index int, data []byte) error {
	if err := t.requireStaging("PutChunk"); err != nil {
		return err
	}
	t.sink.mu.Lock()
	defer t.sink.mu.Unlock()
	if err := popFault(&t.sink.putFaults); err != nil {
		return err
	}
	t.chunkWrites[index] = append([]byte(nil), data...)
	return nil
}

// MarkReceived implements Txn.
func (t *memTxn) MarkReceived(_ context.Context, index int) error {
	if err := t.requireStaging("MarkReceived"); err != nil {
		return err
	}
	t.sink.mu.Lock()
	defer t.sink.mu.Unlock()
	if err := popFault(&t.sink.markFaults); err != nil {
		return err
	}
	t.markWrites[index] = true
	return nil
}

// RemoveChunk implements Txn.
func (t *memTxn) RemoveChunk(_ context.Context, index int) error {
	if err := t.requireStaging("RemoveChunk"); err != nil {
		return err
	}
	t.sink.mu.Lock()
	defer t.sink.mu.Unlock()
	if err := popFault(&t.sink.removeFaults); err != nil {
		return err
	}
	t.chunkRemoves[index] = true
	return nil
}

// PublishFile implements Txn.
func (t *memTxn) PublishFile(_ context.Context, data []byte) error {
	if err := t.requirePublish("PublishFile"); err != nil {
		return err
	}
	t.sink.mu.Lock()
	defer t.sink.mu.Unlock()
	if err := popFault(&t.sink.publishStageFaults); err != nil {
		return err
	}
	t.publishStaged = true
	t.publishData = append([]byte(nil), data...)
	return nil
}

// Commit implements Txn.
func (t *memTxn) Commit(_ context.Context) error {
	t.sink.mu.Lock()
	defer t.sink.mu.Unlock()
	if t.closed {
		return errors.New("transaction already finished")
	}
	t.closed = true

	if t.publish {
		t.sink.publishAttempts++
		if fault, ok := popQueuedFault(&t.sink.publishCommitFaults); ok {
			if fault.applied {
				t.applyLocked()
			}
			return fault.err
		}
		t.applyLocked()
		return nil
	}

	if fault, ok := popQueuedFault(&t.sink.stageCommitFaults); ok {
		if fault.applied {
			t.applyLocked()
		}
		return fault.err
	}
	t.applyLocked()
	return nil
}

// applyLocked applies every buffered change atomically; caller holds sink.mu.
func (t *memTxn) applyLocked() {
	if t.publish {
		if t.publishStaged {
			t.sink.published = true
			t.sink.publishedData = t.publishData
		}
		return
	}
	for index, data := range t.chunkWrites {
		t.sink.chunks[index] = data
	}
	for index := range t.chunkRemoves {
		delete(t.sink.chunks, index)
		delete(t.sink.markers, index)
	}
	for index, marked := range t.markWrites {
		t.sink.markers[index] = marked
	}
}

// Rollback implements Txn.
func (t *memTxn) Rollback(_ context.Context) error {
	t.sink.mu.Lock()
	defer t.sink.mu.Unlock()
	t.closed = true
	return nil
}
