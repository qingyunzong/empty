package q259

import (
	"fmt"
	"image"
)

// decodeRLE 解码对象游程数据为行优先的调色板索引位图。
//
// 每行由若干 (count, index) 字节对组成；count==0 是单字节的行结束标记，
// 其后不跟 index。所有行的有效像素数必须恰好等于 width，总行数必须恰好
// 等于 height，否则返回 ErrInvalidObject（行宽不足、超长、缺行、多行、
// 残缺游程均拒绝）。
func decodeRLE(data []byte, width, height int) ([]uint8, error) {
	pixels := make([]uint8, width*height)
	pos := 0
	row := 0
	col := 0

	for pos < len(data) {
		count := int(data[pos])
		pos++

		if count == 0 {
			if col != width {
				return nil, errRowWidth(row, col, width)
			}
			row++
			col = 0
			continue
		}

		// 非零游程必须带 index 字节。
		if pos >= len(data) {
			return nil, fmt.Errorf("%w: truncated run at row %d", ErrInvalidObject, row)
		}
		index := data[pos]
		pos++

		if row >= height || col+count > width {
			if row >= height {
				return nil, errRowCount(row+1, height)
			}
			return nil, errRowWidth(row, col+count, width)
		}
		for i := 0; i < count; i++ {
			pixels[row*width+col] = index
			col++
		}
	}

	if row != height || col != 0 {
		return nil, errRowCount(row, height)
	}
	return pixels, nil
}

func errRowWidth(row, got, want int) error {
	return fmt.Errorf("%w: row %d width %d, want %d", ErrInvalidObject, row, got, want)
}

func errRowCount(got, want int) error {
	return fmt.Errorf("%w: row count %d, want %d", ErrInvalidObject, got, want)
}

// drawObject 将已解码的索引位图按调色板合成到画布：透明索引跳过、不覆盖
// 底图；其余颜色转换为预乘 RGBA 后以 source-over 混合。
func drawObject(canvas *image.RGBA, pixels []uint8, width, height, x, y int, pal *Palette) {
	stride := canvas.Stride
	dst := canvas.Pix
	originX := canvas.Rect.Min.X
	originY := canvas.Rect.Min.Y

	for row := 0; row < height; row++ {
		for col := 0; col < width; col++ {
			idx := pixels[row*width+col]
			if int(idx) == pal.TransparentIndex {
				continue
			}
			c := pal.Entries[idx]
			px := x + col - originX
			py := y + row - originY
			off := py*stride + px*4
			blendPremultiplied(dst[off:off+4], c)
		}
	}
}

// blendPremultiplied 把直连颜色 c 预乘后以 source-over 混合到 dst 像素。
// 目标像素按 image.RGBA 约定保存预乘值。
func blendPremultiplied(dst []uint8, c Color) {
	const q = 255
	sr := uint32(c.R) * uint32(c.A) / q
	sg := uint32(c.G) * uint32(c.A) / q
	sb := uint32(c.B) * uint32(c.A) / q
	sa := uint32(c.A)

	dr := uint32(dst[0])
	dg := uint32(dst[1])
	db := uint32(dst[2])
	da := uint32(dst[3])

	inv := q - sa
	dst[0] = uint8((sr + dr*inv/q) & 0xff)
	dst[1] = uint8((sg + dg*inv/q) & 0xff)
	dst[2] = uint8((sb + db*inv/q) & 0xff)
	dst[3] = uint8((sa + da*inv/q) & 0xff)
}
