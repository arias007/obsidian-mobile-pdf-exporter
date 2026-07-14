# Obsidian Mobile PDF Exporter

One-click preview-style PDF export for Obsidian mobile and desktop.

## What it does

- Adds one ribbon button, one command, and one note menu item. The title follows the configured interface language.
- Shows a PDF export options panel before exporting, so each export can choose common PDF settings.
- Supports Auto / Chinese / English UI text for export buttons, menus, commands, options, settings, and export prompts.
- Exports the current Markdown preview to a phone-width PDF.
- Keeps text selectable/copyable by writing a real PDF text layer.
- Adds PDF options for page size, orientation, color/grayscale, per-page margins, content scale, headers, footers, selectable-text PDF, and image PDF.
- Saves beside the current note by default, with a combined export-location control for switching to a custom vault folder.
- Uses selectable/editable-text PDF and the highest `3x` image quality by default on new installations.
- Opens the finished PDF by default for viewing or printing, and remembers the last export options by default; both behaviors can be disabled.
- Uses the active Obsidian reading or editing surface as the primary layout source, so the two modes keep their real visible differences; hidden Markdown rendering is only a fallback when the file has no active view.
- Draws a high-resolution visual layer plus a matching real PDF text layer, keeping the preview appearance while text remains selectable.
- Preserves common rendered Markdown styling, including bold, italic, strikethrough, text color, highlights, inline-code backgrounds, tags, links, borders, tables, lists, tasks, quotes, callouts, code blocks, math/SVG, and embeds.
- Keeps short images together when they fit, while tall images retain their readable width and are cropped into continuous vertical page slices instead of being squeezed into one page.
- Draws link color/underlines, task checkboxes, list bullets, ordered-list markers, and small SVG icons from the rendered preview.
- Keeps short images, rows, list items, paragraphs, code blocks, tables, quotes, embeds, and callouts together when doing so does not leave a mostly empty page; long blocks and media are sliced continuously instead of being forced onto one page.
- Exports direct `.excalidraw.md` files as pure image PDFs through the Excalidraw runtime, with automatic lower-resolution retries and page slicing for large drawings.
- Keeps the startup bundle small for Obsidian mobile. Full CJK text export is available when a local font file is installed.

## Install

Download the latest release assets from GitHub, then extract them into:

```text
<your-vault>/.obsidian/plugins/mobile-pdf-exporter/
```

The plugin folder should contain:

```text
manifest.json
main.js
styles.css
```

For selectable Chinese PDF export, version 0.3.57 includes a gzip-compressed CJK subset font and decompresses it only during the first export that needs Chinese text. The first export can take about half a minute while the font is decompressed and cached; later exports should be faster because the cached font is reused. If embedded decompression is unavailable, it can still download and cache the CJK subset font from GitHub/CDN. For offline manual installs, also place `NotoSansSC-Regular.gb2312-subset.ttf` at:

```text
<your-vault>/.obsidian/plugins/mobile-pdf-exporter/fonts/NotoSansSC-Regular.gb2312-subset.ttf
```

Restart Obsidian, or disable and re-enable the plugin from Obsidian settings.

You can also install this repo through BRAT while it is waiting for inclusion in the official Obsidian community plugin browser.

## Obsidian community plugin browser

To appear in Obsidian's built-in Community plugins browser, this plugin must be submitted to `obsidianmd/obsidian-releases` and pass review. The release used for review should attach the standard Obsidian plugin assets directly: `manifest.json`, `main.js`, and `styles.css`.

The standard community-browser assets keep `main.js` below the earlier 0.3.52 bundle size for mobile loading. For CJK text export, 0.3.57 tries the embedded compressed font during export, then falls back to local font files and tagged remote font downloads.

## Usage

Open a Markdown note, then click the `Export preview PDF` ribbon or menu command. Choose the export location, page size, orientation, margin, content scale, header/footer text, color mode, export mode, and other PDF options in the panel, then click `Export PDF`. New installations save the PDF beside the current note, open it after export, and reuse the last export options by default. Existing installations keep their previously configured output folder during migration.

Header and footer text can include `{title}`, `{page}`, `{pages}`, and `{date}`. Leave either field blank to disable it.

The interface language can be set to Auto, Chinese, or English in the plugin settings. Auto follows the browser/system locale and uses English outside Chinese locales.

## Notes

Markor creates PDF through Android WebView printing, so its preview PDF text is selectable. Obsidian plugins do not expose Android native printing, so this plugin uses the closest available browser-side approach: render the Obsidian preview layout, then write real PDF text and images at matching positions.

The exporter walks the active reading surface, including its live canvas and embedded overlay layers, then writes a matching visual layer plus a real PDF text layer. Editing view exports use a complete editor-source text model so CodeMirror virtual scrolling cannot drop off-screen lines or duplicate remounted text. A hidden rendered preview is used only when the target file has no active Markdown view. For CJK text, it tries the embedded compressed font first, then local font files, then tagged remote font downloads, and otherwise falls back to a standard PDF font.

## Changelog

### 0.3.62

- Rebuilds the fix on top of the 0.3.61 rollback baseline.
- Fixes editing-view exports losing long quotes or off-screen text by exporting a complete editor-source text model instead of the virtualized CodeMirror viewport.
- Improves reading-view capture by sampling the live preview while scrolling, so lazy-rendered content is less likely to be missed.
- Snaps page breaks to text-line boundaries and ignores non-content background/keep boxes for page height, reducing clipped text and trailing blank pages.

### 0.3.61

- Fixes editing-view exports that produced leading/trailing blank pages or repeated, offset ghost text.
- Captures the current visible editor frame directly instead of stitching CodeMirror virtual-scroll segments that can remount the same text at different coordinates.
- Keeps reading-view exports on the full rendered document path, so long-note full export should be done from Reading view while Editing view stays true to the current screen.

### 0.3.60

- Exports the active reading or editing surface instead of normalizing both modes through one hidden reading preview.
- Captures virtualized Live Preview content in bounded scroll steps and restores the original scroll position after export.
- Preserves live NoteDraw static/dynamic canvases, floating text/image/file embeds, and other visible content inside the active note surface.
- Prevents medium or long list items and containers from being moved wholesale to a new page when that would leave a large blank area.
- Aligns task checkboxes to their real DOM geometry and preserves their theme border width, radius, background, accent color, and checked state.
- Removes overlapping duplicate text from segmented live capture and keeps every line of long quotes when they continue across pages.
- Restores clickable external URLs and resolves internal note links to `obsidian://open` targets in the current vault.
- Adds a real cancel action to the export progress prompt and removes a just-written output if cancellation arrives during saving.

### 0.3.59

- Fixes the selectable-text PDF font so Chinese, English, numbers, and punctuation render and copy correctly across PDF viewers.
- Expands rendered-style capture to inline backgrounds, highlights, tags, inline code, per-side borders, rounded boxes, and strikethrough text.
- Stops forcing ordinary note images and SVG previews into a single-page height.
- Keeps short media on one page when possible and slices tall images/SVGs continuously across pages without repeating or dropping sections.
- Makes selectable/editable-text PDF and the highest `3x` image quality the new-install defaults.

### 0.3.58

- Fixes issue #3 by preserving automatic table column sizing, keeping text fragments isolated to their source cells, and drawing individual cell borders/backgrounds in both export modes.
- Adds a combined export-location control with `Current note folder` as the new-install default and an optional custom vault folder.
- Opens the exported PDF by default so it is immediately available for viewing or printing.
- Replaces the one-time `Save as default` action with a persistent `Use last export options` toggle that is enabled by default.
- Adds configurable headers and footers with title, page-number, page-count, and date placeholders.
- Applies vertical margins and header/footer space on every page, and makes direct Excalidraw exports respect the configured margins and fixed paper size.

### 0.3.57

- Adds a 0.3.52-style self-contained CJK experiment using an embedded gzip-compressed Unicode CJK subset font.
- Decompresses the embedded font only during the first export that needs Chinese text, then caches it for later exports.
- Keeps the two embedded support QR images from 0.3.54.

### 0.3.56

- Adds fallback CJK font download URLs, so export can retry jsDelivr and the `main` branch font if the version-tag raw URL is temporarily unavailable.
- Keeps the startup bundle small and still loads the CJK font only during export.

### 0.3.55

- Restores selectable/copyable common Chinese PDF export through an on-demand CJK subset font loaded from the matching GitHub tag.
- Keeps `main.js` small for iPhone/iPad plugin startup; the CJK font is not read, decoded, or downloaded until export time.
- Caches the downloaded CJK subset under the plugin `fonts/` folder so later exports can run without another download.

### 0.3.54

- Restores the two embedded support QR images in the settings page while keeping the embedded CJK font subset out of the startup bundle.
- Keeps the release layout to the standard Obsidian assets: `manifest.json`, `main.js`, and `styles.css`.

### 0.3.53

- Reduces the startup `main.js` bundle by removing the embedded CJK font subset and embedded support QR images.
- Restores optional settings QR images to lazy local asset loading, so standard community installs do not parse image data at plugin startup.
- Keeps the release layout to the standard Obsidian assets: `manifest.json`, `main.js`, and `styles.css`.

### 0.3.52

- Embeds the two support QR codes directly into `main.js`, so the settings page can show them after standard community-browser installs.
- Keeps the GitHub release layout to the standard Obsidian assets only: `manifest.json`, `main.js`, and `styles.css`.

### 0.3.51

- Embeds a lightweight common-CJK font subset in `main.js`, so standard community-browser installs can copy common Chinese text without separate font files.
- Keeps full local font files as the first choice when available for broader CJK coverage.
- Stops warming up font bytes when opening the options panel; the embedded subset is decoded only during export.
- Filters unsupported characters per character, so one rare unsupported glyph no longer drops the rest of the line from the PDF text layer.

### 0.3.40

- Migrates the settings page from deprecated imperative `display()` rendering to Obsidian's current `getSettingDefinitions()` API.
- Raises `minAppVersion` to 1.13.0 because the current settings API is available from Obsidian 1.13.0.

### 0.3.39

- Cleans up community review warnings for release dependencies, pop-out window document access, requestAnimationFrame usage, PDF text sanitizing, and CSS compatibility.
- Adds a GitHub Actions release workflow that builds standard release assets and generates GitHub artifact attestations.
- Keeps the PDF export behavior from 0.3.38 unchanged.

### 0.3.38

- Publishes the next standard GitHub release for community plugin review refresh.
- Keeps the 0.3.37 runtime behavior and direct release asset layout unchanged.

### 0.3.37

- Carries forward the 0.3.36 community-review-compatible release structure.
- Keeps the standard direct release assets as `manifest.json`, `main.js`, and `styles.css`.

### 0.3.36

- Fixes automated community plugin review errors for the manifest description and supported API checks.
- Replaces direct style assignments flagged by the reviewer with Obsidian-compatible style helpers.
- Keeps the 0.3.35 bilingual export UI and standard PDF font fallback behavior.

### 0.3.35

- Adds Auto / Chinese / English interface language settings.
- Localizes the export ribbon tooltip, command name, file/editor menu item, export options panel, settings, busy/completed/error export prompt, and main notices.
- Auto language follows the browser/system locale and falls back to English outside Chinese locales.
- Falls back to a standard PDF font when the optional CJK font asset is unavailable, improving direct community-browser install compatibility for English/Latin notes.

### 0.3.34

- Shows the export prompt first after tapping export, then starts the actual PDF work.
- Simplifies the completed prompt text to a short completed state.

### 0.3.33

- Moves the export busy/completed prompt slightly lower while keeping it as a compact top prompt.

### 0.3.32

- Adds current-screen NoteDraw support by copying the visible live `.notedraw-canvas` overlay into ordinary Markdown PDF exports.
- Keeps the old Note Doodle current-screen behavior and still ignores hidden drawing canvases.
- Speeds up direct Excalidraw PDF export by using lower practical raster scales, fewer retry candidates, shorter image-load waits, and duplicate-scale skipping for very large drawings.

### 0.3.31

- Warms up the PDF runtime and font as soon as the export options modal opens, reducing the delay after tapping export.
- Shortens fixed export prompt waits while still forcing the exporting message to paint before work starts.
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

- Forces the exporting prompt to paint before the export job starts, so the user sees feedback first.
- Replaces the top action row with a sticky toolbar whose full background, divider, and buttons stay fixed together while options scroll.
- Keeps the bottom duplicate export button removed.

### 0.3.23

- Shows the simple export prompt before work starts and removes the progress-bar UI.

### 0.3.22

- Shows the exporting prompt first, then waits for the interface to paint before starting the export work.
- Keeps only the top export/cancel actions in the options panel and removes the bottom duplicate action row.
- Makes the top action row a full sticky background bar so the buttons do not float over scrolling options.

### 0.3.21

- Replaces the export progress bar with a simple waiting prompt.
- The prompt appears as soon as export starts and closes automatically after the export finishes.

### 0.3.20

- Adds a visible PDF export progress panel with stage text, an animated progress bar, and elapsed-time feedback for long exports.
- Updates packaged QR-code support text in settings to a bilingual donation prompt.

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
