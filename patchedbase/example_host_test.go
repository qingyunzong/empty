package patchedbase_test

import (
	"errors"
	"fmt"

	"example.org/dataeng/q0312/patchedbase"
)

// ExampleDecoder 演示列接入宿主如何按容器给的元数据新建单 run 解码器、
// 以任意切块喂字节、按错误类别分别处理，并读取补丁溯源信息。
func ExampleDecoder() {
	// 元数据由容器提供：N=4、W=3、BW=1、PW=4、G=4、P=2。
	params := patchedbase.Params{N: 4, W: 3, BW: 1, PW: 4, G: 4, P: 2}
	params.BodyLength = 1 + (4*3+7)/8 + (2*8+7)/8 // BW + 低部段 + 槽段

	// 独立构造 run 体（测试/造数用途；宿主路径只做解码）。
	body := encodeExampleBody()

	dec, err := patchedbase.New(params)
	if err != nil {
		fmt.Println("new:", classify(err))
		return
	}

	// 任意切块：这里切成三块喂入，切块点不影响结果。
	cuts := []int{2, 5}
	from := 0
	for _, at := range cuts {
		if err := dec.Push(body[from:at]); err != nil {
			fmt.Println("push:", classify(err))
			return
		}
		from = at
	}
	if err := dec.Push(body[from:]); err != nil {
		fmt.Println("push:", classify(err))
		return
	}

	result, err := dec.Finish()
	if err != nil {
		fmt.Println("finish:", classify(err))
		return
	}

	fmt.Printf("base=%d\n", result.Base)
	for i, v := range result.Values {
		if v.Patch != nil {
			fmt.Printf("value[%d]=%d patched by slot %d (gap sources %v)\n",
				i, v.Value, v.Patch.Slot, v.Patch.GapSources)
			continue
		}
		fmt.Printf("value[%d]=%d\n", i, v.Value)
	}

	// 失败后实例不可继续使用，宿主新建实例处理下一 run。
	if _, err := dec.Finish(); err != nil {
		fmt.Println("repeat finish:", classify(err))
	}

	// Output:
	// base=10
	// value[0]=11
	// value[1]=28 patched by slot 0 (gap sources [])
	// value[2]=45 patched by slot 1 (gap sources [])
	// value[3]=14
	// repeat finish: state
}

// ExampleDecoder_errorKinds 演示各类失败可分别辨识，宿主不会把截断误判成溢出等。
func ExampleDecoder_errorKinds() {
	small := func() patchedbase.Params {
		p := patchedbase.Params{N: 3, W: 5, BW: 1, PW: 5, G: 1, P: 1}
		p.BodyLength = 1 + (3*5+7)/8 + (1*8+7)/8 // BW + 低部段 + 槽段
		return p
	}

	// 参数错误在 New 阶段即可辨识。
	badParams := small()
	badParams.N = 0
	if _, err := patchedbase.New(badParams); err != nil {
		fmt.Println("bad params:", classify(err))
	}

	// 体长不符在 New 阶段按参数错误拒绝，避免按不可信声明分配。
	wrongLen := small()
	wrongLen.BodyLength++
	if _, err := patchedbase.New(wrongLen); err != nil {
		fmt.Println("wrong length:", classify(err))
	}

	// 截断：只 Push 部分字节就 Finish。
	body := encodeExampleBodySmall()
	dec, err := patchedbase.New(small())
	if err != nil {
		fmt.Println("new small:", classify(err))
		return
	}
	_ = dec.Push(body[:len(body)-1])
	if _, err := dec.Finish(); err != nil {
		fmt.Println("short body:", classify(err))
	}

	// 额外字节：声明体长之外的数据不能被当成补丁槽。
	dec2, err := patchedbase.New(small())
	if err != nil {
		fmt.Println("new small 2:", classify(err))
		return
	}
	_ = dec2.Push(append(append([]byte{}, body...), 0xAA))
	if _, err := dec2.Finish(); err != nil {
		fmt.Println("extra byte:", classify(err))
	}

	// Output:
	// bad params: invalid-parameter
	// wrong length: invalid-parameter
	// short body: truncated
	// extra byte: extra-bytes
}

func classify(err error) string {
	var pe *patchedbase.Error
	if !errors.As(err, &pe) {
		return "unknown"
	}
	switch pe.Kind {
	case patchedbase.KindInvalidParameter:
		return "invalid-parameter"
	case patchedbase.KindTruncated:
		return "truncated"
	case patchedbase.KindExtraBytes:
		return "extra-bytes"
	case patchedbase.KindPadding:
		return "padding"
	case patchedbase.KindBadContinuation:
		return "bad-continuation"
	case patchedbase.KindPatchPosition:
		return "patch-position"
	case patchedbase.KindOverflow:
		return "overflow"
	case patchedbase.KindState:
		return "state"
	default:
		return "unknown"
	}
}

// 下面两个编码器只服务于本例，按 MSB-first 手工打包，与生产解码路径独立。

type exampleBitWriter struct {
	buf []byte
	pos int
}

func (w *exampleBitWriter) write(v uint64, bits int) {
	for i := bits - 1; i >= 0; i-- {
		if w.pos>>3 >= len(w.buf) {
			w.buf = append(w.buf, 0)
		}
		w.buf[w.pos>>3] |= byte((v>>uint(i))&1) << uint(7-w.pos&7)
		w.pos++
	}
}

func (w *exampleBitWriter) pad() {
	for w.pos&7 != 0 {
		w.write(0, 1)
	}
}

func encodeExampleBody() []byte {
	// base=10；低部 1,2,3,4（W=3，12 位补 4 位）；
	// 槽宽 F=8：槽0 gap=1 patch=2 -> 0x12；槽1 gap=1 patch=4 -> 0x14。
	var w exampleBitWriter
	w.write(10, 8)
	for _, low := range []uint64{1, 2, 3, 4} {
		w.write(low, 3)
	}
	w.pad()
	w.write((1<<4)|2, 8)
	w.write((1<<4)|4, 8)
	w.pad()
	return w.buf
}

func encodeExampleBodySmall() []byte {
	// N=3、W=5、BW=1、PW=5、G=1，F=8；槽 gap=1 patch=1 -> 0x21。
	var w exampleBitWriter
	w.write(0, 8)
	for _, low := range []uint64{1, 2, 3} {
		w.write(low, 5)
	}
	w.pad()
	w.write((1<<5)|1, 8)
	w.pad()
	return w.buf
}
