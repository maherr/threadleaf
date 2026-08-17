import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "./obsidian-compat";
import {
  BooleanValue,
  DateValue,
  DurationValue,
  FileValue,
  HTMLValue,
  IconValue,
  ImageValue,
  LinkValue,
  ListValue,
  NotNullValue,
  NullValue,
  NumberValue,
  ObjectValue,
  PrimitiveValue,
  RegExpValue,
  RelativeDateValue,
  StringValue,
  TagValue,
  UrlValue,
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

  it("supports date, duration, link, tag, regexp, and string value families", () => {
    const localDate = new Date(2026, 0, 2, 3, 4, 5);
    const date = new DateValue(localDate);
    const dateOnly = date.dateOnly();
    const parsedDate = DateValue.parseFromString("2026-01-02");
    const duration = DurationValue.parseFromString("P1DT2H") ?? DurationValue.fromMilliseconds(0);
    const oneHour = DurationValue.fromMilliseconds(3_600_000);
    const regexp = new RegExpValue(/threadleaf/iu);
    const dom = new JSDOM("<!doctype html><body></body>");
    const target = dom.window.document.createElement("div");
    const metadataCache = {
      getFirstLinkpathDest: vi.fn().mockReturnValue({ path: "Notes/Welcome.md" }),
    };
    const app = { metadataCache } as unknown as App;
    const link = LinkValue.parseFromString(app, "[[Notes/Welcome|Welcome note]]", "Daily/Today.md");
    const tag = new TagValue("project/compatibility");

    expect(date.toString()).toBe("2026-01-02T03:04:05");
    expect(dateOnly.toString()).toBe("2026-01-02");
    expect(dateOnly).not.toBe(date);
    expect(parsedDate?.toString()).toBe("2026-01-02");
    expect(date.isTruthy()).toBe(true);
    expect(new RelativeDateValue(localDate).toString()).toEqual(expect.any(String));
    date.renderTo(target, {} as never);
    expect(target.querySelector("input")?.value).toBe("2026-01-02T03:04:05.000");
    expect(duration.isTruthy()).toBe(true);
    expect(duration.addToDate(date).toString()).toBe("2026-01-03T05:04:05");
    expect(oneHour.addToDate(date).toString()).toBe("2026-01-02T04:04:05");
    expect(DurationValue.parseFromString("2 weeks")?.days).toBe(14);
    expect(DurationValue.parseFromString("2h")?.hours).toBe(2);
    expect(DurationValue.parseFromString("5 ms")?.milliseconds).toBe(5);
    expect(DurationValue.parseFromString("not a duration")).toBeNull();
    expect(regexp.toString()).toBe("/threadleaf/iu");
    expect(regexp.isTruthy()).toBe(true);
    expect(new HTMLValue("<strong>value</strong>").toString()).toBe("<strong>value</strong>");
    expect(new IconValue("lucide-leaf").toString()).toBe("lucide-leaf");
    expect(new ImageValue("assets/leaf.png").toString()).toBe("assets/leaf.png");
    expect(new UrlValue("https://threadleaf.test").toString()).toBe("https://threadleaf.test");
    expect(tag.toString()).toBe("#project/compatibility");
    expect(tag.tagMatches(new TagValue("#project"))).toBe(true);
    expect(link?.toString()).toBe("[[Notes/Welcome|Welcome note]]");
    expect(link?.resolve()).toEqual({ path: "Notes/Welcome.md" });
    expect(metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
      "Notes/Welcome",
      "Daily/Today.md",
    );

    dom.window.close();
  });

  it("supports file, list, and object values", () => {
    const file = new FileValue({} as App, { path: "Notes/Value.md" } as TFile);
    const list = new ListValue([1, "two", null]);
    const object = new ObjectValue({ label: "value", count: 2 });

    expect(file.toString()).toBe("Notes/Value.md");
    expect(file.isTruthy()).toBe(true);
    expect(ListValue.type).toBe("List");
    expect(list.toString()).toBe("1, two, null");
    expect(list.includes(new StringValue("two"))).toBe(true);
    expect(list.length()).toBe(3);
    expect(list.get(0).toString()).toBe("1");
    expect(list.get(9)).toBe(NullValue.value);
    expect(list.concat(new ListValue(["three"])).toString()).toBe("1, two, null, three");
    expect(ObjectValue.type).toBe("Object");
    expect(object.toString()).toBe('{"label":"value","count":"2"}');
    expect(object.isTruthy()).toBe(true);
    expect(object.isEmpty()).toBe(false);
    expect(new ObjectValue({}).isEmpty()).toBe(true);
    expect(object.get("label")?.toString()).toBe("value");
    expect(object.get("missing")).toBe(NullValue.value);
  });
});
