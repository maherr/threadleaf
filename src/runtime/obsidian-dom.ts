type DomEventListener = (event: Event, delegateTarget: Element) => unknown;

interface DomElementOptions {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | null>;
  title?: string;
  href?: string;
  value?: string;
  type?: string;
  prepend?: boolean;
}

interface ObsidianDomElement extends Element {
  addClass(...classes: string[]): void;
  addClasses(classes: string[]): void;
  removeClass(...classes: string[]): void;
  removeClasses(classes: string[]): void;
  toggleClass(className: string, value: boolean): void;
  hasClass(className: string): boolean;
  setAttr(name: string, value: string | number | null): void;
  setAttrs(attributes: Record<string, string | number | null>): void;
  getAttr(name: string): string | null;
  getText(): string;
  setText(value: string | DocumentFragment): void;
  empty(): void;
  createEl<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    options?: DomElementOptions | string | null,
    callback?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K];
  createDiv(
    options?: DomElementOptions | string | null,
    callback?: (element: HTMLDivElement) => void,
  ): HTMLDivElement;
  createSpan(
    options?: DomElementOptions | string | null,
    callback?: (element: HTMLSpanElement) => void,
  ): HTMLSpanElement;
  on(
    eventType: string,
    selector: string,
    listener: DomEventListener,
    options?: AddEventListenerOptions | boolean,
  ): void;
  off(
    eventType: string,
    selector: string,
    listener: DomEventListener,
    options?: EventListenerOptions | boolean,
  ): void;
  onClickEvent(
    listener: (event: MouseEvent) => unknown,
    options?: AddEventListenerOptions | boolean,
  ): void;
  show(): void;
  hide(): void;
  toggleVisibility(visible: boolean): void;
  setCssProps(properties: Record<string, string>): void;
  setCssStyles(styles: Partial<CSSStyleDeclaration>): void;
}

interface DomCompatibilityWindow {
  Element: typeof Element;
}

const delegatedListeners = new WeakMap<
  Element,
  Map<DomEventListener, Map<string, EventListener>>
>();

function defineMethod(
  prototype: object,
  name: keyof ObsidianDomElement,
  implementation: (...args: never[]) => unknown,
): void {
  if (typeof (prototype as Record<string, unknown>)[name] === "function") {
    return;
  }
  Object.defineProperty(prototype, name, {
    configurable: true,
    writable: true,
    value: implementation,
  });
}

function normalizedClasses(classes: string[]): string[] {
  return classes.flatMap((className) => className.split(/\s+/)).filter(Boolean);
}

function applyElementOptions(element: ObsidianDomElement, value: DomElementOptions | string): void {
  const options: DomElementOptions = typeof value === "string" ? { cls: value } : value;
  const classes = Array.isArray(options.cls) ? options.cls : options.cls ? [options.cls] : [];
  element.addClass(...classes);
  if (options.text !== undefined) {
    element.setText(options.text);
  }
  if (options.attr) {
    element.setAttrs(options.attr);
  }
  for (const property of ["title", "href", "value", "type"] as const) {
    const propertyValue = options[property];
    if (propertyValue !== undefined) {
      (element as unknown as Record<string, unknown>)[property] = propertyValue;
    }
  }
}

export function installObsidianDomCompatibility(targetWindow: DomCompatibilityWindow): void {
  const prototype = targetWindow.Element.prototype as unknown as ObsidianDomElement;

  defineMethod(prototype, "addClass", function (this: Element, ...classes: string[]) {
    this.classList.add(...normalizedClasses(classes));
  });
  defineMethod(prototype, "addClasses", function (this: Element, classes: string[]) {
    this.classList.add(...normalizedClasses(classes));
  });
  defineMethod(prototype, "removeClass", function (this: Element, ...classes: string[]) {
    this.classList.remove(...normalizedClasses(classes));
  });
  defineMethod(prototype, "removeClasses", function (this: Element, classes: string[]) {
    this.classList.remove(...normalizedClasses(classes));
  });
  defineMethod(
    prototype,
    "toggleClass",
    function (this: Element, className: string, value: boolean) {
      this.classList.toggle(className, value);
    },
  );
  defineMethod(prototype, "hasClass", function (this: Element, className: string) {
    return this.classList.contains(className);
  });
  defineMethod(
    prototype,
    "setAttr",
    function (this: Element, name: string, value: string | number | null) {
      if (value === null) {
        this.removeAttribute(name);
      } else {
        this.setAttribute(name, String(value));
      }
    },
  );
  defineMethod(
    prototype,
    "setAttrs",
    function (this: ObsidianDomElement, attributes: Record<string, string | number | null>) {
      for (const [name, value] of Object.entries(attributes)) {
        this.setAttr(name, value);
      }
    },
  );
  defineMethod(prototype, "getAttr", function (this: Element, name: string) {
    return this.getAttribute(name);
  });
  defineMethod(prototype, "getText", function (this: Element) {
    return this.textContent ?? "";
  });
  defineMethod(prototype, "setText", function (this: Element, value: string | DocumentFragment) {
    if (typeof value === "string") {
      this.textContent = value;
    } else {
      this.replaceChildren(value);
    }
  });
  defineMethod(prototype, "empty", function (this: Element) {
    this.replaceChildren();
  });
  defineMethod(prototype, "createEl", function <
    K extends keyof HTMLElementTagNameMap,
  >(this: ObsidianDomElement, tagName: K, options?: DomElementOptions | string | null, callback?: (element: HTMLElementTagNameMap[K]) => void) {
    const element = this.ownerDocument.createElement(tagName) as HTMLElementTagNameMap[K] &
      ObsidianDomElement;
    if (options) {
      applyElementOptions(element, options);
    }
    if (typeof options === "object" && options?.prepend) {
      this.prepend(element);
    } else {
      this.appendChild(element);
    }
    callback?.(element);
    return element;
  });
  defineMethod(
    prototype,
    "createDiv",
    function (
      this: ObsidianDomElement,
      options?: DomElementOptions | string | null,
      callback?: (element: HTMLDivElement) => void,
    ) {
      return this.createEl("div", options, callback);
    },
  );
  defineMethod(
    prototype,
    "createSpan",
    function (
      this: ObsidianDomElement,
      options?: DomElementOptions | string | null,
      callback?: (element: HTMLSpanElement) => void,
    ) {
      return this.createEl("span", options, callback);
    },
  );
  defineMethod(
    prototype,
    "on",
    function (
      this: Element,
      eventType: string,
      selector: string,
      listener: DomEventListener,
      options?: AddEventListenerOptions | boolean,
    ) {
      const delegated: EventListener = (event) => {
        const target = event.target instanceof targetWindow.Element ? event.target : null;
        const matched = target?.closest(selector);
        if (matched && (matched === this || this.contains(matched))) {
          listener.call(matched, event, matched);
        }
      };
      const byListener = delegatedListeners.get(this) ?? new Map();
      const byKey = byListener.get(listener) ?? new Map();
      byKey.set(`${eventType}:${selector}`, delegated);
      byListener.set(listener, byKey);
      delegatedListeners.set(this, byListener);
      this.addEventListener(eventType, delegated, options);
    },
  );
  defineMethod(
    prototype,
    "off",
    function (
      this: Element,
      eventType: string,
      selector: string,
      listener: DomEventListener,
      options?: EventListenerOptions | boolean,
    ) {
      const byListener = delegatedListeners.get(this);
      const byKey = byListener?.get(listener);
      const key = `${eventType}:${selector}`;
      const delegated = byKey?.get(key);
      if (!delegated) {
        return;
      }
      this.removeEventListener(eventType, delegated, options);
      byKey?.delete(key);
      if (byKey?.size === 0) {
        byListener?.delete(listener);
      }
      if (byListener?.size === 0) {
        delegatedListeners.delete(this);
      }
    },
  );
  defineMethod(
    prototype,
    "onClickEvent",
    function (
      this: Element,
      listener: (event: MouseEvent) => unknown,
      options?: AddEventListenerOptions | boolean,
    ) {
      this.addEventListener("click", listener as EventListener, options);
    },
  );
  defineMethod(prototype, "show", function (this: HTMLElement) {
    this.hidden = false;
    this.classList.remove("is-hidden");
  });
  defineMethod(prototype, "hide", function (this: HTMLElement) {
    this.hidden = true;
    this.classList.add("is-hidden");
  });
  defineMethod(
    prototype,
    "toggleVisibility",
    function (this: ObsidianDomElement, visible: boolean) {
      if (visible) {
        this.show();
      } else {
        this.hide();
      }
    },
  );
  defineMethod(
    prototype,
    "setCssProps",
    function (this: HTMLElement, properties: Record<string, string>) {
      for (const [name, value] of Object.entries(properties)) {
        this.style.setProperty(name, value);
      }
    },
  );
  defineMethod(
    prototype,
    "setCssStyles",
    function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
      Object.assign(this.style, styles);
    },
  );
}
