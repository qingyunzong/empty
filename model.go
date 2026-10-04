package kvmerge

// Store 是未压缩读模型：保留全部历史写入，读取时现场解析可见版本。
// 它作为合并结果的对照基准。
type Store struct {
	entries []Entry
}

// NewStore 构造空的未压缩读模型。
func NewStore() *Store { return &Store{} }

// Add 追加一条写入。
func (s *Store) Add(e Entry) { s.entries = append(s.entries, e) }

// AddSegment 追加整段数据。
func (s *Store) AddSegment(seg Segment) { s.entries = append(s.entries, seg.Entries...) }

// Len 返回模型中的条目数。
func (s *Store) Len() int { return len(s.entries) }

// Get 返回键在序号 seq 处的可见值；键不存在或已被删除时 ok 为 false。
func (s *Store) Get(key string, seq uint64) (val string, ok bool) {
	best := -1
	for i, e := range s.entries {
		if e.Key != key || e.Seq > seq {
			continue
		}
		if best < 0 || e.Seq > s.entries[best].Seq {
			best = i
		}
	}
	if best < 0 || s.entries[best].Del {
		return "", false
	}
	return s.entries[best].Val, true
}

// Get 返回合并输出中键在序号 seq 处的可见值，语义与 Store.Get 一致。
func (r Result) Get(key string, seq uint64) (val string, ok bool) {
	best := -1
	for i, e := range r.Output {
		if e.Key != key || e.Seq > seq {
			continue
		}
		if best < 0 || e.Seq > r.Output[best].Seq {
			best = i
		}
	}
	if best < 0 || r.Output[best].Del {
		return "", false
	}
	return r.Output[best].Val, true
}
