// kvmerge-demo 生成随机分层数据，执行合并并打印每个条目的去留原因，
// 最后将压缩读模型与未压缩读模型逐一对照。
package main

import (
	"flag"
	"fmt"
	"math/rand"

	"kvmerge"
)

func main() {
	seed := flag.Int64("seed", 42, "随机种子")
	bottom := flag.Bool("bottom", true, "是否压缩到最底层")
	flag.Parse()

	w := kvmerge.GenWorkload(rand.New(rand.NewSource(*seed)))
	fmt.Printf("随机分层数据：%d 个键，%d 层段，最大序号 %d，快照读者 %v\n",
		len(w.Keys), len(w.Segments), w.MaxSeq, w.Snapshots)
	for _, seg := range w.Segments {
		fmt.Printf("  第%d层：%d 条\n", seg.Level, len(seg.Entries))
	}

	res := kvmerge.Merge(w.Segments, w.Snapshots, *bottom)
	fmt.Printf("\n合并决策（输入 %d 条，保留 %d 条）：\n", len(res.Decisions), len(res.Output))
	for _, d := range res.Decisions {
		mark := "丢弃"
		if d.Kept {
			mark = "保留"
		}
		fmt.Printf("  [%s] %-24s %s\n", mark, d.Entry, d.Reason)
	}

	ref := kvmerge.NewStore()
	for _, s := range w.Segments {
		ref.AddSegment(s)
	}
	readers := append([]uint64{}, w.Snapshots...)
	readers = append(readers, kvmerge.LatestSeq)
	mismatch := 0
	for _, k := range w.Keys {
		for _, r := range readers {
			gv, gok := res.Get(k, r)
			wv, wok := ref.Get(k, r)
			if gv != wv || gok != wok {
				fmt.Printf("  不一致：键 %s 序号 %d：压缩=(%q,%v) 未压缩=(%q,%v)\n", k, r, gv, gok, wv, wok)
				mismatch++
			}
		}
	}
	fmt.Printf("\n读模型对照：%d 个键 × %d 个读者序号，", len(w.Keys), len(readers))
	if mismatch == 0 {
		fmt.Println("压缩与未压缩结果完全一致")
	} else {
		fmt.Printf("发现 %d 处不一致\n", mismatch)
	}
}
