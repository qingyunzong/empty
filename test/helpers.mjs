import assert from "node:assert/strict";
import { EdifactStreamParser } from "../dist/src/index.js";

export const DIRECT =
  "UNB+EX1'UNH+M1+ORDERS'BGM+123'UNT+3+M1'UNZ+1+EX1'";

export const GROUPED =
  "UNB+GEX1'UNG+G1'UNH+GM1+ORDERS'BGM+1'UNT+3+GM1'UNE+1+G1'UNZ+1+GEX1'";

export function parseAll(text, options = {}) {
  const exchanges = [];
  const parser = new EdifactStreamParser({
    ...options,
    onExchange: (exchange) => exchanges.push(exchange),
  });
  parser.push(text);
  parser.finish();
  return exchanges;
}

export function parseBytes(bytes, options = {}) {
  const exchanges = [];
  const parser = new EdifactStreamParser({
    ...options,
    onExchange: (exchange) => exchanges.push(exchange),
  });
  parser.push(bytes);
  parser.finish();
  return exchanges;
}

export function parseChunks(chunks, options = {}) {
  const exchanges = [];
  const parser = new EdifactStreamParser({
    ...options,
    onExchange: (exchange) => exchanges.push(exchange),
  });
  for (const chunk of chunks) {
    parser.push(chunk);
  }
  parser.finish();
  return exchanges;
}

export function expectParseError(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, "EdifactParseError");
    if (code !== undefined) {
      assert.equal(error.code, code);
    }
    return true;
  });
}

export function allComponentTexts(segment) {
  return segment.elements.map((element) =>
    element.map((repetition) => repetition.map((component) => component.text)),
  );
}

export function semanticSegment(segment) {
  return {
    tag: segment.tag,
    elements: allComponentTexts(segment),
  };
}

function semanticMessage(message) {
  return {
    ref: message.ref,
    type: message.type,
    segmentCount: message.segmentCount,
    unh: semanticSegment(message.unh),
    body: message.body.map(semanticSegment),
    unt: semanticSegment(message.unt),
  };
}

export function semanticExchange(exchange) {
  return {
    unbRef: exchange.unbRef,
    mode: exchange.mode,
    count: exchange.count,
    unb: semanticSegment(exchange.unb),
    unz: semanticSegment(exchange.unz),
    directMessages:
      exchange.directMessages === null
        ? null
        : exchange.directMessages.map(semanticMessage),
    groups:
      exchange.groups === null
        ? null
        : exchange.groups.map((group) => ({
            ref: group.ref,
            count: group.count,
            ung: semanticSegment(group.ung),
            une: semanticSegment(group.une),
            messages: group.messages.map(semanticMessage),
          })),
  };
}
