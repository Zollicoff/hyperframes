/**
 * Alpha Blit — in-memory PNG decode + alpha compositing over rgb48le HDR frames.
 *
 * Replaces per-frame FFmpeg spawns for the two-pass HDR compositing path.
 * Uses only Node.js built-ins (zlib) — no additional dependencies.
 */

import { inflateSync } from "zlib";

// ── PNG decoder ───────────────────────────────────────────────────────────────

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG buffer to raw RGBA pixel data (8-bit per channel).
 *
 * Supports color type 6 (RGBA) and color type 2 (RGB) at 8-bit depth,
 * non-interlaced. Chrome's Page.captureScreenshot always emits this format.
 *
 * Returns a Uint8Array of width*height*4 bytes in RGBA order.
 */
export function decodePng(buf: Buffer): { width: number; height: number; data: Uint8Array } {
  // Verify PNG signature
  if (
    buf[0] !== 137 ||
    buf[1] !== 80 ||
    buf[2] !== 78 ||
    buf[3] !== 71 ||
    buf[4] !== 13 ||
    buf[5] !== 10 ||
    buf[6] !== 26 ||
    buf[7] !== 10
  ) {
    throw new Error("decodePng: not a PNG file");
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (pos + 12 <= buf.length) {
    const chunkLen = buf.readUInt32BE(pos);
    const chunkType = buf.toString("ascii", pos + 4, pos + 8);
    const chunkData = buf.subarray(pos + 8, pos + 8 + chunkLen);

    if (chunkType === "IHDR") {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8] ?? 0;
      colorType = chunkData[9] ?? 0;
    } else if (chunkType === "IDAT") {
      idatChunks.push(Buffer.from(chunkData));
    } else if (chunkType === "IEND") {
      break;
    }

    pos += 12 + chunkLen; // length(4) + type(4) + data(chunkLen) + crc(4)
  }

  if (bitDepth !== 8) {
    throw new Error(`decodePng: unsupported bit depth ${bitDepth} (expected 8)`);
  }
  // colorType 6 = RGBA, colorType 2 = RGB
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`decodePng: unsupported color type ${colorType} (expected 2=RGB or 6=RGBA)`);
  }

  const bpp = colorType === 6 ? 4 : 3; // bytes per pixel in the PNG stream
  const stride = width * bpp;

  const compressed = Buffer.concat(idatChunks);
  const decompressed = inflateSync(compressed);

  // Reconstruct filtered rows → output RGBA
  const output = new Uint8Array(width * height * 4);
  const prevRow = new Uint8Array(stride);
  const currRow = new Uint8Array(stride);

  let srcPos = 0;

  for (let y = 0; y < height; y++) {
    const filterType = decompressed[srcPos++] ?? 0;
    const rawRow = decompressed.subarray(srcPos, srcPos + stride);
    srcPos += stride;

    // Apply PNG filter to reconstruct scanline
    switch (filterType) {
      case 0: // None
        currRow.set(rawRow);
        break;
      case 1: // Sub — difference from left pixel
        for (let x = 0; x < stride; x++) {
          currRow[x] = ((rawRow[x] ?? 0) + (x >= bpp ? (currRow[x - bpp] ?? 0) : 0)) & 0xff;
        }
        break;
      case 2: // Up — difference from above pixel
        for (let x = 0; x < stride; x++) {
          currRow[x] = ((rawRow[x] ?? 0) + (prevRow[x] ?? 0)) & 0xff;
        }
        break;
      case 3: // Average — difference from floor((left + above) / 2)
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? (currRow[x - bpp] ?? 0) : 0;
          const up = prevRow[x] ?? 0;
          currRow[x] = ((rawRow[x] ?? 0) + Math.floor((left + up) / 2)) & 0xff;
        }
        break;
      case 4: // Paeth predictor
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? (currRow[x - bpp] ?? 0) : 0;
          const up = prevRow[x] ?? 0;
          const upLeft = x >= bpp ? (prevRow[x - bpp] ?? 0) : 0;
          currRow[x] = ((rawRow[x] ?? 0) + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`decodePng: unknown filter type ${filterType} at row ${y}`);
    }

    // Write to output as RGBA (expand RGB→RGBA if colorType=2)
    const dstBase = y * width * 4;
    if (colorType === 6) {
      output.set(currRow, dstBase);
    } else {
      // RGB → RGBA: set alpha to 255
      for (let x = 0; x < width; x++) {
        output[dstBase + x * 4 + 0] = currRow[x * 3 + 0] ?? 0;
        output[dstBase + x * 4 + 1] = currRow[x * 3 + 1] ?? 0;
        output[dstBase + x * 4 + 2] = currRow[x * 3 + 2] ?? 0;
        output[dstBase + x * 4 + 3] = 255;
      }
    }

    prevRow.set(currRow);
  }

  return { width, height, data: output };
}

// ── 16-bit PNG decoder ────────────────────────────────────────────────────────

/**
 * Decode a 16-bit RGB PNG (from FFmpeg) to an rgb48le Buffer.
 *
 * FFmpeg's `-pix_fmt rgb48le -c:v png` produces 16-bit RGB PNGs.
 * PNG stores 16-bit values in big-endian; this function swaps to little-endian
 * for the streaming encoder's rgb48le input format.
 *
 * Supports colorType 2 (RGB) at 16-bit depth, non-interlaced.
 */
export function decodePngToRgb48le(buf: Buffer): { width: number; height: number; data: Buffer } {
  // Verify PNG signature
  if (
    buf[0] !== 137 ||
    buf[1] !== 80 ||
    buf[2] !== 78 ||
    buf[3] !== 71 ||
    buf[4] !== 13 ||
    buf[5] !== 10 ||
    buf[6] !== 26 ||
    buf[7] !== 10
  ) {
    throw new Error("decodePngToRgb48le: not a PNG file");
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (pos + 12 <= buf.length) {
    const chunkLen = buf.readUInt32BE(pos);
    const chunkType = buf.toString("ascii", pos + 4, pos + 8);
    const chunkData = buf.subarray(pos + 8, pos + 8 + chunkLen);

    if (chunkType === "IHDR") {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8] ?? 0;
      colorType = chunkData[9] ?? 0;
    } else if (chunkType === "IDAT") {
      idatChunks.push(Buffer.from(chunkData));
    } else if (chunkType === "IEND") {
      break;
    }

    pos += 12 + chunkLen;
  }

  if (bitDepth !== 16) {
    throw new Error(`decodePngToRgb48le: unsupported bit depth ${bitDepth} (expected 16)`);
  }
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(
      `decodePngToRgb48le: unsupported color type ${colorType} (expected 2=RGB or 6=RGBA)`,
    );
  }

  // 16-bit: 2 bytes per channel. RGB=6 bytes/pixel, RGBA=8 bytes/pixel
  const bpp = colorType === 6 ? 8 : 6;
  const stride = width * bpp;

  const compressed = Buffer.concat(idatChunks);
  const decompressed = inflateSync(compressed);

  // Reconstruct filtered rows (filter operates on individual bytes)
  const currRow = new Uint8Array(stride);
  const prevRow = new Uint8Array(stride);

  // Output: rgb48le = 3 channels × 2 bytes (LE) = 6 bytes/pixel
  const output = Buffer.allocUnsafe(width * height * 6);

  let srcPos = 0;

  for (let y = 0; y < height; y++) {
    const filterType = decompressed[srcPos++] ?? 0;
    const rawRow = decompressed.subarray(srcPos, srcPos + stride);
    srcPos += stride;

    switch (filterType) {
      case 0:
        currRow.set(rawRow);
        break;
      case 1:
        for (let x = 0; x < stride; x++) {
          currRow[x] = ((rawRow[x] ?? 0) + (x >= bpp ? (currRow[x - bpp] ?? 0) : 0)) & 0xff;
        }
        break;
      case 2:
        for (let x = 0; x < stride; x++) {
          currRow[x] = ((rawRow[x] ?? 0) + (prevRow[x] ?? 0)) & 0xff;
        }
        break;
      case 3:
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? (currRow[x - bpp] ?? 0) : 0;
          const up = prevRow[x] ?? 0;
          currRow[x] = ((rawRow[x] ?? 0) + Math.floor((left + up) / 2)) & 0xff;
        }
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const left = x >= bpp ? (currRow[x - bpp] ?? 0) : 0;
          const up = prevRow[x] ?? 0;
          const upLeft = x >= bpp ? (prevRow[x - bpp] ?? 0) : 0;
          currRow[x] = ((rawRow[x] ?? 0) + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`decodePngToRgb48le: unknown filter type ${filterType} at row ${y}`);
    }

    // Convert big-endian 16-bit RGB(A) → little-endian rgb48le (drop alpha if RGBA)
    const dstBase = y * width * 6;
    for (let x = 0; x < width; x++) {
      const srcBase = x * bpp;
      // PNG stores 16-bit as big-endian: [high, low]. Swap to little-endian: [low, high].
      output[dstBase + x * 6 + 0] = currRow[srcBase + 1] ?? 0; // R low
      output[dstBase + x * 6 + 1] = currRow[srcBase + 0] ?? 0; // R high
      output[dstBase + x * 6 + 2] = currRow[srcBase + 3] ?? 0; // G low
      output[dstBase + x * 6 + 3] = currRow[srcBase + 2] ?? 0; // G high
      output[dstBase + x * 6 + 4] = currRow[srcBase + 5] ?? 0; // B low
      output[dstBase + x * 6 + 5] = currRow[srcBase + 4] ?? 0; // B high
    }

    prevRow.set(currRow);
  }

  return { width, height, data: output };
}

// ── sRGB → HDR color conversion ───────────────────────────────────────────────

/**
 * Build a 256-entry LUT: sRGB 8-bit value → HDR 16-bit signal value.
 *
 * Pipeline per channel: sRGB EOTF (decode gamma) → linear → HDR OETF → 16-bit.
 *
 * Note: converts the transfer function but not the color primaries (bt709 → bt2020).
 * For neutral/near-neutral content (text, UI) the gamut difference is negligible.
 */
function buildSrgbToHdrLut(transfer: "hlg" | "pq"): Uint16Array {
  const lut = new Uint16Array(256);

  // HLG OETF constants (Rec. 2100)
  const hlgA = 0.17883277;
  const hlgB = 1 - 4 * hlgA;
  const hlgC = 0.5 - hlgA * Math.log(4 * hlgA);

  // PQ (SMPTE 2084) OETF constants
  const pqM1 = 0.1593017578125;
  const pqM2 = 78.84375;
  const pqC1 = 0.8359375;
  const pqC2 = 18.8515625;
  const pqC3 = 18.6875;
  const pqMaxNits = 10000.0;
  const sdrNits = 203.0;

  for (let i = 0; i < 256; i++) {
    // sRGB EOTF: signal → linear (range 0–1, relative to SDR white)
    const v = i / 255;
    const linear = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

    let signal: number;
    if (transfer === "hlg") {
      signal =
        linear <= 1 / 12 ? Math.sqrt(3 * linear) : hlgA * Math.log(12 * linear - hlgB) + hlgC;
    } else {
      // PQ OETF: linear light (in SDR nits) → PQ signal
      const Lp = Math.max(0, (linear * sdrNits) / pqMaxNits);
      const Lm1 = Math.pow(Lp, pqM1);
      signal = Math.pow((pqC1 + pqC2 * Lm1) / (1.0 + pqC3 * Lm1), pqM2);
    }

    lut[i] = Math.min(65535, Math.round(signal * 65535));
  }

  return lut;
}

const SRGB_TO_HLG = buildSrgbToHdrLut("hlg");
const SRGB_TO_PQ = buildSrgbToHdrLut("pq");

/** Select the correct sRGB→HDR LUT for the given transfer function. */
export function getSrgbToHdrLut(transfer: "hlg" | "pq"): Uint16Array {
  return transfer === "pq" ? SRGB_TO_PQ : SRGB_TO_HLG;
}

// ── Alpha compositing ─────────────────────────────────────────────────────────

/**
 * Alpha-composite a DOM RGBA overlay (8-bit sRGB) onto an HDR canvas
 * (rgb48le) in-place.
 *
 * DOM pixels are converted from sRGB to the target HDR signal space (HLG or PQ)
 * before blending so the composited output is uniformly encoded. Without this
 * conversion, sRGB content appears orange/washed in HDR playback.
 *
 * @param domRgba   Raw RGBA pixel data from decodePng() — width*height*4 bytes
 * @param canvas    HDR canvas in rgb48le format — width*height*6 bytes, mutated in-place
 * @param width     Canvas width in pixels
 * @param height    Canvas height in pixels
 * @param transfer  HDR transfer function — selects the correct sRGB→HDR LUT
 */
export function blitRgba8OverRgb48le(
  domRgba: Uint8Array,
  canvas: Buffer,
  width: number,
  height: number,
  transfer: "hlg" | "pq" = "hlg",
): void {
  const pixelCount = width * height;
  const lut = transfer === "pq" ? SRGB_TO_PQ : SRGB_TO_HLG;

  for (let i = 0; i < pixelCount; i++) {
    const da = domRgba[i * 4 + 3] ?? 0;

    if (da === 0) {
      continue;
    } else if (da === 255) {
      const r16 = lut[domRgba[i * 4 + 0] ?? 0] ?? 0;
      const g16 = lut[domRgba[i * 4 + 1] ?? 0] ?? 0;
      const b16 = lut[domRgba[i * 4 + 2] ?? 0] ?? 0;
      canvas.writeUInt16LE(r16, i * 6);
      canvas.writeUInt16LE(g16, i * 6 + 2);
      canvas.writeUInt16LE(b16, i * 6 + 4);
    } else {
      const alpha = da / 255;
      const invAlpha = 1 - alpha;

      const hdrR = (canvas[i * 6 + 0] ?? 0) | ((canvas[i * 6 + 1] ?? 0) << 8);
      const hdrG = (canvas[i * 6 + 2] ?? 0) | ((canvas[i * 6 + 3] ?? 0) << 8);
      const hdrB = (canvas[i * 6 + 4] ?? 0) | ((canvas[i * 6 + 5] ?? 0) << 8);

      const domR = lut[domRgba[i * 4 + 0] ?? 0] ?? 0;
      const domG = lut[domRgba[i * 4 + 1] ?? 0] ?? 0;
      const domB = lut[domRgba[i * 4 + 2] ?? 0] ?? 0;

      canvas.writeUInt16LE(Math.round(domR * alpha + hdrR * invAlpha), i * 6);
      canvas.writeUInt16LE(Math.round(domG * alpha + hdrG * invAlpha), i * 6 + 2);
      canvas.writeUInt16LE(Math.round(domB * alpha + hdrB * invAlpha), i * 6 + 4);
    }
  }
}

// ── Positioned HDR region copy ────────────────────────────────────────────────

/**
 * Copy a rectangular region of an rgb48le source onto an rgb48le canvas
 * at position (dx, dy). Clips to canvas bounds. Optional opacity blending
 * (0.0–1.0) over existing canvas content.
 *
 * @param canvas  Destination rgb48le buffer (canvasWidth * canvasHeight * 6 bytes)
 * @param source  Source rgb48le buffer (sw * sh * 6 bytes)
 * @param dx      Destination X offset on canvas
 * @param dy      Destination Y offset on canvas
 * @param sw      Source width in pixels
 * @param sh      Source height in pixels
 * @param canvasWidth  Canvas width in pixels (needed for stride calculation)
 * @param opacity  Optional opacity 0.0–1.0 (default 1.0 = fully opaque copy)
 */
export function blitRgb48leRegion(
  canvas: Buffer,
  source: Buffer,
  dx: number,
  dy: number,
  sw: number,
  sh: number,
  canvasWidth: number,
  opacity?: number,
): void {
  if (sw <= 0 || sh <= 0) return;

  const op = opacity ?? 1.0;
  const canvasHeight = canvas.length / (canvasWidth * 6);

  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(canvasWidth, dx + sw);
  const y1 = Math.min(canvasHeight, dy + sh);
  if (x0 >= x1 || y0 >= y1) return;

  const clippedW = x1 - x0;
  const srcOffsetX = x0 - dx;
  const srcOffsetY = y0 - dy;

  if (op >= 0.999) {
    for (let y = 0; y < y1 - y0; y++) {
      const srcRowOff = ((srcOffsetY + y) * sw + srcOffsetX) * 6;
      const dstRowOff = ((y0 + y) * canvasWidth + x0) * 6;
      source.copy(canvas, dstRowOff, srcRowOff, srcRowOff + clippedW * 6);
    }
  } else {
    const invOp = 1 - op;
    for (let y = 0; y < y1 - y0; y++) {
      for (let x = 0; x < clippedW; x++) {
        const srcOff = ((srcOffsetY + y) * sw + srcOffsetX + x) * 6;
        const dstOff = ((y0 + y) * canvasWidth + x0 + x) * 6;
        const sr = source.readUInt16LE(srcOff);
        const sg = source.readUInt16LE(srcOff + 2);
        const sb = source.readUInt16LE(srcOff + 4);
        const dr = canvas.readUInt16LE(dstOff);
        const dg = canvas.readUInt16LE(dstOff + 2);
        const db = canvas.readUInt16LE(dstOff + 4);
        canvas.writeUInt16LE(Math.round(sr * op + dr * invOp), dstOff);
        canvas.writeUInt16LE(Math.round(sg * op + dg * invOp), dstOff + 2);
        canvas.writeUInt16LE(Math.round(sb * op + db * invOp), dstOff + 4);
      }
    }
  }
}
