package dataeng

// MVT 几何命令 ID（command integer 的低 3 位）。
const (
	CommandMoveTo    = 1
	CommandLineTo    = 2
	CommandClosePath = 7
)

// EncodeZigzag32 实现 MVT 几何参数的 zigzag 编码。
func EncodeZigzag32(v int32) uint32 {
	return uint32((v << 1) ^ (v >> 31))
}

// DecodeZigzag32 实现 MVT 几何参数的 zigzag 解码。
func DecodeZigzag32(v uint32) int32 {
	return int32(v>>1) ^ -int32(v&1)
}

// CommandInteger 按规范把命令 ID 与参数计数打包为 command integer。
func CommandInteger(id, count uint32) uint32 {
	return (id & 0x7) | (count << 3)
}

// CommandID 取出 command integer 的命令 ID。
func CommandID(commandInteger uint32) uint32 {
	return commandInteger & 0x7
}

// CommandCount 取出 command integer 的参数计数。
func CommandCount(commandInteger uint32) uint32 {
	return commandInteger >> 3
}

// ConcatGeometry 在调用方已确认两个 feature 所在 layer 的 extent 一致时，
// 直接拼接 command 流。MVT 的命令参数是相对位移，拼接后仍按原坐标系解释，
// 因此这里只做原始 command integer 拼接，不做坐标变换。
// extent 不一致时必须由调用方拒绝拼接，避免跨网格尺度混用。
func ConcatGeometry(a, b []uint32) []uint32 {
	if len(b) == 0 {
		return cloneU32(a)
	}
	if len(a) == 0 {
		return cloneU32(b)
	}
	out := make([]uint32, 0, len(a)+len(b))
	out = append(out, a...)
	out = append(out, b...)
	return out
}

func cloneU32(in []uint32) []uint32 {
	if len(in) == 0 {
		return nil
	}
	out := make([]uint32, len(in))
	copy(out, in)
	return out
}

// validateGeometry 做结构校验：command 计数必须与后续参数数量匹配，
// 命令 ID 必须是规范定义的三种。返回错误时说明输入瓦片本身非法。
func validateGeometry(geometry []uint32) error {
	for i := 0; i < len(geometry); {
		commandInteger := geometry[i]
		id := CommandID(commandInteger)
		count := CommandCount(commandInteger)
		i++
		switch id {
		case CommandMoveTo, CommandLineTo:
			// 每个参数对占 2 个 zigzag 整数。
			need := int(count) * 2
			if i+need > len(geometry) {
				return errGeometryTruncated
			}
			i += need
		case CommandClosePath:
			if count != 1 {
				return errGeometryCloseCount
			}
		default:
			return errGeometryUnknownCmd
		}
	}
	return nil
}
