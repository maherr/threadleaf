import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  BooleanValue,
  NotNullValue,
  NullValue,
  NumberValue,
  PrimitiveValue,
  StringValue,
  Value,
} from "./obsidian-values";

describe("Obsidian value compatibility", () => {
  it("supports primitive wrappers, singleton null, equality, and rendering", () => {
    class RawPrimitiveValue extends PrimitiveValue<string> {}

    const raw = new RawPrimitiveValue("raw");
    const truthy = new BooleanValue(true);
    const falsey = new BooleanValue(false);
    const text = new StringValue("1");
    const number = new NumberValue(1);
    const nullValue = NullValue.value;
    const dom = new JSDOM("<!doctype html><body></body>");
    const target = dom.window.document.createElement("div");

    expect(raw.toString()).toBe("raw");
    expect(raw.isTruthy()).toBe(true);
    expect(truthy instanceof NotNullValue).toBe(true);
    expect(BooleanValue.type).toBe("boolean");
    expect(StringValue.type).toBe("string");
    expect(NumberValue.type).toBe("number");
    expect(Value.type).toBe("unknown");
    expect(Value.equals(new StringValue("same"), new StringValue("same"))).toBe(true);
    expect(Value.equals(text, number)).toBe(false);
    expect(Value.looseEquals(text, number)).toBe(true);
    expect(truthy.equals(new BooleanValue(true))).toBe(true);
    expect(falsey.isTruthy()).toBe(false);
    expect(nullValue).toBe(NullValue.value);
    expect(nullValue.toString()).toBe("null");
    expect(nullValue.isTruthy()).toBe(false);
    expect(Value.equals(null, null)).toBe(true);
    expect(Value.looseEquals(null, nullValue)).toBe(false);

    text.renderTo(target, {} as never);
    expect(target.textContent).toBe("1");

    dom.window.close();
  });
});
