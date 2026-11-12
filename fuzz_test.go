package dataeng

import (
	stdjson "encoding/json"
	"math/rand"
	"testing"
)

// TestRandomChunksDifferential 用多种合法 JSON、随机切块喂入解码器，并与
// 标准库对照：每个交付元素都必须能被标准库独立解析，且元素数量与顶层一致。
func TestRandomChunksDifferential(t *testing.T) {
	inputs := []string{
		`[]`,
		`[1]`,
		`[1,2,3,4,5]`,
		`["a","b","c"]`,
		`[true,false,null,0,-1,3.14,1e10,-2.5E-3]`,
		`[[],[1],[1,2],{"k":"v"},{"a":{"b":[true,null,{}]}}]`,
		`["esc\"\\\/\b\f\n\r\t\u0041\ud83d\ude00"]`,
		"[\"中文\",\"\u00e9\",\"😀\"]",
		`[ 1 , 2 , { "x" : [ ] } ]`,
	}
	rng := rand.New(rand.NewSource(42))
	for seed := 0; seed < 200; seed++ {
		input := inputs[seed%len(inputs)]
		var want []stdjson.RawMessage
		if err := stdjson.Unmarshal([]byte(input), &want); err != nil {
			t.Fatalf("bad fixture %q: %v", input, err)
		}

		var got [][]byte
		d := New(1<<20, func(e []byte) error {
			got = append(got, append([]byte(nil), e...))
			return nil
		})
		data := []byte(input)
		off := 0
		for off < len(data) {
			step := 1 + rng.Intn(4)
			end := off + step
			if end > len(data) {
				end = len(data)
			}
			n, err := d.Write(data[off:end])
			if err != nil {
				t.Fatalf("seed=%d input=%q write err: %v", seed, input, err)
			}
			off += n
		}
		if err := d.Close(); err != nil {
			t.Fatalf("seed=%d input=%q close err: %v", seed, input, err)
		}
		if len(got) != len(want) {
			t.Fatalf("seed=%d input=%q count=%d want=%d", seed, input, len(got), len(want))
		}
		for i := range want {
			if !rawEqual(got[i], []byte(want[i])) {
				t.Fatalf("seed=%d input=%q elem %d = %s, want %s",
					seed, input, i, got[i], want[i])
			}
		}
	}
}

// rawEqual 比较两段 JSON 在语义上是否相等（忽略空白差异）。
func rawEqual(a, b []byte) bool {
	var va, vb any
	if err := stdjson.Unmarshal(a, &va); err != nil {
		return false
	}
	if err := stdjson.Unmarshal(b, &vb); err != nil {
		return false
	}
	ca, _ := stdjson.Marshal(va)
	cb, _ := stdjson.Marshal(vb)
	return string(ca) == string(cb)
}
