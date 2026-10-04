// Package store 提供基于预期版本(CAS)的并发状态库。
//
// 保证:
//   - Update 携带预期版本,版本不匹配则拒绝;
//   - 成功的更新先把提交帧写入 WAL 并 fsync,然后才对读者可见;
//   - 短写/同步失败不会发布,日志被截回,不留下半个帧;
//   - 崩溃恢复只重放完整且 CRC 校验通过的提交帧。
package store

import (
	"errors"
	"sync"
	"sync/atomic"
)

// ErrVersionMismatch 表示预期版本与当前版本不一致。
// 返回的版本中附带当前版本,便于调用方重试。
var ErrVersionMismatch = errors.New("store: version mismatch")

type Store struct {
	mu      sync.RWMutex
	version uint64
	value   []byte
	wal     *wal

	published atomic.Uint64 // 已持久化并对读者可见的版本
}

// Open 打开(必要时创建)位于 path 的状态库,并重放 WAL 恢复状态。
func Open(path string) (*Store, error) {
	w, version, value, err := openWAL(path)
	if err != nil {
		return nil, err
	}
	s := &Store{version: version, value: value, wal: w}
	s.published.Store(version)
	return s, nil
}

// Update 在 expected 等于当前版本时,把状态持久化后切换为 value,
// 返回新版本号。整个"校验-持久化-发布"在写锁内完成,
// 因此相同预期版本的并发竞争只有一个能成功。
func (s *Store) Update(expected uint64, value []byte) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.version != expected {
		return s.version, ErrVersionMismatch
	}
	next := s.version + 1
	// 先持久化:此调用返回前帧已 fsync;失败则什么都不发布。
	if err := s.wal.append(next, value); err != nil {
		return s.version, err
	}
	// 再可见:持久化成功后才更新内存状态。
	s.value = append([]byte(nil), value...)
	s.version = next
	s.published.Store(next)
	return next, nil
}

// Get 返回当前版本与值的快照。
func (s *Store) Get() (uint64, []byte) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.version, append([]byte(nil), s.value...)
}

// PublishedVersion 返回已持久化并对读者可见的版本(无锁,供故障注入钩子使用)。
func (s *Store) PublishedVersion() uint64 { return s.published.Load() }

func (s *Store) Close() error { return s.wal.close() }
