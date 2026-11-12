# 交换数据流的分隔符释放与信封计数

交换文件采集宿主要把多个连续的EDIFACT式交换解析为结构，不能先按加号或撇号切文本。开发TypeScript可导入流解析及重编码包，仅实现这里的封闭语法，不解释订单、账单等业务。每个交换开始可有9个ASCII字节的UNA，前三字节是UNA，后六字节依次指定component、element、decimal、release、repetition、segment分隔字符；六字节须互异、位于0x21..0x7E且非ASCII字母数字，无UNA时该交换独立重置为默认冒号、加号、句点、问号、星号、撇号，不继承上个交换。UNA固定九字节整体读取，不通过当前segment字符寻找结束。UNA只可在交换起点出现，不能作消息内普通tag；普通segment是三个大写ASCII字母tag，tag本身不允许release，后面零或多个由element分隔的元素，最后segment终止；元素由repetition分成多次，每次由component分成分量，所有连续及末尾空值均保留。release使紧随的一个字节成为数据，不再参与任何分隔或转义，允许释放普通字节；单独release在EOF报错，必须先处理释放再作结构分割，不能反复反转义。decimal只是数值字段约定，在普通数据中不切分。各最终分量须严格UTF8，返回文本及其全部原字节片段，释放字符的原位置也属于该分量来源；不能把被释放的分隔符重新用于切段。CR/LF只可在流首、UNA之后、完整segment之间或交换之间出现并忽略，普通分量中的CR/LF及其他0x00..0x1F字节拒绝。服务segment的简化契约如下：UNB有一个非空scalar交换ref；UNZ有count和匹配ref；UNG有一个非空scalar组ref；UNE有count和匹配组ref；UNH有非空scalar消息ref及非空scalar类型；UNT有segmentCount和匹配消息ref。scalar表示恰一次、恰一个分量，释放后的文本中可有任何可用标点；count严格为无前导零的非负十进制整数，0单独合法。其余tag只能在消息内作为普通业务segment，所有服务tag仅可出现在对应位置，不能当普通数据跳过。一个UNB内要么全部直接UNH/UNT消息，要么全部UNG/UNE组，不能混用；组不能嵌套，每组含零或多个消息，消息不能嵌套。消息segmentCount包括自己的UNH与UNT，组count是该组消息数，UNZ的count在分组模式为组数、直接模式为消息数；空交换UNB后直接UNZ+0+ref合法。组ref在交换内唯一，消息ref也在整个交换内唯一，不能只在各组内查重；不同交换可重用ref。完整交换全部语法、计数与ref通过后才一次交付，后续坏交换保留已交付的前交换，失败实例进入终态且不可继续push；finish残UNA、残segment或未闭合信封均拒绝，不把EOF当隐式终止符。宿主限制单交换输入字节、segment数、分量UTF8字节及重复值个数，读取期间检查，不按声明count分配。重编码接受解析结构及一组合法六字符分隔符，按原有元素/重复/分量次序生成数据，重新计算所有服务计数，数据中六个保留字符一律先加release，固定输出UNA且不输出可选换行；再次解析须得到相同结构和ref，不要求复原原空白或原转义写法。给宿主调用例与独立构造测试，覆盖释放后的release、跨块UTF8、末尾空重复/分量、两个交换不同UNA、分组与直接混用、跨组重复消息ref、UNT差1和第二交换损坏；枚举每个字节切块位置，检查没有半交换回调，不依赖外部EDI服务。

## 实现

- 字节级增量状态机：交换边界、固定九字节 UNA、release 感知的 segment 扫描、segment 内元素/重复/分量展开。
- 完整交换在 UNZ 通过全部语法、计数和 ref 校验后才回调；失败后 parser 进入终态。
- `encodeExchange` / `encodeExchangeText` 从解析结构重编码，始终输出 UNA、转义六个保留字符，并重算 UNT/UNE/UNZ 计数。

## 宿主调用例

```ts
import type { Exchange } from "dataeng-20261112-0303";
import { EdifactStreamParser, encodeExchange } from "dataeng-20261112-0303";

const parser = new EdifactStreamParser({
  limits: {
    maxExchangeBytes: 1_000_000,
    maxSegments: 10_000,
    maxComponentBytes: 64 * 1024,
    maxRepetitions: 1_000,
  },
  onExchange(exchange) {
    // 只有完整且计数/ref 全部通过的交换才会到达这里。
    consume(exchange);
  },
});

for await (const chunk of source) {
  parser.push(chunk); // 推荐传 Uint8Array；也接受 string
}
parser.finish(); // 残 UNA、残 segment、未闭合信封都会抛错

function consume(exchange: Exchange): void {
  // 业务层只读取 exchange 结构，package 不解释 ORDERS/INVOIC 等业务。
  console.log(exchange.unbRef, exchange.mode);
}
```

解析结构的关键形状：

- `exchange.directMessages`：直接模式下的消息数组；空交换为 `[]`。
- `exchange.groups`：分组模式下的组数组；直接模式为 `null`。
- `segment.elements -> repetition -> component`，每一层都保留连续和末尾空值。
- 每个 `component` 含 `text`、原始 `raw` 字节，以及 `byteStart` / `byteEnd`。

重编码示例：

```ts
const output = encodeExchange(exchange, "|~^\\!#"); // 六个字符：component/element/decimal/release/repetition/segment
// output 为 Uint8Array；固定以 UNA|~^\!# 开头，不含可选 CR/LF。
```

## 测试

```bash
npm run build
npm test
```

测试覆盖 release 后的 release、跨块 UTF-8、末尾空重复/分量、两个交换不同 UNA、分组/直接模式互斥、跨组重复消息 ref、UNT 差 1、第二交换损坏保留已交付交换，以及逐字节/多切点分块下不存在半交换回调。实现不依赖任何外部 EDI 服务。
