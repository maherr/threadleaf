import { describe, expect, it } from "vitest";
import {
  foldSearchText,
  mapSearchMatchToSourceRange,
  projectSearchText,
  searchTextFindMatch,
} from "./search-text";

const MiB = 1024 * 1024;

function collectMemory(): number {
  const usage = process.memoryUsage();
  return usage.rss;
}

function collectGc(): void {
  const candidate = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  candidate?.();
}

function measureProjection(units: number): number {
  const source = `${"x".repeat(units - 7)} needle`;
  const started = performance.now();
  const projection = projectSearchText(source);
  const position = searchTextFindMatch(projection.text, "needle");
  expect(position).toBe(units - 6);
  expect(mapSearchMatchToSourceRange(projection, position, "needle".length)).toEqual({
    start: units - 6,
    end: units,
  });
  return performance.now() - started;
}

function measureNonAsciiSearch(repetitions: number): number {
  const source = `${"😀 ".repeat(repetitions)}needle`;
  const started = performance.now();
  const position = searchTextFindMatch(source, "needle");
  expect(position).toBe(source.length - "needle".length);
  return performance.now() - started;
}

/**
 * Content that forces every grapheme through the pinned case-folding table
 * (uppercase Latin letters routed through caseFoldingCodePoints/Targets) and
 * through Latin-diacritic stripping (É), rather than the ASCII fast path.
 */
function caseFoldingSource(units: number): string {
  const word = "CAFÉ STRASSE ";
  const padding = word.repeat(Math.ceil(units / word.length) + 1).slice(0, units);
  return `${padding}needle`;
}

function measureFoldSearchText(units: number): number {
  const source = caseFoldingSource(units);
  const started = performance.now();
  const folded = foldSearchText(source);
  expect(folded.endsWith("needle")).toBe(true);
  return performance.now() - started;
}

function measureCaseFoldingProjection(units: number): number {
  const source = caseFoldingSource(units);
  const started = performance.now();
  const projection = projectSearchText(source);
  const position = searchTextFindMatch(projection.text, "needle");
  expect(position).toBeGreaterThan(0);
  expect(mapSearchMatchToSourceRange(projection, position, "needle".length)?.end).toBe(
    source.length,
  );
  return performance.now() - started;
}

describe("search text projection scale", () => {
  it("keeps 64k to 128k projection work near-linear", () => {
    measureProjection(16_384);
    const shortRuns = Array.from({ length: 3 }, () => measureProjection(65_536));
    const longRuns = Array.from({ length: 3 }, () => measureProjection(131_072));
    const short = Math.min(...shortRuns);
    const long = Math.min(...longRuns);

    // Use the best warmed run to avoid scheduler and GC pauses. A 4x ceiling
    // leaves room for CI noise while still catching super-linear projection.
    expect(long).toBeLessThan(Math.max(short * 4, 50));
  });

  it("keeps a one-million-unit projection below the 127 MiB footprint guard", () => {
    collectGc();
    const before = collectMemory();
    const source = `${"x".repeat(1_000_000 - 7)} needle`;
    const projection = projectSearchText(source);
    const position = searchTextFindMatch(projection.text, "needle");
    expect(mapSearchMatchToSourceRange(projection, position, "needle".length)).toEqual({
      start: 1_000_000 - 6,
      end: 1_000_000,
    });
    collectGc();
    const delta = collectMemory() - before;

    expect(delta).toBeLessThan(127 * MiB);
  });

  it("keeps the non-ASCII grapheme fallback near-linear", () => {
    measureNonAsciiSearch(4_096);
    const shortRuns = Array.from({ length: 3 }, () => measureNonAsciiSearch(16_384));
    const longRuns = Array.from({ length: 3 }, () => measureNonAsciiSearch(32_768));
    const short = Math.min(...shortRuns);
    const long = Math.min(...longRuns);

    // The fallback walks Intl.Segmenter boundaries once for each query. Keep
    // a deliberately broad ceiling for ICU and CI variance while rejecting
    // accidental repeated rescans of the full grapheme stream.
    expect(long).toBeLessThan(Math.max(short * 4, 50));
  });

  it("keeps foldSearchText near-linear at 16k/32k/64k character scales", () => {
    // Every grapheme here does a pinned case-folding table lookup (and, for
    // É, Latin-diacritic stripping); a per-character Map lookup keeps
    // this linear, but an accidental O(n^2) scan (e.g. repeated string
    // concatenation or a rescan per grapheme) would show up as a growing
    // per-unit cost well before one million units.
    measureFoldSearchText(16_384);
    const shortRuns = Array.from({ length: 3 }, () => measureFoldSearchText(32_768));
    const longRuns = Array.from({ length: 3 }, () => measureFoldSearchText(65_536));
    const short = Math.min(...shortRuns);
    const long = Math.min(...longRuns);

    expect(long).toBeLessThan(Math.max(short * 4, 50));
  });

  it("keeps projectSearchText's per-grapheme case folding near-linear at 16k/32k/64k character scales", () => {
    measureCaseFoldingProjection(16_384);
    const shortRuns = Array.from({ length: 3 }, () => measureCaseFoldingProjection(32_768));
    const longRuns = Array.from({ length: 3 }, () => measureCaseFoldingProjection(65_536));
    const short = Math.min(...shortRuns);
    const long = Math.min(...longRuns);

    expect(long).toBeLessThan(Math.max(short * 4, 50));
  });
});
