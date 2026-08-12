export interface CompatibilityEventRef {
  off(): void;
}

type DisposableEventRef =
  | CompatibilityEventRef
  | (() => void)
  | { emitter: { offref(ref: unknown): void } };

export class Component {
  private readonly children: Component[] = [];
  private readonly registrations: Array<() => void> = [];
  private loaded = false;

  load(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.onload();
    for (const child of this.children) {
      child.load();
    }
  }

  onload(): void {}

  unload(): void {
    if (!this.loaded && this.children.length === 0 && this.registrations.length === 0) {
      return;
    }

    let failure: unknown = null;
    try {
      this.onunload();
    } catch (error) {
      failure = error;
    }
    const releaseFailure = this.releaseComponentResources();
    failure ??= releaseFailure;
    this.loaded = false;
    if (failure) {
      throw failure;
    }
  }

  onunload(): void {}

  addChild<T extends Component>(component: T): T {
    if (this.children.includes(component)) {
      return component;
    }
    this.children.push(component);
    if (this.loaded) {
      component.load();
    }
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    const index = this.children.indexOf(component);
    if (index >= 0) {
      this.children.splice(index, 1);
      component.unload();
    }
    return component;
  }

  register(dispose: () => unknown): void {
    this.registrations.push(() => {
      dispose();
    });
  }

  registerEvent(eventRef: DisposableEventRef): void {
    if (typeof eventRef === "function") {
      this.register(eventRef);
      return;
    }
    if ("off" in eventRef && typeof eventRef.off === "function") {
      this.register(() => eventRef.off());
      return;
    }
    if ("emitter" in eventRef) {
      this.register(() => eventRef.emitter.offref(eventRef));
    }
  }

  registerDomEvent(
    element: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    element.addEventListener(type, callback, options);
    this.register(() => element.removeEventListener(type, callback, options));
  }

  registerInterval(id: number): number {
    this.register(() => globalThis.clearInterval(id));
    return id;
  }

  protected releaseComponentResources(): unknown | null {
    let failure: unknown = null;
    for (const child of [...this.children].reverse()) {
      try {
        child.unload();
      } catch (error) {
        failure ??= error;
      }
    }
    this.children.length = 0;

    for (const dispose of [...this.registrations].reverse()) {
      try {
        dispose();
      } catch (error) {
        failure ??= error;
      }
    }
    this.registrations.length = 0;
    return failure;
  }
}

export class BaseComponent {
  disabled = false;

  // biome-ignore lint/suspicious/noThenProperty: Required by Obsidian's public BaseComponent API.
  then(callback: (component: this) => unknown): this {
    callback(this);
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
}
