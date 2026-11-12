package dataeng

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// collect 按给定切块大小喂入 input，收集交付的元素。
// pauseEvery > 0 时每交付 pauseEvery 个元素暂停一次并恢复。
func collect(t *testing.T, input string, maxSize, chunkSize, pauseEvery int) (elems [][]byte, consumed int, err error) {
	t.Helper()
	d := New(maxSize, func(e []byte) error {
		elems = append(elems, append([]byte(nil), e...))
		if pauseEvery > 0 && len(elems)%pauseEvery == 0 {
			return ErrPaused
		}
		return nil
	})
	off := 0
	data := []byte(input)
	for off < len(data) {
		end := off + chunkSize
		if end > len(data) {
			end = len(data)
		}
		chunkLen := end - off
		n, werr := d.Write(data[off:end])
		if n < 0 || n > end-off {
			t.Fatalf("Write returned impossible n=%d (chunk len %d)", n, end-off)
		}
		off += n
		if errors.Is(werr, ErrPaused) {
			// 持续 Resume，直到不再暂停或出错。
			for {
				rerr := d.Resume()
				if rerr == nil {
					break
				}
				if !errors.Is(rerr, ErrPaused) {
					return elems, off, rerr
				}
			}
			continue
		}
		if werr != nil {
			return elems, off, werr
		}
		if n != chunkLen {
			t.Fatalf("non-paused Write consumed %d of %d bytes", n, chunkLen)
		}
	}
	cerr := d.Close()
	return elems, off, cerr
}

func wantElems(wants ...string) [][]byte {
	out := make([][]byte, len(wants))
	for i, w := range wants {
		out[i] = []byte(w)
	}
	return out
}

func joinElems(elems [][]byte) string {
	parts := make([]string, len(elems))
	for i, e := range elems {
		parts[i] = string(e)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// forEverySplit 在切块大小 1..len(input)+1 下重复运行，结果应与切块无关。
func forEverySplit(t *testing.T, input string, maxSize int, check func(t *testing.T, elems [][]byte, err error)) {
	t.Helper()
	for cs := 1; cs <= len(input)+1; cs++ {
		cs := cs
		t.Run(fmt.Sprintf("chunk=%d", cs), func(t *testing.T) {
			elems, _, err := collect(t, input, maxSize, cs, 0)
			check(t, elems, err)
		})
	}
}

func TestBasicElements(t *testing.T) {
	input := `[1, "two", true, false, null, 3.5e-2, [1,2], {"a":1}]`
	want := wantElems("1", `"two"`, "true", "false", "null", "3.5e-2", "[1,2]", `{"a":1}`)
	forEverySplit(t, input, 1<<20, func(t *testing.T, elems [][]byte, err error) {
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !reflect.DeepEqual(elems, want) {
			t.Fatalf("elems = %s, want %s", joinElems(elems), joinElems(want))
		}
	})
}

func TestEmptyArray(t *testing.T) {
	for _, input := range []string{"[]", "[ ]", "[\n\t ]"} {
		forEverySplit(t, input, 1<<20, func(t *testing.T, elems [][]byte, err error) {
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(elems) != 0 {
				t.Fatalf("expected no elements, got %d", len(elems))
			}
		})
	}
}

func TestNestedStructures(t *testing.T) {
	input := `[{"deep":{"arr":[1,{"k":[true,null,"x"]}]}}, [[],[{}]]]`
	want := wantElems(`{"deep":{"arr":[1,{"k":[true,null,"x"]}]}}`, `[[],[{}]]`)
	forEverySplit(t, input, 1<<20, func(t *testing.T, elems [][]byte, err error) {
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !reflect.DeepEqual(elems, want) {
			t.Fatalf("elems = %s, want %s", joinElems(elems), joinElems(want))
		}
	})
}

func TestCrossChunkEscapes(t *testing.T) {
	// 覆盖全部简单转义、\u、代理对与原始多字节 UTF-8；逐字节切块必然跨块。
	input := `["a\"b\\c\/d\b\f\n\r\t\u0041\u00e9\ud83d\ude00\u4e2d"]`
	want := wantElems(`"a\"b\\c\/d\b\f\n\r\t\u0041\u00e9\ud83d\ude00\u4e2d"`)
	forEverySplit(t, input, 1<<20, func(t *testing.T, elems [][]byte, err error) {
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !reflect.DeepEqual(elems, want) {
			t.Fatalf("elems = %s, want %s", joinElems(elems), joinElems(want))
		}
	})
}

func TestRawUTF8(t *testing.T) {
	input := "[\"中文😀\"]"
	want := wantElems("\"中文😀\"")
	forEverySplit(t, input, 1<<20, func(t *testing.T, elems [][]byte, err error) {
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !reflect.DeepEqual(elems, want) {
			t.Fatalf("elems = %s", joinElems(elems))
		}
	})
}

func TestDuplicateKeyRejected(t *testing.T) {
	// 第二个 "k" 的开引号位置即报错偏移。
	input := `[{"k":1,"k":2}]`
	first := strings.Index(input, `"k"`)
	dupOff := strings.Index(input[first+1:], `"k"`) + first + 1
	forEverySplit(t, input, 1<<20, func(t *testing.T, elems [][]byte, err error) {
		var se *SyntaxError
		if !errors.As(err, &se) {
			t.Fatalf("want SyntaxError, got %v", err)
		}
		if se.Offset != dupOff {
			t.Fatalf("offset = %d, want %d (%v)", se.Offset, dupOff, se)
		}
		if len(elems) != 0 {
			t.Fatalf("unfinished element must not be delivered, got %d", len(elems))
		}
	})
}

func TestDuplicateKeyNestedAndEscaped(t *testing.T) {
	// 通过不同转义表达同一逻辑键，仍应判重。
	input := `[{"a\u0041":1,"aA":2}]`
	dupOff := strings.Index(input, `"aA"`)
	forEverySplit(t, input, 1<<20, func(t *testing.T, elems [][]byte, err error) {
		var se *SyntaxError
		if !errors.As(err, &se) || se.Offset != dupOff {
			t.Fatalf("want SyntaxError@%d, got %v", dupOff, err)
		}
	})
}

func TestTrailingData(t *testing.T) {
	forEverySplit(t, "[]x", 1<<20, func(t *testing.T, elems [][]byte, err error) {
		var se *SyntaxError
		if !errors.As(err, &se) || se.Offset != 2 {
			t.Fatalf("want SyntaxError@2, got %v", err)
		}
	})

	// 数组结束后允许空白。
	forEverySplit(t, "[]  \n\t ", 1<<20, func(t *testing.T, elems [][]byte, err error) {
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	// 顶层不是数组：报零偏移。
	forEverySplit(t, `{}`, 1<<20, func(t *testing.T, elems [][]byte, err error) {
		var se *SyntaxError
		if !errors.As(err, &se) || se.Offset != 0 {
			t.Fatalf("want SyntaxError@0, got %v", err)
		}
	})
}

func TestIllegalUTF8(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		off     int
		wantEOF bool
	}{
		{"continuation", "[\"" + string([]byte{0x80}) + "\"]", 2, false},
		{"ff", "[\"" + string([]byte{0xFF}) + "\"]", 2, false},
		{"truncated2", "[\"" + string([]byte{0xC2}), 0, true},
		{"overlong", "[\"" + string([]byte{0xE0, 0x80, 0x80}) + "\"]", 2, false},
		{"surrogate3", "[\"" + string([]byte{0xED, 0xA0, 0x80}) + "\"]", 2, false},
		{"badCont", "[\"" + string([]byte{0xC2, 0x41}) + "\"]", 2, false},
		{"outsideString", "[" + string([]byte{0xC2, 0x80}) + "]", 1, false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			forEverySplit(t, tc.input, 1<<20, func(t *testing.T, elems [][]byte, err error) {
				var se *SyntaxError
				if !errors.As(err, &se) {
					t.Fatalf("want SyntaxError, got %v", err)
				}
				want := tc.off
				if tc.wantEOF {
					want = len(tc.input)
				}
				if se.Offset != want {
					t.Fatalf("offset = %d, want %d (%v)", se.Offset, want, se)
				}
			})
		})
	}
}

func TestIllegalSurrogates(t *testing.T) {
	cases := []string{
		`["\uD800"]`,       // 孤立高代理，闭引号时报
		`["\uDC00"]`,       // 孤立低代理
		`["\uD800\u0041"]`, // 高代理后跟非低代理
		`["\uD800\""]`,     // 高代理后直接遇到引号
		`["\uD800\uDC00"]`, // 合法代理对，作为对照不放在错误列表
	}
	for i, in := range cases {
		in := in
		t.Run(fmt.Sprintf("case%d", i), func(t *testing.T) {
			forEverySplit(t, in, 1<<20, func(t *testing.T, elems [][]byte, err error) {
				if i == len(cases)-1 {
					if err != nil {
						t.Fatalf("valid surrogate pair rejected: %v", err)
					}
					return
				}
				var se *SyntaxError
				if !errors.As(err, &se) {
					t.Fatalf("want SyntaxError, got %v", err)
				}
			})
		})
	}
}

func TestUnexpectedEOFOffsets(t *testing.T) {
	// 输入结束仍缺字节：偏移必须是已输入总长度。
	inputs := []string{
		"[", "[1", `["abc`, `[12.`, `[1e`, `[true`, `[{"a":1}`, `[[`, `[1,`,
		`["\u004`, `["\uD800`,
	}
	for _, in := range inputs {
		in := in
		t.Run(in, func(t *testing.T) {
			forEverySplit(t, in, 1<<20, func(t *testing.T, elems [][]byte, err error) {
				var se *SyntaxError
				if !errors.As(err, &se) || se.Offset != len(in) {
					t.Fatalf("want SyntaxError@%d, got %v", len(in), err)
				}
			})
		})
	}
}

func TestMaxElementSize(t *testing.T) {
	input := `[12345, 1, "abc"]`
	// 首个元素 "12345" 长度 5，超过上限 4。
	forEverySplit(t, input, 4, func(t *testing.T, elems [][]byte, err error) {
		if !errors.Is(err, ErrElementTooLarge) {
			t.Fatalf("want ErrElementTooLarge, got %v", err)
		}
		if len(elems) != 0 {
			t.Fatalf("oversized element must not be delivered, got %d", len(elems))
		}
	})

	// 上限足够时正常交付。
	forEverySplit(t, input, 6, func(t *testing.T, elems [][]byte, err error) {
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(elems) != 3 {
			t.Fatalf("want 3 elements, got %d", len(elems))
		}
	})
}

func TestCallbackErrorTerminates(t *testing.T) {
	myErr := errors.New("boom")
	d := New(1<<20, func(e []byte) error { return myErr })
	if _, err := d.Write([]byte(`[1,2,3]`)); !errors.Is(err, myErr) {
		t.Fatalf("want callback error, got %v", err)
	}
	if _, err := d.Write([]byte(`[1]`)); !errors.Is(err, myErr) {
		t.Fatalf("decoder should stay terminated, got %v", err)
	}
	if err := d.Close(); !errors.Is(err, myErr) {
		t.Fatalf("close should return stored error, got %v", err)
	}
}

func TestPauseResumeNoResend(t *testing.T) {
	input := `[10,20,30,40,50]`
	var got [][]byte
	d := New(1<<20, func(e []byte) error {
		got = append(got, append([]byte(nil), e...))
		return ErrPaused // 每个元素都暂停
	})
	data := []byte(input)
	off := 0
	// 每字节写入。暂停发生在元素后的分隔符上：元素字节已全部消费，分隔符
	// 留在解码器内部（n=0 表示当前块无额外消费）。Resume 后继续喂入后续
	// 新字节，已交付元素绝不重发。
	for off < len(data) {
		n, err := d.Write(data[off : off+1])
		if errors.Is(err, ErrPaused) {
			before := len(got)
			if rerr := d.Resume(); rerr != nil && !errors.Is(rerr, ErrPaused) {
				t.Fatalf("resume error: %v", rerr)
			}
			if len(got) != before {
				t.Fatalf("resume must not redeliver elements")
			}
			// 当前字节（分隔符）已在解码器内部，跳过它，继续后续字节。
			off++
			continue
		}
		if err != nil {
			t.Fatalf("write error: %v", err)
		}
		off += n
	}
	if err := d.Close(); err != nil {
		t.Fatalf("close error: %v", err)
	}
	want := wantElems("10", "20", "30", "40", "50")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %s, want %s", joinElems(got), joinElems(want))
	}
}

func TestPauseWithChunksAndResumeNewData(t *testing.T) {
	// 第一次写入在第二个元素处暂停；未消费尾部由解码器内部保留，恢复后
	// 调用方只写入全新字节，验证跨调用消费计数与“不重发”。
	first := []byte(`[1,2,3`)
	rest := []byte(`,4,5]`)
	var got [][]byte
	d := New(1<<20, func(e []byte) error {
		got = append(got, append([]byte(nil), e...))
		if string(e) == "2" {
			return ErrPaused
		}
		return nil
	})
	n, err := d.Write(first)
	if !errors.Is(err, ErrPaused) {
		t.Fatalf("want pause, got %v", err)
	}
	// 已交付 1、2；n 指向 "2" 之后，first[n:] 未消费并由解码器保留。
	if string(first[n:]) != ",3" {
		t.Fatalf("unconsumed tail = %q, want %q", first[n:], ",3")
	}
	if len(got) != 2 || string(got[0]) != "1" || string(got[1]) != "2" {
		t.Fatalf("delivered before resume = %s", joinElems(got))
	}
	if err := d.Resume(); err != nil {
		t.Fatalf("resume without new data: %v", err)
	}
	// 恢复后只写入全新字节；first[n:] 已在解码器内部，不得重发。
	n2, err := d.Write(rest)
	if err != nil {
		t.Fatalf("second write: %v", err)
	}
	if n2 != len(rest) {
		t.Fatalf("second write consumed %d, want %d", n2, len(rest))
	}
	if err := d.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	want := wantElems("1", "2", "3", "4", "5")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %s, want %s", joinElems(got), joinElems(want))
	}
}

func TestDeliveredKeptOnLaterError(t *testing.T) {
	// 第一个元素正常交付，第二个元素语法错误：已交付元素保留。
	input := `[1, {"k":1,"k":2}]`
	firstKey := strings.Index(input, `"k"`)
	dupOff := strings.Index(input[firstKey+1:], `"k"`) + firstKey + 1
	var got [][]byte
	d := New(1<<20, func(e []byte) error {
		got = append(got, append([]byte(nil), e...))
		return nil
	})
	// 逐字节喂入。
	data := []byte(input)
	var finalErr error
	for i := range data {
		_, finalErr = d.Write(data[i : i+1])
		if finalErr != nil {
			break
		}
	}
	if finalErr == nil {
		finalErr = d.Close()
	}
	var se *SyntaxError
	if !errors.As(finalErr, &se) || se.Offset != dupOff {
		t.Fatalf("want SyntaxError@%d, got %v", dupOff, finalErr)
	}
	if len(got) != 1 || string(got[0]) != "1" {
		t.Fatalf("already delivered element must be kept, got %s", joinElems(got))
	}
}
