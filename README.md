# QueryPad

A clean, fast, open-source SQL editor for **Oracle**, **PostgreSQL**, and **MySQL** — built with Electron, Monaco, and AG Grid.

QueryPad focuses on the things other editors get wrong: a genuinely nice look and feel, great fonts, and the export options you actually need — **export as INSERT**, **export as UPDATE**, and **export selected rows as CSV**.

## Features

- **Three databases** — Oracle (thin mode, no Instant Client needed), PostgreSQL, MySQL
- **Monaco editor** — the same editor that powers VS Code, with SQL syntax highlighting
- **Smart export** — any result set or just the selected rows, as:
  - CSV
  - `INSERT` statements
  - `UPDATE` statements (pick the key column for the `WHERE` clause)
- **Tabs** with per-query auto-save
- **Saved queries** per connection
- **Right-click context menu** on results for quick export / copy
- **Follows your OS theme** (light / dark) automatically
- **Resizable** sidebar and editor/results split
- Ships as a **single portable `.exe`** — copy it anywhere and run

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `F5` | Run query |
| `Shift+F5` | Run selection |
| `Ctrl+S` | Save query |
| `Ctrl+T` | New tab |

## Getting started

```bash
npm install
npm start
```

## Build a portable executable

```bash
npm run build
```

The portable `QueryPad.exe` is written to `dist/`. Copy it anywhere — no installation required.

## Tech stack

- [Electron](https://www.electronjs.org/) — app shell
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — SQL editing
- [AG Grid Community](https://www.ag-grid.com/) — results grid
- [node-oracledb](https://oracle.github.io/node-oracledb/), [pg](https://node-postgres.com/), [mysql2](https://github.com/sidorares/node-mysql2) — database drivers

## License

[MIT](LICENSE)
