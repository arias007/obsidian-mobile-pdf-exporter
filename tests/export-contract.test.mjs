import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourceUrl = new URL("../src/main.ts", import.meta.url);
const stylesUrl = new URL("../styles.css", import.meta.url);

test("the visible export prompt can cancel every expensive phase", async () => {
  const [source, styles] = await Promise.all([
    readFile(sourceUrl, "utf8"),
    readFile(stylesUrl, "utf8")
  ]);

  assert.match(source, /signal\?: AbortSignal/);
  assert.match(source, /private readonly abortController = new AbortController\(\)/);
  assert.match(source, /readonly signal = this\.abortController\.signal/);
  assert.match(source, /busyCancelButton/);
  assert.match(source, /this\.abortController\.abort\(\)/);
  assert.match(source, /captureLiveViewPdfModel\(file, liveSurface, signal\)/);
  assert.match(source, /renderPreviewToSelectablePdf\(file, model, signal\)/);
  assert.match(source, /adapter\.remove\(writtenOutputPath\)/);
  assert.ok((source.match(/throwIfExportCancelled\(signal\)/g) ?? []).length >= 12);
  assert.match(styles, /\.mobile-pdf-exporter-busy-cancel\s*\{/);
  assert.match(styles, /\.mobile-pdf-exporter-busy[\s\S]*pointer-events:\s*auto/);
});

test("external and internal links produce PDF URI annotations", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /function createPdfLinkContext\(app: App, file: TFile\)/);
  assert.match(source, /function resolveRelativeMarkdownLinkPath\(linkPath: string, sourcePath: string\)/);
  assert.match(source, /function isPathLikeMarkdownLink\(linkPath: string\)/);
  assert.match(source, /function collapseVaultPathSegments\(path: string\)/);
  assert.match(source, /collapseVaultPathSegments\(normalizePath\(rootedPath\)\)/);
  assert.match(source, /context\.app\.vault\.getAbstractFileByPath\(relativePath\)/);
  assert.match(source, /metadataCache\.getFirstLinkpathDest\(linkPath, context\.sourcePath\)/);
  assert.match(source, /`obsidian:\/\/open\?vault=\$\{vault\}&file=\$\{file\}`/);
  assert.match(source, /captureLinkFragments\(rootEl, linkContext\)/);
  assert.match(source, /S:\s*"URI"/);
  assert.match(source, /URI:\s*getPdfStringRuntime\(\)\.of\(target\)/);
});

test("live capture deduplicates text and never cuts a page through a text line", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /surface\.mode === "preview"/);
  assert.match(source, /const maxSegments = Math\.min\(512/);
  assert.match(source, /actualTop <= previousActualTop \+ 0\.5/);
  assert.match(source, /captured\.textFragments = dedupeOverlappingLiveTextFragments/);
  assert.match(source, /function areOverlappingDuplicateTextFragments/);
  assert.match(source, /const crossingTextLine = sortedBlocks/);
  assert.match(source, /fragment\.priority === 1/);
  assert.match(source, /crossingTextLine\.bottom \+ PAGE_BREAK_PADDING_PX/);
});
