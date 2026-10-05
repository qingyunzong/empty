package streamlex

import (
	"errors"
	"reflect"
	"testing"
)

// rulesetA：三条字面规则互相竞争——"abc" 可延长 "ab"，"ab" 可延长 "a"。
func rulesetA() []Rule {
	return []Rule{
		Literal("ab", "ab"),
		Literal("abc", "abc"),
		Literal("a", "a"),
	}
}

// rulesetB：关键字 "if" 与标识符 [a-z]+ 竞争，同长时声明在前的关键字优先。
func rulesetB() []Rule {
	ident := Rule{Name: "ident", Start: 0, Trans: []map[byte]int32{{}, {}}, Accept: []bool{false, true}}
	for c := byte('a'); c <= 'z'; c++ {
		ident.Trans[0][c] = 1
		ident.Trans[1][c] = 1
	}
	return []Rule{Literal("if", "if"), ident}
}

func feedAll(t *testing.T, lx *Lexer, chunks ...string) ([]Token, error) {
	t.Helper()
	var got []Token
	for _, c := range chunks {
		toks, err := lx.Feed([]byte(c))
		got = append(got, toks...)
		if err != nil {
			return got, err
		}
	}
	toks, err := lx.End()
	return append(got, toks...), err
}

func TestNoEarlyEmitAtChunkBoundary(t *testing.T) {
	lx := New(rulesetA()...)

	// "ab" 已可接受，但仍可能延长为 "abc"：不得提前发 token。
	toks, err := lx.Feed([]byte("ab"))
	if err != nil || len(toks) != 0 {
		t.Fatalf(`after "ab": got %v, %v; want no token`, toks, err)
	}
	// "abc" 落在块尾，仍处流中：保守起见继续等待。
	toks, err = lx.Feed([]byte("c"))
	if err != nil || len(toks) != 0 {
		t.Fatalf(`after "abc": got %v, %v; want no token`, toks, err)
	}
	// 'x' 使所有自动机走入死状态，"abc" 不可能再延长，立即敲定；
	// 随后 'x' 自身无法匹配，报错于偏移 3。
	toks, err = lx.Feed([]byte("x"))
	want := []Token{{Rule: 1, Name: "abc", Pos: 0, Text: "abc"}}
	if !reflect.DeepEqual(toks, want) {
		t.Fatalf("tokens = %v, want %v", toks, want)
	}
	var lexErr *Error
	if !errors.As(err, &lexErr) || lexErr.Offset != 3 {
		t.Fatalf("err = %v, want *Error at offset 3", err)
	}
}

func TestEndDeterminesTail(t *testing.T) {
	lx := New(rulesetA()...)
	if toks, _ := lx.Feed([]byte("ab")); len(toks) != 0 {
		t.Fatalf("token emitted before End: %v", toks)
	}
	// 结束信号到来，"ab" 不可能再延长，此刻才确定尾项。
	toks, err := lx.End()
	want := []Token{{Rule: 0, Name: "ab", Pos: 0, Text: "ab"}}
	if err != nil || !reflect.DeepEqual(toks, want) {
		t.Fatalf("End = %v, %v; want %v", toks, err, want)
	}
}

func TestLongestMatchThenDeclarationOrder(t *testing.T) {
	// 最长匹配胜过声明顺序："abc" 声明在 "ab" 之后仍胜出。
	got, err := feedAll(t, New(rulesetA()...), "abc")
	want := []Token{{Rule: 1, Name: "abc", Pos: 0, Text: "abc"}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf(`"abc" = %v, %v; want %v`, got, err, want)
	}

	// 同长竞争按声明顺序：关键字 "if" 先于标识符。
	got, err = feedAll(t, New(rulesetB()...), "if")
	want = []Token{{Rule: 0, Name: "if", Pos: 0, Text: "if"}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf(`"if" = %v, %v; want %v`, got, err, want)
	}

	// 更长的标识符胜过关键字。
	got, err = feedAll(t, New(rulesetB()...), "ifz")
	want = []Token{{Rule: 1, Name: "ident", Pos: 0, Text: "ifz"}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf(`"ifz" = %v, %v; want %v`, got, err, want)
	}
}

func TestTokenPositions(t *testing.T) {
	got, err := feedAll(t, New(rulesetA()...), "aa", "bca")
	want := []Token{
		{Rule: 2, Name: "a", Pos: 0, Text: "a"},
		{Rule: 1, Name: "abc", Pos: 1, Text: "abc"},
		{Rule: 2, Name: "a", Pos: 4, Text: "a"},
	}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, %v; want %v", got, err, want)
	}
}

func TestErrorOffset(t *testing.T) {
	// 首字节即无可匹配。
	_, err := feedAll(t, New(rulesetA()...), "b")
	var lexErr *Error
	if !errors.As(err, &lexErr) || lexErr.Offset != 0 {
		t.Fatalf(`"b": err = %v, want offset 0`, err)
	}
	// 部分 token 之后的垃圾：已切出的 token 保留，错误定位到 token 起点。
	got, err := feedAll(t, New(rulesetA()...), "abx")
	want := []Token{{Rule: 0, Name: "ab", Pos: 0, Text: "ab"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf(`"abx": tokens = %v, want %v`, got, want)
	}
	if !errors.As(err, &lexErr) || lexErr.Offset != 2 {
		t.Fatalf(`"abx": err = %v, want offset 2`, err)
	}
	// 结束信号时缓冲区只剩无法成 token 的残句。
	_, err = feedAll(t, New(rulesetB()...), "if", "1")
	if !errors.As(err, &lexErr) || lexErr.Offset != 2 {
		t.Fatalf(`"if1": err = %v, want offset 2`, err)
	}
}

func TestClosedAfterEnd(t *testing.T) {
	lx := New(rulesetA()...)
	if _, err := lx.End(); err != nil {
		t.Fatalf("End: %v", err)
	}
	if _, err := lx.Feed([]byte("a")); !errors.Is(err, ErrClosed) {
		t.Fatalf("Feed after End: %v, want ErrClosed", err)
	}
	if _, err := lx.End(); !errors.Is(err, ErrClosed) {
		t.Fatalf("second End: %v, want ErrClosed", err)
	}
}

func TestEmptyInput(t *testing.T) {
	lx := New(rulesetA()...)
	if toks, err := lx.Feed(nil); err != nil || len(toks) != 0 {
		t.Fatalf("Feed(nil) = %v, %v", toks, err)
	}
	if toks, err := lx.End(); err != nil || len(toks) != 0 {
		t.Fatalf("End = %v, %v", toks, err)
	}
}
