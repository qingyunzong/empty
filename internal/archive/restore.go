package archive

import (
	"archive/tar"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// pendingLink 记录目标尚未出现的硬链接条目（目标可晚到）。
type pendingLink struct {
	name   string
	target string
	mode   fs.FileMode
}

// Restore 将归档从 r 恢复到 destDir。
// 安全保证：
//   - 每个条目名校验，禁止绝对路径与 ".." 路径穿越；
//   - 符号链接目标必须为相对路径且词法解析后不逃出根目录，绝不跟随符号链接；
//   - 硬链接目标可晚到，先挂起，流结束后重试解析；
//   - 任一非法条目导致整次发布失败：先解压到临时目录，
//     成功后才原子替换 destDir；失败时旧目标目录保持不变。
func Restore(r io.Reader, destDir string) error {
	parent := filepath.Dir(destDir)
	tmp, err := os.MkdirTemp(parent, ".arc-release-*")
	if err != nil {
		return fmt.Errorf("创建临时目录失败: %w", err)
	}
	// 默认清理；成功后置 nil 阻止清理。
	cleanup := func() { os.RemoveAll(tmp) }
	defer func() {
		if cleanup != nil {
			cleanup()
		}
	}()

	if err := extractAll(r, tmp); err != nil {
		return err
	}

	if err := swapDir(tmp, destDir); err != nil {
		return err
	}
	cleanup = nil
	return nil
}

func extractAll(r io.Reader, root string) error {
	tr := tar.NewReader(r)
	var pending []pendingLink
	var dirs []dirMode

	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("读取归档失败: %w", err)
		}
		if err := validateRelName(hdr.Name); err != nil {
			return err
		}
		mode := fs.FileMode(hdr.Mode).Perm()
		dest := filepath.Join(root, filepath.FromSlash(hdr.Name))

		switch hdr.Typeflag {
		case tar.TypeDir:
			// 先保证属主可写可进入，最终模式在解压完成后统一恢复。
			if err := os.MkdirAll(dest, mode|0o700); err != nil {
				return err
			}
			dirs = append(dirs, dirMode{path: dest, mode: mode})
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				return err
			}
			if err := writeFile(dest, mode, tr); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := validateLinkTarget(hdr.Name, hdr.Linkname); err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(hdr.Linkname, dest); err != nil {
				return fmt.Errorf("创建符号链接 %q 失败: %w", hdr.Name, err)
			}
		case tar.TypeLink:
			// 硬链接目标本身是归档内路径，同样禁止穿越。
			if err := validateRelName(hdr.Linkname); err != nil {
				return fmt.Errorf("非法硬链接 %q: %w", hdr.Name, err)
			}
			src := filepath.Join(root, filepath.FromSlash(hdr.Linkname))
			if _, err := os.Lstat(src); err != nil {
				// 目标可晚到：挂起，稍后重试。
				pending = append(pending, pendingLink{name: hdr.Name, target: hdr.Linkname, mode: mode})
				continue
			}
			if err := linkTarget(src, dest); err != nil {
				return err
			}
		default:
			return fmt.Errorf("非法条目 %q: 不支持的类型 %d", hdr.Name, hdr.Typeflag)
		}
	}

	// 解析晚到的硬链接目标；每轮无进展则存在缺失目标，整次失败。
	for len(pending) > 0 {
		var next []pendingLink
		progress := false
		for _, pl := range pending {
			src := filepath.Join(root, filepath.FromSlash(pl.target))
			if _, err := os.Lstat(src); err != nil {
				next = append(next, pl)
				continue
			}
			dest := filepath.Join(root, filepath.FromSlash(pl.name))
			if err := linkTarget(src, dest); err != nil {
				return err
			}
			progress = true
		}
		if !progress {
			return fmt.Errorf("硬链接目标缺失: %q", next[0].target)
		}
		pending = next
	}

	// 逆序恢复目录最终模式（先子后父，避免父目录先失去可进入权限）。
	for i := len(dirs) - 1; i >= 0; i-- {
		if err := os.Chmod(dirs[i].path, dirs[i].mode); err != nil {
			return fmt.Errorf("恢复目录 %q 权限失败: %w", dirs[i].path, err)
		}
	}
	return nil
}

type dirMode struct {
	path string
	mode fs.FileMode
}

func writeFile(dest string, mode fs.FileMode, r io.Reader) error {
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func linkTarget(src, dest string) error {
	fi, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("硬链接目标 %q 不是普通文件", src)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	if err := os.Link(src, dest); err != nil {
		return fmt.Errorf("创建硬链接 %q 失败: %w", dest, err)
	}
	return nil
}

// swapDir 用 newDir 原子替换 destDir；失败时回滚，保证旧目录不变。
func swapDir(newDir, destDir string) error {
	if _, err := os.Lstat(destDir); os.IsNotExist(err) {
		return os.Rename(newDir, destDir)
	}
	backup := destDir + ".arc-old"
	os.RemoveAll(backup)
	if err := os.Rename(destDir, backup); err != nil {
		return fmt.Errorf("备份旧目录失败: %w", err)
	}
	if err := os.Rename(newDir, destDir); err != nil {
		os.Rename(backup, destDir) // 回滚
		return fmt.Errorf("替换目标目录失败: %w", err)
	}
	return os.RemoveAll(backup)
}
