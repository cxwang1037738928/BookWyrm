import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';

// #TODO: make this run in parallel for multiple pages, and make deskew function lazier(more efficient)
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// pdfjs needs these asset dirs to render embedded/standard fonts and CJK text.
// Paths must use forward slashes with a trailing slash regardless of OS —
// pdfjs parses them as URL-like strings, not native fs paths.
const PDFJS_ROOT = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
const STANDARD_FONT_DATA_URL = path.join(PDFJS_ROOT, 'standard_fonts').replace(/\\/g, '/') + '/';
const CMAP_URL = path.join(PDFJS_ROOT, 'cmaps').replace(/\\/g, '/') + '/';

const DEFAULT_DPI = parseInt(process.env.RASTER_DPI || '300', 10);
const ENHANCED_DIR = path.resolve(process.env.ENHANCED_DIR || './data/enhanced');

// Chars per square point (page area in PDF points) above which a page is
// considered to have a real digital text layer rather than sparse/no text.
// Empirical cutoff — tune against your corpus rather than trusting blindly.
const TEXT_DENSITY_THRESHOLD = 0.0008;

export const PAGE_TYPE = {
  DIGITAL: 'digital',
  SCANNED: 'scanned',
  MIXED: 'mixed', // scanned image that already carries an OCR text layer
};

export const LAYOUT_TYPE = {
  SINGLE_COLUMN: 'single-column',
  MULTI_COLUMN: 'multi-column',
  TABLE_HEAVY: 'table-heavy',
  FORM: 'form',
  MIXED: 'mixed',
};

// ---------------------------------------------------------------------------
// 2.1 — Page type detection (digital vs scanned)
// ---------------------------------------------------------------------------

/**
 * Loads a PDF via pdfjs-dist for page-level inspection and rendering.
 * @param {string} pdfPath
 * @returns {Promise<import('pdfjs-dist').PDFDocumentProxy>}
 */
export async function loadDocument(pdfPath) {
  const data = new Uint8Array(await fs.readFile(pdfPath));
  return pdfjsLib.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
  }).promise;
}

/**
 * Classifies a single page as digital, scanned, or mixed by combining the
 * extracted text density with whether the page draws any image XObject.
 * (We check for image *presence*, not full-page coverage — recovering the
 * exact transform matrix per paint op from pdfjs's operator list would add
 * real complexity for a marginal accuracy gain.)
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} doc
 * @param {number} pageNumber - 1-indexed
 * @returns {Promise<{ pageNumber: number, type: string, textDensity: number, hasImage: boolean, charCount: number }>}
 */
export async function classifyPageType(doc, pageNumber, { textDensityThreshold = TEXT_DENSITY_THRESHOLD } = {}) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const areaPts = viewport.width * viewport.height;

  const textContent = await page.getTextContent();
  const text = textContent.items.map((item) => item.str).join('');
  const textDensity = text.length / areaPts;

  const opList = await page.getOperatorList();
  const hasImage = opList.fnArray.includes(pdfjsLib.OPS.paintImageXObject);

  let type;
  if (hasImage && textDensity < textDensityThreshold) type = PAGE_TYPE.SCANNED;
  else if (hasImage) type = PAGE_TYPE.MIXED;
  else if (textDensity >= textDensityThreshold) type = PAGE_TYPE.DIGITAL;
  else type = PAGE_TYPE.SCANNED; // no image, little/no text — treat conservatively

  return { pageNumber, type, textDensity: parseFloat(textDensity.toFixed(6)), hasImage, charCount: text.length };
}

/**
 * Classifies every page in a document.
 * @param {string} pdfPath
 * @returns {Promise<Array<ReturnType<typeof classifyPageType>>>}
 */
export async function classifyAllPages(pdfPath) {
  const doc = await loadDocument(pdfPath);
  const results = [];
  for (let p = 1; p <= doc.numPages; p++) {
    results.push(await classifyPageType(doc, p));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2.2 — Rasterization
// ---------------------------------------------------------------------------

/**
 * Rasterizes one PDF page to a PNG buffer at the given DPI.
 * @param {import('pdfjs-dist').PDFDocumentProxy} doc
 * @param {number} pageNumber - 1-indexed
 * @param {number} dpi
 * @returns {Promise<{ buffer: Buffer, width: number, height: number }>}
 */
export async function rasterizePage(doc, pageNumber, dpi = DEFAULT_DPI) {
  const page = await doc.getPage(pageNumber);
  const scale = dpi / 72; // PDF points are 1/72 inch
  const viewport = page.getViewport({ scale });

  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Explicit white fill — some PDFs render transparent regions otherwise,
  // which is the wrong default background for an OCR-bound scan.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  return { buffer: canvas.toBuffer('image/png'), width, height };
}

/**
 * Rasterizes every page of a document.
 * @param {string} pdfPath
 * @param {number} dpi
 * @returns {Promise<Array<{ pageNumber: number, buffer: Buffer, width: number, height: number }>>}
 */
export async function rasterizeDocument(pdfPath, dpi = DEFAULT_DPI) {
  const doc = await loadDocument(pdfPath);
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    pages.push({ pageNumber: p, ...(await rasterizePage(doc, p, dpi)) });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Raw pixel helpers shared across enhancement / layout / content detection
// ---------------------------------------------------------------------------

async function toGrayscaleRaw(buffer) {
  const { data, info } = await sharp(buffer).grayscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function computeHistogram(grayData) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < grayData.length; i++) hist[grayData[i]]++;
  return hist;
}

/** Otsu's method: finds the threshold that maximizes between-class variance. */
function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let weightB = 0;
  let maxVariance = 0;
  let threshold = 0;

  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;

    sumB += t * hist[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) ** 2;

    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }
  return threshold;
}

/** Converts a grayscale (or already-binarized) image buffer to a 0/1 ink mask, thresholding at 128. */
async function toBinaryRaw(buffer) {
  const { data, width, height } = await toGrayscaleRaw(buffer);
  const binary = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) binary[i] = data[i] < 128 ? 1 : 0;
  return { binary, width, height };
}

// ---------------------------------------------------------------------------
// 2.3 — Enhancement pipeline
// ---------------------------------------------------------------------------

/** Median filter — removes salt-and-pepper scanner noise. */
export async function denoise(buffer, { size = 3 } = {}) {
  return sharp(buffer).median(size).toBuffer();
}

/** Stretches the image's luminance histogram to use the full dynamic range. */
export async function normalizeContrast(buffer) {
  return sharp(buffer).normalize().toBuffer();
}

/**
 * Estimates page skew via the classic projection-profile method: rotate by
 * candidate angles and pick the one that maximizes variance of per-row ink
 * counts (text baselines line up into sharp peaks/valleys at the correct angle).
 *
 * @param {Buffer} buffer
 * @returns {Promise<number>} estimated skew angle in degrees
 */
export async function estimateSkewAngle(buffer, { maxAngle = 10, coarseStep = 1, fineStep = 0.1, searchWidth = 1000 } = {}) {
  const small = await sharp(buffer).grayscale().resize({ width: searchWidth, withoutEnlargement: true }).toBuffer();

  async function varianceAtAngle(angle) {
    const { data, info } = await sharp(small)
      .rotate(angle, { background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rowSums = new Float64Array(info.height);
    for (let y = 0; y < info.height; y++) {
      let sum = 0;
      const rowStart = y * info.width;
      for (let x = 0; x < info.width; x++) {
        if (data[rowStart + x] < 128) sum++;
      }
      rowSums[y] = sum;
    }

    const mean = rowSums.reduce((a, b) => a + b, 0) / rowSums.length;
    return rowSums.reduce((a, b) => a + (b - mean) ** 2, 0) / rowSums.length;
  }

  let bestAngle = 0;
  let bestVariance = -Infinity;
  for (let a = -maxAngle; a <= maxAngle; a += coarseStep) {
    const v = await varianceAtAngle(a);
    if (v > bestVariance) {
      bestVariance = v;
      bestAngle = a;
    }
  }

  for (let a = bestAngle - coarseStep; a <= bestAngle + coarseStep; a += fineStep) {
    const v = await varianceAtAngle(a);
    if (v > bestVariance) {
      bestVariance = v;
      bestAngle = a;
    }
  }

  return parseFloat(bestAngle.toFixed(2));
}

/**
 * Corrects page rotation/tilt from scanning.
 * @param {Buffer} buffer
 * @returns {Promise<{ buffer: Buffer, angle: number }>}
 */
export async function deskew(buffer, opts = {}) {
  const angle = await estimateSkewAngle(buffer, opts);
  if (Math.abs(angle) < 0.05) return { buffer, angle: 0 }; // not worth the rotation cost
  const rotated = await sharp(buffer).rotate(angle, { background: '#ffffff' }).toBuffer();
  return { buffer: rotated, angle };
}

/**
 * Converts to black-and-white using an Otsu-derived global threshold —
 * adapts to each page's contrast instead of a fixed cutoff.
 * @param {Buffer} buffer
 * @returns {Promise<{ buffer: Buffer, threshold: number }>}
 */
export async function binarize(buffer) {
  const { data } = await toGrayscaleRaw(buffer);
  const threshold = otsuThreshold(computeHistogram(data), data.length);
  const binarized = await sharp(buffer).threshold(threshold).toBuffer();
  return { buffer: binarized, threshold };
}

/**
 * Runs the full per-page enhancement pipeline in the standard order:
 * denoise → normalize contrast → deskew → binarize. Binarization is last
 * since OCR wants a final clean B&W image and rotating a binary image
 * (instead of grayscale) would introduce jagged edges.
 *
 * @param {Buffer} buffer - rasterized page image (color or grayscale)
 * @returns {Promise<{ buffer: Buffer, angle: number, threshold: number }>}
 */
export async function enhancePage(buffer, opts = {}) {
  const denoised = await denoise(buffer, opts.denoise);
  const normalized = await normalizeContrast(denoised);
  const { buffer: deskewed, angle } = await deskew(normalized, opts.deskew);
  const { buffer: binarized, threshold } = await binarize(deskewed);
  return { buffer: binarized, angle, threshold };
}

// ---------------------------------------------------------------------------
// 2.4 — Layout detection
// ---------------------------------------------------------------------------

/** Counts long contiguous ink runs per row/column — proxy for table/form grid lines. */
function detectLongRuns(binary, width, height, { minHorizontalRatio = 0.25, minVerticalRatio = 0.5 } = {}) {
  const minHRun = Math.floor(width * minHorizontalRatio);
  const minVRun = Math.floor(height * minVerticalRatio);
  let longHorizontalLines = 0;
  let longVerticalLines = 0;

  for (let y = 0; y < height; y++) {
    let run = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if (binary[rowStart + x]) run++;
      else {
        if (run >= minHRun) longHorizontalLines++;
        run = 0;
      }
    }
    if (run >= minHRun) longHorizontalLines++;
  }

  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y < height; y++) {
      if (binary[y * width + x]) run++;
      else {
        if (run >= minVRun) longVerticalLines++;
        run = 0;
      }
    }
    if (run >= minVRun) longVerticalLines++;
  }

  return { longHorizontalLines, longVerticalLines };
}

/** Counts short isolated horizontal runs — proxy for form fill-in underscores. */
function detectShortRuns(binary, width, height, { minRatio = 0.03, maxRatio = 0.15 } = {}) {
  const minLen = Math.floor(width * minRatio);
  const maxLen = Math.floor(width * maxRatio);
  let count = 0;

  for (let y = 0; y < height; y++) {
    let run = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if (binary[rowStart + x]) run++;
      else {
        if (run >= minLen && run <= maxLen) count++;
        run = 0;
      }
    }
    if (run >= minLen && run <= maxLen) count++;
  }
  return { shortHorizontalRuns: count };
}

/** Finds vertical whitespace gutters to estimate column count. */
function detectColumns(binary, width, height, { marginRatio = 0.05, minGutterRatio = 0.02 } = {}) {
  const colSums = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) sum += binary[y * width + x];
    colSums[x] = sum;
  }

  const margin = Math.floor(width * marginRatio);
  const minGutterWidth = Math.floor(width * minGutterRatio);
  const inkRowThreshold = height * 0.01; // columns below this are "empty" for gutter purposes

  let gutters = 0;
  let runEmpty = 0;
  for (let x = margin; x < width - margin; x++) {
    if (colSums[x] <= inkRowThreshold) {
      runEmpty++;
    } else {
      if (runEmpty >= minGutterWidth) gutters++;
      runEmpty = 0;
    }
  }
  if (runEmpty >= minGutterWidth) gutters++;

  return { columnCount: gutters + 1 };
}

/**
 * Classifies page layout from a binarized page image, to route it to the
 * right downstream parser. Heuristic projection/run-length classifier —
 * approximate by nature; swap for a learned layout model (LayoutParser,
 * Detectron2, or a fine-tuned vision model) when accuracy matters more
 * than zero ML dependencies.
 *
 * @param {Buffer} binarizedBuffer - output of enhancePage()/binarize()
 * @returns {Promise<{ type: string, columnCount: number, longHorizontalLines: number, longVerticalLines: number, shortHorizontalRuns: number }>}
 */
export async function detectLayout(binarizedBuffer) {
  const { binary, width, height } = await toBinaryRaw(binarizedBuffer);

  const { columnCount } = detectColumns(binary, width, height);
  const { longHorizontalLines, longVerticalLines } = detectLongRuns(binary, width, height);
  const { shortHorizontalRuns } = detectShortRuns(binary, width, height);

  const tableScore = longHorizontalLines + longVerticalLines;

  let type;
  if (tableScore >= 6) {
    type = columnCount >= 2 ? LAYOUT_TYPE.MIXED : LAYOUT_TYPE.TABLE_HEAVY;
  } else if (shortHorizontalRuns >= 15 && tableScore < 3) {
    type = LAYOUT_TYPE.FORM;
  } else if (columnCount >= 2) {
    type = LAYOUT_TYPE.MULTI_COLUMN;
  } else {
    type = LAYOUT_TYPE.SINGLE_COLUMN;
  }

  return { type, columnCount, longHorizontalLines, longVerticalLines, shortHorizontalRuns };
}

// ---------------------------------------------------------------------------
// 2.5 — Special content flags (stamps, watermarks, handwriting)
// ---------------------------------------------------------------------------

async function toRawRGB(buffer, { maxWidth = 800 } = {}) {
  const { data, info } = await sharp(buffer)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Flags pages likely to contain a stamp by looking for clusters of saturated
 * (non-grayscale) ink — most page content is black text on white/gray paper,
 * so colored ink stands out. Needs the original color rasterization, not the
 * binarized output.
 *
 * @param {Buffer} colorBuffer - output of rasterizePage(), before enhancement
 * @returns {Promise<{ detected: boolean, coloredPixelRatio: number, boundingBox: object|null }>}
 */
export async function detectStamps(colorBuffer, { saturationThreshold = 0.35, minPixelRatio = 0.0005, maxPixelRatio = 0.4 } = {}) {
  const { data, width, height, channels } = await toRawRGB(colorBuffer);
  const total = width * height;
  let coloredCount = 0;
  let minX = width, minY = height, maxX = 0, maxY = 0;

  for (let i = 0; i < total; i++) {
    const idx = i * channels;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    const brightness = (r + g + b) / 3;
    if (brightness > 245 || brightness < 20) continue; // skip paper background and printed black text

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;

    if (saturation >= saturationThreshold) {
      coloredCount++;
      const x = i % width, y = Math.floor(i / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const ratio = coloredCount / total;
  return {
    detected: ratio >= minPixelRatio && ratio <= maxPixelRatio,
    coloredPixelRatio: parseFloat(ratio.toFixed(6)),
    boundingBox: coloredCount > 0 ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null,
  };
}

/**
 * Flags pages likely to contain a watermark: a large area of faint, low-
 * contrast gray that isn't page background (near-white) or ink (near-black).
 * Weak heuristic — light scans or scanner shadows can false-positive.
 *
 * @param {Buffer} colorBuffer
 * @returns {Promise<{ detected: boolean, faintPixelRatio: number }>}
 */
export async function detectWatermark(colorBuffer, { faintMin = 150, faintMax = 235, minFaintRatio = 0.05 } = {}) {
  const { data } = await sharp(colorBuffer)
    .resize({ width: 800, withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let faintCount = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] >= faintMin && data[i] <= faintMax) faintCount++;
  }

  const ratio = faintCount / data.length;
  return { detected: ratio >= minFaintRatio, faintPixelRatio: parseFloat(ratio.toFixed(4)) };
}

/**
 * Coarse, low-confidence handwriting flag based on stroke-width variability:
 * printed glyphs at a fixed size have fairly uniform stroke widths, while
 * handwritten/cursive strokes vary more. This is a heuristic signal meant to
 * route pages to manual review or a dedicated handwriting model — not a
 * reliable classifier on its own.
 *
 * @param {Buffer} binarizedBuffer - output of enhancePage()/binarize()
 * @returns {Promise<{ detected: boolean, strokeWidthCV: number|null, sampleSize: number }>}
 */
export async function detectHandwriting(binarizedBuffer, { minCV = 0.9, minStrokeSamples = 200 } = {}) {
  const { binary, width, height } = await toBinaryRaw(binarizedBuffer);
  const maxStrokeLen = Math.max(4, Math.floor(width * 0.01));
  const runLengths = [];

  for (let y = 0; y < height; y++) {
    let run = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if (binary[rowStart + x]) {
        run++;
      } else {
        if (run >= 1 && run <= maxStrokeLen) runLengths.push(run);
        run = 0;
      }
    }
  }

  if (runLengths.length < minStrokeSamples) {
    return { detected: false, strokeWidthCV: null, sampleSize: runLengths.length };
  }

  const mean = runLengths.reduce((a, b) => a + b, 0) / runLengths.length;
  const variance = runLengths.reduce((a, b) => a + (b - mean) ** 2, 0) / runLengths.length;
  const cv = Math.sqrt(variance) / mean;

  return { detected: cv >= minCV, strokeWidthCV: parseFloat(cv.toFixed(3)), sampleSize: runLengths.length };
}

/**
 * Runs all three special-content detectors for a page.
 * @param {Buffer} colorBuffer - original rasterized color page
 * @param {Buffer} binarizedBuffer - enhanced/binarized page
 */
export async function flagSpecialContent(colorBuffer, binarizedBuffer) {
  const [stamp, watermark, handwriting] = await Promise.all([
    detectStamps(colorBuffer),
    detectWatermark(colorBuffer),
    detectHandwriting(binarizedBuffer),
  ]);
  return { stamp, watermark, handwriting };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Runs the full Stage 2 pipeline for a single page: classify → rasterize →
 * flag special content (on the original color render) → enhance → classify
 * layout (on the enhanced render). Optionally persists the enhanced PNG.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} doc
 * @param {number} pageNumber
 * @param {{ dpi?: number, saveDir?: string|null }} [opts]
 */
export async function processPage(doc, pageNumber, { dpi = DEFAULT_DPI, saveDir = null } = {}) {
  const pageType = await classifyPageType(doc, pageNumber);
  const { buffer: colorBuffer, width, height } = await rasterizePage(doc, pageNumber, dpi);

  const enhanced = await enhancePage(colorBuffer);
  const [layout, specialContent] = await Promise.all([
    detectLayout(enhanced.buffer),
    flagSpecialContent(colorBuffer, enhanced.buffer),
  ]);

  if (saveDir) {
    await fs.mkdir(saveDir, { recursive: true });
    await fs.writeFile(path.join(saveDir, `page_${pageNumber}.png`), enhanced.buffer);
  }

  return {
    pageNumber,
    pageType: pageType.type,
    textDensity: pageType.textDensity,
    dimensions: { width, height, dpi },
    enhancement: { deskewAngle: enhanced.angle, binarizationThreshold: enhanced.threshold },
    layout,
    specialContent,
  };
}

/**
 * Runs processPage() across an entire document. Pages are processed
 * sequentially (not in parallel) — rasterizing at 300 DPI is memory-heavy,
 * and a long PDF processed page-by-page keeps peak memory bounded.
 *
 * @param {string} pdfPath
 * @param {{ docId?: string, dpi?: number }} [opts]
 */
export async function processDocument(pdfPath, { docId, dpi = DEFAULT_DPI } = {}) {
  const doc = await loadDocument(pdfPath);
  const saveDir = docId ? path.join(ENHANCED_DIR, docId) : null;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    pages.push(await processPage(doc, p, { dpi, saveDir }));
  }

  const report = { docId: docId ?? null, pdfPath, numPages: doc.numPages, dpi, processedAt: new Date().toISOString(), pages };

  if (docId) {
    await fs.mkdir(ENHANCED_DIR, { recursive: true });
    await fs.writeFile(path.join(ENHANCED_DIR, `${docId}.json`), JSON.stringify(report, null, 2));
  }

  return report;
}
