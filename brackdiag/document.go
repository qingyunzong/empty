package brackdiag

import "strings"

// lineInfo caches the lex result of one line.
type lineInfo struct {
	text       string
	startState State
	endState   State
	toks       []Tok // offsets relative to line start
	lexed      bool
}

// Document holds source text and maintains incremental lex results
// so that bracket diagnostics after an edit match a full re-scan.
type Document struct {
	lines []lineInfo
}

// NewDocument returns a Document holding text, fully lexed.
func NewDocument(text string) *Document {
	d := &Document{}
	d.SetText(text)
	return d
}

// SetText replaces the whole content and re-lexes from scratch.
func (d *Document) SetText(text string) {
	parts := strings.Split(text, "\n")
	d.lines = make([]lineInfo, len(parts))
	for i, p := range parts {
		d.lines[i] = lineInfo{text: p}
	}
	d.relexFrom(0)
}

// Text returns the current full text.
func (d *Document) Text() string {
	var b strings.Builder
	for i, li := range d.lines {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(li.text)
	}
	return b.String()
}

// lineOffsets returns the absolute start offset of every line.
func (d *Document) lineOffsets() []int {
	offs := make([]int, len(d.lines))
	pos := 0
	for i, li := range d.lines {
		offs[i] = pos
		pos += len(li.text) + 1 // +1 for '\n'
	}
	return offs
}

// locate converts an absolute offset to (line, column).
func (d *Document) locate(offs []int, off int) (line, col int) {
	line = 0
	for line+1 < len(offs) && offs[line+1] <= off {
		line++
	}
	return line, off - offs[line]
}

// Edit replaces the deleteLen bytes starting at off with insert,
// then re-lexes only the lines whose lexical state may have changed.
// Offsets are clamped to the document bounds.
func (d *Document) Edit(off, deleteLen int, insert string) {
	offs := d.lineOffsets()
	total := 0
	if len(offs) > 0 {
		total = offs[len(offs)-1] + len(d.lines[len(d.lines)-1].text)
	}
	if off < 0 {
		off = 0
	}
	if off > total {
		off = total
	}
	end := off + deleteLen
	if end > total {
		end = total
	}
	if end < off {
		end = off
	}

	sl, sc := d.locate(offs, off)
	el, ec := d.locate(offs, end)

	merged := d.lines[sl].text[:sc] + insert + d.lines[el].text[ec:]
	parts := strings.Split(merged, "\n")
	repl := make([]lineInfo, len(parts))
	for i, p := range parts {
		repl[i] = lineInfo{text: p}
	}

	next := make([]lineInfo, 0, len(d.lines)-(el-sl+1)+len(repl))
	next = append(next, d.lines[:sl]...)
	next = append(next, repl...)
	next = append(next, d.lines[el+1:]...)
	d.lines = next

	d.relexFrom(sl)
}

// relexFrom re-lexes starting at line i, stopping as soon as a line's
// cached result was produced with the same incoming state (the edit no
// longer affects subsequent lexical state).
func (d *Document) relexFrom(i int) {
	st := SNormal
	if i > 0 {
		st = d.lines[i-1].endState
	}
	for ; i < len(d.lines); i++ {
		li := &d.lines[i]
		if li.lexed && li.startState == st {
			return
		}
		li.toks, li.endState = lexLine(li.text, st)
		li.startState = st
		li.lexed = true
		st = li.endState
	}
}

// Tokens returns all bracket tokens with absolute offsets, in order.
func (d *Document) Tokens() []Tok {
	offs := d.lineOffsets()
	var toks []Tok
	for i, li := range d.lines {
		for _, t := range li.toks {
			toks = append(toks, Tok{Off: offs[i] + t.Off, Ch: t.Ch})
		}
	}
	return toks
}

// Diagnostics computes bracket matching for the current text.
func (d *Document) Diagnostics() Diag {
	return Match(d.Tokens())
}
