package dataeng

import "sync"

// DB 是分组聚合的版本化入口，维护最新快照并保证并发安全。
// Apply 始终基于最新快照生成新版本；旧快照不会被修改，
// 读者保留的任何历史 *Snapshot 在后续 Apply 之后依然可安全读取。
type DB struct {
	mu     sync.RWMutex
	latest *Snapshot
}

// New 创建只含空初始快照（版本 0）的 DB。
func New() *DB {
	return &DB{
		latest: &Snapshot{
			seq:    0,
			groups: make(map[string]*groupState),
		},
	}
}

// Latest 返回当前最新快照。快照不可变，返回后可被读者长期持有。
func (db *DB) Latest() *Snapshot {
	db.mu.RLock()
	defer db.mu.RUnlock()
	return db.latest
}

// Version 返回最新快照的版本号。
func (db *DB) Version() int64 {
	db.mu.RLock()
	defer db.mu.RUnlock()
	return db.latest.seq
}

// Apply 在最新快照之上原子应用一个批次：
// 任一条操作非法则整批回滚，DB 状态不变并返回错误；
// 成功时提交新版本并返回该快照，读者仍可继续使用旧版本。
func (db *DB) Apply(ops []Op) (*Snapshot, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	next, err := db.latest.Apply(ops)
	if err != nil {
		return nil, err
	}
	db.latest = next
	return next, nil
}
