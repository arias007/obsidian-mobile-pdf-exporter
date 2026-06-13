# Obsidian Mobile PDF Exporter

One-click preview-style PDF export for Obsidian mobile and desktop.

## What it does

- Adds one ribbon button, one command, and one note menu item: `导出预览版 PDF`.
- Shows a PDF export options panel before exporting, so each export can choose common PDF settings.
- Exports the current Markdown preview to a phone-width PDF.
- Keeps text selectable/copyable by writing a real PDF text layer.
- Adds ordinary-note PDF options for page size, orientation, color/grayscale, margin, content scale, selectable-text PDF, and image PDF.
- Uses the rendered Obsidian preview DOM as the layout source.
- Draws real vector PDF text as the visible body, so exported text stays sharp and selectable.
- Embeds images separately and draws lightweight block backgrounds for code, tables, quotes, and callouts.
- Draws link color/underlines, task checkboxes, list bullets, ordered-list markers, and small SVG icons from the rendered preview.
- Avoids page breaks inside images, list items, paragraphs, code blocks, tables, quotes, embeds, and callouts when they can fit on one page.
- Exports direct `.excalidraw.md` files as pure image PDFs through the Excalidraw runtime, with automatic lower-resolution retries and page slicing for large drawings.
- Bundles `NotoSansSC-Regular.otf` for offline Chinese text export.

## Install

Download `mobile-pdf-exporter-v0.3.34.zip` from the GitHub release, then extract it into:

```text
<your-vault>/.obsidian/plugins/mobile-pdf-exporter/
```

The plugin folder should contain:

```text
manifest.json
main.js
styles.css
README.md
versions.json
```

Restart Obsidian, or disable and re-enable the plugin from Obsidian settings.

You can also install this repo through BRAT while it is waiting for inclusion in the official Obsidian community plugin browser.

## Usage

Open a Markdown note, then click the `导出预览版 PDF` ribbon/menu command. Choose the page size, orientation, color mode, export mode, and other common PDF options in the panel, then click `导出 PDF`. The exported PDF is saved to `PDF Exports` in the current vault by default.

## Notes

Markor creates PDF through Android WebView printing, so its preview PDF text is selectable. Obsidian plugins do not expose Android native printing, so this plugin uses the closest available browser-side approach: render the Obsidian preview layout, then write real PDF text and images at matching positions.

The release package includes `fonts/NotoSansSC-Regular.otf` for selectable Chinese text export. The font is read only when exporting, so `main.js` stays smaller and Obsidian startup avoids parsing an embedded font string.

## Changelog

### 0.3.34

- Shows the export prompt first after tapping export, then starts the actual PDF work.
- Simplifies the completed prompt text to a short "导出完成 / 完成" state.

### 0.3.33

- Moves the export busy/completed prompt slightly lower while keeping it as a compact top prompt.

### 0.3.32

- Adds current-screen NoteDraw support by copying the visible live `.notedraw-canvas` overlay into ordinary Markdown PDF exports.
- Keeps the old Note Doodle current-screen behavior and still ignores hidden drawing canvases.
- Speeds up direct Excalidraw PDF export by using lower practical raster scales, fewer retry candidates, shorter image-load waits, and duplicate-scale skipping for very large drawings.

### 0.3.31

- Warms up the PDF runtime and font as soon as the export options modal opens, reducing the delay after tapping export.
- Shortens fixed export prompt waits while still forcing the "正在导出 PDF" message to paint before work starts.
- Uses adaptive preview stabilization and image waits instead of long fixed waits for every note.
- Reuses embedded image and SVG resources across PDF pages during selectable PDF export.

### 0.3.30

- Moves the output folder field near the top of the export options modal so it stays reachable when the mobile keyboard is open.

### 0.3.29

- Keeps the Obsidian-standard single `main.js` plugin structure while lazy-initializing the PDF runtime only after export starts.
- Removes the embedded Noto Sans SC base64 fallback from `main.js`; the release package font file is loaded on demand during export.
- Avoids startup DOM cleanup work and leaves render-root cleanup to the export path.

### 0.3.27

- Expands Note Doodle export detection from reading preview only to any currently visible same-note doodle surface, including editor/source mode.
- Prefer copying the current live Note Doodle canvas into the exported PDF overlay before falling back to saved stroke data.
- Keeps hidden doodles hidden: only currently visible doodle canvases are exported.

### 0.3.26

- Adds an editable PDF filename field in the top export toolbar.
- Uses the edited filename when saving the PDF, while still avoiding overwriting existing files.
- Sanitizes invalid filename characters and falls back to the note name when the field is empty.

### 0.3.25

- Moves the export status UI to a compact top bar for exporting, completed, and failed states.
- Removes the center export status panel and extra completion/failure notices.
- Extends the sticky top action toolbar background to the modal top edge so scrolling options cannot show through a gap.

### 0.3.24

- Forces the "正在导出 PDF" prompt to paint before the export job starts, so the user sees feedback first.
- Replaces the top action row with a sticky toolbar whose full background, divider, and buttons stay fixed together while options scroll.
- Keeps the bottom duplicate export button removed.

### 0.3.23

- Shows the simple export prompt before work starts and removes the progress-bar UI.

### 0.3.22

- Shows the "正在导出 PDF" prompt first, then waits for the interface to paint before starting the export work.
- Keeps only the top export/cancel actions in the options panel and removes the bottom duplicate action row.
- Makes the top action row a full sticky background bar so the buttons do not float over scrolling options.

### 0.3.21

- Replaces the export progress bar with a simple "正在导出 PDF" waiting prompt.
- The prompt appears as soon as export starts and closes automatically after the export finishes.

### 0.3.20

- Adds a visible PDF export progress panel with stage text, an animated progress bar, and elapsed-time feedback for long exports.
- Updates packaged QR-code support text in settings to a bilingual "给我买咖啡 / Buy me a coffee" donation prompt.

### 0.3.19

- Uses the current visible Note Doodle screen state as the rule for PDF export.
- Exports Note Doodle strokes only when the current opened preview for the same note is visibly showing its doodle canvas.
- Does not read saved doodle JSON in the background, so hidden or currently not displayed doodles stay out of the PDF.

### 0.3.18

- Adds export/cancel buttons above the PDF options so mobile users do not need to scroll to the bottom for the common default export path.
- Includes Note Doodle Preview saved doodle strokes in ordinary Markdown PDF export by drawing its overlay into the exported preview PDF.
- Adds canvas capture and page-sliced canvas rendering for selectable-text and image PDF routes.

### 0.3.17

- Opens a common PDF export options panel before exporting from the ribbon, command palette, file menu, or editor menu.
- The panel supports export mode, page size, orientation, color/grayscale, margin, content scale, image-PDF resolution, title, output folder, open/share after export, and saving choices as defaults.
- Keeps the 0.3.15 export engine and does not include the 0.3.16 mobile floating button.

### 0.3.15

- Adds ordinary Markdown note PDF options in plugin settings: export mode, page size, orientation, color/grayscale, margin, content scale, title, and image-PDF resolution.
- Keeps the default one-click behavior compatible with 0.3.14: mobile portrait, color, selectable text PDF.
- Adds an image-PDF route for ordinary notes while keeping external link annotations clickable.

### 0.3.14

- Adds an optional packaged extras area at the bottom of the plugin settings page.
- Keeps release extras out of the source repository and README; the standard Obsidian install assets remain `manifest.json`, `main.js`, and `styles.css`.

### 0.3.13

- Embeds the Noto Sans SC fallback font into `main.js` so standard Obsidian community-plugin installs can export Chinese PDFs without extra font files.
- Publishes standard Obsidian release assets: `manifest.json`, `main.js`, and `styles.css`.
- Keeps the 0.3.12 Excalidraw large drawing export and PNG-too-large warning avoidance behavior.

### 0.3.12

- Avoids Excalidraw `createPNG` first when SVG export is available, so successful large drawing exports should not show PNG-too-large notices.
- Rasterizes Excalidraw SVG internally with canvas size limits before building the sliced image PDF.
- Keeps low-resolution PNG fallback only if the SVG route fails or is unavailable.
- Keeps the 0.3.11 large drawing slicing behavior.

### 0.3.11

- Makes direct `.excalidraw.md` image PDF export more tolerant of large drawings.
- Retries Excalidraw PNG export at lower scales when the generated image is too large or PDF embedding fails.
- Slices tall Excalidraw images into phone-height PDF pages instead of creating one oversized page.

### 0.3.10

- Changes direct `.excalidraw.md` export to a pure image-to-PDF path.
- Uses Excalidraw's PNG export API first, with SVG rasterization only as a fallback.
- Keeps ordinary Markdown export on the existing selectable preview-text PDF path.

### 0.3.9

- Detects `.excalidraw.md` files and skips Excalidraw source blocks such as `# Excalidraw Data` and `compressed-json`, so raw drawing data is no longer exported as PDF text.
- Uses the installed Excalidraw plugin runtime to render a direct SVG preview for Excalidraw files when available.
- Treats large/Excalidraw SVG previews as media instead of tiny icons, keeping them scaled inside the phone-width PDF page instead of clipping or dropping them.

### 0.3.7

- Waits for embedded previews and dynamic task blocks to settle before measuring the export DOM.
- Removes unsupported emoji from the hidden export DOM before measurement, so missing emoji glyphs no longer leave oversized gaps around separators.
- Keeps the 0.3.5 link-annotation and proportional image-scaling fixes.

### 0.3.6

- Tightens separator-heavy preview text before measurement, so `·`, `/`, `|`, punctuation, brackets, and short symbol runs no longer create oversized gaps in the exported PDF.
- Keeps link annotations based on the final rendered DOM rectangles, so external links remain clickable after spacing cleanup.

### 0.3.5

- Tightens spacing around common separators such as `·`, `|`, `/`, Chinese punctuation, and list-like symbol runs so exported preview text no longer looks over-spaced.
- Captures link rectangles from the rendered Obsidian preview and writes full PDF link annotations for normal web, mail, tel, and obsidian links.
- Raises image/figure/page-embed keep priority and draws images with proportional scaling so they are moved or shrunk instead of being cut or flattened.

### 0.3.4

- Tightens phone-preview spacing for titles, headings, paragraphs, lists, quotes, code, embeds, and callouts to reduce the blank, flat feeling.
- Keeps link underlines close to the actual text width and adds PDF link annotations for normal web/mail/tel/obsidian links.
- Adds stronger image and figure page-break protection, with image height constrained to fit the phone page when possible.
- Keeps the 0.3.3 selectable preview-text route and does not switch back to plain text or full-page image PDF.

### 0.3.3

- Builds from the accepted 0.3.2 selectable-text PDF path.
- Preserves link colors by keeping differently colored preview text as separate PDF text runs.
- Draws link underlines, task checkboxes, checked states, list bullets, ordered-list markers, and small SVG icons.
- Keeps pagination improvements for images, list items, paragraphs, tables, code blocks, quotes, embeds, and callouts when they can fit on one page.

### 0.3.2

- Replaced the full-page snapshot background with visible vector PDF text to avoid blurry exports.
- Fixed page width calculation so wide DOM content is wrapped inside the phone-size PDF instead of being clipped.
- Tightened export CSS for tables, code blocks, long links, and embeds to prevent side overflow.
- Uses actual content bottom for pagination to avoid trailing blank pages.
- Adds image embedding and lightweight block backgrounds without rasterizing the whole page.

### 0.3.1

- Fixed PDF font initialization when the bundled fontkit export shape is `{ default: fontkit }`.
- Removed Obsidian-specific DOM helper calls from the renderer setup for better mobile compatibility.
- Kept the Markor-inspired preview-first approach: render preview layout, then write a real selectable PDF text layer.

### 0.3.0

- Removed Text/Snapshot mode selection.
- Removed the options export command.
- Added one-click preview PDF export from ribbon, command palette, and note menu.
- Writes selectable text from the preview DOM, not from a plain Markdown text dump.
- Uses a preview snapshot only as the visual background; text remains real PDF text.
- Falls back to visible selectable text if snapshot capture fails, avoiding blank PDFs.
- Uses an embedded Chinese TrueType font for better PDF reader compatibility.

### 0.2.0

- Added a selectable Text PDF mode and embedded Noto Sans SC fonts.

### 0.1.1

- Fixed blank PDF exports caused by hidden snapshot rendering.


## License
Plugin code and packaged JavaScript are released under the MIT License.

Bundled Noto Sans SC font is licensed under the SIL Open Font License 1.1. See `fonts/LICENSE-OFL.txt`.
