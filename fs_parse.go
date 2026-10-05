package dirdiff

import (
	"fmt"
	"strconv"
	"strings"
)

// encodeContent serializes an entry as file content.
func encodeContent(e Entry) []byte {
	return []byte(fmt.Sprintf("%s@v%d", e.ID, e.Version))
}

// decodeContent parses file content written by encodeContent.
func decodeContent(data []byte) (id string, version int, err error) {
	s := string(data)
	i := strings.LastIndex(s, "@v")
	if i < 0 {
		return "", 0, fmt.Errorf("missing @v separator")
	}
	v, err := strconv.Atoi(s[i+2:])
	if err != nil {
		return "", 0, fmt.Errorf("bad version: %w", err)
	}
	return s[:i], v, nil
}
