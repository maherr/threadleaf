import { caseFoldingCodePoints, caseFoldingTargets } from "../generated/case-folding-table";

/**
 * A derived, comparable search projection. `source` is never rewritten or
 * persisted; segments retain the source UTF-16 range for each extended
 * grapheme that contributed to `text`.
 */
export interface SearchTextProjection {
  source: string;
  text: string;
  segments: readonly SearchTextSegment[];
  boundaries: readonly number[];
}

export interface SearchTextSegment {
  foldedStart: number;
  foldedEnd: number;
  sourceStart: number;
  sourceEnd: number;
}

export interface SearchTextSourceRange {
  start: number;
  end: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const projectionChunkSize = 16_384;
const textChunkSize = 65_536;
const maxTypedOffset = 0xffff_ffff;
const latinLetterPattern = /^\p{Script=Latin}$/u;
const letterPattern = /^\p{Letter}$/u;
const markPattern = /^\p{M}$/u;
const diacriticPattern = /^\p{Diacritic}$/u;
const latinMarkPattern = /^\p{Script_Extensions=Latin}$/u;
const inheritedMarkPattern = /^\p{Script_Extensions=Inherited}$/u;

const caseFoldingTable = new Map<number, number>();
for (let index = 0; index < caseFoldingCodePoints.length; index += 1) {
  caseFoldingTable.set(caseFoldingCodePoints[index] ?? 0, caseFoldingTargets[index] ?? 0);
}

/**
 * Pinned Unicode 17 Simple case folding: Common (C) + Simple (S) status
 * mappings only, from the generated table in
 * src/generated/case-folding-table.ts. Every mapping is exactly one code
 * point to exactly one code point, so folding never changes a grapheme's
 * code point count. A code point absent from the table folds to itself
 * ("All code points not listed in this file map to themselves",
 * CaseFolding.txt).
 *
 * Unlike `String.prototype.toLowerCase`, this mapping is context-
 * independent: Greek capital sigma always folds to U+03C3 (regular sigma),
 * the same target as final sigma U+03C2, rather than the word-position-
 * dependent Final_Sigma lowering rule. Full (F) mappings that grow a string
 * in length (for example sharp s, U+00DF, to "ss") and Turkic (T)
 * dotted/dotless I remapping are excluded by construction, so sharp s stays
 * distinct from "ss" and dotted/dotless I forms are never conflated with
 * plain Latin I outside an explicit Turkic locale.
 */
function caseFold(value: string): string {
  let folded = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const target = caseFoldingTable.get(codePoint);
    folded += target === undefined ? character : String.fromCodePoint(target);
  }
  return folded;
}

/**
 * Offset arrays are deliberately chunked instead of growing one JavaScript
 * array per grapheme. A million-unit note then costs four compact typed
 * offset streams rather than a million objects plus boxed numbers.
 */
class ChunkedOffsets {
  readonly #chunks: Uint32Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > maxTypedOffset) {
      throw new Error(
        `Search projection offsets must fit in unsigned 32-bit storage (received ${value}).`,
      );
    }
    const chunkIndex = Math.floor(this.#length / projectionChunkSize);
    let chunk = this.#chunks[chunkIndex];
    if (!chunk) {
      chunk = new Uint32Array(projectionChunkSize);
      this.#chunks.push(chunk);
    }
    chunk[this.#length % projectionChunkSize] = value;
    this.#length += 1;
  }

  get(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.#length) {
      throw new RangeError(`Search projection offset index ${index} is out of range.`);
    }
    return (
      this.#chunks[Math.floor(index / projectionChunkSize)]?.[index % projectionChunkSize] ?? 0
    );
  }

  toArray(): number[] {
    const values = new Array<number>(this.#length);
    for (let index = 0; index < this.#length; index += 1) {
      values[index] = this.get(index);
    }
    return values;
  }
}

interface CompactProjectionData {
  foldedStarts: ChunkedOffsets;
  foldedEnds: ChunkedOffsets;
  sourceStarts: ChunkedOffsets;
  sourceEnds: ChunkedOffsets;
  boundaries: ChunkedOffsets;
}

const compactProjectionData = new WeakMap<SearchTextProjection, CompactProjectionData>();

function isLatinBase(value: string): boolean {
  return latinLetterPattern.test(value) && letterPattern.test(value);
}

function isLatinDiacritic(value: string): boolean {
  if (!markPattern.test(value) || !diacriticPattern.test(value)) {
    return false;
  }
  // Script_Extensions distinguishes ordinary Latin or inherited accents from
  // marks assigned to Arabic, Hebrew, Indic, or another non-Latin script even
  // when Intl.Segmenter groups them with a Latin base.
  return latinMarkPattern.test(value) || inheritedMarkPattern.test(value);
}

function foldGrapheme(grapheme: string): string {
  const canonical = grapheme.normalize("NFC");
  const decomposed = canonical.normalize("NFD");
  const base = Array.from(decomposed).find(isLatinBase);
  let folded = canonical;
  if (base) {
    // U+0130 (dotted capital I) is a distinct Latin letter, not "I" plus a
    // decorative accent: Unicode Simple case folding (Common + Simple
    // status) has no mapping for it, so it must fold to itself and stay
    // distinct from plain "I" / "i". Stripping this dot as an ordinary Latin
    // diacritic before case folding would collapse that distinction, so it
    // is kept regardless of case-folding mode.
    const preserveDottedI = (base === "I" || base === "i") && decomposed.includes("\u0307");
    folded = Array.from(decomposed)
      .filter((value) => !isLatinDiacritic(value) || (preserveDottedI && value === "\u0307"))
      .join("")
      .normalize("NFC");
  }
  return folded;
}

/**
 * Build a source-preserving search key. Diacritics are removed only when a
 * grapheme has a Latin letter base; non-Latin combining marks remain intact.
 * Canonical decomposition is used for this narrow operation, never
 * compatibility decomposition or transliteration.
 */
export function projectSearchText(value: string, caseSensitive = false): SearchTextProjection {
  const textChunks: string[] = [];
  let chunkParts: string[] = [];
  let chunkLength = 0;
  const appendFolded = (part: string): void => {
    if (!part) {
      return;
    }
    chunkParts.push(part);
    chunkLength += part.length;
    if (chunkLength >= textChunkSize) {
      textChunks.push(chunkParts.join(""));
      chunkParts = [];
      chunkLength = 0;
    }
  };
  const data: CompactProjectionData = {
    foldedStarts: new ChunkedOffsets(),
    foldedEnds: new ChunkedOffsets(),
    sourceStarts: new ChunkedOffsets(),
    sourceEnds: new ChunkedOffsets(),
    boundaries: new ChunkedOffsets(),
  };
  data.boundaries.push(0);
  let foldedOffset = 0;
  for (const part of graphemeSegmenter.segment(value)) {
    const sourceStart = part.index;
    const sourceEnd = sourceStart + part.segment.length;
    const strippedGrapheme = foldGrapheme(part.segment);
    // Case folding is context-independent (unlike `String.prototype.toLowerCase`, which
    // applies word-position-dependent rules such as Greek Final_Sigma), so folding this
    // grapheme in isolation always matches folding it as part of the whole string. The
    // projected `text` below is built directly from these same per-grapheme parts rather
    // than re-derived from a separate whole-string fold that could disagree with the
    // offsets recorded here.
    const foldedPart = caseSensitive ? strippedGrapheme : caseFold(strippedGrapheme);
    appendFolded(foldedPart);
    const foldedStart = foldedOffset;
    foldedOffset += foldedPart.length;
    if (foldedPart.length > 0) {
      data.foldedStarts.push(foldedStart);
      data.foldedEnds.push(foldedOffset);
      data.sourceStarts.push(sourceStart);
      data.sourceEnds.push(sourceEnd);
    }
    data.boundaries.push(sourceEnd);
  }
  if (chunkParts.length > 0) {
    textChunks.push(chunkParts.join(""));
  }
  const text = textChunks.join("");
  // text.length always equals foldedOffset by construction: `text` is exactly the
  // concatenation, in order, of every `foldedPart` passed to `appendFolded` above (chunking
  // only batches that concatenation into fewer `join` calls; it never drops or duplicates a
  // part), and `foldedOffset` is the running sum of `foldedPart.length` over that same
  // sequence. There is no separate derivation of `text` for these two values to disagree on.
  const projection = {} as SearchTextProjection;
  let materializedSegments: SearchTextSegment[] | undefined;
  let materializedBoundaries: number[] | undefined;
  Object.defineProperties(projection, {
    source: { value, enumerable: true },
    text: { value: text, enumerable: true },
    segments: {
      enumerable: true,
      get: (): readonly SearchTextSegment[] => {
        if (!materializedSegments) {
          materializedSegments = Array.from({ length: data.foldedStarts.length }, (_, index) => ({
            foldedStart: data.foldedStarts.get(index),
            foldedEnd: data.foldedEnds.get(index),
            sourceStart: data.sourceStarts.get(index),
            sourceEnd: data.sourceEnds.get(index),
          }));
        }
        return materializedSegments;
      },
    },
    boundaries: {
      enumerable: true,
      get: (): readonly number[] => {
        materializedBoundaries ??= data.boundaries.toArray();
        return materializedBoundaries;
      },
    },
  });
  compactProjectionData.set(projection, data);
  return projection;
}

export function foldSearchText(value: string, caseSensitive = false): string {
  const canonical = value.normalize("NFC");
  let hasNonAscii = false;
  for (let index = 0; index < canonical.length; index += 1) {
    if ((canonical.charCodeAt(index) ?? 0) > 0x7f) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) {
    return caseSensitive ? canonical : canonical.toLowerCase();
  }
  let hasLatinBase = false;
  for (const codePoint of canonical) {
    if (isLatinBase(codePoint)) {
      hasLatinBase = true;
      break;
    }
  }
  if (!hasLatinBase) {
    return caseSensitive ? canonical : caseFold(canonical);
  }
  const foldedChunks: string[] = [];
  let foldedParts: string[] = [];
  let foldedChunkLength = 0;
  for (const part of graphemeSegmenter.segment(canonical)) {
    const foldedPart = foldGrapheme(part.segment);
    foldedParts.push(foldedPart);
    foldedChunkLength += foldedPart.length;
    if (foldedChunkLength >= textChunkSize) {
      foldedChunks.push(foldedParts.join(""));
      foldedParts = [];
      foldedChunkLength = 0;
    }
  }
  if (foldedParts.length > 0) {
    foldedChunks.push(foldedParts.join(""));
  }
  const foldedText = foldedChunks.join("");
  return caseSensitive ? foldedText : caseFold(foldedText);
}

interface GraphemeRange {
  index: number;
  end: number;
}

function nextGrapheme(iterator: Iterator<Intl.SegmentData>): GraphemeRange | undefined {
  const next = iterator.next();
  if (next.done || !next.value) {
    return undefined;
  }
  return { index: next.value.index, end: next.value.index + next.value.segment.length };
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if ((value.charCodeAt(index) ?? 0) > 0x7f) {
      return false;
    }
  }
  return true;
}

/** True when every UTF-16 position is an extended-grapheme boundary. */
export function isSimpleSearchText(value: string): boolean {
  return isAscii(value) && !value.includes("\r\n");
}

/**
 * Visit non-overlapping matches whose start and end are both extended
 * grapheme boundaries. Searching a folded key still needs this check: a
 * plain `a` must not match the `a` prefix of `a\u064e`, and a regional-
 * indicator tail, raw ZWJ, or standalone combining mark must not match inside
 * its containing grapheme.
 */
function visitValidMatches(
  haystack: string,
  needle: string,
  visitor: (start: number) => boolean | undefined,
): number {
  if (!needle || needle.length > haystack.length) {
    return 0;
  }
  // Every UTF-16 position is an extended-grapheme boundary for ASCII text,
  // except between CR and LF. Do not infer boundary safety from a handful of
  // continuation characters: UAX #29 also joins Prepend, Hangul, RI pairs,
  // spacing marks, and newer script-specific rules. Any non-ASCII haystack
  // therefore takes the segmenter path below, which is the complete runtime
  // grapheme implementation and remains linear in the haystack length.
  if (isSimpleSearchText(haystack) && isAscii(needle)) {
    let count = 0;
    let found = haystack.indexOf(needle);
    while (found !== -1) {
      count += 1;
      if (visitor(found) === false) {
        return count;
      }
      found = haystack.indexOf(needle, found + Math.max(1, needle.length));
    }
    return count;
  }

  const iterator = graphemeSegmenter.segment(haystack)[Symbol.iterator]();
  let current = nextGrapheme(iterator);
  let count = 0;
  let candidate = haystack.indexOf(needle);
  while (candidate !== -1) {
    while (current && current.index < candidate) {
      current = nextGrapheme(iterator);
    }
    let valid = current?.index === candidate;
    if (valid && current) {
      const end = candidate + needle.length;
      while (current) {
        if (current.end === end) {
          break;
        }
        if (current.end > end) {
          valid = false;
          break;
        }
        current = nextGrapheme(iterator);
      }
      valid = valid && current?.end === end;
    }
    if (valid) {
      count += 1;
      if (visitor(candidate) === false) {
        break;
      }
    }
    candidate = haystack.indexOf(needle, candidate + Math.max(1, needle.length));
  }
  return count;
}

/** Return the first semantic match, or -1 when no full-grapheme match exists. */
export function searchTextFindMatch(haystack: string, needle: string): number {
  let first = -1;
  visitValidMatches(haystack, needle, (start) => {
    first = start;
    return false;
  });
  return first;
}

export function searchTextFindMappedMatch(
  projection: SearchTextProjection,
  needle: string,
): { position: number; range: SearchTextSourceRange } | null {
  let match: { position: number; range: SearchTextSourceRange } | null = null;
  visitValidMatches(projection.text, needle, (position) => {
    const range = mapSearchMatchToSourceRange(projection, position, needle.length);
    if (!range) {
      return undefined;
    }
    match = { position, range };
    return false;
  });
  return match;
}

/**
 * Count only matches that begin and end at folded grapheme boundaries. This
 * keeps a query for an unmarked Latin base from matching the prefix of a
 * grapheme whose script-specific mark is significant.
 */
export function searchTextMatchCount(haystack: string, needle: string): number {
  return visitValidMatches(haystack, needle, () => undefined);
}

export function searchTextContains(haystack: string, needle: string): boolean {
  return searchTextFindMatch(haystack, needle) !== -1;
}

export function searchTextStartsWith(haystack: string, needle: string): boolean {
  return searchTextFindMatch(haystack, needle) === 0;
}

/**
 * Map a match in a derived key to whole source graphemes. A match that starts
 * or ends inside a folded grapheme expands to that grapheme's full source
 * range, so callers can safely slice `projection.source` with the result.
 */
export function mapSearchMatchToSourceRange(
  projection: SearchTextProjection,
  foldedStart: number,
  foldedLength: number,
): SearchTextSourceRange | null {
  if (
    !Number.isInteger(foldedStart) ||
    !Number.isInteger(foldedLength) ||
    foldedStart < 0 ||
    foldedLength <= 0 ||
    foldedStart + foldedLength > projection.text.length
  ) {
    return null;
  }
  const foldedEnd = foldedStart + foldedLength;
  const data = dataForProjection(projection);
  const firstIndex = lowerBound(data.foldedStarts, foldedStart);
  if (firstIndex >= data.foldedStarts.length || data.foldedStarts.get(firstIndex) !== foldedStart) {
    return null;
  }
  const lastIndex = lowerBound(data.foldedEnds, foldedEnd);
  if (lastIndex >= data.foldedEnds.length || data.foldedEnds.get(lastIndex) !== foldedEnd) {
    return null;
  }
  return {
    start: data.sourceStarts.get(firstIndex),
    end: data.sourceEnds.get(lastIndex),
  };
}

export function sourceBoundaryAtOrBefore(projection: SearchTextProjection, offset: number): number {
  const target = Math.max(0, Math.min(offset, projection.source.length));
  const boundaries = dataForProjection(projection).boundaries;
  const firstAfter = upperBound(boundaries, target);
  return firstAfter === 0 ? 0 : boundaries.get(firstAfter - 1);
}

export function sourceBoundaryAtOrAfter(projection: SearchTextProjection, offset: number): number {
  const target = Math.max(0, Math.min(offset, projection.source.length));
  const boundaries = dataForProjection(projection).boundaries;
  const firstAtOrAfter = lowerBound(boundaries, target);
  return firstAtOrAfter < boundaries.length
    ? boundaries.get(firstAtOrAfter)
    : projection.source.length;
}

function dataForProjection(projection: SearchTextProjection): CompactProjectionData {
  const known = compactProjectionData.get(projection);
  if (known) {
    return known;
  }
  const data: CompactProjectionData = {
    foldedStarts: new ChunkedOffsets(),
    foldedEnds: new ChunkedOffsets(),
    sourceStarts: new ChunkedOffsets(),
    sourceEnds: new ChunkedOffsets(),
    boundaries: new ChunkedOffsets(),
  };
  data.boundaries.push(0);
  for (const segment of projection.segments) {
    data.foldedStarts.push(segment.foldedStart);
    data.foldedEnds.push(segment.foldedEnd);
    data.sourceStarts.push(segment.sourceStart);
    data.sourceEnds.push(segment.sourceEnd);
  }
  for (const boundary of projection.boundaries) {
    if (data.boundaries.length === 1 && boundary === 0) {
      continue;
    }
    data.boundaries.push(boundary);
  }
  compactProjectionData.set(projection, data);
  return data;
}

function lowerBound(values: ChunkedOffsets, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values.get(middle) < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function upperBound(values: ChunkedOffsets, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values.get(middle) <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
