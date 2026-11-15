package dataeng

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// publishLedger 记录已经发布到下游的世代单元，保证恢复重放不重复发布。
type publishLedger struct {
	mu        sync.Mutex
	path      string
	fsync     bool
	Published map[string]time.Time `json:"published"`
}

type ledgerDoc struct {
	Published map[string]time.Time `json:"published"`
}

func loadLedger(path string, fsync bool) (*publishLedger, error) {
	l := &publishLedger{
		path: path, fsync: fsync,
		Published: map[string]time.Time{},
	}
	if fileExists(path) {
		var doc ledgerDoc
		if err := readJSON(path, &doc); err != nil {
			return nil, err
		}
		l.Published = doc.Published
		if l.Published == nil {
			l.Published = map[string]time.Time{}
		}
	}
	return l, nil
}

func (l *publishLedger) has(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, ok := l.Published[key]
	return ok
}

func (l *publishLedger) mark(keys []string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	changed := false
	now := time.Now()
	for _, key := range keys {
		if _, ok := l.Published[key]; !ok {
			l.Published[key] = now
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return writeJSON(l.path, &ledgerDoc{Published: l.Published}, l.fsync)
}

func (l *publishLedger) flush() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return writeJSON(l.path, &ledgerDoc{Published: l.Published}, l.fsync)
}

// PendingPublish 枚举 run 下尚未发布的世代单元：
// 已封闭 run 的基础世代记录（kind=record）与全部修订世代（kind=revision），
// 已在账本中的单元自动跳过。
func (a *Archive) PendingPublish(run string) ([]PendingItem, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	rs, ok := a.runs[run]
	if !ok {
		return nil, fmt.Errorf("%w: run %q", ErrNotFound, run)
	}
	if !rs.meta.Sealed {
		return nil, nil
	}
	var items []PendingItem
	keys := make([]string, 0, len(rs.records))
	for key := range rs.records {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		rec := rs.records[key]
		baseKey := pendingKey("record", run, rec.Target, rec.RequestID, 0)
		if a.ledger.has(baseKey) {
			continue
		}
		base, err := a.ReadBase(run, rec.Target, rec.RequestID)
		if err != nil {
			return nil, err
		}
		items = append(items, PendingItem{
			Key: baseKey, Kind: "record", Run: run,
			Target: rec.Target, RequestID: rec.RequestID, Rev: 0, Record: *base,
		})
	}

	idx, err := a.loadRevIndex(run)
	if err != nil {
		return nil, err
	}
	for _, gen := range idx.Generations {
		seenInGen := map[string]bool{}
		for _, entry := range gen.Entries {
			dedupKey := entry.Target + "\x00" + entry.RequestID
			if seenInGen[dedupKey] {
				continue
			}
			seenInGen[dedupKey] = true
			revKey := pendingKey("revision", run, entry.Target, entry.RequestID, gen.Gen)
			if a.ledger.has(revKey) {
				continue
			}
			rec, err := a.ReadRevision(run, gen.Gen, entry.Target, entry.RequestID)
			if err != nil {
				return nil, err
			}
			items = append(items, PendingItem{
				Key: revKey, Kind: "revision", Run: run,
				Target: entry.Target, RequestID: entry.RequestID,
				Rev: gen.Gen, Record: *rec,
			})
		}
	}
	return items, nil
}

func pendingKey(kind, run, target, requestID string, rev int64) string {
	return fmt.Sprintf("%s|%s|%s|%s|%d", kind, run, target, requestID, rev)
}

// MarkPublished 把一组发布单元记入账本；重复键幂等。
func (a *Archive) MarkPublished(keys []string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return ErrClosed
	}
	return a.ledger.mark(keys)
}

// PublishStream 以稳定顺序把未发布单元推送到 out。发布方处理成功后必须调用
// MarkPublished；进程崩溃重放时账本里已有键的单元不会再次出现。
// out 返回 false（消费方主动停止）时本方法返回 nil，不记账。
func (a *Archive) PublishStream(ctx context.Context, run string, out chan<- PendingItem) error {
	items, err := a.PendingPublish(run)
	if err != nil {
		return err
	}
	for _, item := range items {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case out <- item:
		}
	}
	return nil
}
