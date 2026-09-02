/**
 * Synchronous SHA-256 for the browser — a drop-in shim for `node:crypto`.
 *
 * WHY THIS EXISTS
 *
 * CE's `stateHash`, `traceHash`, `configHash` and event-id functions are
 * synchronous by design: they are called inside the tick loop and their results
 * participate in world identity. The browser's `crypto.subtle.digest()` is
 * asynchronous and cannot be substituted into a synchronous call.
 *
 * Rather than change frozen engine code, the bundler aliases `node:crypto` to
 * this module. CE's five `createHash("sha256").update(payload).digest("hex")`
 * call sites resolve here instead, unchanged.
 *
 * CORRECTNESS REQUIREMENT
 *
 * This must produce byte-identical output to `node:crypto` for identical input,
 * or the browser demo would report different state hashes than CI — which would
 * silently contradict CE's determinism claim. `scripts/verify-shim.mjs` asserts
 * equality against `node:crypto` across the CE payload shapes plus the
 * P-014 replay baseline.
 *
 * Implementation: FIPS 180-4 SHA-256. No dependencies. UTF-8 input, matching
 * Node's default encoding for `update(string)`.
 */

/** Round constants: first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash values: first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const encoder = new TextEncoder();

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** The 64-round compression function, operating on one 512-bit block. */
function compress(h: Uint32Array, block: Uint8Array, offset: number, w: Uint32Array): void {
  for (let i = 0; i < 16; i += 1) {
    const j = offset + i * 4;
    w[i] =
      ((block[j]! << 24) | (block[j + 1]! << 16) | (block[j + 2]! << 8) | block[j + 3]!) >>> 0;
  }

  for (let i = 16; i < 64; i += 1) {
    const w15 = w[i - 15]!;
    const w2 = w[i - 2]!;
    const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
    const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
  }

  let a = h[0]!;
  let b = h[1]!;
  let c = h[2]!;
  let d = h[3]!;
  let e = h[4]!;
  let f = h[5]!;
  let g = h[6]!;
  let hh = h[7]!;

  for (let i = 0; i < 64; i += 1) {
    const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const temp1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
    const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const temp2 = (S0 + maj) >>> 0;

    hh = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  h[0] = (h[0]! + a) >>> 0;
  h[1] = (h[1]! + b) >>> 0;
  h[2] = (h[2]! + c) >>> 0;
  h[3] = (h[3]! + d) >>> 0;
  h[4] = (h[4]! + e) >>> 0;
  h[5] = (h[5]! + f) >>> 0;
  h[6] = (h[6]! + g) >>> 0;
  h[7] = (h[7]! + hh) >>> 0;
}

const HEX = "0123456789abcdef";

function toHex(h: Uint32Array): string {
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    const word = h[i]!;
    for (let shift = 28; shift >= 0; shift -= 4) {
      out += HEX[(word >>> shift) & 0xf];
    }
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  // btoa is available in every browser and in Node 16+.
  return btoa(binary);
}

function digestBytes(h: Uint32Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) {
    const word = h[i]!;
    out[i * 4] = (word >>> 24) & 0xff;
    out[i * 4 + 1] = (word >>> 16) & 0xff;
    out[i * 4 + 2] = (word >>> 8) & 0xff;
    out[i * 4 + 3] = word & 0xff;
  }
  return out;
}

export type BinaryToTextEncoding = "hex" | "base64";

/**
 * Streaming SHA-256 hash object, matching the subset of Node's `Hash` that CE uses.
 *
 * Buffers input and processes complete 512-bit blocks eagerly, so memory stays
 * bounded regardless of payload size.
 */
class Sha256Hash {
  private readonly h: Uint32Array;
  private readonly block: Uint8Array;
  private readonly w: Uint32Array;
  private blockLength = 0;
  private totalBytes = 0;
  private finalised = false;

  constructor() {
    this.h = H0.slice();
    this.block = new Uint8Array(64);
    this.w = new Uint32Array(64);
  }

  /** Append data. Strings are encoded as UTF-8, matching Node's default. */
  update(data: string | Uint8Array): this {
    if (this.finalised) throw new Error("Hash.update called after digest");

    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    this.totalBytes += bytes.length;

    let cursor = 0;

    // Top up a partially filled block first.
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, bytes.length);
      this.block.set(bytes.subarray(0, take), this.blockLength);
      this.blockLength += take;
      cursor = take;
      if (this.blockLength === 64) {
        compress(this.h, this.block, 0, this.w);
        this.blockLength = 0;
      }
    }

    // Process whole blocks directly from the input, no copy.
    while (bytes.length - cursor >= 64) {
      compress(this.h, bytes, cursor, this.w);
      cursor += 64;
    }

    // Retain the remainder.
    if (cursor < bytes.length) {
      this.block.set(bytes.subarray(cursor), 0);
      this.blockLength = bytes.length - cursor;
    }

    return this;
  }

  /** Finalise and return the digest. Default encoding is hex, as CE always requests. */
  digest(encoding: BinaryToTextEncoding = "hex"): string {
    if (this.finalised) throw new Error("Hash.digest called twice");
    this.finalised = true;

    const bitLength = this.totalBytes * 8;

    // Append 0x80, then zeros, then the 64-bit big-endian bit length.
    this.block[this.blockLength] = 0x80;
    this.blockLength += 1;

    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      compress(this.h, this.block, 0, this.w);
      this.blockLength = 0;
      this.block.fill(0);
    } else {
      this.block.fill(0, this.blockLength);
    }

    // JS numbers hold 53 bits exactly, ample for any realistic payload. The high
    // word is written for spec compliance rather than reachability.
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    this.block[56] = (high >>> 24) & 0xff;
    this.block[57] = (high >>> 16) & 0xff;
    this.block[58] = (high >>> 8) & 0xff;
    this.block[59] = high & 0xff;
    this.block[60] = (low >>> 24) & 0xff;
    this.block[61] = (low >>> 16) & 0xff;
    this.block[62] = (low >>> 8) & 0xff;
    this.block[63] = low & 0xff;

    compress(this.h, this.block, 0, this.w);

    return encoding === "base64" ? toBase64(digestBytes(this.h)) : toHex(this.h);
  }
}

/**
 * Node-compatible `createHash`.
 *
 * Only sha256 is implemented, because that is the only algorithm CE uses. An
 * unsupported algorithm throws rather than silently returning a wrong digest.
 */
export function createHash(algorithm: string): Sha256Hash {
  const normalised = algorithm.toLowerCase().replace(/-/g, "");
  if (normalised !== "sha256") {
    throw new Error(
      `causality-engine browser shim implements sha256 only (requested: ${algorithm})`,
    );
  }
  return new Sha256Hash();
}

export type { Sha256Hash as Hash };
export default { createHash };
