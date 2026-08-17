import moment from "moment";
import type { App, RenderContext, TFile } from "./obsidian-compat";

export abstract class Value {
  static type = "unknown";

  static equals(a: Value | null, b: Value | null): boolean {
    if (a === b) {
      return true;
    }
    if (a === null || b === null) {
      return false;
    }
    return Object.getPrototypeOf(a) === Object.getPrototypeOf(b) && a.toString() === b.toString();
  }

  static looseEquals(a: Value | null, b: Value | null): boolean {
    if (a === b) {
      return true;
    }
    if (a === null || b === null) {
      return false;
    }
    return a.toString() === b.toString();
  }

  abstract toString(): string;

  abstract isTruthy(): boolean;

  equals(other: this): boolean {
    return Value.equals(this, other);
  }

  looseEquals(other: Value): boolean {
    return Value.looseEquals(this, other);
  }

  renderTo(el: HTMLElement, _ctx: RenderContext): void {
    el.textContent = this.toString();
  }
}

export abstract class NotNullValue extends Value {}

export abstract class PrimitiveValue<T> extends NotNullValue {
  protected readonly primitiveValue: T;

  constructor(value: T) {
    super();
    this.primitiveValue = value;
  }

  toString(): string {
    return String(this.primitiveValue);
  }

  isTruthy(): boolean {
    return Boolean(this.primitiveValue);
  }
}

export class BooleanValue extends PrimitiveValue<boolean> {
  static type = "boolean";
}

export class StringValue extends PrimitiveValue<string> {
  static type = "string";
}

export class NumberValue extends PrimitiveValue<number> {
  static type = "number";
}

export class NullValue extends Value {
  static value: NullValue = new NullValue();

  toString(): string {
    return "null";
  }

  isTruthy(): boolean {
    return false;
  }
}

const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/u;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function padDatePart(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function formatDate(date: Date): string {
  return `${padDatePart(date.getFullYear(), 4)}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

function formatTime(date: Date): string {
  return `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`;
}

export class DateValue extends NotNullValue {
  static type = "Date";
  readonly date: Date;
  readonly time: boolean;

  constructor(date: Date, time = true) {
    super();
    if (Number.isNaN(date.getTime())) {
      throw new TypeError("DateValue requires a valid Date.");
    }
    this.date = new Date(date);
    this.time = time;
  }

  toString(): string {
    return this.time ? `${formatDate(this.date)}T${formatTime(this.date)}` : formatDate(this.date);
  }

  dateOnly(): DateValue {
    if (!this.time) {
      return this;
    }
    return new DateValue(new Date(`${formatDate(this.date)}T00:00:00`), false);
  }

  relative(): string {
    return moment(this.date).fromNow();
  }

  isTruthy(): boolean {
    return true;
  }

  equals(other: this): boolean {
    return this.time === other.time && this.date.getTime() === other.date.getTime();
  }

  looseEquals(other: Value): boolean {
    const candidate =
      other instanceof StringValue ? DateValue.parseFromString(other.toString()) : other;
    if (!(candidate instanceof DateValue)) {
      return false;
    }
    return this.dateOnly().date.getTime() === candidate.dateOnly().date.getTime();
  }

  printDate(): string {
    return formatDate(this.date);
  }

  printTime(): string {
    return formatTime(this.date);
  }

  renderTo(element: HTMLElement, _ctx: RenderContext): void {
    const input = element.ownerDocument.createElement("input");
    input.className = `metadata-input metadata-input-text ${this.time ? "mod-datetime" : "mod-date"}`;
    input.type = this.time ? "datetime-local" : "date";
    input.value = this.toString();
    input.step = "any";
    input.disabled = true;
    element.replaceChildren(input);
  }

  static parseFromString(input: string): DateValue | null {
    if (DATE_TIME_PATTERN.test(input)) {
      const date = new Date(input);
      return Number.isNaN(date.getTime()) ? null : new DateValue(date, true);
    }
    if (DATE_ONLY_PATTERN.test(input)) {
      const date = new Date(`${input}T00:00:00`);
      return Number.isNaN(date.getTime()) ? null : new DateValue(date, false);
    }
    return null;
  }
}

export class RelativeDateValue extends DateValue {
  override toString(): string {
    return this.relative();
  }

  override renderTo(element: HTMLElement, _ctx: RenderContext): void {
    const span = element.ownerDocument.createElement("span");
    span.className = this.time ? "mod-datetime" : "mod-date";
    span.textContent = this.relative();
    element.replaceChildren(span);
  }
}

function durationValue(value: string | undefined): number {
  return value === undefined ? 0 : Number.parseFloat(value.replace(",", "."));
}

export class DurationValue extends NotNullValue {
  static type = "Duration";
  readonly years: number;
  readonly months: number;
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly milliseconds: number;

  constructor(
    years: number,
    months: number,
    days: number,
    hours: number,
    minutes: number,
    seconds: number,
    milliseconds: number,
  ) {
    super();
    this.years = years;
    this.months = months;
    this.days = days;
    this.hours = hours;
    this.minutes = minutes;
    this.seconds = seconds;
    this.milliseconds = milliseconds;
  }

  toString(): string {
    return moment
      .duration({
        years: this.years,
        months: this.months,
        days: this.days,
        hours: this.hours,
        minutes: this.minutes,
        seconds: this.seconds,
        milliseconds: this.milliseconds,
      })
      .humanize();
  }

  isTruthy(): boolean {
    return [
      this.years,
      this.months,
      this.days,
      this.hours,
      this.minutes,
      this.seconds,
      this.milliseconds,
    ].some((value) => value !== 0);
  }

  equals(other: this): boolean {
    return (
      this.years === other.years &&
      this.months === other.months &&
      this.days === other.days &&
      this.hours === other.hours &&
      this.minutes === other.minutes &&
      this.seconds === other.seconds &&
      this.milliseconds === other.milliseconds
    );
  }

  looseEquals(other: Value): boolean {
    const candidate =
      other instanceof StringValue ? DurationValue.parseFromString(other.toString()) : other;
    return (
      candidate instanceof DurationValue && this.getMilliseconds() === candidate.getMilliseconds()
    );
  }

  addToDate(value: DateValue, subtract = false): DateValue {
    const direction = subtract ? -1 : 1;
    const date = new Date(value.date);
    if (this.years !== 0) date.setFullYear(date.getFullYear() + direction * this.years);
    if (this.months !== 0) date.setMonth(date.getMonth() + direction * this.months);
    if (this.days !== 0) date.setDate(date.getDate() + direction * this.days);
    let time = value.time;
    if (this.hours !== 0) {
      date.setHours(date.getHours() + direction * this.hours);
      time = true;
    }
    if (this.minutes !== 0) {
      date.setMinutes(date.getMinutes() + direction * this.minutes);
      time = true;
    }
    if (this.seconds !== 0) {
      date.setSeconds(date.getSeconds() + direction * this.seconds);
      time = true;
    }
    if (this.milliseconds !== 0) {
      date.setMilliseconds(date.getMilliseconds() + direction * this.milliseconds);
      time = true;
    }
    return new DateValue(date, time);
  }

  getMilliseconds(): number {
    const now = new Date();
    return this.addToDate(new DateValue(now)).date.getTime() - now.getTime();
  }

  static parseFromString(input: string): DurationValue | null {
    const iso = input.match(
      /^P(?:(-?[\d.,]+)Y)?(?:(-?[\d.,]+)M)?(?:(-?[\d.,]+)W)?(?:(-?[\d.,]+)D)?(?:T(?:(-?[\d.,]+)H)?(?:(-?[\d.,]+)M)?(?:(-?[\d.,]+)S)?)?$/u,
    );
    if (iso?.slice(1).some((value) => value !== undefined)) {
      return new DurationValue(
        durationValue(iso[1]),
        durationValue(iso[2]),
        7 * durationValue(iso[3]) + durationValue(iso[4]),
        durationValue(iso[5]),
        durationValue(iso[6]),
        durationValue(iso[7]),
        0,
      );
    }

    const simple = input.match(
      /^(-?[\d.,]+) ?(?:([dhmswMy])|(ms|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?))$/u,
    );
    if (!simple) {
      return null;
    }
    const amount = durationValue(simple[1]);
    const unit = simple[2] ?? simple[3];
    switch (unit) {
      case "y":
      case "year":
      case "years":
        return new DurationValue(amount, 0, 0, 0, 0, 0, 0);
      case "M":
      case "month":
      case "months":
        return new DurationValue(0, amount, 0, 0, 0, 0, 0);
      case "w":
      case "week":
      case "weeks":
        return new DurationValue(0, 0, 7 * amount, 0, 0, 0, 0);
      case "d":
      case "day":
      case "days":
        return new DurationValue(0, 0, amount, 0, 0, 0, 0);
      case "h":
      case "hour":
      case "hours":
        return new DurationValue(0, 0, 0, amount, 0, 0, 0);
      case "m":
      case "minute":
      case "minutes":
        return new DurationValue(0, 0, 0, 0, amount, 0, 0);
      case "s":
      case "second":
      case "seconds":
        return new DurationValue(0, 0, 0, 0, 0, amount, 0);
      case "ms":
      case "millisecond":
      case "milliseconds":
        return new DurationValue(0, 0, 0, 0, 0, 0, amount);
      default:
        return null;
    }
  }

  static fromMilliseconds(milliseconds: number): DurationValue {
    return new DurationValue(0, 0, 0, 0, 0, 0, milliseconds);
  }
}

export class RegExpValue extends NotNullValue {
  static type = "RegExp";
  readonly regexp: RegExp;

  constructor(regexp: RegExp) {
    super();
    this.regexp = regexp;
  }

  toString(): string {
    return this.regexp.toString();
  }

  isTruthy(): boolean {
    return true;
  }
}

export class HTMLValue extends StringValue {}

export class IconValue extends StringValue {}

export class ImageValue extends StringValue {}

export class UrlValue extends StringValue {}

export class TagValue extends StringValue {
  readonly lowerTag: string;

  constructor(value: string) {
    const tag = value.startsWith("#") ? value : `#${value}`;
    super(tag);
    this.lowerTag = tag.toLowerCase();
  }

  tagMatches(other: StringValue): boolean {
    const candidate = other instanceof TagValue ? other.lowerTag : other.toString().toLowerCase();
    return (
      this.lowerTag.startsWith(candidate) &&
      (this.lowerTag.length === candidate.length || this.lowerTag[candidate.length] === "/")
    );
  }
}

export class LinkValue extends StringValue {
  static type = "Link";
  readonly app: App;
  readonly sourcePath: string;
  readonly display: StringValue | null;

  constructor(app: App, target: string, sourcePath: string, display: StringValue | null = null) {
    super(target);
    this.app = app;
    this.sourcePath = sourcePath;
    this.display = display;
  }

  override toString(): string {
    return `[[${this.primitiveValue}${this.display ? `|${this.display.toString()}` : ""}]]`;
  }

  override isTruthy(): boolean {
    return true;
  }

  override equals(other: this): boolean {
    return (
      this.primitiveValue === other.primitiveValue &&
      this.sourcePath === other.sourcePath &&
      this.display?.toString() === other.display?.toString()
    );
  }

  override looseEquals(other: Value): boolean {
    if (other instanceof LinkValue) {
      const resolved = this.resolve();
      const otherResolved = other.resolve();
      return resolved && otherResolved
        ? resolved === otherResolved
        : this.primitiveValue === other.primitiveValue;
    }
    if (other instanceof StringValue) {
      const parsed = LinkValue.parseFromString(this.app, other.toString(), "");
      return parsed ? this.looseEquals(parsed) : false;
    }
    return false;
  }

  resolve(): TFile | null {
    return this.app.metadataCache.getFirstLinkpathDest(this.primitiveValue, this.sourcePath);
  }

  static parseFromString(app: App, input: string, sourcePath: string): LinkValue | null {
    if (!input.startsWith("[[") || !input.endsWith("]]")) {
      return null;
    }
    const inner = input.slice(2, -2);
    const separator = inner.lastIndexOf("|");
    const target = separator === -1 ? inner : inner.slice(0, separator);
    const display = separator === -1 ? null : new StringValue(inner.slice(separator + 1));
    return new LinkValue(app, target, sourcePath, display);
  }
}
