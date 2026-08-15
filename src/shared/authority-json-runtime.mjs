import { createHash } from "node:crypto";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalAuthorityJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalAuthorityJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalAuthorityJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Authority-bearing JSON contains a non-data value.");
  }
  return serialized;
}

export function authorityJsonSha256(value) {
  return createHash("sha256").update(canonicalAuthorityJson(value), "utf8").digest("hex");
}
