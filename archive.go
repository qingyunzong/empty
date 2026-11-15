package dataeng

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"sync"
	"time"
)

// Option 调整归档行为。
type Option func(*config)

type config struct {
	fsync       bool
	walMaxBytes int64
}

// WithNoSync 关闭每次写入后的 fsync，换取更高吞吐（崩溃可能丢失最后若干帧）。
func WithNoSync() Option {
	return func(c *config) { c.fsync = false }
}

// WithWALMaxBytes 设置单个 WAL 分段的滚动阈值，默认 32MiB。
func WithWALMaxBytes(n int64) Option {
	return func(c *config) { c.walMaxBytes = n }
}

// Archive 是 HAR 分片归档的句柄，所有方法均并发安全。
type Archive struct {
	root   string
	cfg    config
	mu     sync.Mutex
	runs   map[string]*runState
	blobs  *blobStore
	ledger *publishLedger
	closed bool
}

type runMeta struct {
	Run         string    `json:"run"`
	Sealed      bool      `json:"sealed"`
	RevisionSeq int64     `json:"revision_seq"`
	CreatedAt   time.Time `json:"created_at,omitempty"`
	SealedAt    time.Time `json:"sealed_at,omitempty"`
}

type runState struct {
	meta       runMeta
	wal        *walWriter
	records    map[string]*Record
	applied    map[string]bool
	arrivalSeq int64
}

// RevisionEntry 是修订世代索引中的一条记录定位信息。
type RevisionEntry struct {
	Target    string    `json:"target"`
	RequestID string    `json:"request_id"`
	Path      string    `json:"path"`
	EventID   string    `json:"event_id"`
	At        time.Time `json:"at"`
}

// RevisionGen 是一个修订世代，包含本世代写入的全部记录条目。
type RevisionGen struct {
	Gen     int64           `json:"gen"`
	At      time.Time       `json:"at"`
	Entries []RevisionEntry `json:"entries"`
}

// RevisionIndex 是 run 的修订世代索引。
type RevisionIndex struct {
	Run         string        `json:"run"`
	Generations []RevisionGen `json:"generations"`
}

func recordKey(target, requestID string) string { return target + "\x00" + requestID }

// Open 打开（或恢复）root 下的归档。恢复时重放全部 WAL，重建 run 状态、
// 未闭合快照与修订世代索引；已发布项由发布账本过滤，不会重复发布。
func Open(root string, opts ...Option) (*Archive, error) {
	cfg := config{fsync: true, walMaxBytes: 32 << 20}
	for _, opt := range opts {
		opt(&cfg)
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	a := &Archive{
		root:  root,
		cfg:   cfg,
		runs:  map[string]*runState{},
		blobs: newBlobStore(root, cfg.fsync),
	}
	if err := a.blobs.ensureLayout(); err != nil {
		return nil, err
	}
	ledger, err := loadLedger(ledgerPath(root), cfg.fsync)
	if err != nil {
		return nil, err
	}
	a.ledger = ledger
	if err := a.recover(); err != nil {
		return nil, err
	}
	return a, nil
}

func (a *Archive) recover() error {
	entries, err := os.ReadDir(runsDir(a.root))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		run := entry.Name()
		rs := &runState{
			records: map[string]*Record{},
			applied: map[string]bool{},
		}
		metaPath := metaPath(a.root, run)
		if fileExists(metaPath) {
			if err := readJSON(metaPath, &rs.meta); err != nil {
				return fmt.Errorf("recover run %q: %w", run, err)
			}
		}
		rs.meta.Run = run

		// 修订索引与 open/base 快照都是 WAL 的派生物：恢复时先清除派生世代
		// 索引，再由事件重放确定性重建，避免每次重启重复累积世代。
		if err := os.RemoveAll(revDir(a.root, run)); err != nil {
			return fmt.Errorf("recover run %q: %w", run, err)
		}
		rs.meta.RevisionSeq = 0
		// 若 WAL 含封闭帧，重放必须先经历未封闭阶段，因此临时复位封闭标记，
		// 由重放到封闭帧时的 sealRun 重新置位。
		wasSealed := rs.meta.Sealed
		if walHasSeal(walDir(a.root, run)) {
			rs.meta.Sealed = false
		}

		err := replayWAL(walDir(a.root, run),
			func(ev *Event) error { return a.replayEvent(rs, ev) },
			func(at time.Time) error {
				if err := a.sealRun(rs, at); err != nil {
					return err
				}
				rs.meta.Sealed = true
				return nil
			},
		)
		if err != nil {
			return fmt.Errorf("recover run %q: %w", run, err)
		}
		if wasSealed && !rs.meta.Sealed {
			// 封闭帧尚未落盘但 meta 已封闭（极端崩溃窗口），补一次封闭。
			if err := a.sealRun(rs, time.Now()); err != nil {
				return err
			}
		}

		wal, err := openWALWriter(walDir(a.root, run), a.cfg.walMaxBytes, a.cfg.fsync)
		if err != nil {
			return err
		}
		rs.wal = wal
		a.runs[run] = rs
	}
	return nil
}

// Ingest 归并一条采集事件，返回事件所属记录的当前快照。
// 重复事件（相同 Event.ID，含按内容派生的 ID）幂等跳过。
func (a *Archive) Ingest(ev Event) (*Record, error) {
	if err := ev.validate(); err != nil {
		return nil, err
	}
	if ev.ID == "" {
		ev.ID = deriveEventID(ev)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil, ErrClosed
	}
	rs, err := a.getOrCreateRun(ev.Run)
	if err != nil {
		return nil, err
	}
	if rs.applied[ev.ID] {
		return cloneRecord(rs.records[recordKey(ev.Target, ev.RequestID)]), nil
	}
	var bodyRef *BlobRef
	if ev.Type == EvRequestBody || ev.Type == EvResponseBody {
		bodyRef, err = a.resolveBodyRef(&ev)
		if err != nil {
			return nil, err
		}
	}
	if err := rs.wal.appendEvent(&ev); err != nil {
		return nil, err
	}
	rs.applied[ev.ID] = true
	rec := rs.apply(&ev, bodyRef)
	if err := a.persistAfterApply(rs, rec, &ev); err != nil {
		return nil, err
	}
	return cloneRecord(rec), nil
}

func (a *Archive) replayEvent(rs *runState, ev *Event) error {
	if ev.ID == "" {
		ev.ID = deriveEventID(*ev)
	}
	if rs.applied[ev.ID] {
		return nil
	}
	var bodyRef *BlobRef
	if ev.Type == EvRequestBody || ev.Type == EvResponseBody {
		ref := BlobRef{
			Algo: ev.BlobAlgo, Digest: ev.BlobDigest, Size: ev.BlobSize,
			MIME: ev.BlobMIME, Run: ev.Run, Target: ev.Target,
			RequestID: ev.RequestID, EventID: ev.ID,
			Role: bodyRole(ev.Type),
		}
		if err := a.blobs.PutRef(ref); err != nil {
			return err
		}
		bodyRef = &ref
	}
	rs.applied[ev.ID] = true
	rec := rs.apply(ev, bodyRef)
	return a.persistAfterApply(rs, rec, ev)
}

func bodyRole(t EventType) string {
	if t == EvRequestBody {
		return "request"
	}
	return "response"
}

func (a *Archive) resolveBodyRef(ev *Event) (*BlobRef, error) {
	ref := BlobRef{
		Algo: ev.BlobAlgo, MIME: ev.BlobMIME, Run: ev.Run, Target: ev.Target,
		RequestID: ev.RequestID, EventID: ev.ID, Role: bodyRole(ev.Type),
	}
	if len(ev.Body) > 0 {
		stored, err := a.blobs.Put(ev.BlobAlgo, ev.BlobMIME, ev.Body, ref)
		if err != nil {
			return nil, err
		}
		ev.BlobAlgo, ev.BlobDigest, ev.BlobSize = stored.Algo, stored.Digest, stored.Size
		return stored, nil
	}
	ref.Algo, ref.Digest, ref.Size = ev.BlobAlgo, ev.BlobDigest, ev.BlobSize
	if err := a.blobs.PutRef(ref); err != nil {
		return nil, err
	}
	return &ref, nil
}

func (rs *runState) nextArrival() int64 {
	rs.arrivalSeq++
	return rs.arrivalSeq
}

func (rs *runState) apply(ev *Event, bodyRef *BlobRef) *Record {
	key := recordKey(ev.Target, ev.RequestID)
	rec := rs.records[key]
	arrival := rs.nextArrival()
	if rec == nil {
		rec = &Record{
			Run: ev.Run, Target: ev.Target, RequestID: ev.RequestID,
			State: StateOpen, Seq: ev.Seq, Arrival: arrival,
			StartedAt: ev.Timestamp,
		}
		rs.records[key] = rec
	}
	rec.AppliedEvents = append(rec.AppliedEvents, ev.ID)
	if rec.StartedAt.IsZero() {
		rec.StartedAt = ev.Timestamp
	}
	switch ev.Type {
	case EvRequest:
		rec.RequestFields = mergeFields(rec.RequestFields, ev.Fields)
	case EvResponse:
		rec.ResponseFields = mergeFields(rec.ResponseFields, ev.Fields)
		if rec.State == StateOpen {
			rec.State = StateComplete
		}
		rec.CompletedAt = ev.Timestamp
	case EvRedirect:
		rec.Redirects = append(rec.Redirects, Redirect{
			Status:  asInt(ev.Fields["status"]),
			From:    asString(ev.Fields["from"]),
			To:      asString(ev.Fields["to"]),
			Headers: asPairs(ev.Fields["headers"]),
			Seq:     ev.Seq, Arrival: arrival, At: ev.Timestamp,
		})
	case EvRequestBody:
		rec.ReqBody = bodyRef
	case EvResponseBody:
		rec.RespBody = bodyRef
	}
	sort.SliceStable(rec.Redirects, func(i, j int) bool {
		if rec.Redirects[i].Seq != rec.Redirects[j].Seq {
			return rec.Redirects[i].Seq < rec.Redirects[j].Seq
		}
		return rec.Redirects[i].Arrival < rec.Redirects[j].Arrival
	})
	return rec
}

// persistAfterApply 把归并后的记录落到正确的世代位置。
func (a *Archive) persistAfterApply(rs *runState, rec *Record, ev *Event) error {
	if !rs.meta.Sealed {
		if rec.State == StateOpen {
			return writeJSON(openRecordPath(a.root, rs.meta.Run, rec.Target, rec.RequestID), rec, a.cfg.fsync)
		}
		path := openRecordPath(a.root, rs.meta.Run, rec.Target, rec.RequestID)
		if fileExists(path) {
			return os.Remove(path)
		}
		return nil
	}
	// 封闭后的每个迟到事件对应一个修订世代；重放时按相同次序派生相同世代号。
	rs.meta.RevisionSeq++
	return a.writeRevision(rs, rec, ev)
}
