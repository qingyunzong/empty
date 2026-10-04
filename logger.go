package auditlog

// Logger 将哈希链与追加存储组合为完整的审计日志。
// 打开时重放并校验整条链，保证已有记录未被篡改。
type Logger struct {
	store *Store
	prev  Digest
	seq   uint64
}

// OpenLogger 打开存储并恢复断电撕裂尾部，随后重放链摘要校验完整性，
// 最后定位到链尾以便继续追加。
func OpenLogger(path string) (*Logger, error) {
	store, err := OpenStore(path)
	if err != nil {
		return nil, err
	}
	records, err := store.Records()
	if err != nil {
		store.Close()
		return nil, err
	}
	if err := VerifyChain(records); err != nil {
		store.Close()
		return nil, err
	}
	l := &Logger{store: store, prev: ZeroDigest}
	if n := len(records); n > 0 {
		l.prev = records[n-1].Hash
		l.seq = records[n-1].Seq + 1
	}
	return l, nil
}

// Log 对 payload 按 ranges 脱敏并追加一条记录。
// 原载荷只用于计算摘要，绝不写入存储；返回的记录已持久化（fsync）。
func (l *Logger) Log(payload []byte, ranges []Range) (*Record, error) {
	rec, err := NewRecord(l.prev, l.seq, payload, ranges)
	if err != nil {
		return nil, err
	}
	if err := l.store.Append(rec); err != nil {
		return nil, err
	}
	l.prev = rec.Hash
	l.seq++
	return rec, nil
}

// Records 返回存储中的全部记录。
func (l *Logger) Records() ([]*Record, error) { return l.store.Records() }

// Close 关闭日志。
func (l *Logger) Close() error { return l.store.Close() }
