import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourceUrl = new URL("../src/main.ts", import.meta.url);
const stylesUrl = new URL("../styles.css", import.meta.url);
const buildConfigUrl = new URL("../esbuild.config.mjs", import.meta.url);

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
  assert.match(source, /await primeLivePreviewLayout\(rootEl, scrollEl, previewRenderer, signal\)/);
  assert.match(source, /section\.render\?\.\(\)/);
  assert.match(source, /renderer\.sizerEl\.append\(\.\.\.sectionElements\)/);
  assert.match(source, /renderer\.measureSection\?\.\(section\)/);
  assert.match(source, /for \(let pass = 0; pass < 3; pass \+= 1\)/);
  assert.match(source, /function buildLivePreviewGapScrollPositions/);
  assert.match(source, /const gapPositions = buildLivePreviewGapScrollPositions/);
  assert.match(source, /for \(let retry = 0; retry < 4 && countMissingLivePreviewSections\(previewRenderer, previewSectionCaptures\) > 0; retry \+= 1\)/);
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
  assert.match(source, /if \(previewRenderer\) \{\s*captureConnectedLivePreviewSections\(/);
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
  assert.match(source, /catch \(directError\) \{\s*const vaultImage = await loadVaultImageForCanvas\(fallback\);/);
  assert.match(source, /const remoteImage = await loadRemoteImageForCanvas\(image\)/);
  assert.match(source, /async function loadVaultImageForCanvas\(fallback\?: ImageExportFallback\)/);
  assert.match(source, /function loadRemoteImageForCanvas/);
  assert.match(source, /const remoteCanvasImageCache = new WeakMap/);
  assert.match(source, /return await loadImage\(source, REMOTE_IMAGE_CORS_TIMEOUT_MS, "anonymous"\)/);
  assert.match(source, /requestUrl\(\{ url: source, method: "GET" \}\),\s*REMOTE_IMAGE_REQUEST_TIMEOUT_MS/);
  assert.match(source, /if \(crossOrigin\) image\.crossOrigin = crossOrigin/);
  assert.match(source, /new Blob\(\[bytes\.buffer\], \{ type: contentType\.split\(";", 1\)\[0\] \}\)/);
});

test("Office exports keep editable text anchored to PDF fragment coordinates", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /function getOfficeTextFragmentLayout\(/);
  assert.match(source, /overlap >= minimumHeight \* 0\.32 \|\| Math\.abs\(fragmentCenter - lineCenter\) <= centerTolerance/);
  assert.match(source, /for \(const line of getPageOfficeTextLines\(model, pageIndex\)\) \{\s*for \(const group of groupPptTextLine\(line\)\)/);
  assert.match(source, /const layout = getPptTextGroupLayout\(model, pageIndex, group\)/);
  assert.match(source, /const richText = buildPptRichTextRuns\(model, group\.fragments\)/);
  assert.match(source, /fit:\s*"shrink"/);
  assert.match(source, /wrap:\s*false/);
  assert.match(source, /function buildWordFlowTextParagraphsXml\([\s\S]*?model: PreviewPdfModel,[\s\S]*?pageIndex: number,[\s\S]*?hyperlinkIds: ReadonlyMap<string, string>/);
  assert.match(source, /const paragraphs = buildWordFlowTextParagraphsXml\([\s\S]*?model,[\s\S]*?pageIndex,[\s\S]*?hyperlinkIds,/);
  assert.match(source, /const needsExplicitNoteDraw = format === "docx" \|\| format === "pptx" \|\| format === "png"/);
  assert.match(source, /return buildEditablePptx\(file, pageModel, \{/);
  assert.match(source, /return buildEditableDocx\(file, pageModel, \{/);
  assert.doesNotMatch(source, /\(format === "docx" \|\| format === "pptx"\)[\s\S]{0,160}?renderMarkdownPreview/);
  assert.match(source, /const editable = await injectEditableWordTextBoxes\(packed, model\)/);
  assert.match(source, /drawingRuns\.map\(buildInlineWordMediaRun\)/);
  assert.match(source, /<wp:inline distT="0" distB="0" distL="0" distR="0">/);
  assert.match(source, /return injectOfficePreviewPages\(editable, model, await renderOfficePreviewPages\(model, options\)\)/);
  assert.match(source, /return injectOfficePreviewPages\(blob, model, await renderOfficePreviewPages\(model, options\)\)/);
  assert.match(source, /includeNoteDraw:\s*true/);
  assert.match(source, /for \(const line of getPageOfficeTextLines\(model, pageIndex\)\)/);
  assert.match(source, /slide\.addText\(richText,/);
  assert.doesNotMatch(source, /slide\.addImage\(\{ data: bytesToDataUrl\(pages\[pageIndex\]\)/);
  assert.match(source, /async function getOfficeMediaFragments\([\s\S]*?renderOptions: OfficeRenderOptions/);
  assert.match(source, /for \(const media of await getOfficeMediaFragments\(model, pageIndex, options\)\)/);
  assert.match(source, /slide\.addImage\(\{\s*data: bytesToDataUrl\(media\.data\)/);
  assert.match(source, /const visualBackground = await renderOfficePageVisualBackground\(model, pageIndex, options\)/);
  assert.match(source, /textFragments: \[\],[\s\S]*imageFragments: model\.imageFragments,[\s\S]*canvasFragments: model\.canvasFragments/);
  assert.match(source, /sourcePath: getImageFragmentSourcePath\(image\)/);
  assert.match(source, /linkPath: fragment\.sourcePath/);
  assert.match(source, /new ImageRun\(\{/);
  assert.match(source, /behindDocument: false/);
  assert.match(source, /wrap: \{ type: TextWrappingType\.NONE \}/);
  assert.doesNotMatch(source, /new Header\(/);
  assert.match(source, /new Paragraph\(\{ children: \[\.\.\.imageRuns, new TextRun\(`__MPE_PAGE_\$\{pageIndex\}__`\)\] \}\)/);
  assert.match(source, /const markerParagraph = new RegExp\(`<w:p\(\?=\[ >\]\)\(\?:\(\?!/);
  assert.match(source, /const drawingRuns = markerXml\.match\(/);
  assert.doesNotMatch(source, /const mediaParagraph = drawingRuns\.length > 0/);
  assert.match(source, /<w:tabs>\$\{tabStops\}<\/w:tabs>/);
  assert.match(source, /const visibleGap = gapPx > Math\.max\(2,/);
  assert.match(source, /return distinctScopes && columnGap && !fragment\.officeDecoration && !previous\.officeDecoration \? "tab" : "space"/);
  assert.match(source, /<w:t xml:space="preserve"> <\/w:t>/);
  assert.match(source, /<w:spacing w:before="\$\{beforeTwips\}" w:after="0"/);
  assert.match(source, /<w:ind w:left="\$\{leftTwips\}"\/>/);
  assert.match(source, /decoration\.checked \? "☑" : "☐"/);
  assert.match(source, /decoration\.kind === "bullet"[\s\S]*?"•"/);
  assert.match(source, /includeText,\s*includeDecorations,\s*includeNoteDraw: true/);
  assert.match(source, /if \(options\.includeDecorations !== false\)/);
  assert.match(source, /if \(options\.includeNoteDraw === true\)/);
  assert.match(source, /function drawCanvasNoteDrawInkLayer\(/);
  assert.match(source, /<w:pStyle w:val="Heading\$\{headingLevel\}"\/>/);
  assert.match(source, /fragment\.fontSizePx \* model\.pxToPt \* 2/);
  assert.match(source, /function buildWordTextPayloadXml\(text: string\)/);
  assert.match(source, /character === "-" && isAsciiDigit\(previous\) && isAsciiDigit\(next\)/);
  assert.match(source, /xml \+= "<w:noBreakHyphen\/>"/);
  assert.match(source, /<w:hyperlink r:id="\$\{relationshipId\}" w:history="1">/);
  assert.match(source, /function injectWordHyperlinkRelationships/);
  assert.match(source, /relationships\/hyperlink/);
  assert.match(source, /hyperlink: fragment\.href \? \{ url: fragment\.href \}/);
  assert.doesNotMatch(source, /<wps:txbx/);
  assert.doesNotMatch(source, /<w:txbxContent>/);
  assert.doesNotMatch(source, /<v:shape/);
  assert.doesNotMatch(source, /<w:pict>/);
  assert.match(source, /if \(element\.matches\("input\[type='checkbox'\]"\)\) continue/);
  assert.match(source, /return usable \|\| "Noto Sans SC"/);
  assert.doesNotMatch(source, /const officePreviewPages = editableOffice/);
  assert.doesNotMatch(source, /injectOfficePreviewPages\(blob, model, previewPages\)/);
  assert.doesNotMatch(source, /injectOfficePreviewPages\(editable, model, previewPages\)/);
});

test("HTML export uses semantic layers instead of a full-page PNG wrapper", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /if \(format === "html" && isMarkdown\)/);
  assert.match(source, /outputBlob = await buildRenderedDomHtml\(file, rendered\.pageEl, signal\)/);
  assert.match(source, /async function buildRenderedDomHtml\(file: TFile, pageEl: HTMLElement, signal\?: AbortSignal\)/);
  assert.match(source, /data-mpe-format="rendered-dom"/);
  assert.match(source, /copyRenderedHtmlStyle\(sourceElements\[index\], clonedElements\[index\]\)/);
  assert.match(source, /const HTML_FLOW_SIZE_PROPERTIES = new Set<string>/);
  assert.match(source, /if \(!preservesSize && HTML_FLOW_SIZE_PROPERTIES\.has\(property\)\) continue/);
  assert.match(source, /\.mpe-rendered-document img\{max-width:100%;height:auto!important\}/);
  assert.match(source, /await inlineRenderedHtmlMedia\(sourceElements, clonedElements, signal\)/);
  assert.match(source, /removeObsidianOnlyHtmlUrls\(clone\)/);
  assert.match(source, /function removeObsidianOnlyHtmlUrls\(root: HTMLElement\)/);
  assert.match(source, /\["src", "srcset", "poster", "data", "aria-label"\]/);
  assert.match(source, /target\.src = bytesToDataUrl\(bytes\)/);
  assert.match(source, /source\.toDataURL\("image\/png"\)/);
  assert.match(source, /target\.replaceWith\(image\)/);
  assert.doesNotMatch(source, /return buildSelfContainedHtml\(file, model, pages\)/);
});

test("live preview Markdown syntax is omitted without removing hashtag text", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /function isLivePreviewMarkdownSyntaxElement\(element: Element\)/);
  assert.match(source, /element\.closest\('\[class\*="cm-formatting"\]'\)/);
  assert.match(source, /!formatting\.classList\.contains\("cm-formatting-hashtag"\)/);
  assert.match(source, /isLivePreviewMarkdownSyntaxElement\(element\) \|\|/);
  assert.match(source, /function getTextHeadingLevel\(parent: HTMLElement\)/);
});

test("NoteDraw exports fall back to persisted strokes when the live canvas is outside the note", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /interface NoteDrawApiRuntime/);
  assert.match(source, /noteDrawSourcePath\?: string/);
  assert.match(source, /getAbstractFileByPath\(normalizePath\(options\.noteDrawSourcePath\)\)/);
  assert.match(source, /const preparedNoteDraw = await this\.prepareNoteDrawExportOverlay\(file, rootEl\)/);
  assert.match(source, /const preparedNoteDraw = await this\.prepareNoteDrawExportOverlay\(noteDrawFile, noteDrawHost\)/);
  assert.match(source, /model = this\.capturePreviewPdfModel\(file, rendered\.pageEl\)/);
  assert.match(source, /preparedNoteDraw\.cleanup\(\)/);
  assert.match(source, /private async prepareNoteDrawExportOverlay\(/);
  assert.match(source, /rawData = await api\.readDrawings\(file\)/);
  assert.match(source, /rawData as \{ visible\?: unknown \}/);
  assert.match(source, /await api\.injectExportSnapshot\(file, host\)/);
  assert.match(source, /drawNoteDoodleStrokes\(context, data\.strokes, width, height\)/);
  assert.match(source, /mobile-pdf-exporter-note-doodle-canvas mobile-pdf-exporter-live-drawing-canvas notedraw-canvas/);
  assert.match(source, /function isNoteDrawCanvasFragment\(fragment: CanvasFragment\)/);
  assert.match(source, /canvas\.closest\(\s*"\.notedraw-shell, \.note-doodle-shell, \.notedraw-export-image-canvas-layer"/);
  assert.match(source, /canvasFragments: model\.canvasFragments\.filter\(\(fragment\) => !isNoteDrawCanvasFragment\(fragment\)\)/);
});

test("plugin UI follows Obsidian window and settings conventions", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /activeDocument\.createElement\("canvas"\)/);
  assert.match(source, /activeDocument\.createElement\("img"\)/);
  assert.match(source, /activeWindow\.setTimeout/);
  assert.doesNotMatch(source, /new Setting\(containerEl\)\.setName\("Mobile PDF Exporter"\)\.setHeading\(\)/);
  assert.doesNotMatch(source, /appendElement\(containerEl, "h[23]"/);
});

test("PptxGenJS is bundled in browser mode for the Electron renderer", async () => {
  const config = await readFile(buildConfigUrl, "utf8");

  assert.match(config, /name: "pptxgen-browser-runtime"/);
  assert.match(config, /const isNode = false;/);
  assert.match(config, /if \(replacements !== 2\)/);
  assert.match(config, /plugins: \[pptxGenBrowserRuntime\]/);
});
