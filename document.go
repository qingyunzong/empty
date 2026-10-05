package bracketdiag

import (
	"errors"
	"fmt"
	"strings"
)

// line 缓存一行的词法结果：行首状态、行内括号 token（相对行首偏移）
// 以及行尾状态（即下一行的行首状态）。
type line struct {
	text   string
	start  State
	end    State
	tokens []Token
}

// Document 维护一份可增量编辑的源码文本及其括号诊断。
// 编辑后仅从首个受影响的行开始重新词法扫描；一旦某行的内容与行首
// 状态都与缓存一致，后续行直接复用缓存，结果与全量扫描一致。
type Document struct {
	lines   []line
	offsets []int // 每行起始字节偏移
	diag    Diagnostics
}

// NewDocument 以全量扫描构建文档。
func NewDocument(text string) *Document {
	d := &Document{}
	d.rebuild(text)
	return d
}

func (d *Document) rebuild(text string) {
	texts := splitLines(text)
	d.lines = make([]line, len(texts))
	d.offsets = make([]int, len(texts))
	st := StateNormal
	off := 0
	for i, lt := range texts {
		toks, end := lexLine(lt, st)
		d.lines[i] = line{text: lt, start: st, end: end, tokens: toks}
		d.offsets[i] = off
		st = end
		off += len(lt) + 1
	}
	d.diag = d.analyze()
}

// Text 返回当前完整文本。
func (d *Document) Text() string {
	var sb strings.Builder
	for i, l := range d.lines {
		if i > 0 {
			sb.WriteByte('\n')
		}
		sb.WriteString(l.text)
	}
	return sb.String()
}

// Len 返回文本字节数。
func (d *Document) Len() int {
	n := 0
	for _, l := range d.lines {
		n += len(l.text) + 1
	}
	if n > 0 {
		n--
	}
	return n
}

// Edit 以 text 替换字节区间 [start, end)（start == end 为插入，
// text 为空为删除），并增量更新词法状态与诊断结果。
func (d *Document) Edit(start, end int, text string) error {
	full := d.Text()
	if start < 0 || end < start || end > len(full) {
		return fmt.Errorf("bracketdiag: edit range [%d, %d) out of bounds (len %d)", start, end, len(full))
	}
	newText := full[:start] + text + full[end:]

	old := d.lines
	texts := splitLines(newText)
	merged := make([]line, len(texts))
	offsets := make([]int, len(texts))
	st := StateNormal
	off := 0
	for i, lt := range texts {
		if i < len(old) && old[i].text == lt && old[i].start == st {
			merged[i] = old[i]
			st = old[i].end
		} else {
			toks, end := lexLine(lt, st)
			merged[i] = line{text: lt, start: st, end: end, tokens: toks}
			st = end
		}
		offsets[i] = off
		off += len(lt) + 1
	}
	d.lines = merged
	d.offsets = offsets
	d.diag = d.analyze()
	return nil
}

// Diagnostics 返回当前括号诊断结果。
func (d *Document) Diagnostics() Diagnostics {
	return d.diag
}

func (d *Document) analyze() Diagnostics {
	var toks []Token
	for i, l := range d.lines {
		for _, t := range l.tokens {
			t.Pos += d.offsets[i]
			toks = append(toks, t)
		}
	}
	return matchTokens(toks)
}

// Verify 校验增量维护的诊断结果与对当前文本的全量扫描一致。
func (d *Document) Verify() error {
	want := Analyze(d.Text())
	if !equalDiagnostics(d.diag, want) {
		return errors.New("bracketdiag: incremental result differs from full scan")
	}
	return nil
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalDiagnostics(a, b Diagnostics) bool {
	if a.EarliestError != b.EarliestError || len(a.Pairs) != len(b.Pairs) {
		return false
	}
	for i := range a.Pairs {
		if a.Pairs[i] != b.Pairs[i] {
			return false
		}
	}
	return equalInts(a.UnmatchedOpens, b.UnmatchedOpens) &&
		equalInts(a.UnmatchedCloses, b.UnmatchedCloses)
}
