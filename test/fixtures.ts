import type { DecoderLimitOverrides } from "../index.js";
import { bytes } from "./helpers.js";

export interface WireFixture {
  name: string;
  wire: Uint8Array;
  limits?: DecoderLimitOverrides;
}

export const validFixtures: WireFixture[] = [
  {
    name: "scalars, errors, null, int64 edges",
    wire: bytes(
      "+hello world\r\n",
      "-ERR something failed\r\n",
      ":0\r\n",
      ":-17\r\n",
      ":9223372036854775807\r\n",
      ":-9223372036854775808\r\n",
      "_\r\n",
      "+empty\r\n",
      "-\r\n",
      ":0\r\n",
    ),
  },
  {
    name: "fixed and empty blobs containing CRLF and a fake push marker",
    wire: bytes(
      "$9\r\nabc\r\n>xyz\r\n",
      "$0\r\n\r\n",
      "$3\r\n\r\n>\r\n",
    ),
  },
  {
    name: "streaming blob chunks",
    wire: bytes(
      "$?\r\n",
      ";5\r\n",
      ">\r\nab",
      "\r\n",
      ";3\r\n",
      "x\r\n",
      "\r\n",
      ";0\r\n",
      "$?\r\n;0\r\n",
    ),
  },
  {
    name: "nested arrays and empty fixed containers",
    wire: bytes(
      "*4\r\n",
      "+a\r\n",
      "*2\r\n:1\r\n_\r\n",
      "$?\r\n;2\r\nhi\r\n;0\r\n",
      "%0\r\n",
      "*0\r\n",
      "%2\r\n",
      "+x\r\n:1\r\n",
      "+x\r\n:2\r\n",
    ),
  },
  {
    name: "map keys may be arrays and blobs; duplicate keys stay ordered",
    wire: bytes(
      "%4\r\n",
      "*1\r\n+array-key\r\n",
      "+array-value\r\n",
      "$6\r\nblob-k\r\n",
      ":7\r\n",
      "+dup\r\n:1\r\n",
      "+dup\r\n:2\r\n",
    ),
  },
  {
    name: "consecutive top-level attributes with duplicate keys",
    wire: bytes(
      "|1\r\n+k1\r\n:1\r\n",
      "|2\r\n+k2\r\n:2\r\n+k2\r\n:3\r\n",
      "|0\r\n",
      "+OK\r\n",
    ),
  },
  {
    name: "attributes nested inside attribute keys and values",
    wire: bytes(
      "|2\r\n",
      "|1\r\n+inner\r\n:9\r\n",
      "+k1\r\n:1\r\n",
      "+k2\r\n",
      "|1\r\n+x\r\n:8\r\n",
      ":2\r\n",
      "+OK\r\n",
    ),
  },
  {
    name: "attributes on array elements and map keys/values",
    wire: bytes(
      "*2\r\n",
      "|1\r\n+e1\r\n:1\r\n",
      "+first\r\n",
      "|2\r\n+e2a\r\n:2\r\n+e2b\r\n:3\r\n",
      "*1\r\n+second\r\n",
      "%1\r\n",
      "|1\r\n+mk\r\n:1\r\n",
      "+k\r\n",
      "|1\r\n+mv\r\n:2\r\n",
      "+v\r\n",
    ),
  },
  {
    name: "fixed push with attributes on push and payload",
    wire: bytes(
      "|1\r\n+meta\r\n:1\r\n",
      ">2\r\n",
      "|1\r\n+item\r\n:2\r\n",
      "+hello\r\n",
      ":42\r\n",
    ),
  },
  {
    name: "a push between two normal responses",
    wire: bytes(
      "+first\r\n",
      "|1\r\n+kind\r\n+notice\r\n",
      ">2\r\n+payload-a\r\n+payload-b\r\n",
      "-ERR second\r\n",
    ),
  },
  {
    name: "streaming array",
    wire: bytes(
      "*?\r\n",
      "+one\r\n",
      "|1\r\n+a\r\n:1\r\n",
      "+two\r\n",
      ".\r\n",
    ),
  },
  {
    name: "streaming map with attributes",
    wire: bytes(
      "%?\r\n",
      "|1\r\n+key-attr\r\n:1\r\n",
      "+k1\r\n",
      "|1\r\n+value-attr\r\n:2\r\n",
      "+v1\r\n",
      "+k2\r\n:2\r\n",
      ".\r\n",
    ),
  },
  {
    name: "empty streaming array and map",
    wire: bytes("*?\r\n.\r\n%?\r\n.\r\n"),
  },
  {
    name: "multi-byte line headers inside a streaming blob",
    wire: bytes(
      "$?\r\n",
      ";1",
      "0\r\n",
      "0123456789",
      "\r\n",
      ";0",
      "\r\n",
    ),
  },
  {
    name: "attributes attached to null and error responses",
    wire: bytes(
      "|1\r\n+tag\r\n+x\r\n_\r\n",
      "|1\r\n+tag\r\n+y\r\n-ERR no\r\n",
    ),
  },
];
