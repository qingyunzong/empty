// Package materiallib 实现一个发布型材料库：
// 每次发布使用独立的尝试目录与单调递增的版本号；
// 只有在本次全部文件写入并核验通过后，才原子切换 current 指针；
// 失败的发布不会污染读者可见的内容，旧版本材料全部保留。
package materiallib

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	attemptsDirName = "attempts"
	currentFileName = "current"
	manifestName    = "MANIFEST.json"
)

// ErrNoCurrent 表示尚无任何一次发布成功切换过指针。
var ErrNoCurrent = errors.New("materiallib: no published attempt")

// Store 是材料库句柄，dir 为库根目录。
type Store struct {
	dir    string
	faults *FaultInjector
}

// Open 打开（必要时创建）位于 dir 的材料库。
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, attemptsDirName), 0o755); err != nil {
		return nil, err
	}
	return &Store{dir: dir, faults: NewFaultInjector()}, nil
}

// Faults 返回故障注入器，用于测试。
func (s *Store) Faults() *FaultInjector { return s.faults }

// Snapshot 是读者看到的一次完整尝试的全部材料。
type Snapshot struct {
	Version uint64
	Files   map[string][]byte
}

type manifestFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type manifest struct {
	Version uint64         `json:"version"`
	Files   []manifestFile `json:"files"`
}

// Publish 将 files（相对路径 -> 内容，含日志、摘要等）作为一次新尝试发布。
// 任一步骤失败都会返回错误，且 current 指针保持不变（FaultAfterPointer 除外，
// 此时指针已切换，但读者看到的仍是单一完整尝试）。成功后返回本次版本号。
func (s *Store) Publish(files map[string][]byte) (uint64, error) {
	if len(files) == 0 {
		return 0, errors.New("materiallib: nothing to publish")
	}
	names := make([]string, 0, len(files))
	for name := range files {
		if err := validateRelPath(name); err != nil {
			return 0, err
		}
		names = append(names, name)
	}
	sort.Strings(names)

	version, err := s.nextVersion()
	if err != nil {
		return 0, err
	}
	attemptDir := s.attemptDir(version)
	// 每次尝试都是全新目录；若已存在说明状态异常，绝不复用旧目录。
	if err := os.Mkdir(attemptDir, 0o755); err != nil {
		return 0, fmt.Errorf("materiallib: create attempt dir: %w", err)
	}
	if err := s.faults.check(FaultAfterAttemptDir); err != nil {
		return 0, err
	}

	for _, name := range names {
		if err := writeFileAtomic(filepath.Join(attemptDir, filepath.FromSlash(name)), files[name]); err != nil {
			return 0, err
		}
	}
	if err := s.faults.check(FaultAfterFiles); err != nil {
		return 0, err
	}

	mf := manifest{Version: version}
	for _, name := range names {
		sum := sha256.Sum256(files[name])
		mf.Files = append(mf.Files, manifestFile{
			Path:   name,
			Size:   int64(len(files[name])),
			SHA256: hex.EncodeToString(sum[:]),
		})
	}
	mdata, err := json.MarshalIndent(&mf, "", "  ")
	if err != nil {
		return 0, err
	}
	if err := writeFileAtomic(filepath.Join(attemptDir, manifestName), mdata); err != nil {
		return 0, err
	}
	if err := s.faults.check(FaultAfterManifest); err != nil {
		return 0, err
	}

	// 切换指针前，对本次尝试目录做全量核验。
	if err := verifyAttempt(attemptDir, &mf); err != nil {
		return 0, err
	}
	if err := s.faults.check(FaultAfterVerify); err != nil {
		return 0, err
	}
	if err := syncDir(attemptDir); err != nil {
		return 0, err
	}
	if err := s.faults.check(FaultBeforePointer); err != nil {
		return 0, err
	}

	if err := s.switchPointer(version); err != nil {
		return 0, err
	}
	if err := s.faults.check(FaultAfterPointer); err != nil {
		return 0, err
	}
	return version, nil
}

// Read 读取当前指针指向的尝试，并在返回前核验其完整性。
// 读者拿到的所有文件保证来自同一次完整尝试，绝不混用不同尝试的内容。
func (s *Store) Read() (*Snapshot, error) {
	data, err := os.ReadFile(filepath.Join(s.dir, currentFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNoCurrent
	}
	if err != nil {
		return nil, err
	}
	version, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		return nil, fmt.Errorf("materiallib: corrupt current pointer: %w", err)
	}
	attemptDir := s.attemptDir(version)

	mdata, err := os.ReadFile(filepath.Join(attemptDir, manifestName))
	if err != nil {
		return nil, fmt.Errorf("materiallib: read manifest: %w", err)
	}
	var mf manifest
	if err := json.Unmarshal(mdata, &mf); err != nil {
		return nil, fmt.Errorf("materiallib: parse manifest: %w", err)
	}
	if mf.Version != version {
		return nil, fmt.Errorf("materiallib: manifest version %d does not match pointer %d", mf.Version, version)
	}
	if err := verifyAttempt(attemptDir, &mf); err != nil {
		return nil, err
	}

	snap := &Snapshot{Version: version, Files: make(map[string][]byte, len(mf.Files))}
	for _, entry := range mf.Files {
		content, err := os.ReadFile(filepath.Join(attemptDir, filepath.FromSlash(entry.Path)))
		if err != nil {
			return nil, err
		}
		snap.Files[entry.Path] = content
	}
	return snap, nil
}

// attemptDir 返回版本对应的独立尝试目录。
func (s *Store) attemptDir(version uint64) string {
	return filepath.Join(s.dir, attemptsDirName, fmt.Sprintf("%06d", version))
}

// nextVersion 扫描尝试目录取最大版本号 +1，保证失败尝试的目录不会被复用。
func (s *Store) nextVersion() (uint64, error) {
	entries, err := os.ReadDir(filepath.Join(s.dir, attemptsDirName))
	if err != nil {
		return 0, err
	}
	var max uint64
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if n, err := strconv.ParseUint(e.Name(), 10, 64); err == nil && n > max {
			max = n
		}
	}
	return max + 1, nil
}

// switchPointer 通过 临时文件 + rename 原子切换 current 指针。
func (s *Store) switchPointer(version uint64) error {
	tmp := filepath.Join(s.dir, currentFileName+".tmp")
	content := []byte(fmt.Sprintf("%06d\n", version))
	if err := writeFileAtomic(tmp, content); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(s.dir, currentFileName)); err != nil {
		return err
	}
	return syncDir(s.dir)
}

// verifyAttempt 核验尝试目录：清单内每个文件的大小与哈希必须匹配，
// 且目录中不得存在清单之外的多余文件。
func verifyAttempt(dir string, mf *manifest) error {
	seen := make(map[string]bool, len(mf.Files))
	for _, entry := range mf.Files {
		if err := validateRelPath(entry.Path); err != nil {
			return err
		}
		content, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(entry.Path)))
		if err != nil {
			return fmt.Errorf("materiallib: verify %s: %w", entry.Path, err)
		}
		sum := sha256.Sum256(content)
		if int64(len(content)) != entry.Size || hex.EncodeToString(sum[:]) != entry.SHA256 {
			return fmt.Errorf("materiallib: verify %s: content mismatch", entry.Path)
		}
		seen[entry.Path] = true
	}
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == manifestName {
			return nil
		}
		if !seen[rel] {
			return fmt.Errorf("materiallib: unexpected file %s in attempt dir", rel)
		}
		return nil
	})
}

// validateRelPath 拒绝绝对路径、越界路径与保留文件名。
func validateRelPath(name string) error {
	if name == "" || filepath.IsAbs(name) || strings.HasPrefix(name, "/") {
		return fmt.Errorf("materiallib: invalid path %q", name)
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(name)))
	if clean != name || clean == "." || strings.HasPrefix(clean, "../") || clean == ".." {
		return fmt.Errorf("materiallib: invalid path %q", name)
	}
	if name == manifestName {
		return fmt.Errorf("materiallib: path %q is reserved", name)
	}
	return nil
}

// writeFileAtomic 先写临时文件并 fsync，再 rename 到目标路径。
func writeFileAtomic(path string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(content); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
