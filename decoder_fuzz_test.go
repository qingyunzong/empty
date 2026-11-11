package q150

import (
	"testing"
)

func decodeAll(data []byte, chunkSize int) []Event {
	var events []Event
	dec := NewDecoder(func(e Event) { events = append(events, e) }, nil)
	for len(data) > 0 {
		n := chunkSize
		if n > len(data) {
			n = len(data)
		}
		_, _ = dec.Write(data[:n])
		data = data[n:]
	}
	_ = dec.Close()
	return events
}

// FuzzDecoderChunking 保证任意字节序列在 1..8 的切块宽度下，
// 解析结果与整块喂入完全一致。
func FuzzDecoderChunking(f *testing.F) {
	f.Add([]byte("id: 1\ndata: a\r\ndata: b\r\n\r\n: c\nid:\nretry: 10\n"))
	f.Add([]byte("\xEF\xBB\xBFdata: x\r\rdata: y\n\n"))
	f.Fuzz(func(t *testing.T, data []byte) {
		want := decodeAll(append([]byte(nil), data...), len(data)+1)
		for chunk := 1; chunk <= 8; chunk++ {
			got := decodeAll(append([]byte(nil), data...), chunk)
			if len(got) != len(want) {
				t.Fatalf("chunk=%d count=%d want=%d", chunk, len(got), len(want))
			}
			for i := range want {
				if got[i] != want[i] {
					t.Fatalf("chunk=%d event %d = %+v want %+v", chunk, i, got[i], want[i])
				}
			}
		}
	})
}
