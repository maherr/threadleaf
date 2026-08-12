import { Component } from "./obsidian-components";
import { createCompatibleIcon } from "./obsidian-icons";

export interface MenuPositionDef {
  x: number;
  y: number;
  width?: number;
  overlap?: boolean;
  left?: boolean;
}

type MenuIconResolver = (iconId: string) => string | null;
type MenuEntry = MenuItem | MenuSeparator;

function replaceContent(element: HTMLElement, content: string | DocumentFragment): void {
  if (typeof content === "string") {
    element.textContent = content;
  } else {
    element.replaceChildren(content.cloneNode(true));
  }
}

export class MenuItem {
  private checked: boolean | null = null;
  private clickCallback: ((event: MouseEvent | KeyboardEvent) => unknown) | null = null;
  private disabled = false;
  private element: HTMLButtonElement | null = null;
  private icon: string | null = null;
  private isLabel = false;
  private section = "";
  private title: string | DocumentFragment = "";
  private warning = false;

  constructor(
    private readonly menu: Menu,
    private readonly iconResolver: MenuIconResolver,
  ) {}

  setTitle(title: string | DocumentFragment): this {
    this.title = title;
    this.renderCurrentElement();
    return this;
  }

  setIcon(icon: string | null): this {
    this.icon = icon;
    this.renderCurrentElement();
    return this;
  }

  setChecked(checked: boolean | null): this {
    this.checked = checked;
    this.renderCurrentElement();
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.renderCurrentElement();
    return this;
  }

  setWarning(isWarning: boolean): this {
    this.warning = isWarning;
    this.renderCurrentElement();
    return this;
  }

  setIsLabel(isLabel: boolean): this {
    this.isLabel = isLabel;
    this.renderCurrentElement();
    return this;
  }

  onClick(callback: (event: MouseEvent | KeyboardEvent) => unknown): this {
    this.clickCallback = callback;
    return this;
  }

  setSection(section: string): this {
    this.section = section;
    this.renderCurrentElement();
    return this;
  }

  render(document: Document): HTMLButtonElement {
    this.element = document.createElement("button");
    this.element.type = "button";
    this.element.className = "menu-item";
    this.element.addEventListener("click", (event) => this.activate(event));
    this.renderCurrentElement();
    return this.element;
  }

  private isEnabledAction(): boolean {
    return !this.disabled && !this.isLabel;
  }

  private activate(event: MouseEvent | KeyboardEvent): void {
    if (!this.isEnabledAction()) {
      return;
    }
    try {
      this.clickCallback?.(event);
    } finally {
      this.menu.hide();
    }
  }

  private renderCurrentElement(): void {
    const element = this.element;
    if (!element) {
      return;
    }
    element.replaceChildren();
    element.disabled = this.disabled || this.isLabel;
    element.classList.toggle("is-warning", this.warning);
    element.classList.toggle("is-label", this.isLabel);
    element.dataset.section = this.section;
    element.setAttribute("role", this.checked === null ? "menuitem" : "menuitemcheckbox");
    if (this.checked === null) {
      element.removeAttribute("aria-checked");
    } else {
      element.setAttribute("aria-checked", String(this.checked));
    }

    const icon = element.ownerDocument.createElement("span");
    icon.className = "menu-item-icon";
    icon.setAttribute("aria-hidden", "true");
    if (this.checked !== null) {
      icon.dataset.checked = String(this.checked);
      if (this.checked) {
        const check = createCompatibleIcon(element.ownerDocument, "check", null);
        if (check) {
          icon.append(check);
        }
      }
    } else if (this.icon) {
      const svg = createCompatibleIcon(
        element.ownerDocument,
        this.icon,
        this.iconResolver(this.icon),
      );
      if (svg) {
        icon.append(svg);
      } else {
        icon.dataset.icon = this.icon;
      }
    }
    const title = element.ownerDocument.createElement("span");
    title.className = "menu-item-title";
    replaceContent(title, this.title);
    element.append(icon, title);
  }
}

export class MenuSeparator {
  render(document: Document): HTMLElement {
    const separator = document.createElement("div");
    separator.className = "menu-separator";
    separator.setAttribute("role", "separator");
    return separator;
  }
}

export class Menu extends Component {
  private container: HTMLElement | null = null;
  private readonly entries: MenuEntry[] = [];
  private readonly hideCallbacks = new Set<() => unknown>();
  private noIcon = false;
  private parentElement: HTMLElement | null = null;
  private releaseListeners: (() => void) | null = null;
  private useNativeMenu = false;

  constructor(private readonly iconResolver: MenuIconResolver = () => null) {
    super();
  }

  setNoIcon(): this {
    this.noIcon = true;
    return this;
  }

  setUseNativeMenu(useNativeMenu: boolean): this {
    this.useNativeMenu = useNativeMenu;
    return this;
  }

  addItem(callback: (item: MenuItem) => unknown): this {
    if (!this.container) {
      const item = new MenuItem(this, this.iconResolver);
      callback(item);
      this.entries.push(item);
    }
    return this;
  }

  addSeparator(): this {
    if (!this.container) {
      this.entries.push(new MenuSeparator());
    }
    return this;
  }

  setParentElement(element: HTMLElement): this {
    this.parentElement = element;
    return this;
  }

  showAtMouseEvent(event: MouseEvent): this {
    return this.showAtPosition({ x: event.clientX, y: event.clientY }, event.view?.document);
  }

  showAtPosition(position: MenuPositionDef, documentOverride?: Document): this {
    this.hide();
    const document = documentOverride ?? this.parentElement?.ownerDocument ?? globalThis.document;
    if (!document) {
      throw new Error("Obsidian menu compatibility requires a renderer document.");
    }
    const container = document.createElement("div");
    container.className = "menu threadleaf-compat-menu";
    container.classList.toggle("menu-no-icon", this.noIcon);
    container.dataset.nativeRequested = String(this.useNativeMenu);
    container.setAttribute("role", "menu");
    container.tabIndex = -1;
    if (position.width !== undefined) {
      container.style.width = `${Math.max(0, position.width)}px`;
    }
    for (const entry of this.entries) {
      container.append(entry.render(document));
    }
    (this.parentElement ?? document.body).append(container);
    this.container = container;

    const rectangle = container.getBoundingClientRect();
    const viewportWidth = document.defaultView?.innerWidth ?? Number.POSITIVE_INFINITY;
    const viewportHeight = document.defaultView?.innerHeight ?? Number.POSITIVE_INFINITY;
    const preferredX = position.left ? position.x - rectangle.width : position.x;
    const preferredY = position.overlap ? position.y - rectangle.height : position.y;
    container.style.left = `${Math.max(4, Math.min(preferredX, viewportWidth - rectangle.width - 4))}px`;
    container.style.top = `${Math.max(4, Math.min(preferredY, viewportHeight - rectangle.height - 4))}px`;

    const onPointerDown = (event: Event): void => {
      if (!container.contains(event.target as Node | null)) {
        this.hide();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => this.handleKeyDown(event);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    this.releaseListeners = () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
    (this.actionElements()[0] ?? container).focus();
    return this;
  }

  hide(): this {
    if (!this.container) {
      return this;
    }
    this.releaseListeners?.();
    this.releaseListeners = null;
    this.container.remove();
    this.container = null;
    for (const callback of this.hideCallbacks) {
      callback();
    }
    return this;
  }

  close(): void {
    this.hide();
  }

  override onunload(): void {
    this.hide();
  }

  onHide(callback: () => unknown): void {
    this.hideCallbacks.add(callback);
  }

  static forEvent(event: PointerEvent | MouseEvent): Menu {
    return new this().showAtMouseEvent(event as MouseEvent);
  }

  private actionElements(): HTMLButtonElement[] {
    return this.container
      ? [...this.container.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")]
      : [];
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.container) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.hide();
      return;
    }
    const actions = this.actionElements();
    const activeIndex = actions.indexOf(event.target as HTMLButtonElement);
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && actions.length > 0) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (Math.max(0, activeIndex) + delta + actions.length) % actions.length;
      actions[nextIndex]?.focus();
    }
  }
}
