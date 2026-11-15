package dataeng

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// safeSegment 把外部标识（run/target/request id）清洗成单段文件名，
// 杜绝路径穿越；原始标识仍保存在文件内容里。
func safeSegment(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "_"
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	name := b.String()
	if name == "." || name == ".." || name == "" {
		return "_"
	}
	return name
}

// atomicWrite 在同目录写临时文件再 rename，保证调用方看到的要么是旧文件、
// 要么是完整新文件。fsync=true 时对文件与父目录做持久化。
func atomicWrite(path string, data []byte, fsync bool) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()
	if _, err := io.Copy(tmp, bytes.NewReader(data)); err != nil {
		return err
	}
	if fsync {
		if err := tmp.Sync(); err != nil {
			return err
		}
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	cleanup = false
	if fsync {
		if d, err := os.Open(dir); err == nil {
			err = d.Sync()
			d.Close()
			return err
		}
	}
	return nil
}

func writeJSON(path string, v any, fsync bool) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return atomicWrite(path, data, fsync)
}

func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
