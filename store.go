package mirror

import "errors"

// ErrMissing 表示键不存在，用于区分“缺失叶”和“全零叶”。
var ErrMissing = errors.New("mirror: key not present")

// KV 是最小键值存储接口，叶数据与树节点哈希都保存在其中。
type KV interface {
	Get(key string) ([]byte, error)
	Put(key string, val []byte)
	Delete(key string)
}

// MemKV 是内存版 KV。
type MemKV struct {
	m map[string][]byte
}

func NewMemKV() *MemKV { return &MemKV{m: make(map[string][]byte)} }

func (s *MemKV) Get(key string) ([]byte, error) {
	v, ok := s.m[key]
	if !ok {
		return nil, ErrMissing
	}
	return append([]byte(nil), v...), nil
}

func (s *MemKV) Put(key string, val []byte) { s.m[key] = append([]byte(nil), val...) }

func (s *MemKV) Delete(key string) { delete(s.m, key) }

// Clone 返回深拷贝，用于从源镜像出目标。
func (s *MemKV) Clone() *MemKV {
	out := NewMemKV()
	for k, v := range s.m {
		out.m[k] = append([]byte(nil), v...)
	}
	return out
}

// CountingKV 包装任意 KV，统计访问次数并记录访问过的键，
// 用于核对差异比较与修复过程实际触及的访问范围。
type CountingKV struct {
	Inner   KV
	Gets    int
	Puts    int
	Deletes int

	GetKeys    []string
	PutKeys    []string
	DeleteKeys []string

	// OnGet 是测试钩子，在每次 Get 时触发（可用于模拟源版本中途变更）。
	OnGet func(key string)
}

func (c *CountingKV) Get(key string) ([]byte, error) {
	c.Gets++
	c.GetKeys = append(c.GetKeys, key)
	if c.OnGet != nil {
		c.OnGet(key)
	}
	return c.Inner.Get(key)
}

func (c *CountingKV) Put(key string, val []byte) {
	c.Puts++
	c.PutKeys = append(c.PutKeys, key)
	c.Inner.Put(key, val)
}

func (c *CountingKV) Delete(key string) {
	c.Deletes++
	c.DeleteKeys = append(c.DeleteKeys, key)
	c.Inner.Delete(key)
}

func (c *CountingKV) Reset() {
	c.Gets, c.Puts, c.Deletes = 0, 0, 0
	c.GetKeys, c.PutKeys, c.DeleteKeys = nil, nil, nil
}
