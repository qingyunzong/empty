// 宿主调用例：演示如何导入 dataeng 包，按参考半开区间裁剪一条比对记录，
// 并使用双向坐标查询。本例不读取 SAM，也不做反向互补。
package main

import (
	"errors"
	"fmt"

	dataeng "example.org/dataeng/q0276"
)

func main() {
	cigar, err := dataeng.ParseCIGAR("2H3S5M2I4M1D3=2N2X3S2H")
	must(err)

	const readLen = 3 + 5 + 2 + 4 + 3 + 2 + 3 // 所有消费读段的 S/M/I/=/X 之和
	bases := make([]byte, readLen)
	quals := make([]byte, readLen)
	for i := range bases {
		bases[i] = byte("ACGT"[i%4])
		quals[i] = byte(30 + i%10)
	}

	rec := &dataeng.Record{
		RefStart:  1000,
		CIGAR:     cigar,
		Bases:     bases,
		Qualities: quals,
	}

	// 裁剪到参考半开区间 [1003, 1015)。
	clipped, err := dataeng.Clip(rec, 1003, 1015)
	must(err)
	if clipped.Empty {
		fmt.Println("窗口内没有保留任何 M/=/X，记录为空")
		return
	}

	fmt.Printf("新起点 s'   : %d\n", clipped.RefStart)
	fmt.Printf("规范化 CIGAR: %s\n", clipped.CIGARString())
	fmt.Printf("原始读段区间: [%d, %d)\n", clipped.ReadStart, clipped.ReadEnd)
	fmt.Printf("保留碱基    : %s\n", string(clipped.Bases))
	fmt.Printf("保留质量    : %v\n", clipped.Qualities)

	// 读段下标 -> 参考坐标 / 插入锚点。
	for local := uint64(0); local < clipped.ReadLength(); local++ {
		pos, err := clipped.MapRead(local)
		must(err)
		switch pos.Kind {
		case dataeng.KindAligned:
			fmt.Printf("读段[%d] -> 参考 %d（比对位）\n", local, pos.RefCoord)
		case dataeng.KindInsertion:
			fmt.Printf("读段[%d] -> 插入锚点 %d\n", local, pos.RefCoord)
		}
	}

	// 参考坐标 -> 读段下标 / D/N 缺口。
	for coord := clipped.RefStart; coord-clipped.RefStart < clipped.RefLength(); coord++ {
		pos, err := clipped.MapRef(coord)
		must(err)
		switch pos.Kind {
		case dataeng.KindAligned:
			fmt.Printf("参考 %d -> 读段[%d]\n", coord, pos.ReadIndex)
		case dataeng.KindDeletion:
			fmt.Printf("参考 %d 位于 D 缺口 [%d,%d)\n", coord, pos.GapStart, pos.GapEnd)
		case dataeng.KindRefSkip:
			fmt.Printf("参考 %d 位于 N 缺跨 [%d,%d)\n", coord, pos.GapStart, pos.GapEnd)
		}
	}

	// 越界与空结果的错误处理示范。
	if _, err := clipped.MapRead(clipped.ReadLength()); errors.Is(err, dataeng.ErrIndexOutOfRange) {
		fmt.Println("越界读段下标已按约定报错")
	}
	empty, err := dataeng.Clip(rec, 5000, 6000)
	must(err)
	fmt.Printf("不相交窗口 Empty=%v\n", empty.Empty)
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
