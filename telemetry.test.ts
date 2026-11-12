import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TelemetryDecoder,
  TelemetryProtocolError,
  type ControlFrame,
  type InformationFrame,
  type SupervisoryFrame,
  type TelemetryFrame,
} from "./telemetry.ts";

// Test-side frame builders: sequence numbers are split into bytes here,
// independently of the module under test.

function sequenceBytes(sequence: number): [number, number] {
  const raw = (sequence * 2) % 65536;
  return [raw % 256, Math.floor(raw / 256)];
}

function wrap(apdu: number[]): Uint8Array {
  return Uint8Array.from([0x68, apdu.length, ...apdu]);
}

function informationBytes(send: number, receive: number, data: number[]): Uint8Array {
  const [s0, s1] = sequenceBytes(send);
  const [r0, r1] = sequenceBytes(receive);
  return wrap([s0, s1, r0, r1, ...data]);
}

function supervisoryBytes(receive: number): Uint8Array {
  const [r0, r1] = sequenceBytes(receive);
  return wrap([0x01, 0x00, r0, r1]);
}

function controlBytes(functionBits: number): Uint8Array {
  return wrap([((functionBits & 0x3f) << 2) | 0x03, 0x00, 0x00, 0x00]);
}

const PAYLOAD = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06];

function makeDecoder(expectedSendSequence = 0, maxApdu = 253) {
  const frames: TelemetryFrame[] = [];
  const decoder = new TelemetryDecoder({
    maxApdu,
    expectedSendSequence,
    onFrame: (frame) => frames.push(frame),
  });
  return { decoder, frames };
}

test("信息帧保留数据并按模32768推进期望发送序号", () => {
  const { decoder, frames } = makeDecoder();
  const secondPayload = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00];
  const returned = decoder.push(
    Uint8Array.from([...informationBytes(0, 10, PAYLOAD), ...informationBytes(1, 11, secondPayload)]),
  );
  decoder.end();

  assert.equal(frames.length, 2);
  assert.deepEqual(returned, frames);
  const first = frames[0] as InformationFrame;
  assert.equal(first.kind, "information");
  assert.equal(first.sendSequence, 0);
  assert.equal(first.receiveSequence, 10);
  assert.deepEqual([...first.data], PAYLOAD);
  assert.equal((frames[1] as InformationFrame).sendSequence, 1);
  assert.deepEqual([...(frames[1] as InformationFrame).data], secondPayload);
  assert.equal(decoder.expectedSendSequence, 2);
});

test("第二字节最低位属于发送序号而不是标志", () => {
  // 序号128编码为 [0x00, 0x01]：第二字节最低位是序号的第8位。
  const { decoder, frames } = makeDecoder(128);
  decoder.push(informationBytes(128, 0, PAYLOAD));
  decoder.end();
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as InformationFrame).sendSequence, 128);
  assert.equal(decoder.expectedSendSequence, 129);

  // 若把该位当标志丢弃，[0x00, 0x01] 会被误读成序号0；期望0时必须拒绝。
  const { decoder: strict } = makeDecoder(0);
  assert.throws(() => strict.push(informationBytes(128, 0, PAYLOAD)), TelemetryProtocolError);
});

test("发送序号32767之后回绕到0", () => {
  const { decoder, frames } = makeDecoder(32767);
  decoder.push(informationBytes(32767, 0, PAYLOAD));
  assert.equal(decoder.expectedSendSequence, 0);
  decoder.push(informationBytes(0, 0, PAYLOAD));
  decoder.end();
  assert.deepEqual(
    frames.map((frame) => (frame as InformationFrame).sendSequence),
    [32767, 0],
  );
  assert.equal(decoder.expectedSendSequence, 1);
});

test("监视帧夹在信息帧之间且不推进发送序号", () => {
  const { decoder, frames } = makeDecoder(5);
  decoder.push(informationBytes(5, 100, PAYLOAD));
  decoder.push(supervisoryBytes(100));
  assert.equal(decoder.expectedSendSequence, 6);
  decoder.push(controlBytes(0x04));
  assert.equal(decoder.expectedSendSequence, 6);
  decoder.push(informationBytes(6, 101, PAYLOAD));
  decoder.end();

  assert.deepEqual(
    frames.map((frame) => frame.kind),
    ["information", "supervisory", "control", "information"],
  );
  assert.equal((frames[1] as SupervisoryFrame).receiveSequence, 100);
  assert.equal((frames[2] as ControlFrame).functionBits, 0x04);
  assert.equal(decoder.expectedSendSequence, 7);
});

test("接收序号原样返回且不在模块内推进", () => {
  const { decoder, frames } = makeDecoder(0);
  decoder.push(informationBytes(0, 5000, PAYLOAD));
  decoder.push(informationBytes(1, 3, PAYLOAD));
  decoder.end();
  assert.deepEqual(
    frames.map((frame) => (frame as InformationFrame).receiveSequence),
    [5000, 3],
  );
});

test("长度为4的信息帧被拒绝", () => {
  const { decoder } = makeDecoder();
  assert.throws(() => decoder.push(wrap([0x00, 0x00, 0x00, 0x00])), TelemetryProtocolError);
});

test("控制帧多个功能位或没有功能位被拒绝", () => {
  const { decoder: multi } = makeDecoder();
  assert.throws(() => multi.push(controlBytes(0x03)), TelemetryProtocolError);

  const { decoder: none } = makeDecoder();
  assert.throws(() => none.push(controlBytes(0x00)), TelemetryProtocolError);

  const { decoder: trailing } = makeDecoder();
  assert.throws(
    () => trailing.push(wrap([0x0b, 0x00, 0x00, 0x01])),
    TelemetryProtocolError,
  );

  const { decoder: long } = makeDecoder();
  assert.throws(
    () => long.push(wrap([0x07, 0x00, 0x00, 0x00, 0x00])),
    TelemetryProtocolError,
  );
});

test("监视帧的保留字节、长度与接收序号格式位校验", () => {
  const { decoder: secondByte } = makeDecoder();
  assert.throws(
    () => secondByte.push(wrap([0x01, 0x01, 0x00, 0x00])),
    TelemetryProtocolError,
  );

  const { decoder: long } = makeDecoder();
  assert.throws(
    () => long.push(wrap([0x01, 0x00, 0x00, 0x00, 0x00])),
    TelemetryProtocolError,
  );

  const { decoder: formatBit } = makeDecoder();
  assert.throws(
    () => formatBit.push(wrap([0x01, 0x00, 0x01, 0x00])),
    TelemetryProtocolError,
  );
});

test("信息帧接收序号的格式位必须为零", () => {
  const { decoder } = makeDecoder();
  const [s0, s1] = sequenceBytes(0);
  assert.throws(
    () => decoder.push(wrap([s0, s1, 0x01, 0x00, ...PAYLOAD])),
    TelemetryProtocolError,
  );
});

test("乱序的发送序号被拒绝", () => {
  const { decoder } = makeDecoder(4);
  assert.throws(() => decoder.push(informationBytes(5, 0, PAYLOAD)), TelemetryProtocolError);
});

test("声明长度小于4或大于宿主maxApdu时立即拒绝", () => {
  const { decoder: tooSmall } = makeDecoder();
  assert.throws(() => tooSmall.push(Uint8Array.from([0x68, 0x03, 0x00])), TelemetryProtocolError);

  const { decoder: tooBig } = makeDecoder(0, 16);
  assert.throws(() => tooBig.push(Uint8Array.from([0x68, 0x11])), TelemetryProtocolError);

  const { decoder: beyond253 } = makeDecoder(0, 253);
  assert.throws(() => beyond253.push(Uint8Array.from([0x68, 0xfe])), TelemetryProtocolError);
});

test("起始字节不是0x68时拒绝", () => {
  const { decoder } = makeDecoder();
  assert.throws(() => decoder.push(Uint8Array.from([0x69, 0x04, 0, 0, 0, 0])), TelemetryProtocolError);
});

test("push可停在长度或控制域中间，逐字节喂入结果一致", () => {
  const stream = Uint8Array.from([
    ...informationBytes(0, 7, PAYLOAD),
    ...supervisoryBytes(8),
    ...informationBytes(1, 9, PAYLOAD),
  ]);

  const { decoder, frames } = makeDecoder();
  // 第一刀停在长度字节之前，第二刀停在控制域中间。
  const firstCut = 1;
  const secondCut = 2 + 3;
  assert.deepEqual(decoder.push(stream.subarray(0, firstCut)), []);
  assert.deepEqual(decoder.push(stream.subarray(firstCut, secondCut)), []);
  decoder.push(stream.subarray(secondCut, stream.length - 3));
  decoder.push(stream.subarray(stream.length - 3));
  decoder.end();
  assert.equal(frames.length, 3);

  const { decoder: bytewise, frames: bytewiseFrames } = makeDecoder();
  for (const byte of stream) {
    bytewise.push(Uint8Array.from([byte]));
  }
  bytewise.end();
  assert.deepEqual(
    bytewiseFrames.map((frame) => frame.kind),
    frames.map((frame) => frame.kind),
  );
});

test("结束时帧未完成则失败", () => {
  const { decoder } = makeDecoder();
  decoder.push(Uint8Array.from([0x68, 0x0a, 0x00]));
  assert.throws(() => decoder.end(), TelemetryProtocolError);
});

test("失败停止组件，已交付帧保留", () => {
  const { decoder, frames } = makeDecoder();
  decoder.push(informationBytes(0, 0, PAYLOAD));
  assert.throws(() => decoder.push(Uint8Array.from([0x68, 0x02])), TelemetryProtocolError);

  assert.equal(decoder.failed, true);
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as InformationFrame).sendSequence, 0);

  assert.throws(() => decoder.push(informationBytes(1, 0, PAYLOAD)), TelemetryProtocolError);
  assert.throws(() => decoder.end(), TelemetryProtocolError);
  assert.equal(frames.length, 1);
});
