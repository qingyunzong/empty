package formal

import "strings"

// RType 是 DNS 资源记录类型（QTYPE）。
type RType uint16

// 本缓存关心的常用类型；TypeNXDOMAIN 是哨兵类型，用于按名称缓存 NXDOMAIN，
// 其值避开真实 DNS TYPE 编码空间。
const (
	TypeA        RType = 1
	TypeNS       RType = 2
	TypeCNAME    RType = 5
	TypeSOA      RType = 6
	TypePTR      RType = 12
	TypeMX       RType = 15
	TypeTXT      RType = 16
	TypeAAAA     RType = 28
	TypeSRV      RType = 33
	TypeNXDOMAIN RType = 65535
)

// RCode 是 DNS 响应码。
type RCode uint16

const (
	RCodeOK       RCode = 0
	RCodeFormErr  RCode = 1
	RCodeServFail RCode = 2
	RCodeNXDomain RCode = 3
	RCodeNotImp   RCode = 4
	RCodeRefused  RCode = 5
)

// RData 是记录数据。
type RData interface{ isRData() }

// CNAMERData 表示 CNAME 记录的目标名称（保留权威返回的原始大小写）。
type CNAMERData struct{ Target string }

// SOARData 表示 SOA 记录的字段。
type SOARData struct {
	NS      string
	MBox    string
	Serial  uint32
	Refresh uint32
	Retry   uint32
	Expire  uint32
	Minimum uint32
}

// AData / AAAAData 保存地址的文本形式，测试与查询路径只需等值比较。
type AData struct{ Addr string }
type AAAAData struct{ Addr string }
type NSData struct{ NS string }
type PTRData struct{ Ptr string }
type MXData struct {
	Pref uint16
	Host string
}
type TXTData struct{ Text string }
type SRVData struct {
	Priority uint16
	Weight   uint16
	Port     uint16
	Target   string
}

func (CNAMERData) isRData() {}
func (SOARData) isRData()   {}
func (AData) isRData()      {}
func (AAAAData) isRData()   {}
func (NSData) isRData()     {}
func (PTRData) isRData()    {}
func (MXData) isRData()     {}
func (TXTData) isRData()    {}
func (SRVData) isRData()    {}

// RR 是一条资源记录。TTL 为权威返回的原始 TTL（秒）。
type RR struct {
	Name  string
	Type  RType
	TTL   uint32
	RData RData
}

// Message 是权威应答的最小表示。查询路径只读 Answer/Authority/RCode。
type Message struct {
	Name      string
	QType     RType
	RCode     RCode
	Answer    []RR
	Authority []RR
}

// NormalizeName 按 RFC 4343 做大小写不敏感归一化：ASCII 字母转小写。
// 同一逻辑名称的不同大小写形式归一化后必须相等，用作缓存键。
func NormalizeName(name string) string {
	if name == "" {
		return ""
	}
	return strings.ToLower(name)
}

// SameName 判断两个名称在 DNS 语义上是否相同（大小写不敏感）。
func SameName(a, b string) bool {
	return NormalizeName(a) == NormalizeName(b)
}
