package dataeng

import (
	stdjson "encoding/json"
	"strings"
	"testing"
)

// TestManyElementsByteWise 用大量混合元素逐字节喂入，确认无状态泄漏、
// 无内存膨胀，且交付结果与标准库一致。
func TestManyElementsByteWise(t *testing.T) {
	var b strings.Builder
	b.WriteByte('[')
	const n = 500
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		switch i % 6 {
		case 0:
			b.WriteString(`{"id":`)
			b.WriteString(itoa(i))
			b.WriteString(`,"tags":["a","b"],"ok":true}`)
		case 1:
			b.WriteString(`["nested",[1,2,3],{"k":"v"}]`)
		case 2:
			b.WriteString(`"str\u00e9\ud83d\ude00"`)
		case 3:
			b.WriteString(itoa(i * 7))
		case 4:
			b.WriteString("true")
		case 5:
			b.WriteString("null")
		}
	}
	b.WriteByte(']')
	input := b.String()

	var want []stdjson.RawMessage
	if err := stdjson.Unmarshal([]byte(input), &want); err != nil {
		t.Fatalf("fixture invalid: %v", err)
	}

	var got [][]byte
	d := New(1<<20, func(e []byte) error {
		got = append(got, append([]byte(nil), e...))
		return nil
	})
	data := []byte(input)
	for i := range data {
		if _, err := d.Write(data[i : i+1]); err != nil {
			t.Fatalf("byte %d: %v", i, err)
		}
	}
	if err := d.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if len(got) != n || len(got) != len(want) {
		t.Fatalf("count got=%d want=%d", len(got), n)
	}
	for i := range want {
		if !rawEqual(got[i], []byte(want[i])) {
			t.Fatalf("elem %d mismatch: %s vs %s", i, got[i], want[i])
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
