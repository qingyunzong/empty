package idem

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// WAL record types. A transaction is a run of recordDecision/recordEffect
// lines terminated by a recordCommit line; anything not terminated by a
// commit marker is torn by a crash and discarded on recovery. Watermark
// records are self-contained single-line commits.
const (
	recordDecision  = "D"
	recordEffect    = "B"
	recordCommit    = "C"
	recordWatermark = "W"
)

type clientGen struct {
	client string
	gen    uint64
}

type walDecision struct {
	Client string `json:"c"`
	Gen    uint64 `json:"g"`
	Seq    uint64 `json:"s"`
	Output []byte `json:"o"`
}

type walWatermark struct {
	Client string `json:"c"`
	Gen    uint64 `json:"g"`
	Seq    uint64 `json:"s"`
}

type store struct {
	mu   sync.Mutex
	wal  *os.File
	walw *bufio.Writer

	crashed   bool
	crashHook func(CrashPoint) error

	records     map[Key]Decision
	watermarks  map[clientGen]uint64
	generations map[string]uint64 // highest generation seen per client
	business    map[string]string
}

func openStore(dir string) (*store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "idem.wal")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	s := &store{
		wal:         f,
		walw:        bufio.NewWriter(f),
		records:     map[Key]Decision{},
		watermarks:  map[clientGen]uint64{},
		generations: map[string]uint64{},
		business:    map[string]string{},
	}
	if err := s.recover(); err != nil {
		f.Close()
		return nil, err
	}
	return s, nil
}

// recover replays the WAL. Only transactions terminated by a commit
// marker are applied; a crash between the decision record and the commit
// marker leaves no trace, guaranteeing atomic visibility.
func (s *store) recover() error {
	if _, err := s.wal.Seek(0, io.SeekStart); err != nil {
		return err
	}
	var (
		pendingDecisions []walDecision
		pendingEffects   []Effect
	)
	sc := bufio.NewScanner(s.wal)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	for sc.Scan() {
		line := sc.Text()
		typ, payload, _ := strings.Cut(line, " ")
		switch typ {
		case recordDecision:
			var d walDecision
			if err := json.Unmarshal([]byte(payload), &d); err != nil {
				return fmt.Errorf("idem: wal corrupt decision: %w", err)
			}
			pendingDecisions = append(pendingDecisions, d)
		case recordEffect:
			var e Effect
			if err := json.Unmarshal([]byte(payload), &e); err != nil {
				return fmt.Errorf("idem: wal corrupt effect: %w", err)
			}
			pendingEffects = append(pendingEffects, e)
		case recordCommit:
			for _, d := range pendingDecisions {
				s.applyDecision(d)
			}
			for _, e := range pendingEffects {
				s.business[e.K] = e.V
			}
			pendingDecisions = pendingDecisions[:0]
			pendingEffects = pendingEffects[:0]
		case recordWatermark:
			var w walWatermark
			if err := json.Unmarshal([]byte(payload), &w); err != nil {
				return fmt.Errorf("idem: wal corrupt watermark: %w", err)
			}
			s.applyWatermark(clientGen{client: w.Client, gen: w.Gen}, w.Seq)
		default:
			// Torn trailing line from a crash: stop replay.
			return nil
		}
	}
	// Uncommitted tail (crash mid-transaction): discarded.
	return sc.Err()
}

func (s *store) applyDecision(d walDecision) {
	k := Key{Client: d.Client, Gen: d.Gen, Seq: d.Seq}
	s.records[k] = Decision{Key: k, Output: d.Output}
	if d.Gen > s.generations[d.Client] {
		s.generations[d.Client] = d.Gen
	}
}

func (s *store) applyWatermark(cg clientGen, seq uint64) {
	if seq <= s.watermarks[cg] {
		return
	}
	s.watermarks[cg] = seq
	// Reclaim records at or below the watermark.
	for k := range s.records {
		if k.Client == cg.client && k.Gen == cg.gen && k.Seq <= seq {
			delete(s.records, k)
		}
	}
}

func (s *store) checkLive() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.checkLiveLocked()
}

func (s *store) checkLiveLocked() error {
	if s.crashed {
		return ErrCrashed
	}
	return nil
}

func (s *store) setCrashHook(h func(CrashPoint) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.crashHook = h
}

// crash fires the injection hook; on error the store is marked crashed
// and no further writes occur, simulating power loss mid-commit.
func (s *store) crash(p CrashPoint) error {
	if s.crashHook == nil {
		return nil
	}
	if err := s.crashHook(p); err != nil {
		s.crashed = true
		return errors.Join(ErrInjectedCrash, err)
	}
	return nil
}

// commit durably and atomically commits a decision record plus its
// business effects. In-memory state is mutated only after the commit
// marker is durable.
func (s *store) commit(d Decision, effects []Effect) error {
	dj, _ := json.Marshal(walDecision{
		Client: d.Key.Client, Gen: d.Key.Gen, Seq: d.Key.Seq, Output: d.Output,
	})
	if err := s.writeLine(recordDecision + " " + string(dj)); err != nil {
		return err
	}
	if err := s.crash(PointAfterDecisionRecord); err != nil {
		return err
	}
	for _, e := range effects {
		ej, _ := json.Marshal(e)
		if err := s.writeLine(recordEffect + " " + string(ej)); err != nil {
			return err
		}
	}
	if err := s.crash(PointAfterBusinessEffects); err != nil {
		return err
	}
	if err := s.writeLine(recordCommit); err != nil {
		return err
	}
	if err := s.flush(); err != nil {
		return err
	}
	if err := s.crash(PointAfterCommit); err != nil {
		return err
	}
	// Commit marker durable: apply to memory.
	s.applyDecision(walDecision{
		Client: d.Key.Client, Gen: d.Key.Gen, Seq: d.Key.Seq, Output: d.Output,
	})
	for _, e := range effects {
		s.business[e.K] = e.V
	}
	return nil
}

// ack advances the watermark for cg to seq (monotonic) durably.
func (s *store) ack(cg clientGen, seq uint64) error {
	if seq <= s.watermarks[cg] {
		return nil
	}
	wj, _ := json.Marshal(walWatermark{Client: cg.client, Gen: cg.gen, Seq: seq})
	if err := s.writeLine(recordWatermark + " " + string(wj)); err != nil {
		return err
	}
	if err := s.flush(); err != nil {
		return err
	}
	s.applyWatermark(cg, seq)
	return nil
}

func (s *store) writeLine(line string) error {
	if _, err := s.walw.WriteString(line + "\n"); err != nil {
		return err
	}
	// Flush each line so a "crash" leaves exactly the lines written so
	// far, mimicking a journaled device.
	return s.walw.Flush()
}

func (s *store) flush() error {
	if err := s.walw.Flush(); err != nil {
		return err
	}
	return s.wal.Sync()
}

func (s *store) close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.crashed {
		return s.wal.Close()
	}
	if err := s.flush(); err != nil {
		return err
	}
	return s.wal.Close()
}
