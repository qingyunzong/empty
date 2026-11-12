package dataeng_test

import (
	"fmt"
	"math/big"

	dataeng "example.org/dataeng/q0260"
)

// ExampleTable_ReadBatch 演示接入宿主解析完表头后，如何用本包按需读取
// 固定列、P/Q 变长堆数组，并检查物理来源与读取次数。
func ExampleTable_ReadBatch() {
	const W, R, H int64 = 24, 1, 24
	buf := make([]byte, 32)

	// 行内：固定 J（缩放）在偏移 0；P 变长 B 描述符在偏移 8。
	putBE32(buf, 0, 6) // 原始值 6，缩放后 6/2+1 = 4
	putDescP(buf, 8, 3, 0)
	// 共享堆起点 H=24，放 3 个无符号字节。
	buf[H] = 0x0A
	buf[H+1] = 0x0B
	buf[H+2] = 0x0C

	table, err := dataeng.New(dataeng.Config{
		Reader:      byteReaderAt{buf: buf},
		DataLength:  int64(len(buf)),
		RowWidth:    W,
		RowCount:    R,
		ExtraBytes:  8,
		HeapStart:   H,
		MaxElements: 64,
		Columns: []dataeng.Column{
			{
				Name: "temp", Offset: 0, Type: dataeng.TypeJ,
				Desc: dataeng.DescFixed, FixedCount: 1,
				Scale: big.NewRat(1, 2), Zero: big.NewRat(1, 1),
			},
			{Name: "wave", Offset: 8, Type: dataeng.TypeB, Desc: dataeng.DescP},
		},
	})
	if err != nil {
		panic(err)
	}

	batch, err := table.ReadBatch([]int64{0}, []string{"temp", "wave"})
	if err != nil {
		panic(err)
	}

	fmt.Println("temp =", batch.Arrays[0].Values[0].FloatString(2))
	fmt.Printf("wave = %v source=%+v\n", batch.Arrays[1].U8, batch.Arrays[1].Source)
	fmt.Println("read calls =", len(batch.Reads.Calls))
	// Output:
	// temp = 4.00
	// wave = [10 11 12] source={Offset:24 Length:3}
	// read calls = 2
}

type byteReaderAt struct{ buf []byte }

func (b byteReaderAt) ReadAt(p []byte, off int64) (int, error) {
	return copy(p, b.buf[off:]), nil
}

func putBE32(dst []byte, off int, v int32) {
	dst[off] = byte(v >> 24)
	dst[off+1] = byte(v >> 16)
	dst[off+2] = byte(v >> 8)
	dst[off+3] = byte(v)
}

func putDescP(dst []byte, off int, count, rel int32) {
	putBE32(dst, off, count)
	putBE32(dst, off+4, rel)
}
