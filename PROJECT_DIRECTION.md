# Project Direction

This document records the product direction for Obsidian Mobile PDF Exporter.
It is based on the real feedback that shaped `v0.3.2`, which is the current
accepted baseline.

## Core Goal

The plugin should do one thing well:

Export the current Obsidian note as a mobile-style preview PDF with selectable,
copyable text.

The expected user flow is simple:

1. Open a note in Obsidian.
2. Click one menu item or ribbon button.
3. Get a clean phone-width PDF that looks like the Obsidian preview as much as
   practical.

No mode selection, no export wizard, no text-only fallback exposed to the user.

## Accepted Baseline

`v0.3.2` is the accepted baseline.

Keep these properties:

- Text in the exported PDF must be selectable and copyable.
- The visible text must be sharp, not a blurry page screenshot.
- The page should use a phone-width reading layout.
- Side content must not be clipped outside the PDF.
- The export should avoid large empty trailing pages.
- The main button/menu action should export immediately.

Future changes should start from this behavior and improve it in small steps.

## Do Not Regress Into These Routes

These routes are explicitly not the product direction:

- Do not turn the export into a plain Markdown text dump.
- Do not output a pure image PDF.
- Do not ask the user to choose between Text PDF, Snapshot PDF, Preview PDF, or
  similar modes.
- Do not use a simplified Markdown parser as the main rendering path.
- Do not continue from the later experimental `0.3.8` direction where preview
  preservation failed and the output became a block of simplified text.

Fallbacks may exist internally to prevent complete failure, but the primary
path must remain preview-first and selectable-text-first.

## Rendering Direction

The preferred rendering model is:

1. Use Obsidian's rendered preview DOM as the layout source.
2. Read visible text, image, block, list, checkbox, and callout positions from
   that rendered preview.
3. Write real PDF text for copyable text.
4. Embed images as images, not as one full-page screenshot.
5. Draw lightweight PDF shapes for backgrounds, borders, callouts, code blocks,
   tables, and task/list decorations.

The output does not need to be a perfect browser print clone, but it should keep
the spirit of the Obsidian preview instead of flattening everything into plain
paragraphs.

## Next Improvement Order

Improve in this order:

1. Pagination stability.
   Avoid splitting images, task blocks, callouts, tables, and short paragraphs
   when there is enough room to move them to the next page.

2. Rich preview details.
   Preserve common Obsidian preview details: task checkboxes, bullets, numbered
   lists, callout blocks, quote/code/table backgrounds, and embeds where
   practical.

3. Image handling.
   Keep images within the mobile page width, preserve aspect ratio, and avoid
   cutting images across pages where practical.

4. Typography cleanup.
   Keep text sharp, readable, and compact; avoid excessive letter spacing,
   flattened-looking text, and unnecessary side whitespace.

5. Source cleanup.
   Rebuild a clean TypeScript source baseline that reproduces the accepted
   `v0.3.2` package before adding larger features.

## Acceptance Checklist

A release is not considered good enough unless it satisfies these checks:

- The export command is one-click.
- The output PDF is not blank.
- Text can be copied from the PDF.
- The PDF uses a mobile reading width.
- Text is not blurry.
- Text is not spread with abnormal character spacing.
- Content is not clipped at the left or right edge.
- There are no obvious empty trailing pages.
- Images and rich blocks are preserved as much as the implementation supports.
- The current installed Obsidian plugin version and command registration are
  verified after installation.

## Current Public Release

- GitHub repository: `https://github.com/arias007/obsidian-mobile-pdf-exporter`
- Current accepted release: `v0.3.2`
- Release asset: `mobile-pdf-exporter-v0.3.2.zip`

The public package intentionally includes `NotoSansSC-Regular.otf` and does not
redistribute local system fonts such as `SimHei.ttf`.
