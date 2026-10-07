package testiso

import (
	"os"
	"strings"
)

// LoadManifest parses a manifest file: one root-relative input path per
// line, blank lines and '#' comments ignored.
func LoadManifest(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var entries []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		entries = append(entries, line)
	}
	return entries, nil
}
