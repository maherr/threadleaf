import type { RenderContext } from "./obsidian-compat";

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
