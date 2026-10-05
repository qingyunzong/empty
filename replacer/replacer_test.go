package replacer

import (
	"reflect"
	"testing"
)

func TestLongestMatch(t *testing.T) {
	d := NewDict(
		Entry{Key: "ab", Value: "X"},
		Entry{Key: "abc", Value: "Y"},
		Entry{Key: "b", Value: "Z"},
	)
	cases := map[string]string{
		"abc":  "Y",
		"abcd": "Yd",
		"abx":  "Xx",
		"b":    "Z",
		"abbc": "XZc",
		"xyz":  "xyz",
		"":     "",
	}
	for in, want := range cases {
		if got := ReplaceString(d, in); got != want {
			t.Errorf("ReplaceString(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPriorityOnSameKey(t *testing.T) {
	d := NewDict(
		Entry{Key: "go", Value: "低", Priority: 1},
		Entry{Key: "go", Value: "高", Priority: 10},
		Entry{Key: "go", Value: "中", Priority: 5},
	)
	if got := ReplaceString(d, "go!"); got != "高!" {
		t.Errorf("got %q, want %q", got, "高!")
	}
	// 与加入顺序无关
	d2 := NewDict(
		Entry{Key: "go", Value: "高", Priority: 10},
		Entry{Key: "go", Value: "低", Priority: 1},
	)
	if got := ReplaceString(d2, "go"); got != "高" {
		t.Errorf("got %q, want %q", got, "高")
	}
}

func TestReplacementNotRescanned(t *testing.T) {
	d := NewDict(
		Entry{Key: "a", Value: "b"},
		Entry{Key: "b", Value: "c"},
		Entry{Key: "bb", Value: "W"},
	)
	if got := ReplaceString(d, "a"); got != "b" {
		t.Errorf("got %q, want %q（替换串不应再扫描）", got, "b")
	}
	if got := ReplaceString(d, "aa"); got != "bb" {
		t.Errorf("got %q, want %q（替换产物的 bb 不应命中 W）", got, "bb")
	}
}

func TestUnicodeIntervals(t *testing.T) {
	d := NewDict(
		Entry{Key: "你", Value: "您"},
		Entry{Key: "你好", Value: "Hello"},
	)
	pieces := Replace(d, "a你好b")
	want := []Piece{
		{Text: "a", Start: 0, End: 1},
		{Text: "Hello", Start: 1, End: 3, Replaced: true},
		{Text: "b", Start: 3, End: 4},
	}
	if !reflect.DeepEqual(pieces, want) {
		t.Errorf("pieces = %+v, want %+v", pieces, want)
	}
}

func TestEmptyKeyIgnored(t *testing.T) {
	d := NewDict(Entry{Key: "", Value: "X"}, Entry{Key: "a", Value: "A"})
	if got := ReplaceString(d, "ab"); got != "Ab" {
		t.Errorf("got %q, want %q", got, "Ab")
	}
}

func TestNilDictPassthrough(t *testing.T) {
	st := NewStream()
	st.Write("hello")
	if got := Join(st.Flush()); got != "hello" {
		t.Errorf("got %q, want %q", got, "hello")
	}
}
