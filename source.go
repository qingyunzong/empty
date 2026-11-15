package dataeng

import (
	"context"
	"sort"
	"sync"
)

// OffsetOutOfRangeError is returned by a PartitionSource when the requested
// offset is no longer retained by the log (for example after a leader
// truncation or retention deletion). The reader recovers by seeking to the
// earliest still-available offset.
type OffsetOutOfRangeError struct {
	Partition int
	// Earliest is the smallest offset currently available in the partition.
	Earliest int64
}

func (e *OffsetOutOfRangeError) Error() string {
	return "dataeng: requested offset out of range for partition"
}

// PartitionSource supplies batches for one partition. Implementations are used
// serially by the reader; the in-memory implementation in this package is
// additionally safe for concurrent mutation from test goroutines.
type PartitionSource interface {
	// Partition returns the partition id served by this source.
	Partition() int
	// Fetch returns batches starting at offset. It blocks while no batch is
	// available until ctx is cancelled. An empty response with nil batches
	// means "nothing new yet".
	Fetch(ctx context.Context, offset int64) (*FetchResponse, error)
	// ListOffsets reports the earliest retained offset and the exclusive end
	// offset (the offset the next appended record will get).
	ListOffsets(ctx context.Context) (earliest, latest int64, err error)
}

// CheckpointStore persists the last delivered offset per partition so that a
// restarted reader resumes without re-delivering committed data. Only
// delivered offsets are persisted; the in-memory transaction state is rebuilt
// from the log on recovery.
type CheckpointStore interface {
	Load(ctx context.Context) (map[int]int64, error)
	Save(ctx context.Context, offsets map[int]int64) error
}

// MemoryCheckpoint is an in-memory CheckpointStore, useful for tests and for
// embedding inside durable stores.
type MemoryCheckpoint struct {
	mu      sync.Mutex
	offsets map[int]int64
}

// NewMemoryCheckpoint creates an empty in-memory checkpoint store.
func NewMemoryCheckpoint() *MemoryCheckpoint {
	return &MemoryCheckpoint{offsets: make(map[int]int64)}
}

func (m *MemoryCheckpoint) Load(context.Context) (map[int]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[int]int64, len(m.offsets))
	for partition, offset := range m.offsets {
		out[partition] = offset
	}
	return out, nil
}

func (m *MemoryCheckpoint) Save(_ context.Context, offsets map[int]int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.offsets = make(map[int]int64, len(offsets))
	for partition, offset := range offsets {
		m.offsets[partition] = offset
	}
	return nil
}

// memEntry is one retained batch in MemorySource.
type memEntry struct {
	batch *Batch
	// lsoAt is the last stable offset advertised alongside this entry.
	lsoAt int64
}

// MemorySource is a controllable in-memory PartitionSource used by tests and
// by embedders building simulators. It supports appending batches, truncating
// the head of the log (leader truncation) and rewinding the leader epoch.
type MemorySource struct {
	mu        sync.Mutex
	partition int
	entries   []memEntry
	// lso is the advertised last stable offset; <= 0 means unbounded.
	lso int64
}

// NewMemorySource creates an empty in-memory source for partition.
func NewMemorySource(partition int) *MemorySource {
	return &MemorySource{partition: partition}
}

// Partition implements PartitionSource.
func (s *MemorySource) Partition() int { return s.partition }

// SetLSO updates the advertised last stable offset.
func (s *MemorySource) SetLSO(lso int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lso = lso
}

// Append adds an already-built batch. The batch's partition is normalized to
// the source's partition and BaseOffset must follow the previous entries.
func (s *MemorySource) Append(batch *Batch) {
	s.mu.Lock()
	defer s.mu.Unlock()
	batch.Partition = s.partition
	s.entries = append(s.entries, memEntry{batch: batch, lsoAt: s.lso})
}

// Truncate drops every retained record whose offset is below earliest,
// modelling a leader truncation. A data batch straddling the cut is rewritten
// in place to keep only its surviving records, so fetches resuming at earliest
// still see offset-contiguous batches.
func (s *MemorySource) Truncate(earliest int64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	survivors := make([]memEntry, 0, len(s.entries))
	for _, entry := range s.entries {
		end := entry.batch.BaseOffset + int64(len(entry.batch.Records))
		if entry.batch.Control {
			end = entry.batch.BaseOffset + 1
		}
		if end <= earliest {
			continue
		}
		if entry.batch.BaseOffset >= earliest {
			survivors = append(survivors, entry)
			continue
		}
		// Straddling data batch: drop the leading records below earliest.
		batch := entry.batch
		drop := int(earliest - batch.BaseOffset)
		if drop < len(batch.Records) {
			batch.Records = append([]*Record(nil), batch.Records[drop:]...)
			batch.BaseOffset = earliest
			for index, record := range batch.Records {
				record.Offset = earliest + int64(index)
			}
			survivors = append(survivors, entry)
		}
	}
	s.entries = survivors
}

// RewindEpoch lowers the leader epoch of all retained batches, modelling a
// stale leader that rewrote history after truncation.
func (s *MemorySource) RewindEpoch(epoch int32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, entry := range s.entries {
		entry.batch.LeaderEpoch = epoch
	}
}

// Fetch implements PartitionSource.
func (s *MemorySource) Fetch(_ context.Context, offset int64) (*FetchResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.entries) == 0 || offset < s.entries[0].batch.BaseOffset {
		earliest := int64(0)
		if len(s.entries) > 0 {
			earliest = s.entries[0].batch.BaseOffset
		}
		return nil, &OffsetOutOfRangeError{Partition: s.partition, Earliest: earliest}
	}

	resp := &FetchResponse{Partition: s.partition, LastStableOffset: s.lso}
	for _, entry := range s.entries {
		if entry.batch.BaseOffset >= offset {
			resp.Batches = append(resp.Batches, entry.batch)
			if entry.lsoAt > 0 {
				resp.LastStableOffset = entry.lsoAt
			}
		}
	}
	return resp, nil
}

// ListOffsets implements PartitionSource.
func (s *MemorySource) ListOffsets(context.Context) (int64, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.entries) == 0 {
		return 0, 0, nil
	}
	earliest := s.entries[0].batch.BaseOffset
	last := s.entries[len(s.entries)-1].batch
	latest := last.BaseOffset + int64(len(last.Records))
	if last.Control {
		latest = last.BaseOffset + 1
	}
	return earliest, latest, nil
}

// DataBatch builds a non-control batch containing payloads as records. Offsets
// are assigned consecutively starting at baseOffset and sequence numbers start
// at zero; use the returned pointers directly when custom sequences are needed.
func DataBatch(partition int, baseOffset int64, leaderEpoch int32, producerID int64, producerEpoch int16, transactional bool, payloads ...[]byte) *Batch {
	batch := &Batch{
		Partition:     partition,
		BaseOffset:    baseOffset,
		LeaderEpoch:   leaderEpoch,
		ProducerID:    producerID,
		ProducerEpoch: producerEpoch,
	}
	for index, payload := range payloads {
		batch.Records = append(batch.Records, &Record{
			Partition:     partition,
			Offset:        baseOffset + int64(index),
			Value:         append([]byte(nil), payload...),
			ProducerID:    producerID,
			ProducerEpoch: producerEpoch,
			Sequence:      int32(index),
			Transactional: transactional,
		})
	}
	return batch
}

// PlainBatch builds a non-transactional data batch (ProducerID == 0).
func PlainBatch(partition int, baseOffset int64, leaderEpoch int32, payloads ...[]byte) *Batch {
	batch := DataBatch(partition, baseOffset, leaderEpoch, 0, 0, false, payloads...)
	for _, record := range batch.Records {
		record.ProducerID = 0
		record.ProducerEpoch = 0
	}
	return batch
}

// ControlBatch builds a COMMIT or ABORT marker batch at offset.
func ControlBatch(partition int, offset int64, leaderEpoch int32, producerID int64, producerEpoch int16, marker ControlType) *Batch {
	return &Batch{
		Partition:     partition,
		BaseOffset:    offset,
		LeaderEpoch:   leaderEpoch,
		ProducerID:    producerID,
		ProducerEpoch: producerEpoch,
		Control:       true,
		Marker:        marker,
	}
}

// sortedPartitions returns partition ids in ascending order for deterministic
// cross-partition output.
func sortedPartitions(partitions map[int]*partitionState) []int {
	out := make([]int, 0, len(partitions))
	for partition := range partitions {
		out = append(out, partition)
	}
	sort.Ints(out)
	return out
}
