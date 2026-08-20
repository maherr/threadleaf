import type { WorkspaceBaseSnapshot, WorkspaceBaseViewSnapshot } from "../shared/contracts";

export interface BaseViewActions {
  openPath(path: string): Promise<void>;
}

function matchesQuery(view: WorkspaceBaseViewSnapshot, rowIndex: number, query: string): boolean {
  if (!query) return true;
  const row = view.rows[rowIndex];
  if (!row) return false;
  return [row.title, row.path, row.group ?? "", ...Object.values(row.values)]
    .join("\n")
    .toLocaleLowerCase("en-US")
    .includes(query);
}

export class BaseViewController {
  readonly #activeViewByPath = new Map<string, number>();
  readonly #queryByPath = new Map<string, string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly actions: BaseViewActions,
  ) {}

  render(snapshot: WorkspaceBaseSnapshot): void {
    const activeIndex = Math.min(
      this.#activeViewByPath.get(snapshot.path) ?? 0,
      Math.max(0, snapshot.views.length - 1),
    );
    this.#activeViewByPath.set(snapshot.path, activeIndex);
    const query = this.#queryByPath.get(snapshot.path) ?? "";
    this.root.replaceChildren();
    this.root.dataset.basePath = snapshot.path;

    const header = document.createElement("header");
    header.className = "base-view-header";
    const identity = document.createElement("div");
    identity.className = "base-view-identity";
    const eyebrow = document.createElement("span");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Base";
    const title = document.createElement("h2");
    title.textContent = snapshot.title;
    identity.append(eyebrow, title);
    header.append(identity);

    if (snapshot.views.length > 0) {
      const tabs = document.createElement("div");
      tabs.className = "base-view-tabs";
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", "Base views");
      snapshot.views.forEach((view, index) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "base-view-tab";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(index === activeIndex));
        tab.textContent = view.name;
        tab.addEventListener("click", () => {
          this.#activeViewByPath.set(snapshot.path, index);
          this.render(snapshot);
        });
        tabs.append(tab);
      });
      header.append(tabs);
    }

    const tools = document.createElement("div");
    tools.className = "base-view-tools";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search this view";
    search.setAttribute("aria-label", "Search displayed Base properties");
    search.value = query;
    search.addEventListener("input", () => {
      this.#queryByPath.set(snapshot.path, search.value);
      this.render(snapshot);
      const replacement = this.root.querySelector<HTMLInputElement>(".base-view-tools input");
      replacement?.focus({ preventScroll: true });
      replacement?.setSelectionRange(
        search.selectionStart ?? search.value.length,
        search.selectionEnd ?? search.value.length,
      );
    });
    tools.append(search);
    header.append(tools);
    this.root.append(header);

    if (snapshot.diagnostics.length > 0) {
      const notices = document.createElement("div");
      notices.className = "base-view-diagnostics";
      notices.setAttribute("role", "status");
      for (const diagnostic of snapshot.diagnostics) {
        const notice = document.createElement("p");
        notice.textContent = `${diagnostic.message} (${diagnostic.path})`;
        notices.append(notice);
      }
      this.root.append(notices);
    }

    const view = snapshot.views[activeIndex];
    if (!view) {
      const empty = document.createElement("div");
      empty.className = "base-view-empty";
      empty.innerHTML =
        "<strong>This Base has no usable view.</strong><span>Fix the YAML source in a text editor, then reopen it.</span>";
      this.root.append(empty);
      return;
    }

    const queryValue = query.toLocaleLowerCase("en-US").trim();
    const rows = view.rows.filter((_row, index) => matchesQuery(view, index, queryValue));
    const summary = document.createElement("p");
    summary.className = "base-view-summary";
    summary.textContent = `${rows.length} shown of ${view.totalRows}${view.truncated ? " (bounded view)" : ""} · ${view.type}`;
    this.root.append(summary);

    const scroller = document.createElement("div");
    scroller.className = "base-table-scroller";
    const table = document.createElement("table");
    table.className = "base-table";
    const head = document.createElement("thead");
    const headingRow = document.createElement("tr");
    for (const column of view.columns) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = column.label;
      headingRow.append(cell);
    }
    head.append(headingRow);
    table.append(head);
    const body = document.createElement("tbody");
    let previousGroup: string | null | undefined;
    for (const row of rows) {
      if (row.group !== null && row.group !== previousGroup) {
        const groupRow = document.createElement("tr");
        groupRow.className = "base-table-group";
        const groupCell = document.createElement("th");
        groupCell.colSpan = Math.max(1, view.columns.length);
        groupCell.scope = "rowgroup";
        groupCell.textContent = row.group;
        groupRow.append(groupCell);
        body.append(groupRow);
        previousGroup = row.group;
      }
      const tableRow = document.createElement("tr");
      tableRow.dataset.baseRowPath = row.path;
      for (const column of view.columns) {
        const cell = document.createElement("td");
        const value = row.values[column.property] ?? "";
        if (column.property === "file.name") {
          const open = document.createElement("button");
          open.type = "button";
          open.className = "base-note-link";
          open.textContent = value || row.title;
          open.title = `Open ${row.path}`;
          open.addEventListener("click", () => void this.actions.openPath(row.path));
          cell.append(open);
        } else {
          cell.textContent = value || "None";
          if (!value) cell.className = "base-table-empty-value";
        }
        tableRow.append(cell);
      }
      body.append(tableRow);
    }
    table.append(body);
    scroller.append(table);
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "base-view-empty-results";
      empty.textContent = queryValue ? "No rows match this search." : "No files match this view.";
      scroller.append(empty);
    }
    this.root.append(scroller);
  }
}
