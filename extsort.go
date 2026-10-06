package jsoncanon

import (
	"container/heap"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

// ErrPaused is returned when a run checkpoints itself and pauses so it can
// be resumed later (see Options.PauseAfterSegments).
var ErrPaused = errors.New("jsoncanon: paused after checkpoint")

// extEntry is one object member in the external sort: its key plus the
// location of its already-canonicalized value bytes and relative spans.
type extEntry struct {
	Key     string `json:"key"`
	ValOff  int64  `json:"valOff"`
	ValLen  int64  `json:"valLen"`
	SpanOff int64  `json:"spanOff"`
	SpanLen int64  `json:"spanLen"`
}

// checkpointState is persisted so a paused run can be resumed. The original
// input hash must match on resume.
type checkpointState struct {
	InputHash string   `json:"inputHash"`
	MemBudget int64    `json:"memBudget"`
	TempDir   string   `json:"tempDir"`
	Segments  []string `json:"segments"`
}

// extSorter canonicalizes one large object with an external sort.
type extSorter struct {
	c        *cw
	dir      string // temp dir for this object
	vals     *os.File
	spans    *os.File
	segBuf   []extEntry
	segBytes int64
	segments []string
	segIndex int
	newSegs  int
	root     bool
}

// writeObjectExt canonicalizes each member value into temp files, sorts
// keys in bounded-memory segments, then k-way merges them in UTF-8 byte
// order. Duplicate keys are detected across segment boundaries at merge
// time.
func (c *cw) writeObjectExt(w io.Writer, v *Value, path string, root bool) error {
	dir := c.opts.TempDir
	if dir == "" {
		d, err := os.MkdirTemp("", "jsoncanon-")
		if err != nil {
			return err
		}
		dir = d
		if c.opts.StatePath == "" {
			defer os.RemoveAll(dir)
		}
	} else if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var objDir string
	if root {
		// Deterministic name so a resumed run reuses the same directory.
		objDir = filepath.Join(dir, "root-obj")
		if err := os.MkdirAll(objDir, 0o755); err != nil {
			return err
		}
	} else {
		var err error
		objDir, err = os.MkdirTemp(dir, "obj-")
		if err != nil {
			return err
		}
	}
	keep := root && c.opts.StatePath != ""
	if !keep {
		defer os.RemoveAll(objDir)
	}

	s := &extSorter{c: c, dir: objDir, root: root}
	var err error
	if s.vals, err = os.Create(filepath.Join(objDir, "vals.bin")); err != nil {
		return err
	}
	defer s.vals.Close()
	if s.spans, err = os.Create(filepath.Join(objDir, "spans.bin")); err != nil {
		return err
	}
	defer s.spans.Close()

	for i := range v.Obj {
		if err := s.addMember(&v.Obj[i]); err != nil {
			return err
		}
	}
	if err := s.flush(); err != nil {
		return err
	}

	if _, err := io.WriteString(w, "{"); err != nil {
		return err
	}
	if err := s.mergeEmit(w, path); err != nil {
		return err
	}
	_, err = io.WriteString(w, "}")
	return err
}

// addMember canonicalizes one member value into the temp files and buffers
// its entry for the current segment.
func (s *extSorter) addMember(m *Member) error {
	// Canonicalize the member value with a sub-collector so its spans are
	// recorded relative to the value root ("").
	sub := &cw{opts: &Options{
		MemBudget: s.c.opts.MemBudget,
		TempDir:   s.dir,
	}, res: &Result{}}
	if s.c.opts.CollectSpans {
		sub.opts.CollectSpans = true
	}
	valOff, err := s.vals.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	if err := sub.writeValue(s.vals, m.Value, "", false); err != nil {
		return err
	}
	valEnd, err := s.vals.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}

	e := extEntry{Key: m.Key, ValOff: valOff, ValLen: valEnd - valOff}
	if s.c.opts.CollectSpans {
		spanBytes, err := json.Marshal(sub.res.Spans)
		if err != nil {
			return err
		}
		spanOff, err := s.spans.Seek(0, io.SeekCurrent)
		if err != nil {
			return err
		}
		if _, err := s.spans.Write(spanBytes); err != nil {
			return err
		}
		e.SpanOff = spanOff
		e.SpanLen = int64(len(spanBytes))
	}
	s.segBuf = append(s.segBuf, e)
	s.segBytes += int64(len(e.Key)) + e.ValLen + 64
	if budget := s.c.opts.MemBudget; budget > 0 && s.segBytes >= budget {
		return s.flush()
	}
	return nil
}

// flush sorts the buffered entries and writes them as one segment file,
// checkpointing after each segment. On resume, already-checkpointed
// segments are reused instead of rewritten.
func (s *extSorter) flush() error {
	if len(s.segBuf) == 0 {
		return nil
	}
	reuse := s.root && s.c.opts.ReuseSegments != nil
	if reuse && s.segIndex < len(s.c.opts.ReuseSegments) {
		seg := s.c.opts.ReuseSegments[s.segIndex]
		if _, err := os.Stat(seg); err != nil {
			return fmt.Errorf("resume: segment %s: %w", seg, err)
		}
		s.segments = append(s.segments, seg)
		s.segIndex++
		s.segBuf = s.segBuf[:0]
		s.segBytes = 0
		return nil
	}

	sort.Slice(s.segBuf, func(i, j int) bool { return s.segBuf[i].Key < s.segBuf[j].Key })
	segPath := filepath.Join(s.dir, fmt.Sprintf("seg-%05d.jsonl", s.segIndex))
	f, err := os.Create(segPath)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(f)
	for _, e := range s.segBuf {
		if err := enc.Encode(e); err != nil {
			f.Close()
			return err
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	s.segments = append(s.segments, segPath)
	s.segIndex++
	s.newSegs++
	s.segBuf = s.segBuf[:0]
	s.segBytes = 0

	if s.root && s.c.opts.StatePath != "" {
		state := checkpointState{
			InputHash: s.c.opts.InputHash,
			MemBudget: s.c.opts.MemBudget,
			TempDir:   s.c.opts.TempDir,
			Segments:  append([]string(nil), s.segments...),
		}
		if err := writeStateFile(s.c.opts.StatePath, &state); err != nil {
			return err
		}
		if n := s.c.opts.PauseAfterSegments; n > 0 && s.newSegs >= n {
			return ErrPaused
		}
	}
	return nil
}

// segReader streams entries from one segment file.
type segReader struct {
	f   *os.File
	dec *json.Decoder
	cur extEntry
	ok  bool
}

func (r *segReader) next() error {
	var e extEntry
	if err := r.dec.Decode(&e); err != nil {
		if err == io.EOF {
			r.ok = false
			return nil
		}
		return err
	}
	r.cur = e
	r.ok = true
	return nil
}

type mergeHeap []*segReader

func (h mergeHeap) Len() int           { return len(h) }
func (h mergeHeap) Less(i, j int) bool { return h[i].cur.Key < h[j].cur.Key }
func (h mergeHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *mergeHeap) Push(x any)        { *h = append(*h, x.(*segReader)) }
func (h *mergeHeap) Pop() any {
	old := *h
	n := len(old)
	r := old[n-1]
	*h = old[:n-1]
	return r
}

// mergeEmit k-way merges the sorted segments, rejects duplicate keys across
// segment boundaries, and writes the members in sorted order.
func (s *extSorter) mergeEmit(w io.Writer, path string) error {
	readers := make([]*segReader, 0, len(s.segments))
	for _, seg := range s.segments {
		f, err := os.Open(seg)
		if err != nil {
			return err
		}
		defer f.Close()
		r := &segReader{f: f, dec: json.NewDecoder(f)}
		if err := r.next(); err != nil {
			return err
		}
		readers = append(readers, r)
	}
	h := mergeHeap(nil)
	for _, r := range readers {
		if r.ok {
			heap.Push(&h, r)
		}
	}

	prev := ""
	first := true
	count := 0
	for h.Len() > 0 {
		r := h[0]
		e := r.cur
		if !first && e.Key == prev {
			return &DuplicateKeyError{Key: e.Key}
		}
		first = false
		prev = e.Key

		if count > 0 {
			if _, err := io.WriteString(w, ","); err != nil {
				return err
			}
		}
		if err := writeJSONString(w, e.Key); err != nil {
			return err
		}
		if _, err := io.WriteString(w, ":"); err != nil {
			return err
		}
		if _, err := io.Copy(w, io.NewSectionReader(s.vals, e.ValOff, e.ValLen)); err != nil {
			return err
		}
		memberPath := path + "/" + escapePointer(e.Key)
		if s.c.opts.CollectSpans {
			if err := s.emitSpans(e, memberPath); err != nil {
				return err
			}
		}
		count++

		if err := r.next(); err != nil {
			return err
		}
		if r.ok {
			heap.Fix(&h, 0)
		} else {
			heap.Pop(&h)
		}
	}
	return nil
}

// emitSpans reads the member's relative spans and re-roots them at
// memberPath in the global span list.
func (s *extSorter) emitSpans(e extEntry, memberPath string) error {
	buf := make([]byte, e.SpanLen)
	if _, err := s.spans.ReadAt(buf, e.SpanOff); err != nil {
		return err
	}
	var rel []SpanEntry
	if err := json.Unmarshal(buf, &rel); err != nil {
		return err
	}
	for _, se := range rel {
		s.c.res.Spans = append(s.c.res.Spans, SpanEntry{
			Path:  memberPath + se.Path,
			Start: se.Start,
			End:   se.End,
		})
	}
	return nil
}

func writeStateFile(path string, st *checkpointState) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readStateFile(path string) (*checkpointState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var st checkpointState
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, fmt.Errorf("invalid state file: %w", err)
	}
	return &st, nil
}
