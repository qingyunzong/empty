// arc 是目录归档/恢复 CLI。
//
//	arc create <源目录> <归档文件>
//	arc restore <归档文件> <新根目录>
//	arc verify <源目录> <恢复目录>
package main

import (
	"fmt"
	"os"
	"reflect"

	"arctool/internal/archive"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "create":
		if len(os.Args) != 4 {
			usage()
			os.Exit(2)
		}
		err = create(os.Args[2], os.Args[3])
	case "restore":
		if len(os.Args) != 4 {
			usage()
			os.Exit(2)
		}
		err = restore(os.Args[2], os.Args[3])
	case "verify":
		if len(os.Args) != 4 {
			usage()
			os.Exit(2)
		}
		err = verify(os.Args[2], os.Args[3])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "arc: 发布失败:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `用法:
  arc create  <源目录> <归档文件>   归档目录（硬链接去重，符号链接不跟随）
  arc restore <归档文件> <新根目录>  恢复到新根（禁止路径穿越，失败时旧目录不变）
  arc verify  <源目录> <恢复目录>   核对两侧硬链接 inode 关系一致`)
}

func create(src, out string) error {
	f, err := os.Create(out)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		f.Close()
		if !ok {
			os.Remove(out) // 失败不留下半成品归档
		}
	}()
	if err := archive.Create(src, f); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	ok = true
	fmt.Println("归档完成:", out)
	return nil
}

func restore(arc, dest string) error {
	f, err := os.Open(arc)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := archive.Restore(f, dest); err != nil {
		return err
	}
	fmt.Println("恢复完成:", dest)
	return nil
}

func verify(src, dest string) error {
	a, err := archive.InodeGroups(src)
	if err != nil {
		return err
	}
	b, err := archive.InodeGroups(dest)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(a, b) {
		return fmt.Errorf("硬链接 inode 关系不一致: 源=%v 目标=%v", a, b)
	}
	fmt.Printf("inode 关系一致，共 %d 个硬链接组\n", len(a))
	return nil
}
