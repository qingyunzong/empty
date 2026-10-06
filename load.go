package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// LoadFile reads segments from a JSONL file (one segment per line) into a
// graph. Segments may appear in any order.
func LoadFile(path string) (*Graph, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	g := NewGraph()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	line := 0
	for sc.Scan() {
		line++
		text := strings.TrimSpace(sc.Text())
		if text == "" {
			continue
		}
		var seg Segment
		if err := json.Unmarshal([]byte(text), &seg); err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		seg.Line = line
		g.Add(seg)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return g, nil
}
