package bracketdiag

// Pair 是一对匹配括号的位置（字节偏移）。
type Pair struct {
	Open  int `json:"open"`
	Close int `json:"close"`
}

// Diagnostics 是括号诊断结果。
type Diagnostics struct {
	// Pairs 按右括号出现顺序记录的匹配对。
	Pairs []Pair `json:"pairs"`
	// UnmatchedOpens 是扫描结束后仍未闭合的开括号位置（升序）。
	UnmatchedOpens []int `json:"unmatchedOpens"`
	// UnmatchedCloses 是扫描时无法与栈顶匹配的闭括号位置（升序）。
	UnmatchedCloses []int `json:"unmatchedCloses"`
	// EarliestError 是最早的未配对括号位置：优先取扫描中遇到的第一个
	// 未匹配闭括号；若没有，则取最早的未闭合开括号。无错误时为 -1。
	EarliestError int `json:"earliestError"`
}

type openEntry struct {
	pos  int
	kind BracketKind
}

// matchTokens 对按位置升序的 token 流做栈式匹配。
func matchTokens(toks []Token) Diagnostics {
	d := Diagnostics{EarliestError: -1}
	var stack []openEntry
	for _, t := range toks {
		if t.Open {
			stack = append(stack, openEntry{pos: t.Pos, kind: t.Kind})
			continue
		}
		if n := len(stack); n > 0 && stack[n-1].kind == t.Kind {
			d.Pairs = append(d.Pairs, Pair{Open: stack[n-1].pos, Close: t.Pos})
			stack = stack[:n-1]
		} else {
			d.UnmatchedCloses = append(d.UnmatchedCloses, t.Pos)
			if d.EarliestError == -1 {
				d.EarliestError = t.Pos
			}
		}
	}
	for _, e := range stack {
		d.UnmatchedOpens = append(d.UnmatchedOpens, e.pos)
	}
	if d.EarliestError == -1 && len(d.UnmatchedOpens) > 0 {
		d.EarliestError = d.UnmatchedOpens[0]
	}
	return d
}

// Analyze 对完整文本做全量扫描，返回括号诊断结果。
// 它是增量 Document 结果正确性的参照基准。
func Analyze(text string) Diagnostics {
	var toks []Token
	st := StateNormal
	off := 0
	for _, line := range splitLines(text) {
		lt, end := lexLine(line, st)
		for _, t := range lt {
			t.Pos += off
			toks = append(toks, t)
		}
		st = end
		off += len(line) + 1
	}
	return matchTokens(toks)
}

// splitLines 按 '\n' 切分文本，返回不含换行符的行。
// 空文本返回一个空行；以 '\n' 结尾时末尾有一个空行。
func splitLines(text string) []string {
	lines := []string{}
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			lines = append(lines, text[start:i])
			start = i + 1
		}
	}
	return append(lines, text[start:])
}
