// Compare state hashes between two result directories for every shared unit.
// Usage: node scripts/compare-hashes.mjs <dirA> <dirB>
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [dirA, dirB] = process.argv.slice(2);
if (!dirA || !dirB) {
  console.log("usage: node scripts/compare-hashes.mjs <dirA> <dirB>");
  process.exit(2);
}

const filesA = readdirSync(join(dirA, "units")).filter((f) => f.endsWith(".json")).sort();
const filesB = readdirSync(join(dirB, "units")).filter((f) => f.endsWith(".json")).sort();
const shared = filesA.filter((f) => filesB.includes(f));

let match = 0;
let mismatch = 0;
for (const f of shared) {
  const a = JSON.parse(readFileSync(join(dirA, "units", f), "utf8"));
  const b = JSON.parse(readFileSync(join(dirB, "units", f), "utf8"));
  if (a.hashes?.stateHash === b.hashes?.stateHash) {
    match += 1;
  } else {
    mismatch += 1;
    console.log(`MISMATCH ${f}: ${a.hashes?.stateHash} vs ${b.hashes?.stateHash}`);
  }
}
console.log(`parity: ${match} matched, ${mismatch} mismatched (${shared.length} shared units)`);
process.exit(mismatch === 0 ? 0 : 1);