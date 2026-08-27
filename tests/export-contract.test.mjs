import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourceUrl = new URL("../src/main.ts", import.meta.url);
const stylesUrl = new URL("../styles.css", import.meta.url);
const buildConfigUrl = new URL("../esbuild.config.mjs", import.meta.url);
const builtPluginUrl = new URL("../main.js", import.meta.url);

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
  assert.match(source, /const maxWidth = measuredWidth/);
  assert.match(source, /context\.rect\([\s\S]*?left,[\s\S]*?measuredWidth,[\s\S]*?fragment\.bottom - fragment\.top/);
  assert.match(source, /context\.clip\(\)/);
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
  assert.doesNotMatch(source, /section\.render\?\.\(\)/);
  assert.match(source, /renderer\.updateVirtualDisplay\?\.\(scrollEl\.scrollTop\)/);
  assert.match(source, /function snapshotCanvasElement\(canvas: HTMLCanvasElement\)/);
  assert.match(source, /await waitForRestoredNoteDrawSurface\(rootEl, signal\)/);
  assert.match(source, /captured\.canvasFragments = snapshotRestoredNoteDrawCanvases/);
  assert.doesNotMatch(source, /renderer\.sizerEl\.append\(\.\.\.sectionElements\)/);
  assert.doesNotMatch(source, /renderer\.measureSection\?\.\(section\)/);
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
  assert.match(source, /function isEmbeddedPreviewPending/);
  assert.match(source, /const effectiveTimeout = Math\.min\(timeoutMs, 700\)/);
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
  assert.match(source, /const inspectionScale = pixelCount > 2_000_000/);
  assert.match(source, /previewContext\.drawImage\(canvas, 0, 0, inspectionCanvas\.width, inspectionCanvas\.height\)/);
  assert.doesNotMatch(source, /if \(pixelCount > 8_000_000\) return fullBounds/);
  assert.match(source, /function removeEmptyTrailingPageBreaks\(model: PreviewPdfModel\)/);
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
  assert.match(source, /const paragraphs = `\$\{floatingParagraph\}\$\{buildWordFlowTextParagraphsXml\(model, pageIndex, hyperlinkIds\)\}`/);
  assert.match(source, /if \(format === "png"\) \{\s*const noteDrawVisual = preferNativeNoteDrawCanvas\(model\)/);
  assert.match(source, /const needsExplicitNoteDraw = format === "docx" \|\| format === "pptx"/);
  assert.match(source, /function preferNativeNoteDrawCanvas\(\s*model: PreviewPdfModel\s*\): \{ model: PreviewPdfModel; usesNativeCanvas: boolean \}/);
  assert.match(source, /const usesNativeCanvas = model\.canvasFragments\.some\(isNativeNoteDrawCanvasFragment\)/);
  assert.match(source, /canvasFragments: model\.canvasFragments\.filter\(\(fragment\) => !isNoteDrawCanvasFragment\(fragment\)\)/);
  assert.match(source, /return buildEditablePptx\(file, pageModel, \{/);
  assert.match(source, /return buildEditableDocx\(file, pageModel, \{/);
  assert.doesNotMatch(source, /\(format === "docx" \|\| format === "pptx"\)[\s\S]{0,160}?renderMarkdownPreview/);
  assert.match(source, /const editable = await injectEditableWordTextBoxes\(\s*packed,\s*model,\s*sectionResults\.flatMap\(\(result\) => result\.videos\)\s*\)/);
  assert.match(source, /const floatingRuns = drawingRuns\.map\(\(runXml\) =>/);
  assert.match(source, /if \(!videoPart\) return runXml/);
  assert.match(source, /w:line="1" w:lineRule="exact"/);
  assert.doesNotMatch(source, /buildInlineWordMediaRun/);
  assert.doesNotMatch(source, /<wp:inline/);
  assert.match(source, /return injectOfficePreviewPages\(\s*editable,\s*model,\s*await renderOfficePreviewPages\(model, options\),\s*embeddedAssets/);
  assert.match(source, /return injectOfficePreviewPages\(\s*blob,\s*model,\s*await renderOfficePreviewPages\(model, options\),\s*embeddedAssets\.filter/);
  assert.match(source, /includeNoteDraw:\s*true/);
  assert.match(source, /for \(const line of getPageOfficeTextLines\(model, pageIndex\)\)/);
  assert.match(source, /slide\.addText\(richText,/);
  assert.doesNotMatch(source, /slide\.addImage\(\{ data: bytesToDataUrl\(pages\[pageIndex\]\)/);
  assert.match(source, /async function getOfficeMediaFragments\([\s\S]*?renderOptions: OfficeRenderOptions/);
  assert.match(source, /async function getDocxVideoCoverFragments\(/);
  assert.match(source, /for \(const fragment of model\.videoFragments\)[\s\S]*?getVideoCoverDataUrl\(fragment\.element\)/);
  assert.match(source, /assetPath: fragment\.sourcePath/);
  assert.match(source, /for \(const media of await getOfficeMediaFragments\(model, pageIndex, options\)\)/);
  assert.match(source, /slide\.addImage\(\{\s*data: bytesToDataUrl\(media\.data\)/);
  assert.match(source, /slide\.addMedia\(\{\s*type: "video",\s*data: bytesToDataUrl\(placement\.asset\.bytes, placement\.asset\.mimeType\)/);
  assert.match(source, /const visualBackground = await renderOfficePageVisualBackground\(model, pageIndex, options\)/);
  assert.match(source, /textFragments: \[\],[\s\S]*imageFragments: model\.imageFragments,[\s\S]*canvasFragments: model\.canvasFragments/);
  assert.match(source, /sourcePath: getImageFragmentSourcePath\(image\)/);
  assert.match(source, /linkPath: fragment\.sourcePath/);
  assert.match(source, /new ImageRun\(\{/);
  assert.match(source, /async function getOfficeNoteDrawFragments\(/);
  assert.match(source, /for \(const element of model\.noteDrawSourceElements \?\? model\.noteDrawElements \?\? \[\]\)/);
  assert.match(source, /for \(const stroke of model\.noteDrawInkStrokes \?\? \[\]\)/);
  assert.match(source, /\.\.\.await getOfficeNoteDrawFragments\(model, pageIndex, options\)/);
  assert.match(source, /behindDocument: false/);
  assert.match(source, /wrap: \{ type: TextWrappingType\.NONE \}/);
  assert.doesNotMatch(source, /new Header\(/);
  assert.match(source, /new Paragraph\(\{ children: \[\.\.\.imageRuns, new TextRun\(`__MPE_PAGE_\$\{pageIndex\}__`\)\] \}\)/);
  assert.match(source, /const markerParagraph = new RegExp\(`<w:p\(\?=\[ >\]\)\(\?:\(\?!/);
  assert.match(source, /const drawingRuns = markerXml\.match\(/);
  assert.match(source, /buildWordOleVideoRun\(runXml, videoPart, videoObjectIndex\)/);
  assert.match(source, /word\/embeddings\/mpe-video-\$\{index\}\.bin/);
  assert.match(source, /relationships\/oleObject/);
  assert.match(source, /application\/vnd\.openxmlformats-officedocument\.oleObject/);
  assert.match(source, /<o:OLEObject Type="Embed" ProgID="Package"/);
  assert.match(source, /buildOlePackage\(part\.asset\.name, part\.asset\.bytes\)/);
  assert.match(source, /<w:tabs>\$\{tabStops\}<\/w:tabs>/);
  assert.match(source, /const visibleGap = gapPx > Math\.max\(2,/);
  assert.match(source, /return distinctScopes && columnGap && !fragment\.officeDecoration && !previous\.officeDecoration \? "tab" : "space"/);
  assert.match(source, /<w:t xml:space="preserve"> <\/w:t>/);
  assert.match(source, /<w:spacing w:before="\$\{beforeTwips\}" w:after="0"/);
  assert.match(source, /<w:ind w:left="\$\{leftTwips\}"\/>/);
  assert.match(source, /decoration\.checked \? "☑" : "☐"/);
  assert.match(source, /decoration\.kind === "bullet"[\s\S]*?"•"/);
  assert.match(source, /includeNoteDraw(?:\s*:\s*true|\s*\n)/);
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
  assert.match(source, /<v:shape id=/);
  assert.match(source, /<w:object w:dxaOrig=/);
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
  assert.match(source, /outputBlob = await buildRenderedDomHtml\(\s*this\.app,\s*file,\s*rendered\.pageEl,\s*noteDrawHost,\s*preparedNoteDraw,\s*signal/);
  assert.match(source, /async function buildRenderedDomHtml\(\s*app: App,\s*file: TFile,\s*pageEl: HTMLElement,\s*noteDrawHost: HTMLElement/);
  assert.match(source, /data-mpe-format="rendered-dom"/);
  assert.match(source, /copyRenderedHtmlStyle\(sourceElements\[index\], clonedElements\[index\]\)/);
  assert.match(source, /const HTML_FLOW_SIZE_PROPERTIES = new Set<string>/);
  assert.match(source, /if \(!preservesSize && HTML_FLOW_SIZE_PROPERTIES\.has\(property\)\) continue/);
  assert.match(source, /\.mpe-rendered-document img\{max-width:100%;height:auto!important\}/);
  assert.match(source, /await inlineRenderedHtmlMedia\(app, file\.path, sourceElements, clonedElements, signal\)/);
  assert.match(source, /await injectRenderedHtmlNoteDrawAssets\(/);
  assert.match(source, /removeObsidianOnlyHtmlUrls\(clone\)/);
  assert.match(source, /function removeObsidianOnlyHtmlUrls\(root: HTMLElement\)/);
  assert.match(source, /\["src", "srcset", "poster", "data", "aria-label"\]/);
  assert.match(source, /target\.src = bytesToDataUrl\(bytes, mimeType\)/);
  assert.match(source, /source\.toDataURL\("image\/png"\)/);
  assert.match(source, /target\.replaceWith\(image\)/);
  assert.match(source, /const projectedElements = projectNoteDrawElements\(/);
  assert.match(source, /const htmlFallbackElements = injectedImageLayers\.length > 0/);
  assert.match(source, /drawCanvasNoteDrawElementLayer\(context, htmlFallbackElements/);
  assert.match(source, /const htmlGeometry = layout === "html" \? this\.getHtmlRenderGeometry\(file\) : null/);
  assert.match(source, /--mobile-pdf-exporter-padding-left/);
  assert.match(source, /--mobile-pdf-exporter-padding-right/);
  assert.match(source, /overlay\.kind === "notedraw" && noteDrawApi\?\.readDrawings/);
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
  assert.match(source, /drawNoteDoodleStrokes\(context, data\.strokes, width, height, contentFrame\)/);
  assert.match(source, /mobile-pdf-exporter-note-doodle-canvas mobile-pdf-exporter-live-drawing-canvas notedraw-canvas/);
  assert.match(source, /function isNoteDrawCanvasFragment\(fragment: CanvasFragment\)/);
  assert.match(source, /canvas\.closest\(\s*"\.notedraw-shell, \.note-doodle-shell, \.notedraw-export-image-canvas-layer"/);
  assert.match(source, /canvasFragments: model\.canvasFragments\.filter\(\(fragment\) => !isNoteDrawCanvasFragment\(fragment\)\)/);
  assert.match(source, /prepareNoteDrawElementData\(this\.app, host\.ownerDocument, rawData\)/);
  assert.match(source, /function measureNoteDrawTargetContentFrame\(host: HTMLElement, surfaceWidth: number\)/);
  assert.match(source, /contentLeft: Number\.isFinite\(frameContentLeft\) \? frameContentLeft : 0/);
  assert.match(source, /contentWidth: frameContentWidth >= 1 \? frameContentWidth : frameWidth/);
  assert.match(source, /targetContentLeft \+ \(element\.layoutBox\.x - sourceFrame\.contentLeft\) \* frameScaleX/);
  assert.match(source, /targetContentLeft \+ \(normalizedX \* sourceFrame\.surfaceWidth - sourceFrame\.contentLeft\) \* frameScaleX/);
  assert.match(source, /rawAnchor\?\.basis === "note-content-v1"/);
  assert.match(source, /contentFrame\.left \+ point\.anchor\.x \* contentFrame\.width/);
  assert.match(source, /function projectNoteDrawElements\(/);
  assert.match(source, /function drawCanvasNoteDrawElementLayer\(/);
  assert.match(source, /candidate\?\.kind === "text" \|\| candidate\?\.kind === "embed" \|\| candidate\?\.connector/);
  assert.match(source, /AP: \{ N: appearanceRef \}/);
  assert.match(source, /P: page\.ref/);
  assert.match(source, /Subtype: "Form"/);
});

test("PDF NoteDraw ink uses continuous canvas coordinates without a burned duplicate", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const projectionStart = source.indexOf("function projectNoteDrawInkStrokes(");
  const projectionEnd = source.indexOf("function normalizeNoteDoodleStroke(", projectionStart);
  const projection = source.slice(projectionStart, projectionEnd);

  assert.match(projection, /const mapped = noteDoodlePointToCanvas\(point, widthPx, heightPx, contentFrame\)/);
  assert.match(source, /inkSurfaceOffsetX: number/);
  assert.match(source, /inkSurfaceOffsetY: number/);
  assert.match(source, /canvasRect\.left - hostRect\.left \+ host\.scrollLeft/);
  assert.match(source, /function measureNoteDrawInkSurfaceOffset\(host: HTMLElement\)/);
  assert.match(source, /const y = Math\.abs\(rawY\) <= 64 \? rawY : 0/);
  assert.match(source, /const sourceX = mapped\.x \+ \(flow \? 0 : inkSurfaceOffsetX\)/);
  assert.match(source, /const sourceY = mapped\.y \+ \(flow \? 0 : inkSurfaceOffsetY\)/);
  assert.doesNotMatch(projection, /mapNoteDrawLineToDomY\(/);
  assert.doesNotMatch(source, /function eraseNativeNoteDrawInkFromCanvasModel\(/);
  assert.doesNotMatch(source, /globalCompositeOperation = "destination-out"/);
  assert.match(source, /const pdfBackgroundModel = noteDrawVisual\.model/);
  assert.match(source, /const visualModel = noteDrawVisual\.model/);
  assert.match(source, /const pdfInkStrokes = model\.noteDrawInkStrokes \?\? \[\]/);
});

test("NoteDraw watercolor ink preserves source width and text-line anchoring", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /variant: string;/);
  assert.match(source, /textAnchor: \{[\s\S]*?baseline: number;[\s\S]*?\} \| null;/);
  assert.match(source, /variant: typeof candidate\?\.variant === "string"/);
  assert.match(source, /textAnchor: normalizeNoteDrawTextAnchor\(candidate\?\.textAnchor\)/);
  assert.match(source, /const anchoredTextY = stroke\.variant === "text-highlight"/);
  assert.match(source, /mapNoteDrawLineAnchorY\(/);
  assert.match(source, /const positionedY = anchoredTextY \?\? sourceY/);
  assert.match(source, /const widthPt = Math\.max\(0\.5, stroke\.widthPx \* options\.pxToPt\)/);
  assert.doesNotMatch(source, /stroke\.widthPx \* options\.pxToPt \* \(stroke\.brush === "watercolor" \? 2\.15 : 1\)/);
  assert.match(source, /context\.lineWidth = strokeWidth;/);
  assert.doesNotMatch(source, /strokeWidth \* \(layerIndex === 0 \? 2\.15 : 1\.55\)/);
});

test("generated NoteDraw fallback canvases do not get mistaken for native ink layers", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /function isGeneratedNoteDrawCanvasFragment\(fragment: CanvasFragment\)/);
  assert.match(source, /function getCanvasVisualSignature\(canvas: HTMLCanvasElement\)/);
  assert.match(source, /native \? getCanvasVisualSignature\(fragment\.element\) : fragment\.element\.className/);
  assert.match(source, /canvasFragments: model\.canvasFragments\.filter\(\(fragment\) => !isNoteDrawCanvasFragment\(fragment\)\)/);
  assert.match(source, /includeNoteDraw = true/);
});

test("native NoteDraw surfaces are raster-free and emit one semantic PDF Ink layer", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /const pdfInkStrokes = model\.noteDrawInkStrokes \?\? \[\]/);
  assert.match(source, /canvasFragments: model\.canvasFragments\.filter\(\(fragment\) => !isNoteDrawCanvasFragment\(fragment\)\)/);
  assert.match(source, /noteDrawElements/);
  assert.doesNotMatch(source, /function eraseNativeNoteDrawInkFromCanvasModel\(/);
  assert.doesNotMatch(source, /NoteDraw export stopped:/);
  assert.match(source, /drawNoteDrawInkAnnotationLayer\(pdfPage, pdfInkStrokes/);
});

test("Cancip Office cards keep stable layout and expose a usable file fallback", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /\.obcc-inline-workbench-embed\[data-cancip-inline-path\]/);
  assert.match(source, /wrapper\.getAttribute\("data-cancip-inline-path"\)/);
  assert.match(source, /Open original/);
  assert.doesNotMatch(source, /prepareOfficeEmbedExportLayout/);
  assert.doesNotMatch(source, /local-direct-test-export/);
});

test("multilingual text and videos keep visual and selectable export fallbacks", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /embeddedArabicFontGzipBase64/);
  assert.match(source, /function detectRequiredPdfScriptFonts\(/);
  assert.match(source, /private async loadExportFontSet\(/);
  assert.match(source, /requiresRasterTextFallback\(fragment\.text\)/);
  assert.match(source, /direction: "ltr" \| "rtl"/);
  assert.match(source, /function captureVideoFragments\(/);
  assert.match(source, /function drawCanvasVideoLayer\(/);
  assert.match(source, /drawCanvasVideoPlayGlyph\(/);
  assert.match(source, /const bytes = vaultAsset\?\.bytes \?\?/);
  assert.match(source, /if \(bytes\?\.byteLength\) \{/);
  assert.doesNotMatch(source, /HTML_VIDEO_INLINE_MAX_BYTES/);
  assert.match(source, /await pdfDoc\.attach\(asset\.bytes, name,/);
  assert.match(source, /zip\.file\(archivePath, asset\.bytes\)/);
});

test("title choices and localized status text are honored across common languages", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /const UI_LANGUAGES = \[[\s\S]*?"auto",[\s\S]*?"zh",[\s\S]*?"en",[\s\S]*?"ja",[\s\S]*?"ko",[\s\S]*?"es",[\s\S]*?"fr",[\s\S]*?"de",[\s\S]*?"ru",[\s\S]*?"pt",[\s\S]*?"it",[\s\S]*?"ar",[\s\S]*?"hi",[\s\S]*?"id",[\s\S]*?"tr",[\s\S]*?"vi",[\s\S]*?"th"[\s\S]*?\] as const/);
  assert.match(source, /const suppressedInlineTitles = this\.settings\.includeTitle\s*\? \[\]\s*:\s*Array\.from\(rootEl\.querySelectorAll<HTMLElement>\("\.inline-title"\)\)/);
  assert.match(source, /suppressedInlineTitles\.forEach\(\(element\) => element\.classList\.add\("mobile-pdf-exporter-skip"\)\)/);
  assert.match(source, /suppressedInlineTitles\.forEach\(\(element\) => element\.classList\.remove\("mobile-pdf-exporter-skip"\)\)/);
  const translationEnd = source.indexOf("} as const;", source.indexOf("const UI_TEXT ="));
  assert.ok(translationEnd > 0);
  const runtimeSource = source.slice(translationEnd);
  assert.doesNotMatch(runtimeSource, /[\u4e00-\u9fff]/u);
});

test("punctuation and emoji preserve original grapheme clusters", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /isEmojiLikeText\(text\) \|\| \/\[:：\]\/u\.test\(text\)/);
  assert.match(source, /new Segmenter\(undefined, \{ granularity: "grapheme" \}\)/);
  assert.match(source, /\p\{Extended_Pictographic\}/);
  assert.match(source, /\p\{Regional_Indicator\}/);
  assert.match(source, /\p\{Emoji_Modifier\}/);
  assert.match(source, /\|\\uFE0F\|\\u20E3/);
  assert.match(source, /\[0x2000, 0x2bff\]/);
  assert.match(source, /\[0x2e00, 0x2e7f\]/);
  assert.match(source, /\[0x3000, 0x303f\]/);
  assert.match(source, /\[0xfe00, 0xfe6f\]/);
  assert.match(source, /\[0xff01, 0xff65\]/);
  assert.match(source, /context\.fillText\(emoji, x, baselineY\)/);
  assert.doesNotMatch(source, /return " · "/);
  assert.doesNotMatch(source, /replace\(\/\\uFE0F/);
  assert.doesNotMatch(source, /\[·•・\|｜\/、，,;；:：<>/);
  assert.doesNotMatch(source, /\(\[A-Za-z0-9\]\)\(\[:：\]\)/);
});

test("plugin UI follows Obsidian window and settings conventions", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /activeDocument\.createElement\("canvas"\)/);
  assert.match(source, /activeDocument\.createElement\("img"\)/);
  assert.match(source, /activeWindow\.setTimeout/);
  assert.doesNotMatch(source, /new Setting\(containerEl\)\.setName\("Mobile PDF Exporter"\)\.setHeading\(\)/);
  assert.doesNotMatch(source, /appendElement\(containerEl, "h[23]"/);
});

test("scaled live surfaces stay horizontally centered at every content scale", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const layout = await import("../src/surface-layout.ts");

  assert.equal(layout.computeCenteredSurfaceOffset(800, 800, 24), 24);
  assert.equal(layout.computeCenteredSurfaceOffset(800, 1000, 24), -76);
  assert.equal(layout.computeCenteredSurfaceOffset(800, 600, 24), 124);
  assert.equal(layout.computeCenteredSurfaceOffset(Number.NaN, 600, 24), -276);
  assert.match(source, /const scaledContentWidthPx = liveWidthPx \* surfaceScale/);
  assert.match(source, /computeCenteredSurfaceOffset\(\s*usableWidthPx,\s*scaledContentWidthPx,\s*horizontalInsetPx\s*\)/);
  assert.match(source, /transformSurfaceCapture\(captured, centeredOffsetPx, surfaceScale\)/);
  assert.match(source, /offsetX: centeredOffsetPx/);
});

test("PDF text keeps line endings visible and normalizes Arabic copy mappings", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const text = await import("../src/pdf-text.ts");

  assert.equal(text.getTextFragmentPaintWidth(100, 180, 16, 800), 87.2);
  assert.equal(text.getTextFragmentPaintWidth(780, 800, 16, 800), 20);
  const cmap = [
    "beginbfchar",
    "<0001> <FEA2>",
    "<0002> <FEE0>",
    "<0003> <0041>",
    "endbfchar"
  ].join("\n");
  const normalized = text.normalizePdfToUnicodeCMap(cmap);
  assert.match(normalized, /<0001> <062D>/);
  assert.match(normalized, /<0002> <0644>/);
  assert.match(normalized, /<0003> <0041>/);
  assert.match(source, /normalizePdfToUnicodeMaps\(pdfDoc, \{ PDFName, decodePDFRawStream \}\)/);
  assert.match(source, /getTextFragmentPaintWidth\(/);
  assert.match(source, /const clipLeft = fragment\.direction === "rtl"/);
  assert.match(source, /!\/\^var\\\(/iu);
});

test("mobile preview renders the real PDF with selectable text and never opens a share sheet", async () => {
  const [source, styles] = await Promise.all([
    readFile(sourceUrl, "utf8"),
    readFile(stylesUrl, "utf8")
  ]);

  assert.match(source, /renderPreviewPdfBlob\(/);
  assert.match(source, /const pdfBlob = await this\.plugin\.renderPreviewPdfBlob\(/);
  assert.match(source, /pdfjsLib\.getDocument\(/);
  assert.match(source, /new pdfjsLib\.TextLayer\(/);
  assert.match(source, /loadPdfJsRuntime\(\)/);
  assert.match(source, /loadPdfJsWorkerRuntime\(\)/);
  assert.doesNotMatch(source, /import \* as pdfjsLib from "pdfjs-dist\/legacy\/build\/pdf\.mjs"/);
  assert.doesNotMatch(source, /^import\s+\{[^}]+\}\s+from "pdf-lib"/m);
  assert.match(source, /const previousWorker = workerGlobal\.pdfjsWorker/);
  assert.match(source, /delete workerGlobal\.pdfjsWorker/);
  assert.match(source, /return withBundledPreviewWorker\(async \(pdfjsLib\) =>/);
  assert.match(source, /host\.empty\(\);\s*try \{\s*for \(let pageNumber/s);
  assert.doesNotMatch(source, /pdfjsWorker\s*\?\?=/);
  assert.doesNotMatch(source, /disableWorker:\s*true/);
  assert.match(source, /mobile-pdf-exporter-preview-pdf-text-layer/);
  assert.match(source, /previewCollapsed: false/);
  assert.match(source, /setIcon\(icon, !this\.draft\.previewEnabled \? "eye" : expanded \? "chevron-down" : "chevron-right"\)/);
  assert.match(source, /button\.setAttribute\("aria-expanded", String\(expanded\)\)/);
  assert.doesNotMatch(source, /mobile-pdf-exporter-preview-collapse-button/);
  assert.doesNotMatch(styles, /mobile-pdf-exporter-preview-collapse-button/);
  assert.doesNotMatch(source, /renderPreviewPngBlobs/);
  assert.doesNotMatch(source, /renderExcalidrawToPreviewPng/);
  assert.match(styles, /\.mobile-pdf-exporter-preview-frame-wrap\s*\{/);
  assert.match(styles, /overflow:\s*auto/);
  assert.match(styles, /touch-action:\s*pan-x pan-y/);
  assert.match(styles, /mobile-pdf-exporter-preview-pdf-text-layer/);
  assert.doesNotMatch(styles, /\.mobile-pdf-exporter-preview-page\s*\{/);
  assert.doesNotMatch(source, /navigator\.share/);
  assert.doesNotMatch(source, /shareAfterExport/);
  assert.doesNotMatch(source, /shareFileIfAvailable/);
  assert.doesNotMatch(source, /cls: "mobile-pdf-exporter-preview-frame"/);
});

test("export panel keeps PDF actions together and reuses a matching preview", async () => {
  const [source, styles] = await Promise.all([
    readFile(sourceUrl, "utf8"),
    readFile(stylesUrl, "utf8")
  ]);

  assert.match(source, /prebuiltBlob\?: Blob/);
  assert.match(source, /format === "pdf" && options\.prebuiltBlob/);
  assert.match(source, /previewSettingsKey === getPdfExportSettingsKey\(exportSettings\)/);
  assert.match(source, /mobile-pdf-exporter-primary-actions/);
  assert.match(source, /mobile-pdf-exporter-more-button/);
  assert.match(source, /mobile-pdf-exporter-more-panel/);
  assert.match(styles, /\.mobile-pdf-exporter-primary-actions\s*\{/);
  assert.match(styles, /\.mobile-pdf-exporter-more-panel\s*\{/);
  assert.match(styles, /position:\s*absolute/);
});

/* quality choices and preview refresh contract */
test("quality choices are unique and enabled previews refresh after export-setting changes", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.equal((source.match(/\.addOption\("4", this\.(?:plugin\.)?t\("imageQualityUltra"\)\)/g) ?? []).length, 0);
  assert.equal((source.match(/\.addOption\("3", this\.(?:plugin\.)?t\("imageQualityUltra"\)\)/g) ?? []).length, 2);
  assert.match(source, /imageRasterScale: clampNumber\(saved\.imageRasterScale, 1, 3/);
  assert.match(source, /private previewRefreshTimer = 0/);
  assert.match(source, /private schedulePreviewRefresh\(\): void/);
  assert.match(source, /activeWindow\.setTimeout/);
  assert.match(source, /this\.previewRefreshTimer = 0;/);
  assert.match(source, /void this\.refreshPdfPreview\(\)/);
  assert.match(source, /this\.previewRefreshTimer/);
  assert.match(source, /this\.draft\.noteExportMode/);
  assert.match(source, /this\.draft\.pagePreset/);
  assert.match(source, /this\.draft\.imageRasterScale/);
  assert.match(source, /context\.imageSmoothingQuality = "high"/);
  assert.match(source, /const SELECTABLE_PREVIEW_BACKGROUND_MAX_SCALE = 4/);
});

test("PptxGenJS is bundled in browser mode for the Electron renderer", async () => {
  const config = await readFile(buildConfigUrl, "utf8");

  assert.match(config, /name: "pptxgen-browser-runtime"/);
  assert.match(config, /const isNode = false;/);
  assert.match(config, /if \(replacements !== 2\)/);
  assert.match(config, /plugins: \[pptxGenBrowserRuntime, safeZipSchedulers, safePdfjsRuntime\]/);
  assert.match(config, /name: "safe-pdfjs-runtime"/);
  assert.match(config, /pdfjs-dist.*legacy.*build/s);
  assert.match(config, /PDF\.js worker global registration/);
  assert.match(config, /var __webpack_exports__ = \{\};/);
});

test("the release bundle contains no dynamic code or script injection", async () => {
  const [config, bundle] = await Promise.all([
    readFile(buildConfigUrl, "utf8"),
    readFile(builtPluginUrl, "utf8")
  ]);

  assert.match(config, /name: "safe-zip-schedulers"/);
  assert.match(config, /sanitizeLegacyZipSchedulers/);
  assert.match(config, /replaceExactly/);
  assert.match(config, /dynamicFunctionCount !== 1 \|\| dynamicScriptCount !== 4/);
  assert.match(config, /still contains dynamic code execution after sanitization/);
  assert.doesNotMatch(bundle, /\beval\s*\(/);
  assert.doesNotMatch(bundle, /new\s+Function\s*\(/);
  assert.doesNotMatch(bundle, /createElement\s*\(\s*["']script["']/);
});
