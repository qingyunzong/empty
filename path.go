package dataeng

import (
	"fmt"
	"strings"
)

type domStep struct {
	tag string
	id  string
}

// parseDOMPath accepts the common crawler spellings "html>body>div[2]>p[3]",
// "/html/body/div[2]/p[3]" and "#article>p:nth-of-type(3)". Numeric sibling
// positions are intentionally discarded: they change when an advertisement or
// navigation node is inserted, which must not look like a body edit.
func parseDOMPath(path string) []domStep {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}
	var parts []string
	if strings.ContainsAny(path, "/>") {
		parts = strings.FieldsFunc(path, func(r rune) bool {
			return r == '/' || r == '>'
		})
	} else {
		// Some crawlers emit descendant paths as "html body article p[2]".
		parts = strings.Fields(path)
	}
	steps := make([]domStep, 0, len(parts))
	for _, raw := range parts {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if strings.HasPrefix(raw, "#") {
			id := strings.TrimSpace(strings.TrimPrefix(raw, "#"))
			if id != "" {
				steps = append(steps, domStep{tag: "*", id: id})
			}
			continue
		}

		step := domStep{}
		if hash := strings.IndexByte(raw, '#'); hash >= 0 {
			idPart := raw[hash+1:]
			if end := strings.IndexAny(idPart, ".:[ "); end >= 0 {
				idPart = idPart[:end]
			}
			step.id = idPart
			raw = raw[:hash]
		}
		if dot := strings.IndexByte(raw, '.'); dot >= 0 {
			raw = raw[:dot]
		}
		if colon := strings.IndexByte(raw, ':'); colon >= 0 {
			raw = raw[:colon]
		}
		if bracket := strings.IndexByte(raw, '['); bracket >= 0 {
			raw = raw[:bracket]
		}
		step.tag = strings.ToLower(strings.TrimSpace(raw))
		if step.tag == "" {
			step.tag = "*"
		}
		steps = append(steps, step)
	}
	return steps
}

func (s domStep) canonical() string {
	if s.id == "" {
		return s.tag
	}
	return s.tag + "#" + s.id
}

func pathKey(steps []domStep) string {
	if len(steps) == 0 {
		return ""
	}
	parts := make([]string, len(steps))
	for i, step := range steps {
		parts[i] = step.canonical()
	}
	return strings.Join(parts, ">")
}

// normalizedContentPaths builds identities for content blocks. Numeric DOM
// indices are replaced by a rank among content siblings with the same tag
// path, so adding, removing or moving an advertisement sibling does not alter
// the identity of the paragraphs around it.
func normalizedContentPaths(blocks []Block) []string {
	out := make([]string, len(blocks))
	ranks := make(map[string]int, len(blocks))
	for i, block := range blocks {
		steps := parseDOMPath(block.Path)
		if len(steps) == 0 {
			continue
		}
		parent := pathKey(steps[:len(steps)-1])
		ranks[parent]++
		out[i] = fmt.Sprintf("%s[%d]", pathKey(steps), ranks[parent])
	}
	return out
}
