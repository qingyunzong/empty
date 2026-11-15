package dataeng

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"
)

func (a *Archive) writeRevision(rs *runState, rec *Record, ev *Event) error {
	gen := rs.meta.RevisionSeq
	rec.Rev = gen
	rec.History = append(rec.History, gen)
	if rec.State == StateOpen {
		rec.State = StateSealed
	}
	path := genRecordPath(a.root, rs.meta.Run, gen, rec.Target, rec.RequestID)
	if err := writeJSON(path, rec, a.cfg.fsync); err != nil {
		return err
	}
	idx, err := a.loadRevIndex(rs.meta.Run)
	if err != nil {
		return err
	}
	idx.Generations = append(idx.Generations, RevisionGen{
		Gen: gen, At: time.Now(),
		Entries: []RevisionEntry{{
			Target: rec.Target, RequestID: rec.RequestID, Path: path,
			EventID: ev.ID, At: ev.Timestamp,
		}},
	})
	if err := writeJSON(revIndexPath(a.root, rs.meta.Run), idx, a.cfg.fsync); err != nil {
		return err
	}
	return writeJSON(metaPath(a.root, rs.meta.Run), &rs.meta, a.cfg.fsync)
}

func (a *Archive) loadRevIndex(run string) (*RevisionIndex, error) {
	idx := &RevisionIndex{Run: run}
	path := revIndexPath(a.root, run)
	if fileExists(path) {
		if err := readJSON(path, idx); err != nil {
			return nil, err
		}
	}
	return idx, nil
}

func (a *Archive) getOrCreateRun(run string) (*runState, error) {
	if rs, ok := a.runs[run]; ok {
		return rs, nil
	}
	if err := os.MkdirAll(runDir(a.root, run), 0o755); err != nil {
		return nil, err
	}
	rs := &runState{
		meta:    runMeta{Run: run, CreatedAt: time.Now()},
		records: map[string]*Record{},
		applied: map[string]bool{},
	}
	if err := writeJSON(metaPath(a.root, run), &rs.meta, a.cfg.fsync); err != nil {
		return nil, err
	}
	wal, err := openWALWriter(walDir(a.root, run), a.cfg.walMaxBytes, a.cfg.fsync)
	if err != nil {
		return nil, err
	}
	rs.wal = wal
	a.runs[run] = rs
	return rs, nil
}

// CloseRun 封闭 run：把全部记录固化到基础世代、清空未闭合快照，并向 WAL
// 追加封闭帧。重复调用幂等。封闭后到达的事件自动进入修订世代。
func (a *Archive) CloseRun(run string) (*RunSummary, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil, ErrClosed
	}
	rs, ok := a.runs[run]
	if !ok {
		return nil, fmt.Errorf("%w: run %q", ErrNotFound, run)
	}
	if err := a.sealRun(rs, time.Now()); err != nil {
		return nil, err
	}
	return a.summarize(rs), nil
}

func (a *Archive) sealRun(rs *runState, at time.Time) error {
	if rs.meta.Sealed {
		return nil
	}
	run := rs.meta.Run
	for _, rec := range rs.records {
		snapshot := cloneRecord(rec)
		snapshot.Rev = 0
		if snapshot.State == StateOpen {
			snapshot.State = StateSealed
		}
		if err := writeJSON(baseRecordPath(a.root, run, snapshot.Target, snapshot.RequestID),
			snapshot, a.cfg.fsync); err != nil {
			return err
		}
		openPath := openRecordPath(a.root, run, rec.Target, rec.RequestID)
		if fileExists(openPath) {
			if err := os.Remove(openPath); err != nil {
				return err
			}
		}
	}
	rs.meta.Sealed = true
	rs.meta.SealedAt = at
	if err := writeJSON(metaPath(a.root, run), &rs.meta, a.cfg.fsync); err != nil {
		return err
	}
	if rs.wal == nil {
		return nil // 恢复重放期间 WAL 尚未打开，封闭帧本身来自 WAL，无需回写。
	}
	return rs.wal.appendSeal(at)
}

func (a *Archive) summarize(rs *runState) *RunSummary {
	out := &RunSummary{
		Run:         rs.meta.Run,
		State:       "sealed",
		RecordCount: len(rs.records),
		RevisionSeq: rs.meta.RevisionSeq,
		SealedAt:    rs.meta.SealedAt,
	}
	for _, rec := range rs.records {
		if rec.State == StateComplete {
			out.Complete++
		} else {
			out.SealedOpen++
		}
	}
	return out
}

// ListRuns 返回归档内已知的 run 标识，按名称排序。
func (a *Archive) ListRuns() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, 0, len(a.runs))
	for run := range a.runs {
		out = append(out, run)
	}
	sort.Strings(out)
	return out
}

// IsSealed 报告 run 是否已封闭。
func (a *Archive) IsSealed(run string) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	rs, ok := a.runs[run]
	if !ok {
		return false, fmt.Errorf("%w: run %q", ErrNotFound, run)
	}
	return rs.meta.Sealed, nil
}

// ListRecords 返回 run 下全部记录的当前世代快照，按 (Target, Arrival) 稳定排序。
func (a *Archive) ListRecords(run string) ([]Record, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	rs, ok := a.runs[run]
	if !ok {
		return nil, fmt.Errorf("%w: run %q", ErrNotFound, run)
	}
	out := make([]Record, 0, len(rs.records))
	for _, rec := range rs.records {
		out = append(out, *cloneRecord(rec))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Target != out[j].Target {
			return out[i].Target < out[j].Target
		}
		return out[i].Arrival < out[j].Arrival
	})
	return out, nil
}

// GetRecord 取单条记录的当前世代快照；不存在返回 ErrNotFound。
func (a *Archive) GetRecord(run, target, requestID string) (*Record, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	rs, ok := a.runs[run]
	if !ok {
		return nil, fmt.Errorf("%w: run %q", ErrNotFound, run)
	}
	rec, ok := rs.records[recordKey(target, requestID)]
	if !ok {
		return nil, fmt.Errorf("%w: record %q/%q", ErrNotFound, target, requestID)
	}
	return cloneRecord(rec), nil
}

// Revisions 返回 run 的修订世代索引（封闭后的迟到事件每个一个世代）。
func (a *Archive) Revisions(run string) (*RevisionIndex, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.runs[run]; !ok {
		return nil, fmt.Errorf("%w: run %q", ErrNotFound, run)
	}
	return a.loadRevIndex(run)
}

// ReadRevision 从磁盘读取某条修订世代记录，用于离线复核而不触碰内存态。
func (a *Archive) ReadRevision(run string, gen int64, target, requestID string) (*Record, error) {
	path := genRecordPath(a.root, run, gen, target, requestID)
	if !fileExists(path) {
		return nil, fmt.Errorf("%w: revision %d %q/%q", ErrNotFound, gen, target, requestID)
	}
	var rec Record
	if err := readJSON(path, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// ReadBase 读取封闭时固化的基础世代记录。
func (a *Archive) ReadBase(run, target, requestID string) (*Record, error) {
	path := baseRecordPath(a.root, run, target, requestID)
	if !fileExists(path) {
		return nil, fmt.Errorf("%w: base %q/%q", ErrNotFound, target, requestID)
	}
	var rec Record
	if err := readJSON(path, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// Close 刷写并关闭全部 WAL 与发布账本。
func (a *Archive) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil
	}
	for _, rs := range a.runs {
		if err := rs.wal.close(); err != nil {
			return err
		}
	}
	if err := a.ledger.flush(); err != nil {
		return err
	}
	a.closed = true
	return nil
}

// BlobData 按摘要读取正文数据。
func (a *Archive) BlobData(algo, digest string) ([]byte, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.blobs.Read(algo, digest)
}

// BlobRefs 返回某正文 blob 的全部独立来源关系。
func (a *Archive) BlobRefs(algo, digest string) ([]BlobRef, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.blobs.Refs(algo, digest)
}

func cloneRecord(r *Record) *Record {
	if r == nil {
		return nil
	}
	data, err := json.Marshal(r)
	if err != nil {
		return r
	}
	var out Record
	if err := json.Unmarshal(data, &out); err != nil {
		return r
	}
	return &out
}
