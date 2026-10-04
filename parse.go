package cfg

import (
	"fmt"
	"os"
	"strings"
)

// RawSection is a section as parsed from the file, before inheritance
// resolution and interpolation.
type RawSection struct {
	Name     string
	Parents  []string // inheritance targets, in listed order
	Own      map[string]string
	OwnOrder []string
}

// ParseFile reads and parses a config file.
func ParseFile(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(string(data))
}

// Parse parses INI-style config text.
//
//	[section]
//	inherit = parent1, parent2
//	key = value with ${other} and ${section.field} references
//
// Lines starting with '#' or ';' are comments. The key "inherit" is a
// directive listing parent sections and is not a field.
func Parse(text string) (*Config, error) {
	c := &Config{raw: map[string]*RawSection{}}
	var cur *RawSection
	for lineno, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			if !strings.HasSuffix(line, "]") {
				return nil, fmt.Errorf("line %d: malformed section header %q", lineno+1, line)
			}
			name := strings.TrimSpace(line[1 : len(line)-1])
			if name == "" {
				return nil, fmt.Errorf("line %d: empty section name", lineno+1)
			}
			if _, dup := c.raw[name]; dup {
				return nil, fmt.Errorf("line %d: duplicate section %q", lineno+1, name)
			}
			cur = &RawSection{Name: name, Own: map[string]string{}}
			c.raw[name] = cur
			c.order = append(c.order, name)
			continue
		}
		if cur == nil {
			return nil, fmt.Errorf("line %d: key outside any section", lineno+1)
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("line %d: expected key = value, got %q", lineno+1, line)
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if key == "inherit" {
			for _, p := range strings.Split(value, ",") {
				if p = strings.TrimSpace(p); p != "" {
					cur.Parents = append(cur.Parents, p)
				}
			}
			continue
		}
		if _, dup := cur.Own[key]; dup {
			return nil, fmt.Errorf("line %d: duplicate key %q in section %q", lineno+1, key, cur.Name)
		}
		cur.Own[key] = value
		cur.OwnOrder = append(cur.OwnOrder, key)
	}
	return c, nil
}
