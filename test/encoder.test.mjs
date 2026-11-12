import test from "node:test";
import assert from "node:assert/strict";
import {
  EdifactEncodeError,
  encodeExchange,
  encodeExchangeText,
} from "../dist/src/index.js";
import {
  DIRECT,
  GROUPED,
  allComponentTexts,
  expectParseError,
  parseAll,
  semanticExchange,
} from "./helpers.mjs";

const CUSTOM = "|~^\\!#";

test("re-encodes with a fixed UNA and no optional line breaks", () => {
  const [exchange] = parseAll(DIRECT);
  const text = encodeExchangeText(exchange, CUSTOM);

  assert.equal(text.startsWith(`${"UNA"}${CUSTOM}`), true);
  assert.equal(text.includes("\r"), false);
  assert.equal(text.includes("\n"), false);

  const [roundTrip] = parseAll(text);
  assert.deepEqual(semanticExchange(roundTrip), semanticExchange(exchange));
  assert.equal(roundTrip.unbRef, "EX1");
  assert.equal(roundTrip.directMessages[0].ref, "M1");
});

test("always emits UNA even when the original exchange had none", () => {
  const [exchange] = parseAll(DIRECT);
  assert.equal(exchange.unaPresent, false);
  const bytes = encodeExchange(exchange);
  const text = new TextDecoder().decode(bytes);
  assert.equal(text.startsWith("UNA:+.?*'"), true);
  const [roundTrip] = parseAll(bytes);
  assert.equal(roundTrip.unaPresent, true);
  assert.deepEqual(semanticExchange(roundTrip), semanticExchange(exchange));
});

test("escapes every output separator character in data", () => {
  const [exchange] = parseAll(
    "UNB+E'UNH+M+T'TST+|~^\\!#'UNT+3+M'UNZ+1+E'",
  );
  const text = encodeExchangeText(exchange, CUSTOM);
  const [roundTrip] = parseAll(text);
  const body = roundTrip.directMessages[0].body[0];
  assert.equal(body.elements[0][0][0].text, "|~^\\!#");

  const expectedRaw = ["|", "~", "^", "\\", "!", "#"]
    .map((character) => `\\${character}`)
    .join("");
  assert.equal(Buffer.from(body.elements[0][0][0].raw).toString(), expectedRaw);
});

test("escapes a release character in data exactly once", () => {
  const [exchange] = parseAll(
    "UNB+E'UNH+M+T'TST+A??B'UNT+3+M'UNZ+1+E'",
  );
  const text = encodeExchangeText(exchange);
  const [roundTrip] = parseAll(text);
  const component = roundTrip.directMessages[0].body[0].elements[0][0][0];
  assert.equal(component.text, "A?B");
  assert.equal(Buffer.from(component.raw).toString(), "A??B");
});

test("re-encodes grouped structures and their refs", () => {
  const [exchange] = parseAll(GROUPED);
  const [roundTrip] = parseAll(encodeExchange(exchange, CUSTOM));
  assert.deepEqual(semanticExchange(roundTrip), semanticExchange(exchange));
  assert.equal(roundTrip.mode, "group");
  assert.equal(roundTrip.groups[0].ref, "G1");
  assert.equal(roundTrip.groups[0].messages[0].ref, "GM1");
});

test("preserves trailing empty repetitions and components through a round trip", () => {
  const [exchange] = parseAll(
    "UNB+E'UNH+M+T'TST+a*::+b+'UNT+3+M'UNZ+1+E'",
  );
  const [roundTrip] = parseAll(encodeExchange(exchange));
  const body = roundTrip.directMessages[0].body[0];
  assert.deepEqual(allComponentTexts(body), [
    [["a"], ["", "", ""]],
    [["b"]],
    [[""]],
  ]);
  assert.deepEqual(semanticExchange(roundTrip), semanticExchange(exchange));
});

test("recomputes UNT counts from the actual body", () => {
  const [exchange] = parseAll(
    "UNB+E'UNH+M+T'BGM+1'FTX+A'UNT+4+M'UNZ+1+E'",
  );
  const message = exchange.directMessages[0];
  const shortened = {
    ...exchange,
    directMessages: [{ ...message, body: message.body.slice(0, 1) }],
  };

  const text = encodeExchangeText(shortened);
  assert.equal(text.includes("UNT+3+M'"), true);
  const [roundTrip] = parseAll(text);
  assert.equal(roundTrip.directMessages[0].body.length, 1);
  assert.equal(roundTrip.directMessages[0].segmentCount, 3);
  assert.equal(
    roundTrip.directMessages[0].unt.elements[0][0][0].text,
    "3",
  );
});

test("recomputes UNE and UNZ counts from actual group contents", () => {
  const [exchange] = parseAll(
    "UNB+G'UNG+G1'UNH+A+T'UNT+2+A'UNH+B+T'UNT+2+B'UNE+2+G1'UNZ+1+G'",
  );
  const group = exchange.groups[0];
  const shortened = {
    ...exchange,
    groups: [{ ...group, messages: group.messages.slice(0, 1) }],
  };

  const text = encodeExchangeText(shortened);
  assert.equal(text.includes("UNE+1+G1'"), true);
  const [roundTrip] = parseAll(text);
  assert.equal(roundTrip.groups[0].messages.length, 1);
  assert.equal(roundTrip.groups[0].count, 1);
  assert.equal(roundTrip.groups[0].une.elements[0][0][0].text, "1");
});

test("recomputes UNZ group count after removing a group", () => {
  const [exchange] = parseAll(
    "UNB+G'UNG+G1'UNH+A+T'UNT+2+A'UNE+1+G1'UNG+G2'UNH+B+T'UNT+2+B'UNE+1+G2'UNZ+2+G'",
  );
  const shortened = { ...exchange, groups: exchange.groups.slice(0, 1) };
  const text = encodeExchangeText(shortened);
  assert.equal(text.includes("UNZ+1+G'"), true);
  const [roundTrip] = parseAll(text);
  assert.equal(roundTrip.count, 1);
  assert.equal(roundTrip.groups.length, 1);
});

test("encodes an empty exchange with UNZ count zero", () => {
  const [exchange] = parseAll("UNB+E'UNZ+0+E'");
  const text = encodeExchangeText(exchange, CUSTOM);
  const [roundTrip] = parseAll(text);
  assert.equal(roundTrip.mode, "direct");
  assert.deepEqual(roundTrip.directMessages, []);
  assert.equal(
    roundTrip.unz.elements[0][0][0].text,
    "0",
  );
});

test("rejects invalid output separators", () => {
  const [exchange] = parseAll(DIRECT);
  for (const separators of [":+", ":+++++", "A+?*:'", "::::::\\"]) {
    assert.throws(
      () => encodeExchange(exchange, separators),
      (error) => {
        assert.ok(error instanceof EdifactEncodeError);
        assert.equal(error.name, "EdifactEncodeError");
        assert.equal(error.code, "separator");
        return true;
      },
    );
  }
});

test("round-trips two exchanges with different UNA choices", () => {
  const first = `UNA${CUSTOM}UNB~E1#UNZ~0~E1#`;
  const second = "UNA;%&?@$UNB%E2$UNZ%0%E2$";
  const [one, two] = parseAll(first + second);

  const oneText = encodeExchangeText(one, CUSTOM);
  const twoText = encodeExchangeText(two, ";%&?@$");
  const [roundOne] = parseAll(oneText);
  const [roundTwo] = parseAll(twoText);
  assert.deepEqual(semanticExchange(roundOne), semanticExchange(one));
  assert.deepEqual(semanticExchange(roundTwo), semanticExchange(two));
});

test("rejects duplicate refs when constructing an encoding", () => {
  const [exchange] = parseAll(
    "UNB+E'UNH+A+T'UNT+2+A'UNH+B+T'UNT+2+B'UNZ+2+E'",
  );
  const duplicate = {
    ...exchange,
    directMessages: [
      exchange.directMessages[0],
      { ...exchange.directMessages[1], ref: "A" },
    ],
  };
  assert.throws(
    () => encodeExchange(duplicate),
    (error) => {
      assert.ok(error instanceof EdifactEncodeError);
      assert.equal(error.name, "EdifactEncodeError");
      assert.equal(error.code, "ref");
      return true;
    },
  );
});

test("host can parse and re-encode in one call sequence", () => {
  const [exchange] = parseAll(DIRECT);
  const output = encodeExchange(exchange, ":+.?*'");
  const [again] = parseAll(output);
  assert.deepEqual(semanticExchange(again), semanticExchange(exchange));
  assert.equal(again.unbRef, "EX1");
});

test("accepts a separators object and escapes punctuation in refs", () => {
  const [exchange] = parseAll(
    "UNB+A?+B?:C?*D?.E??'UNZ+0+A?+B?:C?*D?.E??'",
  );
  const separators = {
    component: "|",
    element: "~",
    decimal: "^",
    release: "\\",
    repetition: "!",
    segment: "#",
  };
  const [roundTrip] = parseAll(encodeExchange(exchange, separators));
  assert.equal(roundTrip.unbRef, "A+B:C*D.E?");
  assert.equal(roundTrip.unz.elements[1][0][0].text, "A+B:C*D.E?");
  assert.deepEqual(semanticExchange(roundTrip), semanticExchange(exchange));
});
