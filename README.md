# Obsidian Mobile PDF Exporter

One-click preview-style PDF export for Obsidian mobile and desktop.

This repository currently publishes the packaged `v0.3.2` build that was validated in a real Obsidian vault. It is intended for manual installation or release-asset downloads.

Project direction and future improvement rules are documented in [`PROJECT_DIRECTION.md`](PROJECT_DIRECTION.md).

## Features

- Adds a ribbon button, command palette command, and note menu item: `导出预览版 PDF`.
- Exports the current Markdown note through an Obsidian preview-rendered layout.
- Uses a phone-width PDF page size for mobile-style reading.
- Keeps exported text selectable and copyable by writing real PDF text.
- Embeds images separately.
- Draws lightweight block backgrounds for code blocks, tables, quotes, and callouts.
- Bundles `NotoSansSC-Regular.otf` for offline Chinese text export.

## Install

Download `mobile-pdf-exporter-v0.3.2.zip` from the GitHub release, then extract it into:

```text
<your-vault>/.obsidian/plugins/mobile-pdf-exporter/
```

The plugin folder should contain:

```text
manifest.json
main.js
styles.css
versions.json
fonts/NotoSansSC-Regular.otf
```

Restart Obsidian, or disable and re-enable the plugin from Obsidian settings.

## Usage

Open a Markdown note, then click the `导出预览版 PDF` ribbon/menu command. The exported PDF is saved to `PDF Exports` in the current vault by default.

## Notes

Markor can create selectable preview PDFs through Android WebView printing. Obsidian plugins do not expose the same Android native print pipeline, so this plugin uses a browser-side approach: render the Obsidian preview layout, collect visible text/image positions, then write a real selectable PDF.

The original local build tried `fonts/SimHei.ttf` first and then fell back to `fonts/NotoSansSC-Regular.otf`. This public repository intentionally does not redistribute `SimHei.ttf`; the included Noto Sans SC font is used as the public fallback.

## Changelog

### 0.3.2

- Replaced the full-page snapshot background with visible vector PDF text to avoid blurry exports.
- Fixed page-width calculation so wide DOM content is wrapped inside the phone-size PDF instead of being clipped.
- Tightened export CSS for tables, code blocks, long links, and embeds to reduce side overflow.
- Uses actual content bottom for pagination to avoid trailing blank pages.
- Adds image embedding and lightweight block backgrounds without rasterizing the whole page.

### 0.3.1

- Fixed PDF font initialization when the bundled fontkit export shape is `{ default: fontkit }`.
- Removed Obsidian-specific DOM helper calls from the renderer setup for better mobile compatibility.
- Kept the preview-first approach: render preview layout, then write a real selectable PDF text layer.

### 0.3.0

- Removed Text/Snapshot mode selection.
- Removed the options export command.
- Added one-click preview PDF export from ribbon, command palette, and note menu.
- Writes selectable text from the preview DOM, not from a plain Markdown text dump.
- Uses a preview snapshot only as the visual background; text remains real PDF text.
- Falls back to visible selectable text if snapshot capture fails, avoiding blank PDFs.

## License

Plugin code and packaged JavaScript are released under the MIT License.

Bundled Noto Sans SC font is licensed under the SIL Open Font License 1.1. See `fonts/LICENSE-OFL.txt`.
