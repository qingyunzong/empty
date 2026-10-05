package streamlex

import (
	"errors"
	"math/rand"
	"slices"
	"testing"
)

// stringsOfLen 枚举 alphabet 上全体长度为 n 的串。
func stringsOfLen(alphabet string, n int) []string {
	if n == 0 {
		return []string{""}
	}
	var out []string
	var rec func(cur []byte, k int)
	rec = func(cur []byte, k int) {
		if k == n {
			out = append(out, string(cur))
			return
		}
		for i := 0; i < len(alphabet); i++ {
			rec(append(cur, alphabet[i]), k+1)
		}
	}
	rec(nil, 0)
	return out
}

// runChunked 按 mask 把 s 切块喂给流式分析器：第 i 位置位表示在 i 之后切开。
func runChunked(rules []Rule, s string, mask uint64) ([]Token, error) {
	lx := New(rules...)
	var got []Token
	start := 0
	for i := 0; i < len(s); i++ {
		if i == len(s)-1 || mask&(1<<uint(i)) != 0 {
			toks, err := lx.Feed([]byte(s[start : i+1]))
			got = append(got, toks...)
			if err != nil {
				return got, err
			}
			start = i + 1
		}
	}
	toks, err := lx.End()
	return append(got, toks...), err
}

func errOffset(err error) int {
	if err == nil {
		return -1
	}
	var lexErr *Error
	if errors.As(err, &lexErr) {
		return lexErr.Offset
	}
	return -2
}

// checkChunkings 对单个输入枚举全部 2^(n-1) 种切块，逐一与全串匹配对照。
func checkChunkings(t *testing.T, rules []Rule, s string) {
	t.Helper()
	want, wantErr := LexAll(rules, []byte(s))
	cuts := 1
	if n := len(s); n > 1 {
		cuts = 1 << uint(n-1)
	}
	for mask := 0; mask < cuts; mask++ {
		got, gotErr := runChunked(rules, s, uint64(mask))
		if !slices.Equal(got, want) || errOffset(gotErr) != errOffset(wantErr) {
			t.Fatalf("input %q mask %b:\nstream  = %v, err %v\nlexall  = %v, err %v",
				s, mask, got, gotErr, want, wantErr)
		}
	}
}

// TestExhaustive 枚举短输入与全部切块方式，验证流式结果与全串匹配一致。
func TestExhaustive(t *testing.T) {
	cases := []struct {
		name     string
		rules    []Rule
		alphabet string
		maxLen   int
	}{
		{"literals", rulesetA(), "abc", 7},
		{"keyword-vs-ident", rulesetB(), "abfiz", 5},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			checked := 0
			for n := 0; n <= tc.maxLen; n++ {
				for _, s := range stringsOfLen(tc.alphabet, n) {
					checkChunkings(t, tc.rules, s)
					checked++
				}
			}
			t.Logf("checked %d inputs x all chunkings", checked)
		})
	}
}

// TestRandomizedLongInputs 以固定种子对较长输入做随机切块对照。
func TestRandomizedLongInputs(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for _, rules := range [][]Rule{rulesetA(), rulesetB()} {
		alphabet := "abc"
		if rules[1].Name == "ident" {
			alphabet = "abfiz"
		}
		for iter := 0; iter < 2000; iter++ {
			n := rng.Intn(200)
			buf := make([]byte, n)
			for i := range buf {
				buf[i] = alphabet[rng.Intn(len(alphabet))]
			}
			s := string(buf)
			want, wantErr := LexAll(rules, buf)

			lx := New(rules...)
			var got []Token
			var gotErr error
			for start := 0; start < n && gotErr == nil; {
				end := start + 1 + rng.Intn(17)
				if end > n {
					end = n
				}
				var toks []Token
				toks, gotErr = lx.Feed([]byte(s[start:end]))
				got = append(got, toks...)
				start = end
			}
			if gotErr == nil {
				var toks []Token
				toks, gotErr = lx.End()
				got = append(got, toks...)
			}
			if !slices.Equal(got, want) || errOffset(gotErr) != errOffset(wantErr) {
				t.Fatalf("input %q:\nstream = %v, err %v\nlexall = %v, err %v",
					s, got, gotErr, want, wantErr)
			}
		}
	}
}
