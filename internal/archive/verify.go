package archive

import (
	"crypto/sha256"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"syscall"
)

// InodeGroups 返回 root 下普通文件按 (dev,ino) 分组的相对路径集合，
// 仅保留组内成员数大于 1 的硬链接组，用于核对恢复前后 inode 关系一致。
func InodeGroups(root string) ([][]string, error) {
	groups := map[inodeKey][]string{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if !fi.Mode().IsRegular() {
			return nil
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok {
			return fmt.Errorf("无法获取 %q 的 inode 信息", p)
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		key := inodeKey{dev: uint64(st.Dev), ino: st.Ino}
		groups[key] = append(groups[key], filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	var out [][]string
	for _, members := range groups {
		if len(members) > 1 {
			sort.Strings(members)
			out = append(out, members)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i][0] < out[j][0] })
	return out, nil
}

// Snapshot 生成目录内容的确定性摘要（路径、类型、哈希/链接目标），
// 用于核对目录未被修改。
func Snapshot(root string) ([]string, error) {
	var lines []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		switch {
		case fi.IsDir():
			lines = append(lines, fmt.Sprintf("dir  %s %04o", rel, fi.Mode().Perm()))
		case fi.Mode()&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			lines = append(lines, fmt.Sprintf("link %s -> %s", rel, target))
		case fi.Mode().IsRegular():
			h := sha256.New()
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			if _, err := io.Copy(h, f); err != nil {
				f.Close()
				return err
			}
			f.Close()
			lines = append(lines, fmt.Sprintf("file %s %04o %x", rel, fi.Mode().Perm(), h.Sum(nil)))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(lines)
	return lines, nil
}
