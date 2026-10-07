package indexrebuild

import (
	"sync"
	"sync/atomic"
)

// Store 对外提供读写与查询。查询永远走 idx 原子指针当前指向的索引：
// 重建完成并切换前，所有查询都由旧索引服务。
type Store struct {
	writeMu sync.Mutex // 串行化所有写提交，保证日志与在线索引一致
	main    *MainTable
	idx     atomic.Pointer[Index]
}

func NewStore() *Store {
	s := &Store{main: NewMainTable()}
	s.idx.Store(NewIndex())
	return s
}

func (s *Store) Put(key, value string) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	op := s.main.Put(key, value)
	s.idx.Load().Apply(op) // 在线索引同步跟进
}

func (s *Store) Delete(key string) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	op := s.main.Delete(key)
	s.idx.Load().Apply(op)
}

// Query 读当前索引指针，无锁切换语义：切换前命中旧索引，切换后命中新索引。
func (s *Store) Query(value string) []string {
	return s.idx.Load().Get(value)
}

func (s *Store) Main() *MainTable { return s.main }

// currentIndex 供测试断言指针身份（切换前后是否为同一索引实例）。
func (s *Store) currentIndex() *Index { return s.idx.Load() }

// RebuildHooks 在重建各阶段插入屏障，测试用它确定性地交错写入与切换。
type RebuildHooks struct {
	AfterFreeze  func(version uint64) // 快照冻结后、建索引前
	AfterBuild   func()               // 新索引构建完成后、重放前
	BeforeCommit func()               // 最终重放+切换前（未持写锁，写入仍可提交）
	AfterSwitch  func()               // 切换完成后
}

// RebuildIndex 流程：冻结源版本 -> 离线构建 -> 屏障 -> 持写锁重放增量(含删除) -> 原子切换。
// 最终重放与切换在同一把写锁内完成，因此切换瞬间不会有已提交日志被漏放。
func (s *Store) RebuildIndex(hooks *RebuildHooks) {
	if hooks == nil {
		hooks = &RebuildHooks{}
	}
	version, snap := s.main.Snapshot() // 冻结
	if hooks.AfterFreeze != nil {
		hooks.AfterFreeze(version)
	}
	fresh := BuildIndex(snap)
	if hooks.AfterBuild != nil {
		hooks.AfterBuild()
	}
	if hooks.BeforeCommit != nil {
		hooks.BeforeCommit()
	}
	s.writeMu.Lock() // 屏障：阻断新提交，重放到最新版本后切换
	for _, op := range s.main.ChangesSince(version) {
		fresh.Apply(op)
	}
	s.idx.Store(fresh) // 原子切换
	s.writeMu.Unlock()
	if hooks.AfterSwitch != nil {
		hooks.AfterSwitch()
	}
}
