import { describe, it } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { AmountDocument } from '../src/editor.js';
import { parseAmount } from '../src/parser.js';

function createDoc(text: string): AmountDocument {
  const r = AmountDocument.create(text);
  if (!r.ok) throw new Error(`建文档失败: ${text}: ${r.error}`);
  return r.doc;
}

describe('文档创建与快照', () => {
  it('创建即发布版本 0', () => {
    const doc = createDoc('1亿2万3.45');
    equal(doc.versionCount, 1);
    const v0 = doc.currentVersion;
    equal(v0.index, 0);
    equal(v0.text, '1亿2万3.45');
    equal(v0.cents, 10002000345);
  });

  it('非法初始文本被拒绝', () => {
    ok(!AmountDocument.create('1万2万').ok);
    ok(!AmountDocument.create('').ok);
    ok(!AmountDocument.create('1.234').ok);
  });
});

describe('增量编辑：只重算受影响段', () => {
  it('编辑万段后重算，其他段 token 保持身份与原字节', () => {
    const doc = createDoc('1亿2万3.45');
    const v0 = doc.currentVersion;
    const yiDigit = v0.tokens.find((t) => t.text === '1');
    const onesDigit = v0.tokens.find((t) => t.text === '3');
    const decDigit = v0.tokens.find((t) => t.text === '4');
    ok(yiDigit && onesDigit && decDigit);

    const r = doc.setSegment('wan', '6千7百');
    ok(r.ok);
    const v1 = r.version;
    equal(v1.text, '1亿6千7百万3.45');
    equal(v1.cents, 16700000345);
    equal(doc.versionCount, 2);

    // 未受影响段的 token id 不变（词法结构保留）
    const yiDigit1 = v1.tokens.find((t) => t.text === '1');
    const onesDigit1 = v1.tokens.find((t) => t.text === '3');
    const decDigit1 = v1.tokens.find((t) => t.text === '4');
    equal(yiDigit1?.id, yiDigit.id);
    equal(onesDigit1?.id, onesDigit.id);
    equal(decDigit1?.id, decDigit.id);

    // 字节偏移重排正确（UTF-8：亿/万 3 字节）
    const texts = v1.tokens.map((t) => [t.text, t.byteOffset] as const);
    deepEqual(texts, [
      ['1', 0], ['亿', 1], ['6', 4], ['千', 5], ['7', 8], ['百', 9], ['万', 12],
      ['3', 15], ['.', 16], ['4', 17], ['5', 18],
    ]);
    // 与完整解析一致
    const full = parseAmount(v1.text);
    ok(full.ok);
    equal(full.cents, v1.cents);
  });

  it('编辑亿段与个段、增删小数段', () => {
    const doc = createDoc('1亿2万3');
    ok(doc.setSegment('yi', '9千9百').ok);
    equal(doc.currentVersion.text, '9千9百亿2万3');
    equal(doc.currentVersion.cents, 99000002000300); // 990000020003 元
    ok(doc.setSegment('ones', '4千5').ok); // 4千5 = 4500（单位后裸数字按位落位）
    equal(doc.currentVersion.text, '9千9百亿2万4千5');
    equal(doc.currentVersion.cents, 99000002450000); // 990000024500 元
    ok(doc.setSegment('decimals', '05').ok);
    equal(doc.currentVersion.text, '9千9百亿2万4千5.05');
    equal(doc.currentVersion.cents, 99000002450005);
    ok(doc.setSegment('decimals', '').ok); // 删除小数段
    equal(doc.currentVersion.text, '9千9百亿2万4千5');
    ok(doc.setSegment('yi', '').ok); // 删除亿段
    equal(doc.currentVersion.text, '2万4千5');
    equal(doc.currentVersion.cents, 2450000); // 24500 元
  });
});

describe('来源查询：某金额位由哪些原 token 决定', () => {
  it('1亿2千3百万45.67', () => {
    const doc = createDoc('1亿2千3百万45.67');
    const v = doc.currentVersion;
    equal(v.cents, 12300004567);
    const textsAt = (place: number): string[] => v.digitSource(place).map((t) => t.text);
    deepEqual(textsAt(1), ['7']);
    deepEqual(textsAt(10), ['6', '7']);
    deepEqual(textsAt(100), ['5', '6', '7']);
    deepEqual(textsAt(1000), ['4', '5', '6', '7']);
    deepEqual(textsAt(10000000000), ['1', '2', '3', '4', '5', '6', '7']);
    // 单位与分隔符不决定任何位
    ok(!textsAt(10000000000).includes('亿'));
    ok(!textsAt(10000000000).includes('万'));
    ok(!textsAt(10000000000).includes('千'));
  });
});

describe('错误编辑不发布，旧快照不变', () => {
  it('各类非法编辑均被拒绝且状态不变', () => {
    const doc = createDoc('1亿2万3.45');
    const before = doc.currentVersion;
    const beforeCount = doc.versionCount;

    const badEdits: [Parameters<AmountDocument['setSegment']>[0], string][] = [
      ['wan', '1万'],        // 段内含分隔符
      ['wan', '1千2千'],     // 重复单位
      ['wan', '2百3千'],     // 单位逆序
      ['yi', '99999'],       // 段溢出
      ['yi', '零'],          // 亿段无数字
      ['decimals', '123'],   // 小数超两位
      ['decimals', '1零'],   // 小数含非数字
      ['ones', 'abc'],       // 非法字符
      ['ones', '10000'],     // 个段溢出
    ];
    for (const [role, content] of badEdits) {
      const r = doc.setSegment(role, content);
      ok(!r.ok, `期望拒绝 ${role} <- ${JSON.stringify(content)}`);
      equal(doc.versionCount, beforeCount, '错误编辑不得发布新版本');
      equal(doc.currentVersion, before, '错误编辑不得改变当前快照');
      equal(doc.currentVersion.text, '1亿2万3.45');
    }
  });

  it('删除个段且无万亿段时拒绝', () => {
    const doc = createDoc('123.45');
    const r = doc.setSegment('ones', '');
    ok(!r.ok);
    equal(doc.currentVersion.text, '123.45');
  });

  it('成功编辑后旧快照内容不变', () => {
    const doc = createDoc('1亿2万3.45');
    const v0 = doc.currentVersion;
    const v0Digits = JSON.stringify(v0.digits);
    ok(doc.setSegment('wan', '6千7百').ok);
    ok(doc.setSegment('decimals', '99').ok);
    equal(doc.versionCount, 3);
    // 旧快照不变
    equal(doc.versionAt(0), v0);
    equal(v0.text, '1亿2万3.45');
    equal(v0.cents, 10002000345);
    equal(JSON.stringify(v0.digits), v0Digits);
    equal(doc.versionAt(1).text, '1亿6千7百万3.45');
    equal(doc.currentVersion.text, '1亿6千7百万3.99');
    equal(doc.currentVersion.cents, 16700000399);
  });
});
