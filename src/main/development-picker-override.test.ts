import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readDevelopmentPickerOverride,
  readDevelopmentVaultPath,
} from "./development-picker-override";

describe("readDevelopmentVaultPath", () => {
  it("ignores the vault override in packaged builds", () => {
    expect(readDevelopmentVaultPath(true, { THREADLEAF_VAULT_PATH: "/vault" })).toBeUndefined();
  });

  it("normalizes a meaningful development vault path", () => {
    expect(readDevelopmentVaultPath(false, { THREADLEAF_VAULT_PATH: " ./vault " })).toBe(
      path.resolve("./vault"),
    );
    expect(readDevelopmentVaultPath(false, { THREADLEAF_VAULT_PATH: "  " })).toBeUndefined();
  });
});

describe("readDevelopmentPickerOverride", () => {
  it("ignores test picker settings in packaged builds", () => {
    expect(
      readDevelopmentPickerOverride(true, {
        THREADLEAF_TEST_PICKER_CANCEL: "1",
        THREADLEAF_TEST_PICKER_PATH: "/vault",
      }),
    ).toBeNull();
  });

  it("can model a cancelled picker in development", () => {
    expect(readDevelopmentPickerOverride(false, { THREADLEAF_TEST_PICKER_CANCEL: "1" })).toEqual({
      status: "cancelled",
    });
  });

  it("gives cancellation priority over a selected test path", () => {
    expect(
      readDevelopmentPickerOverride(false, {
        THREADLEAF_TEST_PICKER_CANCEL: "1",
        THREADLEAF_TEST_PICKER_PATH: "/vault",
      }),
    ).toEqual({ status: "cancelled" });
  });

  it("normalizes a selected development path", () => {
    expect(
      readDevelopmentPickerOverride(false, { THREADLEAF_TEST_PICKER_PATH: " ./vault " }),
    ).toEqual({ status: "selected", path: path.resolve("./vault") });
  });

  it("does not override the native picker without a meaningful setting", () => {
    expect(readDevelopmentPickerOverride(false, {})).toBeNull();
    expect(readDevelopmentPickerOverride(false, { THREADLEAF_TEST_PICKER_PATH: "  " })).toBeNull();
  });
});
