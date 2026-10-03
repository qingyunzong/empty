"use strict";

const fs = require("node:fs");
const path = require("node:path");

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

module.exports = { writeJsonAtomic, readJsonFile };
