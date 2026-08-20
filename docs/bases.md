# Bases

Threadleaf opens visible `.base` files as native, searchable property tables. A Base remains a local
YAML view definition over ordinary Markdown files and frontmatter. Opening one never converts or
rewrites the Base or its notes.

The first desktop slice supports:

- multiple named views with direct tab switching;
- table, list, and other declared view names rendered through one consistent bounded table surface;
- global and per-view recursive `and`, `or`, and `not` filters;
- equality and ordered comparisons over note properties;
- `file.hasTag()`, `file.inFolder()`, `file.name`, `file.path`, `file.ext`, `file.folder`, and
  `file.tags`;
- configured property order and display names;
- multi-property sorting, one-property grouping, and row limits;
- search across every displayed property; and
- direct opening of a result note in the same workspace pane.

The view caps displayed columns at 32 and rows at 500. It reports both the complete matching count
and whether the visible result was bounded. This keeps an unfiltered Base responsive on large
vaults, following the official guidance that a view may receive thousands of entries.

## Honest boundaries

Formula definitions and formula columns are preserved but not evaluated yet. Filter expressions
outside the supported subset display an explicit diagnostic and return no rows, rather than a
plausible partial result. The current Base surface is read-only: edit the YAML or note properties in
their source documents. Cards, maps, CSV export, point-and-click filter editing, and plugin-provided
view rendering remain future work.

The behavior is independently implemented from the public format and API documentation:

- [Obsidian Bases introduction](https://obsidian.md/help/bases)
- [Obsidian Bases syntax](https://obsidian.md/help/bases/syntax)
- [Obsidian Bases views](https://obsidian.md/help/bases/views)
- [Obsidian developer guide for custom Bases views](https://docs.obsidian.md/plugins/guides/bases-view)

No proprietary implementation text or asset is included.
