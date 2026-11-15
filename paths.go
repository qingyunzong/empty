package dataeng

import (
	"path/filepath"
)

// 磁盘布局（root 为 Open 时指定的归档根目录）：
//
//	root/
//	  runs/<run>/meta.json                 run 元数据（sealed、世代计数等）
//	  runs/<run>/wal/00000001.wal          分段 WAL（帧格式见 wal.go）
//	  runs/<run>/open/<target>/<req>.json  未闭合记录快照（每次归并原子重写）
//	  runs/<run>/base/<target>/<req>.json  封闭时固化的基础世代（rev=0）
//	  runs/<run>/revs/index.json           修订世代索引
//	  runs/<run>/revs/gen-<n>/<target>/<req>.json
//	  blobs/data/<algo>/<digest[:2]>/<digest>   内容寻址的正文数据（全局去重）
//	  blobs/refs/<algo>/<digest>.json       该 blob 的独立来源关系清单
//	  publish/ledger.json                   发布账本（恢复重放不重复发布）

func runsDir(root string) string           { return filepath.Join(root, "runs") }
func runDir(root, run string) string       { return filepath.Join(runsDir(root), safeSegment(run)) }
func walDir(root, run string) string       { return filepath.Join(runDir(root, run), "wal") }
func openDir(root, run string) string      { return filepath.Join(runDir(root, run), "open") }
func baseDir(root, run string) string      { return filepath.Join(runDir(root, run), "base") }
func revDir(root, run string) string       { return filepath.Join(runDir(root, run), "revs") }
func metaPath(root, run string) string     { return filepath.Join(runDir(root, run), "meta.json") }
func revIndexPath(root, run string) string { return filepath.Join(revDir(root, run), "index.json") }

func openRecordPath(root, run, target, req string) string {
	return filepath.Join(openDir(root, run), safeSegment(target), safeSegment(req)+".json")
}

func baseRecordPath(root, run, target, req string) string {
	return filepath.Join(baseDir(root, run), safeSegment(target), safeSegment(req)+".json")
}

func genRecordPath(root, run string, gen int64, target, req string) string {
	return filepath.Join(revDir(root, run), genDirName(gen), safeSegment(target), safeSegment(req)+".json")
}

func genDirName(gen int64) string {
	// gen-000001 形式，保证目录名按世代单调可排序。
	return "gen-" + pad6(gen)
}

func pad6(n int64) string {
	const digits = "0123456789"
	var buf [16]byte
	i := len(buf)
	if n == 0 {
		return "000000"
	}
	for n > 0 {
		i--
		buf[i] = digits[n%10]
		n /= 10
	}
	out := string(buf[i:])
	for len(out) < 6 {
		out = "0" + out
	}
	return out
}

func blobDataPath(root, algo, digest string) string {
	return filepath.Join(root, "blobs", "data", safeSegment(algo), digest[:2], digest)
}

func blobRefsPath(root, algo, digest string) string {
	return filepath.Join(root, "blobs", "refs", safeSegment(algo), digest+".json")
}

func ledgerPath(root string) string {
	return filepath.Join(root, "publish", "ledger.json")
}
