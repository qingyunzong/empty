// Package archive 提供目录归档与安全恢复能力。
// 归档格式使用标准库 archive/tar：普通文件去重硬链接（TypeLink），
// 符号链接按原样记录（TypeSymlink，绝不跟随）。
package archive

import (
	"archive/tar"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
)

// inodeKey 用于识别同一硬链接组。
type inodeKey struct {
	dev uint64
	ino uint64
}

// validateRelName 校验归档内的相对路径名，禁止绝对路径与路径穿越。
func validateRelName(name string) error {
	if name == "" {
		return fmt.Errorf("条目名为空")
	}
	if path.IsAbs(name) || filepath.IsAbs(name) {
		return fmt.Errorf("非法条目 %q: 不允许绝对路径", name)
	}
	clean := path.Clean(name)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return fmt.Errorf("非法条目 %q: 路径穿越", name)
	}
	if strings.Contains(name, "\x00") {
		return fmt.Errorf("非法条目 %q: 含 NUL 字符", name)
	}
	return nil
}

// validateLinkTarget 校验符号链接目标：必须为相对路径，
// 且相对链接所在目录解析（纯词法，不跟随任何链接）后不得逃出根目录。
func validateLinkTarget(entryName, target string) error {
	if path.IsAbs(target) || filepath.IsAbs(target) {
		return fmt.Errorf("非法符号链接 %q -> %q: 不允许绝对目标", entryName, target)
	}
	resolved := path.Clean(path.Join(path.Dir(entryName), target))
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		return fmt.Errorf("非法符号链接 %q -> %q: 目标逃出根目录", entryName, target)
	}
	return nil
}

// Create 将 srcDir 归档写入 w。普通文件按 (dev,ino) 去重，
// 后续同 inode 文件记为硬链接条目；符号链接不跟随（循环链接安全）。
// 任一非法条目都会使整个归档失败。
func Create(srcDir string, w io.Writer) error {
	info, err := os.Stat(srcDir)
	if err != nil {
		return fmt.Errorf("读取源目录失败: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%q 不是目录", srcDir)
	}

	tw := tar.NewWriter(w)
	seen := map[inodeKey]string{}

	walkErr := filepath.WalkDir(srcDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(srcDir, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		name := filepath.ToSlash(rel)
		if err := validateRelName(name); err != nil {
			return err
		}
		fi, err := os.Lstat(p) // 不跟随符号链接，循环链接不会被解析
		if err != nil {
			return err
		}
		hdr := &tar.Header{
			Name:    name,
			Mode:    int64(fi.Mode().Perm()),
			ModTime: fi.ModTime(),
		}
		switch {
		case fi.IsDir():
			hdr.Typeflag = tar.TypeDir
			hdr.Name += "/"
			return tw.WriteHeader(hdr)
		case fi.Mode()&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			if err := validateLinkTarget(name, target); err != nil {
				return err
			}
			hdr.Typeflag = tar.TypeSymlink
			hdr.Linkname = target
			return tw.WriteHeader(hdr)
		case fi.Mode().IsRegular():
			st, ok := fi.Sys().(*syscall.Stat_t)
			if !ok {
				return fmt.Errorf("无法获取 %q 的 inode 信息", name)
			}
			key := inodeKey{dev: uint64(st.Dev), ino: st.Ino}
			if first, dup := seen[key]; dup {
				hdr.Typeflag = tar.TypeLink
				hdr.Linkname = first
				return tw.WriteHeader(hdr)
			}
			seen[key] = name
			hdr.Typeflag = tar.TypeReg
			hdr.Size = fi.Size()
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			defer f.Close()
			if _, err := io.CopyN(tw, f, fi.Size()); err != nil {
				return fmt.Errorf("写入 %q 内容失败: %w", name, err)
			}
			return nil
		default:
			return fmt.Errorf("非法条目 %q: 不支持的文件类型 %v", name, fi.Mode().Type())
		}
	})
	if walkErr != nil {
		tw.Close()
		return walkErr
	}
	return tw.Close()
}
