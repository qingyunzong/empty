package norm

import "fmt"

// Error describes a parse or normalization failure tied to a source span.
// Start and End are byte offsets into the input (End == 0 means a point
// span at Start).
type Error struct {
	Msg   string
	Start int
	End   int
	src   []byte
}

func (e *Error) Error() string {
	line, col := lineCol(e.src, e.Start)
	return fmt.Sprintf("line %d, column %d (offset %d): %s", line, col, e.Start, e.Msg)
}

// Span returns the byte-offset span of the error within the source.
func (e *Error) Span() (start, end int) { return e.Start, e.End }

func lineCol(src []byte, off int) (line, col int) {
	if off > len(src) {
		off = len(src)
	}
	if off < 0 {
		off = 0
	}
	line, col = 1, 1
	for i := 0; i < off; i++ {
		if src[i] == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	return line, col
}
