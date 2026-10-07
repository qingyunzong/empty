package sched

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

const (
	opAdd   = "add"
	opClaim = "claim"
	opAck   = "ack"
)

// record is one entry in the write-ahead log.
type record struct {
	Op          string `json:"op"`
	ID          string `json:"id"`
	Deadline    int64  `json:"deadline,omitempty"`
	Payload     []byte `json:"payload,omitempty"`
	Generation  int64  `json:"gen,omitempty"`
	LeaseExpiry int64  `json:"expiry,omitempty"`
}

// syncWriter is the durability boundary. *os.File satisfies it; tests
// wrap it to inject write/fsync failures.
type syncWriter interface {
	Write(p []byte) (int, error)
	Sync() error
}

// Open opens (creating if needed) the log at path and replays it to
// rebuild the scheduler state. Tasks whose acknowledgements were never
// persisted become claimable again, with a fresh generation, once their
// recorded lease expires.
func Open(path string, opts ...Option) (*Scheduler, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	s := &Scheduler{
		w:        f,
		tasks:    make(map[string]*taskState),
		leaseTTL: int64(30),
		now:      func() int64 { return time.Now().Unix() },
	}
	for _, opt := range opts {
		opt(s)
	}
	if err := s.replay(f); err != nil {
		f.Close()
		return nil, err
	}
	s.f = f
	return s, nil
}

// persist appends a record and fsyncs it before returning. The caller
// only applies in-memory state (and only returns success) after this
// call succeeds.
func (s *Scheduler) persist(rec record) error {
	line, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	if _, err := s.w.Write(line); err != nil {
		return fmt.Errorf("sched: persist %s: %w", rec.Op, err)
	}
	if err := s.w.Sync(); err != nil {
		return fmt.Errorf("sched: sync %s: %w", rec.Op, err)
	}
	if s.afterPersist != nil {
		s.afterPersist(rec.Op)
	}
	return nil
}

func (s *Scheduler) replay(f *os.File) error {
	if _, err := f.Seek(0, 0); err != nil {
		return err
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var rec record
		if err := json.Unmarshal(line, &rec); err != nil {
			return fmt.Errorf("sched: corrupt log record: %w", err)
		}
		switch rec.Op {
		case opAdd:
			s.tasks[rec.ID] = &taskState{task: Task{ID: rec.ID, Deadline: rec.Deadline, Payload: rec.Payload}}
		case opClaim:
			ts, ok := s.tasks[rec.ID]
			if !ok {
				return fmt.Errorf("sched: claim for unknown task %q", rec.ID)
			}
			ts.done = false
			ts.generation = rec.Generation
			ts.leaseExpiry = rec.LeaseExpiry
			if rec.Generation > s.gen {
				s.gen = rec.Generation
			}
		case opAck:
			ts, ok := s.tasks[rec.ID]
			if !ok {
				return fmt.Errorf("sched: ack for unknown task %q", rec.ID)
			}
			ts.done = true
		default:
			return fmt.Errorf("sched: unknown log op %q", rec.Op)
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	_, err := f.Seek(0, 2)
	return err
}
