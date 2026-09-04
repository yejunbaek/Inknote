# InkNote

A OneNote-style desktop notetaking app: type anywhere, draw anywhere, on the
same free-form page.

## Running it

You need [Node.js](https://nodejs.org) installed (LTS is fine).

```bash
cd inknote
npm install
npm start
```

The first `npm install` downloads Electron (~150 MB) and takes a minute.

## What's in this version

- **Free-form canvas** — infinite, pannable page. Click anywhere with the text
  tool to start a text box; draw anywhere with the pen.
- **Pen tools** — pen (pressure-sensitive if you have a drawing tablet or
  touchscreen pen), highlighter (draws behind your ink, like a real one),
  and a stroke eraser that removes whole strokes on contact.
- **Sections and pages** — sidebar on the left. Double-click a name to rename,
  hover for the delete button.
- **Auto-save** — everything saves to disk about 700 ms after you stop.
  Export/Import buttons make a JSON backup.

## Shortcuts

| Key | Action |
| --- | --- |
| `V` | Select / move |
| `T` | Text box |
| `P` | Pen |
| `H` | Highlighter |
| `E` | Eraser |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+N` | New page |
| `Ctrl+S` | Force save |
| Space + drag, or middle-drag | Pan |
| `Ctrl` + scroll | Zoom |

## Where notes are stored

`%APPDATA%\inknote\notebooks\notebook.json` on Windows.
Writes go to a temp file and are then renamed, so a crash mid-save can't
corrupt the notebook.

## Project layout

```
main.js        Electron main process — window + file IO over IPC
preload.js     The only bridge from the page to the filesystem
src/index.html Layout
src/styles.css Styling
src/renderer.js All app logic: canvas, camera, tools, undo, sidebar
smoke.js       Headless jsdom test — `node smoke.js` (needs `npm i jsdom`)
```

## Ideas for next time

Shape recognition, image paste, ruled/grid page backgrounds, lasso select,
text formatting (bold/size/color), search across pages, PDF export, and
per-page background templates.
