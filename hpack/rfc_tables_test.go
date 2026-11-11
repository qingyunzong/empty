// Code generated from RFC 7541 tables for test fixtures; DO NOT EDIT by hand.

package hpack

func rfcStaticTable() StaticTable {
	return StaticTable{
		{Name: ":authority", Value: ""},
		{Name: ":method", Value: "GET"},
		{Name: ":method", Value: "POST"},
		{Name: ":path", Value: "/"},
		{Name: ":path", Value: "/index.html"},
		{Name: ":scheme", Value: "http"},
		{Name: ":scheme", Value: "https"},
		{Name: ":status", Value: "200"},
		{Name: ":status", Value: "204"},
		{Name: ":status", Value: "206"},
		{Name: ":status", Value: "304"},
		{Name: ":status", Value: "400"},
		{Name: ":status", Value: "404"},
		{Name: ":status", Value: "500"},
		{Name: "accept-charset", Value: ""},
		{Name: "accept-encoding", Value: "gzip, deflate"},
		{Name: "accept-language", Value: ""},
		{Name: "accept-ranges", Value: ""},
		{Name: "accept", Value: ""},
		{Name: "access-control-allow-origin", Value: ""},
		{Name: "age", Value: ""},
		{Name: "allow", Value: ""},
		{Name: "authorization", Value: ""},
		{Name: "cache-control", Value: ""},
		{Name: "content-disposition", Value: ""},
		{Name: "content-encoding", Value: ""},
		{Name: "content-language", Value: ""},
		{Name: "content-length", Value: ""},
		{Name: "content-location", Value: ""},
		{Name: "content-range", Value: ""},
		{Name: "content-type", Value: ""},
		{Name: "cookie", Value: ""},
		{Name: "date", Value: ""},
		{Name: "etag", Value: ""},
		{Name: "expect", Value: ""},
		{Name: "expires", Value: ""},
		{Name: "from", Value: ""},
		{Name: "host", Value: ""},
		{Name: "if-match", Value: ""},
		{Name: "if-modified-since", Value: ""},
		{Name: "if-none-match", Value: ""},
		{Name: "if-range", Value: ""},
		{Name: "if-unmodified-since", Value: ""},
		{Name: "last-modified", Value: ""},
		{Name: "link", Value: ""},
		{Name: "location", Value: ""},
		{Name: "max-forwards", Value: ""},
		{Name: "proxy-authenticate", Value: ""},
		{Name: "proxy-authorization", Value: ""},
		{Name: "range", Value: ""},
		{Name: "referer", Value: ""},
		{Name: "refresh", Value: ""},
		{Name: "retry-after", Value: ""},
		{Name: "server", Value: ""},
		{Name: "set-cookie", Value: ""},
		{Name: "strict-transport-security", Value: ""},
		{Name: "transfer-encoding", Value: ""},
		{Name: "user-agent", Value: ""},
		{Name: "vary", Value: ""},
		{Name: "via", Value: ""},
		{Name: "www-authenticate", Value: ""},
	}
}

func rfcHuffmanTable() *HuffmanTable {
	t := &HuffmanTable{}
	for s := 0; s < 256; s++ {
		var c HuffmanCode
		switch s {
		case 0:
			c = HuffmanCode{Bits: 0x1ff8, N: 13}
		case 1:
			c = HuffmanCode{Bits: 0x7fffd8, N: 23}
		case 2:
			c = HuffmanCode{Bits: 0xfffffe2, N: 28}
		case 3:
			c = HuffmanCode{Bits: 0xfffffe3, N: 28}
		case 4:
			c = HuffmanCode{Bits: 0xfffffe4, N: 28}
		case 5:
			c = HuffmanCode{Bits: 0xfffffe5, N: 28}
		case 6:
			c = HuffmanCode{Bits: 0xfffffe6, N: 28}
		case 7:
			c = HuffmanCode{Bits: 0xfffffe7, N: 28}
		case 8:
			c = HuffmanCode{Bits: 0xfffffe8, N: 28}
		case 9:
			c = HuffmanCode{Bits: 0xffffea, N: 24}
		case 10:
			c = HuffmanCode{Bits: 0x3ffffffc, N: 30}
		case 11:
			c = HuffmanCode{Bits: 0xfffffe9, N: 28}
		case 12:
			c = HuffmanCode{Bits: 0xfffffea, N: 28}
		case 13:
			c = HuffmanCode{Bits: 0x3ffffffd, N: 30}
		case 14:
			c = HuffmanCode{Bits: 0xfffffeb, N: 28}
		case 15:
			c = HuffmanCode{Bits: 0xfffffec, N: 28}
		case 16:
			c = HuffmanCode{Bits: 0xfffffed, N: 28}
		case 17:
			c = HuffmanCode{Bits: 0xfffffee, N: 28}
		case 18:
			c = HuffmanCode{Bits: 0xfffffef, N: 28}
		case 19:
			c = HuffmanCode{Bits: 0xffffff0, N: 28}
		case 20:
			c = HuffmanCode{Bits: 0xffffff1, N: 28}
		case 21:
			c = HuffmanCode{Bits: 0xffffff2, N: 28}
		case 22:
			c = HuffmanCode{Bits: 0x3ffffffe, N: 30}
		case 23:
			c = HuffmanCode{Bits: 0xffffff3, N: 28}
		case 24:
			c = HuffmanCode{Bits: 0xffffff4, N: 28}
		case 25:
			c = HuffmanCode{Bits: 0xffffff5, N: 28}
		case 26:
			c = HuffmanCode{Bits: 0xffffff6, N: 28}
		case 27:
			c = HuffmanCode{Bits: 0xffffff7, N: 28}
		case 28:
			c = HuffmanCode{Bits: 0xffffff8, N: 28}
		case 29:
			c = HuffmanCode{Bits: 0xffffff9, N: 28}
		case 30:
			c = HuffmanCode{Bits: 0xffffffa, N: 28}
		case 31:
			c = HuffmanCode{Bits: 0xffffffb, N: 28}
		case 32:
			c = HuffmanCode{Bits: 0x14, N: 6}
		case 33:
			c = HuffmanCode{Bits: 0x3f8, N: 10}
		case 34:
			c = HuffmanCode{Bits: 0x3f9, N: 10}
		case 35:
			c = HuffmanCode{Bits: 0xffa, N: 12}
		case 36:
			c = HuffmanCode{Bits: 0x1ff9, N: 13}
		case 37:
			c = HuffmanCode{Bits: 0x15, N: 6}
		case 38:
			c = HuffmanCode{Bits: 0xf8, N: 8}
		case 39:
			c = HuffmanCode{Bits: 0x7fa, N: 11}
		case 40:
			c = HuffmanCode{Bits: 0x3fa, N: 10}
		case 41:
			c = HuffmanCode{Bits: 0x3fb, N: 10}
		case 42:
			c = HuffmanCode{Bits: 0xf9, N: 8}
		case 43:
			c = HuffmanCode{Bits: 0x7fb, N: 11}
		case 44:
			c = HuffmanCode{Bits: 0xfa, N: 8}
		case 45:
			c = HuffmanCode{Bits: 0x16, N: 6}
		case 46:
			c = HuffmanCode{Bits: 0x17, N: 6}
		case 47:
			c = HuffmanCode{Bits: 0x18, N: 6}
		case 48:
			c = HuffmanCode{Bits: 0x0, N: 5}
		case 49:
			c = HuffmanCode{Bits: 0x1, N: 5}
		case 50:
			c = HuffmanCode{Bits: 0x2, N: 5}
		case 51:
			c = HuffmanCode{Bits: 0x19, N: 6}
		case 52:
			c = HuffmanCode{Bits: 0x1a, N: 6}
		case 53:
			c = HuffmanCode{Bits: 0x1b, N: 6}
		case 54:
			c = HuffmanCode{Bits: 0x1c, N: 6}
		case 55:
			c = HuffmanCode{Bits: 0x1d, N: 6}
		case 56:
			c = HuffmanCode{Bits: 0x1e, N: 6}
		case 57:
			c = HuffmanCode{Bits: 0x1f, N: 6}
		case 58:
			c = HuffmanCode{Bits: 0x5c, N: 7}
		case 59:
			c = HuffmanCode{Bits: 0xfb, N: 8}
		case 60:
			c = HuffmanCode{Bits: 0x7ffc, N: 15}
		case 61:
			c = HuffmanCode{Bits: 0x20, N: 6}
		case 62:
			c = HuffmanCode{Bits: 0xffb, N: 12}
		case 63:
			c = HuffmanCode{Bits: 0x3fc, N: 10}
		case 64:
			c = HuffmanCode{Bits: 0x1ffa, N: 13}
		case 65:
			c = HuffmanCode{Bits: 0x21, N: 6}
		case 66:
			c = HuffmanCode{Bits: 0x5d, N: 7}
		case 67:
			c = HuffmanCode{Bits: 0x5e, N: 7}
		case 68:
			c = HuffmanCode{Bits: 0x5f, N: 7}
		case 69:
			c = HuffmanCode{Bits: 0x60, N: 7}
		case 70:
			c = HuffmanCode{Bits: 0x61, N: 7}
		case 71:
			c = HuffmanCode{Bits: 0x62, N: 7}
		case 72:
			c = HuffmanCode{Bits: 0x63, N: 7}
		case 73:
			c = HuffmanCode{Bits: 0x64, N: 7}
		case 74:
			c = HuffmanCode{Bits: 0x65, N: 7}
		case 75:
			c = HuffmanCode{Bits: 0x66, N: 7}
		case 76:
			c = HuffmanCode{Bits: 0x67, N: 7}
		case 77:
			c = HuffmanCode{Bits: 0x68, N: 7}
		case 78:
			c = HuffmanCode{Bits: 0x69, N: 7}
		case 79:
			c = HuffmanCode{Bits: 0x6a, N: 7}
		case 80:
			c = HuffmanCode{Bits: 0x6b, N: 7}
		case 81:
			c = HuffmanCode{Bits: 0x6c, N: 7}
		case 82:
			c = HuffmanCode{Bits: 0x6d, N: 7}
		case 83:
			c = HuffmanCode{Bits: 0x6e, N: 7}
		case 84:
			c = HuffmanCode{Bits: 0x6f, N: 7}
		case 85:
			c = HuffmanCode{Bits: 0x70, N: 7}
		case 86:
			c = HuffmanCode{Bits: 0x71, N: 7}
		case 87:
			c = HuffmanCode{Bits: 0x72, N: 7}
		case 88:
			c = HuffmanCode{Bits: 0xfc, N: 8}
		case 89:
			c = HuffmanCode{Bits: 0x73, N: 7}
		case 90:
			c = HuffmanCode{Bits: 0xfd, N: 8}
		case 91:
			c = HuffmanCode{Bits: 0x1ffb, N: 13}
		case 92:
			c = HuffmanCode{Bits: 0x7fff0, N: 19}
		case 93:
			c = HuffmanCode{Bits: 0x1ffc, N: 13}
		case 94:
			c = HuffmanCode{Bits: 0x3ffc, N: 14}
		case 95:
			c = HuffmanCode{Bits: 0x22, N: 6}
		case 96:
			c = HuffmanCode{Bits: 0x7ffd, N: 15}
		case 97:
			c = HuffmanCode{Bits: 0x3, N: 5}
		case 98:
			c = HuffmanCode{Bits: 0x23, N: 6}
		case 99:
			c = HuffmanCode{Bits: 0x4, N: 5}
		case 100:
			c = HuffmanCode{Bits: 0x24, N: 6}
		case 101:
			c = HuffmanCode{Bits: 0x5, N: 5}
		case 102:
			c = HuffmanCode{Bits: 0x25, N: 6}
		case 103:
			c = HuffmanCode{Bits: 0x26, N: 6}
		case 104:
			c = HuffmanCode{Bits: 0x27, N: 6}
		case 105:
			c = HuffmanCode{Bits: 0x6, N: 5}
		case 106:
			c = HuffmanCode{Bits: 0x74, N: 7}
		case 107:
			c = HuffmanCode{Bits: 0x75, N: 7}
		case 108:
			c = HuffmanCode{Bits: 0x28, N: 6}
		case 109:
			c = HuffmanCode{Bits: 0x29, N: 6}
		case 110:
			c = HuffmanCode{Bits: 0x2a, N: 6}
		case 111:
			c = HuffmanCode{Bits: 0x7, N: 5}
		case 112:
			c = HuffmanCode{Bits: 0x2b, N: 6}
		case 113:
			c = HuffmanCode{Bits: 0x76, N: 7}
		case 114:
			c = HuffmanCode{Bits: 0x2c, N: 6}
		case 115:
			c = HuffmanCode{Bits: 0x8, N: 5}
		case 116:
			c = HuffmanCode{Bits: 0x9, N: 5}
		case 117:
			c = HuffmanCode{Bits: 0x2d, N: 6}
		case 118:
			c = HuffmanCode{Bits: 0x77, N: 7}
		case 119:
			c = HuffmanCode{Bits: 0x78, N: 7}
		case 120:
			c = HuffmanCode{Bits: 0x79, N: 7}
		case 121:
			c = HuffmanCode{Bits: 0x7a, N: 7}
		case 122:
			c = HuffmanCode{Bits: 0x7b, N: 7}
		case 123:
			c = HuffmanCode{Bits: 0x7ffe, N: 15}
		case 124:
			c = HuffmanCode{Bits: 0x7fc, N: 11}
		case 125:
			c = HuffmanCode{Bits: 0x3ffd, N: 14}
		case 126:
			c = HuffmanCode{Bits: 0x1ffd, N: 13}
		case 127:
			c = HuffmanCode{Bits: 0xffffffc, N: 28}
		case 128:
			c = HuffmanCode{Bits: 0xfffe6, N: 20}
		case 129:
			c = HuffmanCode{Bits: 0x3fffd2, N: 22}
		case 130:
			c = HuffmanCode{Bits: 0xfffe7, N: 20}
		case 131:
			c = HuffmanCode{Bits: 0xfffe8, N: 20}
		case 132:
			c = HuffmanCode{Bits: 0x3fffd3, N: 22}
		case 133:
			c = HuffmanCode{Bits: 0x3fffd4, N: 22}
		case 134:
			c = HuffmanCode{Bits: 0x3fffd5, N: 22}
		case 135:
			c = HuffmanCode{Bits: 0x7fffd9, N: 23}
		case 136:
			c = HuffmanCode{Bits: 0x3fffd6, N: 22}
		case 137:
			c = HuffmanCode{Bits: 0x7fffda, N: 23}
		case 138:
			c = HuffmanCode{Bits: 0x7fffdb, N: 23}
		case 139:
			c = HuffmanCode{Bits: 0x7fffdc, N: 23}
		case 140:
			c = HuffmanCode{Bits: 0x7fffdd, N: 23}
		case 141:
			c = HuffmanCode{Bits: 0x7fffde, N: 23}
		case 142:
			c = HuffmanCode{Bits: 0xffffeb, N: 24}
		case 143:
			c = HuffmanCode{Bits: 0x7fffdf, N: 23}
		case 144:
			c = HuffmanCode{Bits: 0xffffec, N: 24}
		case 145:
			c = HuffmanCode{Bits: 0xffffed, N: 24}
		case 146:
			c = HuffmanCode{Bits: 0x3fffd7, N: 22}
		case 147:
			c = HuffmanCode{Bits: 0x7fffe0, N: 23}
		case 148:
			c = HuffmanCode{Bits: 0xffffee, N: 24}
		case 149:
			c = HuffmanCode{Bits: 0x7fffe1, N: 23}
		case 150:
			c = HuffmanCode{Bits: 0x7fffe2, N: 23}
		case 151:
			c = HuffmanCode{Bits: 0x7fffe3, N: 23}
		case 152:
			c = HuffmanCode{Bits: 0x7fffe4, N: 23}
		case 153:
			c = HuffmanCode{Bits: 0x1fffdc, N: 21}
		case 154:
			c = HuffmanCode{Bits: 0x3fffd8, N: 22}
		case 155:
			c = HuffmanCode{Bits: 0x7fffe5, N: 23}
		case 156:
			c = HuffmanCode{Bits: 0x3fffd9, N: 22}
		case 157:
			c = HuffmanCode{Bits: 0x7fffe6, N: 23}
		case 158:
			c = HuffmanCode{Bits: 0x7fffe7, N: 23}
		case 159:
			c = HuffmanCode{Bits: 0xffffef, N: 24}
		case 160:
			c = HuffmanCode{Bits: 0x3fffda, N: 22}
		case 161:
			c = HuffmanCode{Bits: 0x1fffdd, N: 21}
		case 162:
			c = HuffmanCode{Bits: 0xfffe9, N: 20}
		case 163:
			c = HuffmanCode{Bits: 0x3fffdb, N: 22}
		case 164:
			c = HuffmanCode{Bits: 0x3fffdc, N: 22}
		case 165:
			c = HuffmanCode{Bits: 0x7fffe8, N: 23}
		case 166:
			c = HuffmanCode{Bits: 0x7fffe9, N: 23}
		case 167:
			c = HuffmanCode{Bits: 0x1fffde, N: 21}
		case 168:
			c = HuffmanCode{Bits: 0x7fffea, N: 23}
		case 169:
			c = HuffmanCode{Bits: 0x3fffdd, N: 22}
		case 170:
			c = HuffmanCode{Bits: 0x3fffde, N: 22}
		case 171:
			c = HuffmanCode{Bits: 0xfffff0, N: 24}
		case 172:
			c = HuffmanCode{Bits: 0x1fffdf, N: 21}
		case 173:
			c = HuffmanCode{Bits: 0x3fffdf, N: 22}
		case 174:
			c = HuffmanCode{Bits: 0x7fffeb, N: 23}
		case 175:
			c = HuffmanCode{Bits: 0x7fffec, N: 23}
		case 176:
			c = HuffmanCode{Bits: 0x1fffe0, N: 21}
		case 177:
			c = HuffmanCode{Bits: 0x1fffe1, N: 21}
		case 178:
			c = HuffmanCode{Bits: 0x3fffe0, N: 22}
		case 179:
			c = HuffmanCode{Bits: 0x1fffe2, N: 21}
		case 180:
			c = HuffmanCode{Bits: 0x7fffed, N: 23}
		case 181:
			c = HuffmanCode{Bits: 0x3fffe1, N: 22}
		case 182:
			c = HuffmanCode{Bits: 0x7fffee, N: 23}
		case 183:
			c = HuffmanCode{Bits: 0x7fffef, N: 23}
		case 184:
			c = HuffmanCode{Bits: 0xfffea, N: 20}
		case 185:
			c = HuffmanCode{Bits: 0x3fffe2, N: 22}
		case 186:
			c = HuffmanCode{Bits: 0x3fffe3, N: 22}
		case 187:
			c = HuffmanCode{Bits: 0x3fffe4, N: 22}
		case 188:
			c = HuffmanCode{Bits: 0x7ffff0, N: 23}
		case 189:
			c = HuffmanCode{Bits: 0x3fffe5, N: 22}
		case 190:
			c = HuffmanCode{Bits: 0x3fffe6, N: 22}
		case 191:
			c = HuffmanCode{Bits: 0x7ffff1, N: 23}
		case 192:
			c = HuffmanCode{Bits: 0x3ffffe0, N: 26}
		case 193:
			c = HuffmanCode{Bits: 0x3ffffe1, N: 26}
		case 194:
			c = HuffmanCode{Bits: 0xfffeb, N: 20}
		case 195:
			c = HuffmanCode{Bits: 0x7fff1, N: 19}
		case 196:
			c = HuffmanCode{Bits: 0x3fffe7, N: 22}
		case 197:
			c = HuffmanCode{Bits: 0x7ffff2, N: 23}
		case 198:
			c = HuffmanCode{Bits: 0x3fffe8, N: 22}
		case 199:
			c = HuffmanCode{Bits: 0x1ffffec, N: 25}
		case 200:
			c = HuffmanCode{Bits: 0x3ffffe2, N: 26}
		case 201:
			c = HuffmanCode{Bits: 0x3ffffe3, N: 26}
		case 202:
			c = HuffmanCode{Bits: 0x3ffffe4, N: 26}
		case 203:
			c = HuffmanCode{Bits: 0x7ffffde, N: 27}
		case 204:
			c = HuffmanCode{Bits: 0x7ffffdf, N: 27}
		case 205:
			c = HuffmanCode{Bits: 0x3ffffe5, N: 26}
		case 206:
			c = HuffmanCode{Bits: 0xfffff1, N: 24}
		case 207:
			c = HuffmanCode{Bits: 0x1ffffed, N: 25}
		case 208:
			c = HuffmanCode{Bits: 0x7fff2, N: 19}
		case 209:
			c = HuffmanCode{Bits: 0x1fffe3, N: 21}
		case 210:
			c = HuffmanCode{Bits: 0x3ffffe6, N: 26}
		case 211:
			c = HuffmanCode{Bits: 0x7ffffe0, N: 27}
		case 212:
			c = HuffmanCode{Bits: 0x7ffffe1, N: 27}
		case 213:
			c = HuffmanCode{Bits: 0x3ffffe7, N: 26}
		case 214:
			c = HuffmanCode{Bits: 0x7ffffe2, N: 27}
		case 215:
			c = HuffmanCode{Bits: 0xfffff2, N: 24}
		case 216:
			c = HuffmanCode{Bits: 0x1fffe4, N: 21}
		case 217:
			c = HuffmanCode{Bits: 0x1fffe5, N: 21}
		case 218:
			c = HuffmanCode{Bits: 0x3ffffe8, N: 26}
		case 219:
			c = HuffmanCode{Bits: 0x3ffffe9, N: 26}
		case 220:
			c = HuffmanCode{Bits: 0xffffffd, N: 28}
		case 221:
			c = HuffmanCode{Bits: 0x7ffffe3, N: 27}
		case 222:
			c = HuffmanCode{Bits: 0x7ffffe4, N: 27}
		case 223:
			c = HuffmanCode{Bits: 0x7ffffe5, N: 27}
		case 224:
			c = HuffmanCode{Bits: 0xfffec, N: 20}
		case 225:
			c = HuffmanCode{Bits: 0xfffff3, N: 24}
		case 226:
			c = HuffmanCode{Bits: 0xfffed, N: 20}
		case 227:
			c = HuffmanCode{Bits: 0x1fffe6, N: 21}
		case 228:
			c = HuffmanCode{Bits: 0x3fffe9, N: 22}
		case 229:
			c = HuffmanCode{Bits: 0x1fffe7, N: 21}
		case 230:
			c = HuffmanCode{Bits: 0x1fffe8, N: 21}
		case 231:
			c = HuffmanCode{Bits: 0x7ffff3, N: 23}
		case 232:
			c = HuffmanCode{Bits: 0x3fffea, N: 22}
		case 233:
			c = HuffmanCode{Bits: 0x3fffeb, N: 22}
		case 234:
			c = HuffmanCode{Bits: 0x1ffffee, N: 25}
		case 235:
			c = HuffmanCode{Bits: 0x1ffffef, N: 25}
		case 236:
			c = HuffmanCode{Bits: 0xfffff4, N: 24}
		case 237:
			c = HuffmanCode{Bits: 0xfffff5, N: 24}
		case 238:
			c = HuffmanCode{Bits: 0x3ffffea, N: 26}
		case 239:
			c = HuffmanCode{Bits: 0x7ffff4, N: 23}
		case 240:
			c = HuffmanCode{Bits: 0x3ffffeb, N: 26}
		case 241:
			c = HuffmanCode{Bits: 0x7ffffe6, N: 27}
		case 242:
			c = HuffmanCode{Bits: 0x3ffffec, N: 26}
		case 243:
			c = HuffmanCode{Bits: 0x3ffffed, N: 26}
		case 244:
			c = HuffmanCode{Bits: 0x7ffffe7, N: 27}
		case 245:
			c = HuffmanCode{Bits: 0x7ffffe8, N: 27}
		case 246:
			c = HuffmanCode{Bits: 0x7ffffe9, N: 27}
		case 247:
			c = HuffmanCode{Bits: 0x7ffffea, N: 27}
		case 248:
			c = HuffmanCode{Bits: 0x7ffffeb, N: 27}
		case 249:
			c = HuffmanCode{Bits: 0xffffffe, N: 28}
		case 250:
			c = HuffmanCode{Bits: 0x7ffffec, N: 27}
		case 251:
			c = HuffmanCode{Bits: 0x7ffffed, N: 27}
		case 252:
			c = HuffmanCode{Bits: 0x7ffffee, N: 27}
		case 253:
			c = HuffmanCode{Bits: 0x7ffffef, N: 27}
		case 254:
			c = HuffmanCode{Bits: 0x7fffff0, N: 27}
		case 255:
			c = HuffmanCode{Bits: 0x3ffffee, N: 26}
		}
		t.Codes[s] = c
	}
	t.EOS = HuffmanCode{Bits: 0x3fffffff, N: 30}
	return t
}
