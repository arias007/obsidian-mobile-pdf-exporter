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

test("live capture avoids virtual-scroll loss, blank trailing pages, and split text lines", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /if \(liveSurface\) \{\s*model = await this\.captureLiveViewPdfModel\(file, liveSurface, signal\)/);
  assert.doesNotMatch(source, /captureMarkdownEditorSourcePdfModel/);
  assert.doesNotMatch(source, /buildMarkdownEditorSourceCapture/);
  assert.match(source, /function buildLiveSurfaceCaptureScrollPositions/);
  assert.match(source, /function getLivePreviewRenderer/);
  assert.match(source, /function captureConnectedLivePreviewSections/);
  assert.match(source, /measuredHeight: Math\.max\(0, rect\.height\)/);
  assert.match(source, /function getLivePreviewSectionLayoutHeight/);
  assert.match(source, /return Math\.max\(cachedHeight, measuredHeight\)/);
  assert.match(source, /sectionTop \+= getLivePreviewSectionLayoutHeight\(section, capture\)/);
  assert.match(source, /sectionTop \+= getLivePreviewSectionLayoutHeight\(section, captures\.get\(index\)\)/);
  assert.match(source, /function buildMissingLivePreviewSectionScrollPositions/);
  assert.match(source, /function appendLivePreviewSectionCaptures/);
  assert.match(source, /function captureLivePreviewRootOverlays/);
  assert.match(source, /const previewSectionCaptures = new Map<number, CapturedLivePreviewSection>/);
  assert.match(source, /appendLivePreviewSectionCaptures\(captured, previewRenderer, previewSectionCaptures, seen\)/);
  assert.match(source, /countMissingLivePreviewSections\(previewRenderer, previewSectionCaptures\)/);
  assert.match(source, /Live reading view did not render/);
  assert.match(source, /function buildLivePreviewGapScrollPositions/);
  assert.match(source, /const gapPositions = buildLivePreviewGapScrollPositions/);
  assert.match(source, /if \(surface\.mode === "preview" && !previewRenderer\) \{/);
  assert.match(source, /const captureWholePreview = surface\.mode === "preview" && index === 0/);
  assert.match(source, /surface\.mode === "preview" && !hasRenderedContent\(rootEl\)/);
  assert.match(source, /await waitForRenderedContent\(rootEl, 1800\)/);
  assert.match(source, /scrollEl\.dispatchEvent\(new Event\("scroll"\)\)/);
  assert.match(source, /await waitForPreviewDomStable\(rootEl, 360\)/);
  assert.match(source, /function sortTextFragmentsForDrawing/);
  assert.doesNotMatch(source, /function mergeAdjacentFragments/);
  assert.match(source, /await waitForLiveSurfaceSettled\(rootEl, scrollEl, signal\)/);
  assert.match(source, /function settleLiveSurfaceAtScrollPosition/);
  assert.match(source, /await settleLiveSurfaceAtScrollPosition\(rootEl, scrollEl, scrollPositions\[index\], signal, previewRenderer\)/);
  assert.match(source, /Math\.abs\(scrollEl\.scrollTop - expectedTop\) <= 1\.5/);
  assert.match(source, /function waitForLivePreviewRendererSettled/);
  assert.match(source, /if \(previewRenderer\) \{\s*await waitForLivePreviewRendererSettled\(scrollEl, previewRenderer, signal\)/);
  assert.match(source, /section\.el\?\.isConnected \? 1 : 0/);
  assert.match(source, /function getUncapturedConnectedPreviewSectionElements/);
  assert.match(source, /waitForImagesInElements\(connectedSections, 900\)/);
  assert.match(source, /else if \(rootEl\.querySelector\("img"\)\) \{\s*await waitForImages\(rootEl, Math\.min\(IMAGE_WAIT_TIMEOUT_MS, 1100\)\);\s*await settleLiveSurfaceAtScrollPosition/);
  assert.match(source, /let appendedPreviewMissingWindows = false/);
  assert.match(source, /previewRenderer && !appendedPreviewMissingWindows && index === scrollPositions\.length - 1/);
  assert.match(source, /function waitForImagesInElements/);
  assert.match(source, /const imageSignature = Array\.from\(rootEl\.querySelectorAll\("img"\)\)/);
  assert.match(source, /function waitForLiveSurfaceSettled/);
  assert.match(source, /interface LiveSurfaceCaptureWindow/);
  assert.match(source, /textNodes: WeakMap<Text, CachedLiveTextCapture>/);
  assert.match(source, /function filterSurfaceCaptureToBand/);
  assert.match(source, /const bandTop = captureWholePreview \|\| isFirstWindow \? 0 : actualTop \+ overlapHeight \/ 2/);
  assert.match(source, /const bandBottom = captureWholePreview \|\| isLastWindow/);
  assert.match(source, /function measureVisibleCapturedSurfaceBottom/);
  assert.match(source, /const capturedBottomPx = measureVisibleCapturedSurfaceBottom\(transformed\)/);
  assert.match(source, /const transformedContentHeight = Math\.max\(1, capturedBottomPx\)/);
  assert.doesNotMatch(source, /contentHeightPx \* surfaceScale/);
  assert.doesNotMatch(source, /const maxSegments = Math\.min\(512/);
  assert.doesNotMatch(source, /actualTop <= previousActualTop \+ 0\.5/);
  assert.doesNotMatch(source, /const maxSteps = 96/);
  assert.match(source, /captured\.textFragments = dedupeOverlappingLiveTextFragments/);
  assert.match(source, /function areOverlappingDuplicateTextFragments/);
  assert.match(source, /function getCanvasVisiblePixelBounds/);
  assert.match(source, /Array\.isArray\(strokes\) && strokes\.length === 0/);
  assert.match(source, /if \(pixelCount > 8_000_000\) return fullBounds/);
  assert.match(source, /nextBreak = moveBreakOutsideTextLines\(pageTop, nextBreak, pageHeightPx, sortedBlocks\)/);
  assert.match(source, /function moveBreakOutsideTextLines/);
  assert.match(source, /return enforceMaximumPageSpan\(breaks, contentHeightPx, pageHeightPx, sortedBlocks\)/);
  assert.match(source, /function enforceMaximumPageSpan/);
  assert.match(source, /while \(target - current > maximumSpan \+ 0\.5\)/);
  assert.match(source, /let nextBreak = Math\.min\(idealBreak, textSafeBreak\)/);
  assert.match(source, /isContentEnd \|\| target - current > PAGE_BREAK_MIN_ADVANCE_PX/);
  assert.match(source, /const crossingTextLine = sortedBlocks/);
  assert.match(source, /fragment\.priority === 1/);
  assert.match(source, /const beforeLine = crossingTextLine\.top/);
  assert.match(source, /const afterLine = crossingTextLine\.bottom/);
  assert.match(source, /fragment\.bottom <= pageTopPx \+ 0\.5 \|\| fragment\.top >= pageBottomPx - 0\.5/);
  assert.match(source, /fragment\.bottom <= options\.pageTopPx \+ 0\.5 \|\| fragment\.top >= options\.pageBottomPx - 0\.5/);
  assert.doesNotMatch(source, /const maxBoxBottom/);
  assert.doesNotMatch(source, /const maxKeepBottom/);
});

test("remote images fall back to Obsidian requests when canvas export is cross-origin blocked", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /function imageFragmentSliceToPngBytes/);
  assert.match(source, /catch \(directError\) \{\s*const remoteImage = await loadRemoteImageForCanvas\(image\)/);
  assert.match(source, /function loadRemoteImageForCanvas/);
  assert.match(source, /const remoteCanvasImageCache = new WeakMap/);
  assert.match(source, /return await loadImage\(source, REMOTE_IMAGE_CORS_TIMEOUT_MS, "anonymous"\)/);
  assert.match(source, /requestUrl\(\{ url: source, method: "GET" \}\),\s*REMOTE_IMAGE_REQUEST_TIMEOUT_MS/);
  assert.match(source, /if \(crossOrigin\) image\.crossOrigin = crossOrigin/);
  assert.match(source, /new Blob\(\[bytes\.buffer\], \{ type: contentType\.split\(";", 1\)\[0\] \}\)/);
});
