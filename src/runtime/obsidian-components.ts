export interface CompatibilityEventRef {
  off(): void;
}

type DisposableEventRef =
  | CompatibilityEventRef
  | (() => void)
  | { emitter: { offref(ref: unknown): void } };

export class Component {
  _loaded = false;
  private readonly componentChildren: Component[] = [];
  private readonly registrations: Array<() => void> = [];

  load(): void {
    if (this._loaded) {
      return;
    }
    this._loaded = true;
    this.onload();
    for (const child of this.componentChildren) {
      child.load();
    }
  }

  onload(): void {}

  unload(): void {
    if (!this._loaded && this.componentChildren.length === 0 && this.registrations.length === 0) {
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
    this._loaded = false;
    if (failure) {
      throw failure;
    }
  }

  onunload(): void {}

  addChild<T extends Component>(component: T): T {
    if (this.componentChildren.includes(component)) {
      return component;
    }
    this.componentChildren.push(component);
    if (this._loaded) {
      component.load();
    }
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    const index = this.componentChildren.indexOf(component);
    if (index >= 0) {
      this.componentChildren.splice(index, 1);
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
    for (const child of [...this.componentChildren].reverse()) {
      try {
        child.unload();
      } catch (error) {
        failure ??= error;
      }
    }
    this.componentChildren.length = 0;

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
