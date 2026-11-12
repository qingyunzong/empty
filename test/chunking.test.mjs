import test from "node:test";
import assert from "node:assert/strict";
import { EdifactStreamParser } from "../dist/src/index.js";

const CUSTOM_UNA = "UNA|~^\\!#";
const STREAM =
  CUSTOM_UNA +
  "UNB~E1#UNH~M1~T#TST~\u4f60\u597d#UNT~3~M1#UNZ~1~E1#" +
  "UNB+E2'UNG+G2'UNH+M2+T'UNT+2+M2'UNE+1+G2'UNZ+1+E2'";

function assertCompleteExchange(exchange) {
  assert.equal(exchange.unb.tag, "UNB");
  assert.equal(exchange.unz.tag, "UNZ");
  assert.ok(exchange.byteEnd > exchange.byteStart);
  if (exchange.mode === "direct") {
    for (const message of exchange.directMessages) {
      assert.equal(message.unh.tag, "UNH");
      assert.equal(message.unt.tag, "UNT");
    }
  } else {
    for (const group of exchange.groups) {
      assert.equal(group.ung.tag, "UNG");
      assert.equal(group.une.tag, "UNE");
      for (const message of group.messages) {
        assert.equal(message.unh.tag, "UNH");
        assert.equal(message.unt.tag, "UNT");
      }
    }
  }
}

test("every two-chunk split never exposes a partial exchange", () => {
  const bytes = new TextEncoder().encode(STREAM);

  for (let split = 0; split <= bytes.length; split += 1) {
    const delivered = [];
    const parser = new EdifactStreamParser({
      onExchange: (exchange) => delivered.push(exchange),
    });

    parser.push(bytes.slice(0, split));
    for (const exchange of delivered) {
      assertCompleteExchange(exchange);
      assert.ok(exchange.byteEnd <= split);
    }
    assert.ok(delivered.length <= 2);

    parser.push(bytes.slice(split));
    parser.finish();
    assert.equal(delivered.length, 2);
    for (const exchange of delivered) {
      assertCompleteExchange(exchange);
      assert.ok(exchange.byteEnd <= bytes.length);
    }
    assert.equal(delivered[0].unbRef, "E1");
    assert.equal(delivered[1].unbRef, "E2");
  }
});

test("single-byte chunks do not fire callbacks before UNZ completes", () => {
  const bytes = new TextEncoder().encode(STREAM);
  const delivered = [];
  const parser = new EdifactStreamParser({
    onExchange: (exchange) => delivered.push(exchange),
  });

  for (let index = 0; index < bytes.length; index += 1) {
    parser.push(bytes.slice(index, index + 1));
    for (const exchange of delivered) {
      assertCompleteExchange(exchange);
      assert.ok(exchange.byteEnd <= index + 1);
    }
  }
  parser.finish();

  assert.equal(delivered.length, 2);
  assert.equal(
    delivered[0].directMessages[0].body[0].elements[0][0][0].text,
    "\u4f60\u597d",
  );
});

test("a callback is not fired one byte before UNZ is terminated", () => {
  const bytes = new TextEncoder().encode(STREAM);
  const delivered = [];
  const parser = new EdifactStreamParser({
    onExchange: (exchange) => delivered.push(exchange),
  });

  const firstExchangeEnd = new TextEncoder().encode(
    CUSTOM_UNA +
      "UNB~E1#UNH~M1~T#TST~\u4f60\u597d#UNT~3~M1#UNZ~1~E1#",
  ).length;
  parser.push(bytes.slice(0, firstExchangeEnd - 1));
  assert.equal(delivered.length, 0);
  parser.push(bytes.slice(firstExchangeEnd - 1, firstExchangeEnd));
  assert.equal(delivered.length, 1);
  assertCompleteExchange(delivered[0]);

  parser.push(bytes.slice(firstExchangeEnd));
  parser.finish();
  assert.equal(delivered.length, 2);
});

test("all possible three-chunk boundaries keep delivery atomic", () => {
  const bytes = new TextEncoder().encode(STREAM);
  const boundaries = bytes.length;
  for (let first = 0; first <= boundaries; first += 1) {
    for (let second = first; second <= boundaries; second += 1) {
      const delivered = [];
      const parser = new EdifactStreamParser({
        onExchange: (exchange) => delivered.push(exchange),
      });
      parser.push(bytes.slice(0, first));
      parser.push(bytes.slice(first, second));
      for (const exchange of delivered) {
        assertCompleteExchange(exchange);
        assert.ok(exchange.byteEnd <= second);
      }
      parser.push(bytes.slice(second));
      parser.finish();
      assert.equal(delivered.length, 2);
    }
  }
});
