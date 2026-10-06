package norm

import (
	"bufio"
	"encoding/json"
	"os"
)

// spanRecord is one line of the NDJSON source-span table emitted with
// -spans. Offsets are byte offsets into the input; lines/columns are
// 1-based.
type spanRecord struct {
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	StartLine int    `json:"startLine"`
	StartCol  int    `json:"startCol"`
	EndLine   int    `json:"endLine"`
	EndCol    int    `json:"endCol"`
}

type spanWriter struct {
	f  *os.File
	bw *bufio.Writer
}

func openSpanWriter(path string, appendMode bool) (*spanWriter, error) {
	flag := os.O_CREATE | os.O_WRONLY
	if appendMode {
		flag |= os.O_APPEND
	} else {
		flag |= os.O_TRUNC
	}
	f, err := os.OpenFile(path, flag, 0o644)
	if err != nil {
		return nil, err
	}
	return &spanWriter{f: f, bw: bufio.NewWriter(f)}, nil
}

func (s *spanWriter) record(src []byte, path, kind string, start, end int) {
	sl, sc := lineCol(src, start)
	el, ec := lineCol(src, end)
	data, err := json.Marshal(spanRecord{
		Path: path, Kind: kind, Start: start, End: end,
		StartLine: sl, StartCol: sc, EndLine: el, EndCol: ec,
	})
	if err != nil {
		return
	}
	s.bw.Write(data)
	s.bw.WriteByte('\n')
}

func (s *spanWriter) close() {
	s.bw.Flush()
	s.f.Sync()
	s.f.Close()
}

func (n *norm) recordSpan(path, kind string, start, end int) {
	if n.spans == nil {
		return
	}
	n.spans.record(n.src, path, kind, start, end)
}
