# InkNote

A desktop notetaking app that mixes OneNote and Milanote: type anywhere, draw
anywhere, and arrange cards, images and columns on the same free-form board.

## Running it

You need [Node.js](https://nodejs.org) installed (LTS is fine).

```bash
cd inknote
npm install
npm start
```

If `npm install` finishes suspiciously fast and `npm start` then complains
that "Electron failed to install correctly", your npm blocked Electron's
post-install script. Fix it with:

```bash
npm approve-scripts electron
npm rebuild electron
```

Keep the project **outside OneDrive** — syncing `node_modules` mid-install
breaks the Electron unzip step.

## The web version

There is a browser build that needs no install and no account:

```bash
npm run web        # builds docs/
npx serve docs     # try it locally
```

`docs/` is what GitHub Pages serves — see **PUBLISHING.md** for the handful of
commands that put it online.

It is the same app. `src/` is the single source for both builds; the only
difference is where things are stored: the desktop version uses files on your
disk, the web version uses the visitor's own browser (IndexedDB), and nothing
is uploaded anywhere. **Export** / **Import** in the sidebar moves a notebook
between them.

## Launching it like an app (no installer)

One command gives you a desktop and Start Menu shortcut that runs InkNote
straight from this folder:

```bash
npm install
npm run shortcut
```

From then on, **updating is just extracting a new zip over this folder** — no
rebuild, no reinstall. The shortcut points at Electron's own executable, so it
opens with no console window behind it.

The trade-offs versus a real install: this folder and its `node_modules` have
to stay where they are, and the app won't appear in Add/Remove Programs.

## Building a real installer

If you want a proper installed app — Add/Remove Programs entry, self-contained,
independent of this folder:

```bash
npm install
npm run dist
```

That produces two files in `dist\`:

| File | What it is |
| --- | --- |
| `InkNote-Setup-0.19.0.exe` | Installer. Run it once; it adds a desktop shortcut and Start Menu entry, and shows up in Add/Remove Programs. |
| `InkNote-0.19.0-portable.exe` | Single self-contained file. Double-click to run — no install, keep it on a USB stick if you like. |

The build downloads a few helper binaries from GitHub the first time, so give
it a couple of minutes. Windows SmartScreen will warn that the app is from an
unknown publisher, because it isn't code-signed — click **More info → Run
anyway**. Signing needs a paid certificate; nothing about the app requires it.

Every way of launching InkNote — the shortcut, the installer, the portable
exe, `npm start` — reads and writes the same notes in `%APPDATA%\inknote\`.
That path is pinned in `main.js` rather than derived from the app name, which
would otherwise differ between a dev run and a packaged build and quietly give
you two separate notebooks.

To change the icon, edit `build/make-icon.py` and run `npm run icon`
(needs `pip install pillow`).

## Board items

| Tool | Key | What it does |
| --- | --- | --- |
| Select | `V` | Click any item to select it, then drag it from anywhere on its body. **Double-click** to type in it. |
| Card | `C` | Click the board to drop a note card. |
| Checklist | `K` | A tickable list. `Enter` adds the next row, `Backspace` on an empty row removes it. Drops into columns like a card. |
| Row | `R` | Like a column, turned sideways: boxes sit side by side and the row shrink-wraps around them. |
| Column | `L` | A container that stacks items vertically and shrinks to fit them. Drag things in and out; drop position decides the order. Columns nest inside columns. |
| Arrow | `A` | Click one item, then another, to connect them. The arrow follows both as they move. |
| Image box | `I` | Places an empty frame. Click the **+** in its centre (or drop a file on it) to fill it later. **Ctrl+V** a screenshot or dragging a file onto blank board still creates a filled one directly. |
| Variable field | `F` | A named variable on the left, a value on the right. The name comes from a shared list; the value belongs to that box alone. |
| Page link | `G` | A box that points at another page — or at one specific block on it. Pick from a searchable list, then rename the box to whatever you like. |
| Pen | `P` | Pressure-sensitive ink (works with tablet and touchscreen pens). |
| Highlighter | `H` | Translucent, draws behind your pen ink. |
| Eraser | `E` | Removes whole strokes on contact. Doesn't touch cards. |

Every item has three controls that appear on hover: a purple **grip**
(top-left) to drag, an **×** (top-right) to delete, and a small square
(bottom-right) to resize. Only images take a height you set — cards,
checklists, links and columns all grow and shrink to fit their contents.

**Items are objects first, text second.** A single click selects the item as a
whole (so `Delete` removes it); a double-click puts a caret in the text.
`Esc` steps back out: it closes the editor, cancels a half-drawn arrow, and
returns you to the select tool.

With a card, checklist, link or arrow selected, clicking a colour swatch
recolours it rather than just arming the next stroke.

### Columns and rows

A **column** stacks its contents top to bottom; a **row** lays them out left to
right. They're the same container in two orientations and share everything —
the collapse toggle, the item count, nesting, drop targeting — so anything true
of one is true of the other.

The difference beyond direction: a column has a width you can drag, and
stretches its children to fill it. A row has no width of its own. It
shrink-wraps around whatever is inside, and leaves each box at its own width,
which is why it has no resize handle — fitting its contents *is* the type.

Drop ordering follows the orientation: a column decides position by where you
release vertically, a row by where you release horizontally.

Rows nest in columns, columns nest in rows, rows nest in rows.

### Columns

Two ways to put something in a column: drag it in, or pick a tool and click
the column's open area — the new item is built directly inside it. That works
for the column tool too, so columns nest as deep as you like.

**Names.** Double-click a column or row header to rename it, same as anywhere
else in the app.

**Collapsing.** Every header has a **−** button that folds it shut and becomes
**+** to open it again; it's in the right-click menu too.

**The count** beside the name is that container's own boxes, not everything
buried beneath it. A row holding four columns of five fields each reads "4
items", and each column reads "5 items" on its own header. Rolling the nested
totals up would make every outer container report a number you can't act on.
(The delete confirmation is the exception — it counts the whole subtree,
because that's what you'd actually lose.)

Collapsing is saved with the notebook but deliberately kept out of the undo
stack — `Ctrl+Z` should walk back your edits, not your folding. A folded column
stops accepting drops, and arrows pointing at anything hidden inside it attach
to the column itself rather than collapsing to a point. Following a link that
targets a buried block opens every column above it first.

Dropping always targets the *innermost* column under the pointer, and a column
can never be dropped into itself or into anything it contains. Deleting a
column takes its whole subtree, and the confirmation counts every item that
would go with it, at any depth.

### Page links

A link box stores a page id, an optional block id, and your own label.

Left unnamed, the box calls itself after **what it actually points at**: the
block's own text when it targets a block, the page title when it targets a
whole page. So a link into *TYPES* aimed at a card reading "Pikachu" shows
**Pikachu**, not *TYPES*.

Renaming the box changes only the box — the target keeps its real name, which
the box always shows in small text underneath, so a link called "fire move"
still tells you it points at *Combat › Fireball › Damage*.

**Linking to one block.** In the page picker, each row has a **Go to page**
button. Click it and InkNote opens that page, frames its contents, and drops
into pick-a-block mode — a bar appears at the top, and the next **box** you
click becomes the link's target.

**Finding a block by name.** Going to a page and hunting for a box is fine the
first time; after that the target should just be typeable. So the picker
searches **blocks as well as pages**: type `pika` (or `pi`, or `PIKACHU` — it
ignores case) and the card reading "Pikachu" appears as its own row, with the
page it lives on underneath. Picking it sets the page and the block in one
click, no navigation.

Every target you choose is also **remembered**. On the first run after
upgrading, the list is seeded from every link already in your notebook, so
existing targets are there straight away rather than starting empty. With the search box empty, the
picker lists the blocks you've linked to before under **Recently linked**, most
recent first, so repeat targets are one click away. Two boxes on the same page reading the same thing collapse to a single row —
they'd be indistinguishable in the list anyway, and the one kept is whichever
you've linked to before. Blocks you've never linked to only appear once you
type — otherwise the list would be a dump of every box
in the notebook. Remembered targets whose page or block has since been deleted
drop off the list on their own.

Blank board is for getting around while you're picking: drag it to pan, scroll
and zoom as usual. Clicking empty space does nothing, so you can go hunting for
the box you want without a stray click committing something. To link the page
as a whole, use **Link the whole page** on the bar; `Esc` or **Cancel** backs
out without changing anything. Either way you're returned to the page your link
box lives on.

A link with a block target shows a bullseye icon and a three-part subtitle —
*Combat › Fireball › Damage*. Following it opens the page, centres the board
on that block, and flashes it.

If the page is deleted the box turns red and says so. If just the block is
deleted, every link anchored to it quietly falls back to page-level rather
than pointing at nothing.

### Variable fields

A field box shows a **variable name** on the left and a **value** on the right,
like an inspector row.

The names live in one notebook-wide list. Click the name to open a dropdown
with a search box; type a name that doesn't exist yet and it offers to create
it. Every field box everywhere sees the same list.

The value is per-box and starts empty. Two boxes on the same variable hold two
independent values — putting `Health` on ten pages doesn't make them share a
number.

Boxes store the variable's **id**, not its text, so **Rename variable…**
(right-click a field) renames it in every box at once and leaves all the values
alone. Deleting a variable from the dropdown leaves the boxes and their values
in place; they just go back to asking which variable they are.

Names are matched case-insensitively, so you can't end up with both `Health`
and `health` in the list.

**A box as the value.** The right half of a field is a slot, not just a text
input. Drag any box into it — a page link, a card, even a whole column — and
that box becomes the field's value, with the field growing to fit it. Clicking
the empty slot with a creation tool builds one there directly.

When there isn't room to sit side by side — inside a column, say — the box
drops onto its own line and the field **grows taller** rather than squeezing
the box into a sliver. Out on open board, where there is room, they stay side
by side.

The typed value isn't discarded when you do this; it comes back if you take the
box out again (right-click the field → **Take the box out**, or just drag it).
A field holds one box at a time, so a filled one stops advertising itself as a
drop target. The hosted box counts as part of the field for copying, duplicating
and deleting.

### Selecting more than one box

**Ctrl+click** adds a box to the selection, or removes it if it's already
there. The status bar shows the count. Clicking blank board clears the
selection; **Ctrl+clicking** blank board leaves it alone.

Everything then acts on the whole selection: `Ctrl+C` / `Ctrl+V`, `Ctrl+D`,
`Delete` (one confirmation for the lot), the colour swatches, and the
right-click menu, which relabels itself — "Duplicate 4 boxes".

Dragging any member moves the whole group together, keeping their relative
positions. Only free-standing boxes travel — anything living inside a column
keeps its slot, because "move it, but also somewhere in a list" has no sensible
answer.

**Sliding a group into a container.** Drag the group onto a column or row and
they all go in together at the drop point. The order they land in:

1. **All from the same container** — the order they already had in it.
2. **All loose on the board** — the order they read on the board: top-to-bottom
   for a column, left-to-right for a row.
3. **Mixed origins** — the order you ctrl-clicked them, which is the only
   sequence they have in common.

A field is the exception: one slot, so it takes a single box and declines a
group.

If you select a column *and* something inside it, the inner box isn't treated
separately; it's already coming along with its container. That keeps a
duplicate from producing two copies of the same card.

### Copy and paste

`Ctrl+C` copies the selected box, `Ctrl+V` pastes it under your cursor —
**on any page**, not just the one you copied from. Both also appear in the
right-click menus: **Copy** on a box, **Paste here** on blank board.

A copy takes the box's whole subtree and any arrows running between the
copied items, exactly like Duplicate. The clipboard keeps its contents, so you
can paste the same thing repeatedly. Copying a box that lives inside a column
pastes it free-standing.

This is InkNote's own clipboard rather than the system one — a board item is a
graph of objects with ids, parents and arrows, and nothing outside the app
could use a serialised copy. Other apps still get a plain-text summary when
you copy, so pasting elsewhere isn't a dead end. And a screenshot on the system
clipboard still wins over `Ctrl+V`, since that's unambiguous.

### Duplicating and reordering boxes

**Ctrl+D**, or **right-click → Duplicate**, copies the selected box with
everything it holds. A free-floating box lands offset by a nudge so both stay
visible; one inside a column lands directly after the original.

Duplicating a column brings its whole nested subtree, and any arrows running
*between* copied items are recreated between the copies. Arrows to items
outside the copy are not duplicated — there's no sensible answer for where
they'd point.

Right-clicking a box also offers **Edit text**, **Bring to front**, **Delete**,
and, depending on the type, **Change target…** or **Replace picture…**.

Two duplicated image boxes share one file on disk. Deleting one keeps the file
as long as anything else still references it.

## The sidebar

Sections and pages both support:

- **Double-click** a name to rename it in place. `Enter` commits, `Esc` cancels.
- **Right-click** for a menu: Rename, Delete, plus Duplicate on pages and
  "New page in this section" on sections.
- **Drag to reorder** within the list. A purple line shows where the row will
  land.
- **Drag a page onto a section** to move it there. A section is never left
  with zero pages, so the last page in a section won't move.

Duplicating a page deep-copies it, regenerates every item id, and remaps the
arrows onto the new ids — so the copy's connections point inside the copy
rather than back at the original.

## Delete confirmations

Anything with content in it asks before it goes:

- **Sections** and **pages** always confirm, and name what's inside. These
  can't be undone.
- **Columns** confirm and tell you how many items go with them.
- **Cards with text**, **checklists with entries**, and **images** confirm.
  Empty cards vanish silently — they were a misclick.
- The last section, and the last page in a section, refuse to be deleted.

Item deletes are undoable with `Ctrl+Z`; section and page deletes are not.

## Other shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+click` | Add or remove a box from the selection |
| `Ctrl+C` / `Ctrl+V` | Copy / paste the selection — across pages too |
| `Ctrl+D` | Duplicate the selection |
| `Ctrl+N` | New page |
| `Ctrl+S` | Force save |
| `Delete` | Delete the selection, or the selected arrow |
| `Esc` | Close the editor / cancel an arrow / back to the select tool |
| `Enter` | In a checklist: add the next row |
| `Home` or `Ctrl+0` | Re-centre on your work |
| Middle-drag | Pan the camera — never moves a box, wherever you press |
| Space + drag | Pan |
| `Ctrl` + scroll | Zoom |

### The blank-board menu

Right-clicking empty board gives you **Paste here**, quick **New card /
checklist / column here**, and **Re-centre on my work**.

## Mouse buttons

- **Left** interacts: select, drag, draw, type.
- **Middle** only ever pans the camera. It's intercepted before it can reach a
  box, so pressing it on a card, or on a small control like a collapse toggle,
  still pans and never moves or triggers anything.
- **Right** opens a context menu and nothing else — it can't start a drag.

## Getting un-lost

The board is infinite, so it's easy to pan off into blank space. The **house
button** in the toolbar, the `Home` key, or `Ctrl+0` frames everything on the
current page and glides the camera there.

It fits the content rather than jumping to a fixed spot, so it works whether
your work sits near the origin or thousands of pixels away. It never zooms in
past 100% — blowing a single card up to fill the window would be its own kind
of disorienting — and an empty page just returns to the origin. Ink counts as
content alongside boxes.

## Where things are stored

```
%APPDATA%\inknote\notebooks\notebook.json   your notes
%APPDATA%\inknote\images\                   pasted and imported pictures
```

Images are written to disk as real files and referenced by an
`inknote-img://` URL rather than being inlined as base64 — otherwise a few
pasted screenshots would turn `notebook.json` into a multi-megabyte file that
has to be re-parsed on every autosave.

Notebook writes go to a temp file and are then renamed, so a crash mid-save
can't corrupt your notes. Export/Import make a portable JSON backup (images
are not bundled into it).

Notebooks from v0.1 open fine — old text boxes become cards automatically.

## Project layout

```
main.js         Electron main process: window, file IO, image protocol
build/          App icon + the script that generates it
preload.js      The only bridge from the page to the filesystem
src/index.html  Layout
src/styles.css  Styling
src/renderer.js All app logic: canvas, camera, tools, items, links, undo
web/            The browser build's storage adapter and starter notebook
docs/           Generated web build (npm run web) — this is what Pages serves
smoke.js        Headless jsdom test — `npm i --no-save jsdom && node smoke.js`
build/preview.js  Renders a fixture in real Chromium and screenshots it,
                for checking layout — `npm i --no-save playwright && npm run preview`
```

## Ideas for next time

Nested boards (open a card as its own canvas), lasso select, multi-select,
shape recognition for ink, link cards that fetch a page preview, text
formatting, search across pages, ruled/grid page backgrounds, and PDF export.
