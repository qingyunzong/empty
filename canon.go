package jsoncanon

import (
	"io"
	"sort"
	"strconv"
	"strings"
)

// SpanEntry maps a value in the canonical output (by JSON Pointer path)
// to its byte span in the original source.
type SpanEntry struct {
	Path  string `json:"path"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

// Options controls canonicalization.
type Options struct {
	// MemBudget is the maximum number of bytes a single object may use for
	// in-memory key sorting. Objects whose estimated size exceeds the
	// budget are sorted externally via temporary files. <= 0 means
	// unlimited (always in memory).
	MemBudget int64
	// TempDir holds external-sort temporary files. Empty means a fresh
	// directory under os.TempDir.
	TempDir string
	// CollectSpans enables source-span collection.
	CollectSpans bool

	// Checkpointing / pause / resume (root object only).
	StatePath          string   // where to persist checkpoint state; "" disables
	InputHash          string   // hex SHA-256 of the original input
	ReuseSegments      []string // segment files from a previous paused run
	PauseAfterSegments int      // if > 0, return ErrPaused after writing this many new segments
}

// Result carries by-products of canonicalization.
type Result struct {
	Spans []SpanEntry
}

// WriteCanonical writes the strict-JSON canonical form of v to w: object
// keys sorted by UTF-8 byte order, no insignificant whitespace, numbers
// preserved as exact decimal literals. Duplicate keys are rejected.
func WriteCanonical(w io.Writer, v *Value, opts *Options) (*Result, error) {
	if opts == nil {
		opts = &Options{}
	}
	c := &cw{opts: opts, res: &Result{}}
	if err := c.writeValue(w, v, "", true); err != nil {
		return nil, err
	}
	return c.res, nil
}

// Canonicalize is the in-memory convenience form of WriteCanonical.
func Canonicalize(v *Value, opts *Options) ([]byte, *Result, error) {
	var sb strings.Builder
	res, err := WriteCanonical(&sb, v, opts)
	if err != nil {
		return nil, nil, err
	}
	return []byte(sb.String()), res, nil
}

type cw struct {
	opts *Options
	res  *Result
}

func (c *cw) recordSpan(path string, sp Span) {
	if c.opts.CollectSpans {
		c.res.Spans = append(c.res.Spans, SpanEntry{Path: path, Start: sp.Start, End: sp.End})
	}
}

func escapePointer(seg string) string {
	s := strings.ReplaceAll(seg, "~", "~0")
	return strings.ReplaceAll(s, "/", "~1")
}

func (c *cw) writeValue(w io.Writer, v *Value, path string, root bool) error {
	c.recordSpan(path, v.Span)
	switch v.Kind {
	case KindNull:
		_, err := io.WriteString(w, "null")
		return err
	case KindBool:
		if v.Bool {
			_, err := io.WriteString(w, "true")
			return err
		}
		_, err := io.WriteString(w, "false")
		return err
	case KindNumber:
		_, err := io.WriteString(w, v.Num)
		return err
	case KindString:
		return writeJSONString(w, v.Str)
	case KindArray:
		if _, err := io.WriteString(w, "["); err != nil {
			return err
		}
		for i, el := range v.Arr {
			if i > 0 {
				if _, err := io.WriteString(w, ","); err != nil {
					return err
				}
			}
			if err := c.writeValue(w, el, path+"/"+strconv.Itoa(i), false); err != nil {
				return err
			}
		}
		_, err := io.WriteString(w, "]")
		return err
	case KindObject:
		return c.writeObject(w, v, path, root)
	}
	return nil
}

func (c *cw) writeObject(w io.Writer, v *Value, path string, root bool) error {
	budget := c.opts.MemBudget
	if budget <= 0 || estimateObjectSize(v) <= budget {
		return c.writeObjectMem(w, v, path)
	}
	return c.writeObjectExt(w, v, path, root)
}

func (c *cw) writeObjectMem(w io.Writer, v *Value, path string) error {
	members := make([]Member, len(v.Obj))
	copy(members, v.Obj)
	sort.Slice(members, func(i, j int) bool {
		return members[i].Key < members[j].Key // string < compares UTF-8 bytes
	})
	for i := 1; i < len(members); i++ {
		if members[i-1].Key == members[i].Key {
			return &DuplicateKeyError{Key: members[i].Key}
		}
	}
	if _, err := io.WriteString(w, "{"); err != nil {
		return err
	}
	for i, m := range members {
		if i > 0 {
			if _, err := io.WriteString(w, ","); err != nil {
				return err
			}
		}
		if err := writeJSONString(w, m.Key); err != nil {
			return err
		}
		if _, err := io.WriteString(w, ":"); err != nil {
			return err
		}
		if err := c.writeValue(w, m.Value, path+"/"+escapePointer(m.Key), false); err != nil {
			return err
		}
	}
	_, err := io.WriteString(w, "}")
	return err
}

// estimateObjectSize approximates the canonical byte size of an object.
func estimateObjectSize(v *Value) int64 {
	var n int64 = 2
	for _, m := range v.Obj {
		n += int64(len(m.Key)) + 3 + estimateValueSize(m.Value)
	}
	return n
}

func estimateValueSize(v *Value) int64 {
	switch v.Kind {
	case KindNull:
		return 4
	case KindBool:
		return 5
	case KindNumber:
		return int64(len(v.Num))
	case KindString:
		return int64(len(v.Str)) + 2
	case KindArray:
		var n int64 = 2
		for _, el := range v.Arr {
			n += estimateValueSize(el) + 1
		}
		return n
	case KindObject:
		return estimateObjectSize(v)
	}
	return 0
}

// writeJSONString writes s as a canonical JSON string: only the mandatory
// escapes plus \u00XX for other control characters.
func writeJSONString(w io.Writer, s string) error {
	var buf []byte
	buf = append(buf, '"')
	for _, r := range s {
		switch r {
		case '"':
			buf = append(buf, '\\', '"')
		case '\\':
			buf = append(buf, '\\', '\\')
		case '\b':
			buf = append(buf, '\\', 'b')
		case '\f':
			buf = append(buf, '\\', 'f')
		case '\n':
			buf = append(buf, '\\', 'n')
		case '\r':
			buf = append(buf, '\\', 'r')
		case '\t':
			buf = append(buf, '\\', 't')
		default:
			if r < 0x20 {
				const hex = "0123456789abcdef"
				buf = append(buf, '\\', 'u', '0', '0', hex[byte(r)>>4], hex[byte(r)&0xf])
			} else {
				buf = append(buf, string(r)...)
			}
		}
	}
	buf = append(buf, '"')
	_, err := w.Write(buf)
	return err
}
