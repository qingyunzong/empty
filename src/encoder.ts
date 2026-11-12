import { normalizeSeparators, separatorBytes } from "./bytes.js";
import { EdifactEncodeError } from "./errors.js";
import type { ComponentValue, Exchange, Group, Message, Segment, Separators } from "./types.js";

const SERVICE_TAGS = new Set(["UNA", "UNB", "UNZ", "UNG", "UNE", "UNH", "UNT"]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F]/;

function assertTag(tag: string): void {
  if (!/^[A-Z]{3}$/.test(tag)) {
    throw new EdifactEncodeError(`invalid segment tag ${JSON.stringify(tag)}`, "tag");
  }
}

function assertText(text: string, label: string): void {
  if (text.length === 0) {
    throw new EdifactEncodeError(`${label} must not be empty`, "service-shape");
  }
  if (CONTROL_CHARACTER_PATTERN.test(text)) {
    throw new EdifactEncodeError(`${label} contains a control character`, "control-byte");
  }
}

function escapeData(text: string, separators: Separators): string {
  if (CONTROL_CHARACTER_PATTERN.test(text)) {
    throw new EdifactEncodeError("component data contains a control character", "control-byte");
  }
  const reserved = new Set([
    separators.component,
    separators.element,
    separators.decimal,
    separators.release,
    separators.repetition,
    separators.segment,
  ]);
  let encoded = "";
  for (const character of text) {
    encoded += reserved.has(character) ? `${separators.release}${character}` : character;
  }
  return encoded;
}

function encodeComponents(components: readonly ComponentValue[], separators: Separators): string {
  if (components.length === 0) {
    throw new EdifactEncodeError("repetition must contain at least one component", "shape");
  }
  return components
    .map((component) => escapeData(component.text, separators))
    .join(separators.component);
}

function encodeElements(segment: Segment, separators: Separators): string {
  let encoded = segment.tag;
  for (const element of segment.elements) {
    if (element.length === 0) {
      throw new EdifactEncodeError("element must contain at least one repetition", "shape");
    }
    encoded += separators.element;
    encoded += element
      .map((repetition) => encodeComponents(repetition, separators))
      .join(separators.repetition);
  }
  return encoded + separators.segment;
}

function encodeBusinessSegment(segment: Segment, separators: Separators): string {
  assertTag(segment.tag);
  if (SERVICE_TAGS.has(segment.tag)) {
    throw new EdifactEncodeError(
      `service segment ${segment.tag} cannot be encoded as business data`,
      "service-shape",
    );
  }
  return encodeElements(segment, separators);
}

function encodeService(tag: string, values: readonly string[], separators: Separators): string {
  let encoded = tag;
  for (const value of values) {
    encoded += separators.element;
    encoded += escapeData(value, separators);
  }
  return encoded + separators.segment;
}

function encodeMessage(
  message: Message,
  messageRefs: Set<string>,
  separators: Separators,
): string {
  assertText(message.ref, "message ref");
  assertText(message.type, "message type");
  if (messageRefs.has(message.ref)) {
    throw new EdifactEncodeError(`duplicate message ref ${message.ref}`, "ref");
  }
  messageRefs.add(message.ref);

  let encoded = encodeService("UNH", [message.ref, message.type], separators);
  for (const segment of message.body) {
    encoded += encodeBusinessSegment(segment, separators);
  }
  encoded += encodeService(
    "UNT",
    [String(message.body.length + 2), message.ref],
    separators,
  );
  return encoded;
}

function encodeGroup(
  group: Group,
  groupRefs: Set<string>,
  messageRefs: Set<string>,
  separators: Separators,
): string {
  assertText(group.ref, "group ref");
  if (groupRefs.has(group.ref)) {
    throw new EdifactEncodeError(`duplicate group ref ${group.ref}`, "ref");
  }
  groupRefs.add(group.ref);

  let encoded = encodeService("UNG", [group.ref], separators);
  for (const message of group.messages) {
    encoded += encodeMessage(message, messageRefs, separators);
  }
  encoded += encodeService("UNE", [String(group.messages.length), group.ref], separators);
  return encoded;
}

export function encodeExchange(
  exchange: Exchange,
  separatorsInput: Separators | string = exchange.separators,
): Uint8Array {
  const separators = normalizeSeparators(separatorsInput);
  const una = [
    "UNA",
    ...separatorBytes(separators).map((byte) => String.fromCharCode(byte)),
  ].join("");

  assertText(exchange.unbRef, "exchange ref");
  let body = encodeService("UNB", [exchange.unbRef], separators);
  const groupRefs = new Set<string>();
  const messageRefs = new Set<string>();

  if (exchange.mode === "group") {
    if (exchange.groups === null || exchange.directMessages !== null) {
      throw new EdifactEncodeError("group-mode exchange has inconsistent message data", "shape");
    }
    for (const group of exchange.groups) {
      body += encodeGroup(group, groupRefs, messageRefs, separators);
    }
    body += encodeService("UNZ", [String(exchange.groups.length), exchange.unbRef], separators);
  } else {
    if (exchange.directMessages === null || exchange.groups !== null) {
      throw new EdifactEncodeError("direct-mode exchange has inconsistent group data", "shape");
    }
    for (const message of exchange.directMessages) {
      body += encodeMessage(message, messageRefs, separators);
    }
    body += encodeService(
      "UNZ",
      [String(exchange.directMessages.length), exchange.unbRef],
      separators,
    );
  }

  return new TextEncoder().encode(una + body);
}

export function encodeExchangeText(
  exchange: Exchange,
  separatorsInput: Separators | string = exchange.separators,
): string {
  return new TextDecoder().decode(encodeExchange(exchange, separatorsInput));
}
