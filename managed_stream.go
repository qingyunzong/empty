package q150

import "sync"

// managedStream 包装正文流，使 Close 幂等且并发安全，并记录关闭次数，
// 便于测试验证“正文流一定被关闭且只关闭一次”。
type managedStream struct {
	stream Stream

	mu       sync.Mutex
	closed   bool
	closeCnt int
}

func newManagedStream(stream Stream) *managedStream {
	return &managedStream{stream: stream}
}

func (m *managedStream) Read(p []byte) (int, error) {
	return m.stream.Read(p)
}

// Close 关闭底层流；重复调用只生效一次。
func (m *managedStream) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	m.closed = true
	m.closeCnt = 1
	return m.stream.Close()
}

func (m *managedStream) closeCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closeCnt
}
