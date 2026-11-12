package dataeng_test

import (
	"encoding/binary"
	"fmt"
	"os"

	dataeng "example.org/dataeng/q0299"
)

// hostHeader 模拟实验设备接入宿主已经解析出的 TDMS 式段头与元数据。
// 真实宿主在这里完成容器头/字符串表/DAQmx 等解析，本包只接收解析结果。
type hostHeader struct {
	number  int64
	big     bool
	newList bool
	updates []dataeng.Update
	rawOff  int64
	rawLen  int64
}

// ingestHostSegment 是宿主适配器：把解析结果与不可变文件 ReaderAt 交给引擎，
// 失败段不生效，宿主修正元数据后可用原段号重试。
func ingestHostSegment(eng *dataeng.Engine, f *os.File, h hostHeader) error {
	endian := dataeng.LittleEndian
	if h.big {
		endian = dataeng.BigEndian
	}
	return eng.Ingest(dataeng.Segment{
		SegmentNumber: h.number,
		Endian:        endian,
		NewList:       h.newList,
		Layout:        dataeng.LayoutContiguous,
		Updates:       h.updates,
		Reader:        f,
		RawOffset:     h.rawOff,
		RawLength:     h.rawLen,
	})
}

func ExampleEngine_hostIntegration() {
	// 宿主以不可变字节文件模拟采集落盘结果；真实场景这里是 *os.File 或对象存储 ReaderAt。
	// 段1（小端）：通道 /dev/temp 为 i16，n=2，两个 chunk 共 8 字节。
	raw1 := make([]byte, 8)
	le := binary.LittleEndian
	le.PutUint16(raw1[0:], 100)
	le.PutUint16(raw1[2:], 101)
	le.PutUint16(raw1[4:], 102)
	le.PutUint16(raw1[6:], 103)

	// 段2复用索引，原始区接在文件后偏移 8 处，一个 chunk 2 个样本。
	raw2 := make([]byte, 4)
	le.PutUint16(raw2[0:], 104)
	le.PutUint16(raw2[2:], 105)

	path := tempFilePath(append(raw1, raw2...))
	defer os.Remove(path)
	f, err := os.Open(path)
	if err != nil {
		panic(err)
	}
	defer f.Close()

	eng, err := dataeng.New(dataeng.Budget{
		MaxChannelsPerSegment: 32,
		MaxChunksPerSegment:   1 << 16,
		MaxCachedIndexes:      128,
	})
	if err != nil {
		panic(err)
	}

	headers := []hostHeader{
		{
			number:  1,
			newList: true,
			rawOff:  0,
			rawLen:  8,
			updates: []dataeng.Update{
				{Path: "/dev/temp", Kind: dataeng.IndexNew, Type: dataeng.TypeI16, SamplesPerChunk: 2},
			},
		},
		{
			number:  2,
			newList: false,
			rawOff:  8,
			rawLen:  4,
			updates: []dataeng.Update{
				{Path: "/dev/temp", Kind: dataeng.IndexReuse},
			},
		},
	}
	for _, h := range headers {
		if err := ingestHostSegment(eng, f, h); err != nil {
			panic(err)
		}
	}

	// 只读取逻辑半开区间 [2,5)，句柄按需 ReadAt，不会全文件读入。
	handle, err := eng.Open("/dev/temp", 2, 5)
	if err != nil {
		panic(err)
	}
	for {
		res, ok, err := handle.Next()
		if err != nil {
			panic(err)
		}
		if !ok {
			break
		}
		fmt.Printf("logical=%d value=%d segment=%d chunk=%d physical=%d\n",
			res.Source.LogicalIndex, res.I16, res.Source.SegmentNumber,
			res.Source.Chunk, res.Source.PhysicalOffset)
	}

	// Output:
	// logical=2 value=102 segment=1 chunk=1 physical=4
	// logical=3 value=103 segment=1 chunk=1 physical=6
	// logical=4 value=104 segment=2 chunk=0 physical=8
}
