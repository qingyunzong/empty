"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const rational_1 = require("./rational");
const ellipse_1 = require("./ellipse");
const intersect_1 = require("./intersect");
// Usage: node dist/src/cli.js A B C D E F -- a b c
// Ellipse: A x^2 + B x y + C y^2 + D x + E y + F = 0
// Line:    a x + b y + c = 0
// Coefficients are integers or fractions like -3/4.
const args = process.argv.slice(2);
const sep = args.indexOf("--");
if (sep !== 6 || args.length !== 10) {
    console.error("usage: cli A B C D E F -- a b c   (ellipse coeffs -- line coeffs)");
    process.exit(2);
}
const nums = args.filter((s) => s !== "--").map(rational_1.Rat.parse);
const [A, B, C, D, E, F, a, b, c] = nums;
let ellipse;
let line;
try {
    ellipse = ellipse_1.Ellipse.create(A, B, C, D, E, F);
    line = new ellipse_1.Line(a, b, c);
}
catch (err) {
    console.error(`rejected: ${err.message}`);
    process.exit(1);
}
const result = (0, intersect_1.intersectEllipseLine)(ellipse, line);
const showPoint = (pt) => {
    console.log(`  x = ${pt.x}   (~${pt.x.approx()})`);
    console.log(`  y = ${pt.y}   (~${pt.y.approx()})`);
    console.log(`  t in [${pt.tInterval.lo}, ${pt.tInterval.hi}]`);
};
console.log(`discriminant = ${result.discriminant}`);
switch (result.kind) {
    case "none":
        console.log("no intersection");
        break;
    case "tangent":
        console.log("tangent point:");
        showPoint(result.point);
        break;
    case "two":
        console.log("two intersection points:");
        showPoint(result.points[0]);
        showPoint(result.points[1]);
        break;
}
