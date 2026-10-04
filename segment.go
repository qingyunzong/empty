package tailer

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// segmentName formats a segment id as a file name.
func segmentName(id int) string { return fmt.Sprintf("segment-%06d.log", id) }

// parseSegmentName extracts the segment id from a file name.
func parseSegmentName(name string) (int, bool) {
	if !strings.HasPrefix(name, "segment-") || !strings.HasSuffix(name, ".log") {
		return 0, false
	}
	id, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, "segment-"), ".log"))
	if err != nil || id < 0 {
		return 0, false
	}
	return id, true
}

// listSegments returns the sorted ids of all segment files in dir.
func listSegments(dir string) ([]int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var ids []int
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if id, ok := parseSegmentName(e.Name()); ok {
			ids = append(ids, id)
		}
	}
	sort.Ints(ids)
	return ids, nil
}

// nextSegmentAfter returns the smallest existing segment id greater than id.
func nextSegmentAfter(dir string, id int) (int, bool, error) {
	ids, err := listSegments(dir)
	if err != nil {
		return 0, false, err
	}
	for _, s := range ids {
		if s > id {
			return s, true, nil
		}
	}
	return 0, false, nil
}

func segmentPath(dir string, id int) string { return filepath.Join(dir, segmentName(id)) }
