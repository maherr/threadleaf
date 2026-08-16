import calendarProfileJson from "../../scripts/compatibility/trust/calendar-beta-2.0.0-beta.2.authority-profile.json" with {
  type: "json",
};
import inspectionRunawayProfileJson from "../../scripts/compatibility/trust/inspection-runaway-0.1.0.authority-profile.json" with {
  type: "json",
};
import inspectionSafeProfileJson from "../../scripts/compatibility/trust/inspection-safe-0.1.0.authority-profile.json" with {
  type: "json",
};
import inspectionTeardownProfileJson from "../../scripts/compatibility/trust/inspection-teardown-0.1.0.authority-profile.json" with {
  type: "json",
};
import excalidraw2253ProfileJson from "../../scripts/compatibility/trust/obsidian-excalidraw-plugin-2.25.3.authority-profile.json" with {
  type: "json",
};
import excalidraw2264ProfileJson from "../../scripts/compatibility/trust/obsidian-excalidraw-plugin-2.26.4.authority-profile.json" with {
  type: "json",
};
import styleSettingsProfileJson from "../../scripts/compatibility/trust/obsidian-style-settings-1.0.9.authority-profile.json" with {
  type: "json",
};
import templaterProfileJson from "../../scripts/compatibility/trust/templater-obsidian-2.25.0.authority-profile.json" with {
  type: "json",
};
import {
  type ExactPluginPackageIdentity,
  type PluginCapabilityId,
  pluginCapabilityIds,
  type ReviewedAuthorityExecutionProfile,
  type ReviewedAuthorityPlatform,
  type ReviewedAuthorityProfile,
  reviewedAuthorityExecutionProfiles,
  reviewedAuthorityPlatforms,
  reviewedAuthorityProfileSchemaVersion,
} from "../shared/plugins";

export { authorityJsonSha256, canonicalAuthorityJson } from "../shared/authority-json";

import { authorityJsonSha256 } from "../shared/authority-json";

const digestPattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u;
const profileIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const profileSchemaReference = "./reviewed-authority-profile.v1.schema.json";
const ambientNodeAuthorities = ["network", "filesystem", "subprocess"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unknown fields.`);
  }
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new Error(`${label} must be an exact non-floating version or distribution tag.`);
  }
  return value;
}

function parseCapabilities(value: unknown, label: string): PluginCapabilityId[] {
  if (!Array.isArray(value) || value.length > pluginCapabilityIds.length) {
    throw new Error(`${label} must be a bounded capability array.`);
  }
  const capabilities = value.map((candidate): PluginCapabilityId => {
    if (
      typeof candidate !== "string" ||
      !pluginCapabilityIds.includes(candidate as PluginCapabilityId)
    ) {
      throw new Error(`${label} contains an unknown capability.`);
    }
    return candidate as PluginCapabilityId;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(`${label} contains duplicate capabilities.`);
  }
  return capabilities;
}

function parsePlatforms(value: unknown): ReviewedAuthorityPlatform[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > reviewedAuthorityPlatforms.length
  ) {
    throw new Error("Reviewed authority profile allowedPlatforms is invalid.");
  }
  const platforms = value.map((candidate): ReviewedAuthorityPlatform => {
    if (
      typeof candidate !== "string" ||
      !reviewedAuthorityPlatforms.includes(candidate as ReviewedAuthorityPlatform)
    ) {
      throw new Error("Reviewed authority profile contains an unknown platform.");
    }
    return candidate as ReviewedAuthorityPlatform;
  });
  if (new Set(platforms).size !== platforms.length) {
    throw new Error("Reviewed authority profile contains duplicate platforms.");
  }
  return platforms;
}

function parsePackageIdentity(value: unknown): ExactPluginPackageIdentity {
  if (!isRecord(value)) {
    throw new Error("Reviewed authority profile requires a complete package identity.");
  }
  requireExactKeys(
    value,
    [
      "pluginId",
      "manifestVersion",
      "distributionTag",
      "manifestSha256",
      "mainSha256",
      "stylesSha256",
      "packageTreeSha256",
    ],
    "Reviewed package identity",
  );
  if (
    typeof value.pluginId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.pluginId)
  ) {
    throw new Error("Reviewed package identity pluginId is invalid.");
  }
  return {
    pluginId: value.pluginId,
    manifestVersion: requireVersion(value.manifestVersion, "manifestVersion"),
    distributionTag: requireVersion(value.distributionTag, "distributionTag"),
    manifestSha256: requireDigest(value.manifestSha256, "manifestSha256"),
    mainSha256: requireDigest(value.mainSha256, "mainSha256"),
    stylesSha256:
      value.stylesSha256 === null ? null : requireDigest(value.stylesSha256, "stylesSha256"),
    packageTreeSha256: requireDigest(value.packageTreeSha256, "packageTreeSha256"),
  };
}

export function reviewedAuthorityPayload(profile: ReviewedAuthorityProfile) {
  return {
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    packageIdentity: profile.packageIdentity,
    packageIdentityDigest: profile.packageIdentityDigest,
    expectedStaticCapabilities: profile.expectedStaticCapabilities,
    requiredAuthorities: profile.requiredAuthorities,
    executionProfile: profile.executionProfile,
    allowedPlatforms: profile.allowedPlatforms,
  };
}

export function parseReviewedAuthorityProfile(value: unknown): ReviewedAuthorityProfile {
  if (!isRecord(value)) {
    throw new Error("Reviewed authority profile must be a JSON object.");
  }
  requireExactKeys(
    value,
    [
      "$schema",
      "schemaVersion",
      "profileId",
      "profileRevision",
      "packageIdentity",
      "packageIdentityDigest",
      "expectedStaticCapabilities",
      "requiredAuthorities",
      "executionProfile",
      "allowedPlatforms",
      "authorityDigest",
    ],
    "Reviewed authority profile",
  );
  if (
    value.$schema !== profileSchemaReference ||
    value.schemaVersion !== reviewedAuthorityProfileSchemaVersion ||
    typeof value.profileId !== "string" ||
    !profileIdPattern.test(value.profileId) ||
    typeof value.profileRevision !== "number" ||
    !Number.isSafeInteger(value.profileRevision) ||
    value.profileRevision < 1 ||
    typeof value.executionProfile !== "string" ||
    !reviewedAuthorityExecutionProfiles.includes(
      value.executionProfile as ReviewedAuthorityExecutionProfile,
    )
  ) {
    throw new Error("Reviewed authority profile metadata is invalid.");
  }
  const profile: ReviewedAuthorityProfile = {
    $schema: profileSchemaReference,
    schemaVersion: reviewedAuthorityProfileSchemaVersion,
    profileId: value.profileId,
    profileRevision: value.profileRevision,
    packageIdentity: parsePackageIdentity(value.packageIdentity),
    packageIdentityDigest: requireDigest(value.packageIdentityDigest, "packageIdentityDigest"),
    expectedStaticCapabilities: parseCapabilities(
      value.expectedStaticCapabilities,
      "expectedStaticCapabilities",
    ),
    requiredAuthorities: parseCapabilities(value.requiredAuthorities, "requiredAuthorities"),
    executionProfile: value.executionProfile as ReviewedAuthorityExecutionProfile,
    allowedPlatforms: parsePlatforms(value.allowedPlatforms),
    authorityDigest: requireDigest(value.authorityDigest, "authorityDigest"),
  };
  if (profile.packageIdentityDigest !== authorityJsonSha256(profile.packageIdentity)) {
    throw new Error("Reviewed authority profile package identity digest is stale.");
  }
  if (profile.authorityDigest !== authorityJsonSha256(reviewedAuthorityPayload(profile))) {
    throw new Error("Reviewed authority profile authority digest is stale.");
  }
  if (
    profile.expectedStaticCapabilities.some(
      (capability) => !profile.requiredAuthorities.includes(capability),
    )
  ) {
    throw new Error("Required authorities must include every expected static capability.");
  }
  if (
    ambientNodeAuthorities.some((capability) => !profile.requiredAuthorities.includes(capability))
  ) {
    throw new Error("Node renderer profiles must disclose filesystem, network, and subprocess.");
  }
  return profile;
}

function cloneProfile(profile: ReviewedAuthorityProfile): ReviewedAuthorityProfile {
  return {
    ...profile,
    packageIdentity: { ...profile.packageIdentity },
    expectedStaticCapabilities: [...profile.expectedStaticCapabilities],
    requiredAuthorities: [...profile.requiredAuthorities],
    allowedPlatforms: [...profile.allowedPlatforms],
  };
}

const parsedProfiles = [
  parseReviewedAuthorityProfile(styleSettingsProfileJson),
  parseReviewedAuthorityProfile(calendarProfileJson),
  parseReviewedAuthorityProfile(templaterProfileJson),
  parseReviewedAuthorityProfile(inspectionSafeProfileJson),
  parseReviewedAuthorityProfile(inspectionRunawayProfileJson),
  parseReviewedAuthorityProfile(inspectionTeardownProfileJson),
  parseReviewedAuthorityProfile(excalidraw2253ProfileJson),
  parseReviewedAuthorityProfile(excalidraw2264ProfileJson),
];

if (
  new Set(parsedProfiles.map(({ profileId }) => profileId)).size !== parsedProfiles.length ||
  new Set(parsedProfiles.map(({ packageIdentityDigest }) => packageIdentityDigest)).size !==
    parsedProfiles.length
) {
  throw new Error("Reviewed authority profile registry contains duplicate identities.");
}

export function reviewedAuthorityProfiles(): ReviewedAuthorityProfile[] {
  return parsedProfiles.map(cloneProfile);
}

export function reviewedAuthorityProfileByIdentity(
  packageIdentityDigest: string,
): ReviewedAuthorityProfile | null {
  const profile = parsedProfiles.find(
    (candidate) => candidate.packageIdentityDigest === packageIdentityDigest,
  );
  return profile ? cloneProfile(profile) : null;
}
