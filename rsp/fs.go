package rsp

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// OSFS reads response files from the operating system's file system.
type OSFS struct{}

func (OSFS) ReadFile(p string) ([]byte, error) { return os.ReadFile(p) }

func (OSFS) Resolve(dir, ref string) string {
	if filepath.IsAbs(ref) {
		return filepath.Clean(ref)
	}
	if dir == "" {
		return filepath.Clean(ref)
	}
	return filepath.Join(dir, ref)
}

func (OSFS) Canonical(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return filepath.ToSlash(abs), nil
}

// MapFS is an in-memory FS for tests and virtual environments. Paths use
// "/" separators; relative paths resolve against the virtual root "/".
type MapFS struct {
	Files map[string]string
}

func (m MapFS) ReadFile(p string) ([]byte, error) {
	content, ok := m.Files[p]
	if !ok {
		return nil, fmt.Errorf("open %s: no such file", p)
	}
	return []byte(content), nil
}

func (m MapFS) Resolve(dir, ref string) string {
	if strings.HasPrefix(ref, "/") {
		return path.Clean(ref)
	}
	if dir == "" {
		dir = "/"
	}
	return path.Join(dir, ref)
}

func (m MapFS) Canonical(p string) (string, error) {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return path.Clean(p), nil
}

// Names returns the sorted list of files in the table.
func (m MapFS) Names() []string {
	names := make([]string, 0, len(m.Files))
	for name := range m.Files {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
