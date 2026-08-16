#!/usr/bin/env node

import { readFileSync } from "node:fs";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

const categories = [
  "note",
  "abstract",
  "info",
  "todo",
  "tip",
  "success",
  "question",
  "warning",
  "failure",
  "danger",
  "bug",
  "example",
  "quote",
];

// Machado, Oliveira, and Fernandes (2009), deuteranomaly operators in linear RGB.
const deutan = new Map([
  [
    0.6,
    [
      [0.498864, 0.674741, -0.173604],
      [0.205199, 0.754872, 0.039929],
      [-0.011131, 0.030969, 0.980162],
    ],
  ],
  [
    0.8,
    [
      [0.422823, 0.781057, -0.203881],
      [0.245752, 0.709602, 0.044646],
      [-0.011843, 0.037423, 0.974421],
    ],
  ],
]);

function block(pattern, label) {
  const match = pattern.exec(tokens);
  if (!match) throw new Error(`missing ${label} token block`);
  return match[1];
}

function values(source) {
  return Object.fromEntries(
    [...source.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/giu)].map((match) => [
      match[1],
      match[2].toLowerCase(),
    ]),
  );
}

const light = values(block(/:root\s*\{([\s\S]*?)\n\}/u, "light"));
const dark = values(block(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/u, "dark"));

function rgb(value) {
  if (!/^#[0-9a-f]{6}$/u.test(value ?? "")) throw new Error(`invalid color ${value}`);
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function linear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function delinear(value) {
  const bounded = Math.max(0, Math.min(1, value));
  return (bounded <= 0.0031308 ? bounded * 12.92 : 1.055 * bounded ** (1 / 2.4) - 0.055) * 255;
}

function luminance(color) {
  const [r, g, b] = color.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(left, right) {
  const high = Math.max(luminance(left), luminance(right));
  const low = Math.min(luminance(left), luminance(right));
  return (high + 0.05) / (low + 0.05);
}

function simulate(color, severity) {
  const matrix = deutan.get(severity);
  if (!matrix) throw new Error(`unsupported severity ${severity}`);
  const source = color.map(linear);
  return matrix.map((row) =>
    delinear(row.reduce((sum, item, index) => sum + item * source[index], 0)),
  );
}

function lab(color) {
  const [r, g, b] = color.map(linear);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (value) => (value > 216 / 24389 ? value ** (1 / 3) : (841 / 108) * value + 4 / 29);
  const [fx, fy, fz] = [x, y, z].map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function radians(degrees) {
  return (degrees * Math.PI) / 180;
}

function degrees(radiansValue) {
  return (radiansValue * 180) / Math.PI;
}

function ciede2000(first, second) {
  const [l1, a1, b1] = lab(first);
  const [l2, a2, b2] = lab(second);
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const meanC = (c1 + c2) / 2;
  const g = meanC > 0 ? 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7))) : 0;
  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;
  const c1Prime = Math.hypot(a1Prime, b1);
  const c2Prime = Math.hypot(a2Prime, b2);
  const h1Prime = (degrees(Math.atan2(b1, a1Prime)) + 360) % 360;
  const h2Prime = (degrees(Math.atan2(b2, a2Prime)) + 360) % 360;
  const deltaL = l2 - l1;
  const deltaC = c2Prime - c1Prime;
  let deltaHue = 0;
  if (c1Prime * c2Prime !== 0) {
    const difference = h2Prime - h1Prime;
    deltaHue =
      Math.abs(difference) <= 180
        ? difference
        : difference > 180
          ? difference - 360
          : difference + 360;
  }
  const deltaH = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(radians(deltaHue) / 2);
  const meanL = (l1 + l2) / 2;
  const meanCPrime = (c1Prime + c2Prime) / 2;
  let meanHue;
  if (c1Prime * c2Prime === 0) meanHue = h1Prime + h2Prime;
  else if (Math.abs(h1Prime - h2Prime) <= 180) meanHue = (h1Prime + h2Prime) / 2;
  else if (h1Prime + h2Prime < 360) meanHue = (h1Prime + h2Prime + 360) / 2;
  else meanHue = (h1Prime + h2Prime - 360) / 2;
  const t =
    1 -
    0.17 * Math.cos(radians(meanHue - 30)) +
    0.24 * Math.cos(radians(2 * meanHue)) +
    0.32 * Math.cos(radians(3 * meanHue + 6)) -
    0.2 * Math.cos(radians(4 * meanHue - 63));
  const deltaTheta = 30 * Math.exp(-1 * ((meanHue - 275) / 25) ** 2);
  const rc = meanCPrime > 0 ? 2 * Math.sqrt(meanCPrime ** 7 / (meanCPrime ** 7 + 25 ** 7)) : 0;
  const sl = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanCPrime;
  const sh = 1 + 0.015 * meanCPrime * t;
  const rt = -Math.sin(radians(2 * deltaTheta)) * rc;
  return Math.sqrt(
    (deltaL / sl) ** 2 +
      (deltaC / sc) ** 2 +
      (deltaH / sh) ** 2 +
      rt * (deltaC / sc) * (deltaH / sh),
  );
}

function auditTheme(name, theme) {
  const inks = categories.map((category) => [category, rgb(theme[`callout-${category}-ink`])]);
  const grounds = {
    title: rgb(theme["background-secondary-alt"]),
    body: rgb(theme["background-primary-alt"]),
    outside: rgb(theme["background-primary"]),
  };
  const contrastRows = inks.flatMap(([category, color]) =>
    Object.entries(grounds).map(([ground, background]) => ({
      category,
      ground,
      ratio: contrast(color, background),
    })),
  );
  const pairwise = Object.fromEntries(
    [...deutan.keys()].map((severity) => {
      const rows = [];
      for (let left = 0; left < inks.length; left += 1) {
        for (let right = left + 1; right < inks.length; right += 1) {
          rows.push({
            left: inks[left][0],
            right: inks[right][0],
            delta: ciede2000(simulate(inks[left][1], severity), simulate(inks[right][1], severity)),
          });
        }
      }
      return [severity, rows.sort((a, b) => a.delta - b.delta)[0]];
    }),
  );
  const minimumContrast = contrastRows.sort((a, b) => a.ratio - b.ratio)[0];
  if (minimumContrast.ratio < 3)
    throw new Error(`${name} UI contrast failed: ${JSON.stringify(minimumContrast)}`);
  for (const [severity, minimum] of Object.entries(pairwise)) {
    if (minimum.delta < 11)
      throw new Error(`${name} deutan ${severity} failed: ${JSON.stringify(minimum)}`);
  }
  return { minimumContrast, pairwise };
}

if (/background:\s*color-mix\([^;]*var\(--callout-color\)/u.test(renderer)) {
  throw new Error("callout category color leaked back into a pale material channel");
}
if (!/\.callout\s*\{[^}]*background:\s*var\(--surface-raised\)/su.test(renderer)) {
  throw new Error("callout body is not the shared raised material");
}
if (!/\.callout-title\s*\{[^}]*background:\s*var\(--surface-sunken\)/su.test(renderer)) {
  throw new Error("callout title is not the shared sunken material");
}

console.log(
  JSON.stringify(
    {
      schema: "threadleaf-longstitch-color-audit/v1",
      thresholds: { uiContrast: 3, categoricalCiede2000: 11 },
      light: auditTheme("light", light),
      dark: auditTheme("dark", dark),
      materialChannels: { title: "shared", body: "shared", categorical: false },
    },
    null,
    2,
  ),
);
