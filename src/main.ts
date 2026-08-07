import {
  App,
  Component,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
  setIcon
} from "obsidian";
import type { Color, PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import embeddedCjkFontGzipBase64 from "../fonts/NotoSansSC-Regular.gb2312-subset.ttf.gz";
import embeddedLatinFontGzipBase64 from "../fonts/NotoSans-Regular.ttf.gz";
import embeddedArabicFontGzipBase64 from "../fonts/NotoSansArabic-Regular.ttf.gz";
import embeddedHebrewFontGzipBase64 from "../fonts/NotoSansHebrew-Regular.ttf.gz";
import embeddedDevanagariFontGzipBase64 from "../fonts/NotoSansDevanagari-Regular.ttf.gz";
import embeddedThaiFontGzipBase64 from "../fonts/NotoSansThai-Regular.ttf.gz";
import supportCode1Base64 from "./generated/support-code-1.jpg";
import supportCode2Base64 from "./generated/support-code-2.png";

const UI_LANGUAGES = [
  "auto",
  "zh",
  "en",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "ru",
  "pt",
  "it",
  "ar",
  "hi",
  "id",
  "tr",
  "vi",
  "th"
] as const;
type UiLanguage = typeof UI_LANGUAGES[number];
type ResolvedUiLanguage = Exclude<UiLanguage, "auto">;

const UI_LANGUAGE_LABELS: Record<ResolvedUiLanguage, string> = {
  zh: "中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  ru: "Русский",
  pt: "Português",
  it: "Italiano",
  ar: "العربية",
  hi: "हिन्दी",
  id: "Bahasa Indonesia",
  tr: "Türkçe",
  vi: "Tiếng Việt",
  th: "ไทย"
};

const NOTE_PDF_EXPORT_MODES = ["selectable", "image"] as const;
type NotePdfExportMode = typeof NOTE_PDF_EXPORT_MODES[number];

const PDF_PAGE_PRESETS = ["current", "mobile", "a4", "a5", "letter"] as const;
type PdfPagePreset = typeof PDF_PAGE_PRESETS[number];

const EXPORT_FORMATS = ["pdf", "docx", "pptx", "png", "html", "zip"] as const;
type ExportFormat = typeof EXPORT_FORMATS[number];

// Obsidian wikilinks: ![[target#heading|alias]] or [[target]]
const ZIP_WIKILINK_PATTERN = /(!?)\[\[([^\]|#]+)((?:#[^\]|]*)?)((?:\|[^\]]*)?)\]\]/gu;
// Standard Markdown links/embeds: ![alt](target "title") or [text](target)
// Tolerates unencoded spaces and one level of parentheses inside the target,
// which Obsidian accepts even though strict CommonMark does not.
const ZIP_MARKDOWN_LINK_PATTERN =
  /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|(?:[^()\n"]|\([^()\n]*\))*?)((?:\s+(?:"[^"]*"|'[^']*'))?)\s*\)/gu;

function isExternalLinkTarget(target: string): boolean {
  const value = target.trim();
  if (!value) return true;
  if (value.startsWith("#")) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  if (/^(?:data|mailto|tel|obsidian|file|blob|javascript):/i.test(value)) return true;
  return value.startsWith("//");
}

function decodeVaultLinkTarget(target: string): string {
  const trimmed = target.trim();
  const unwrapped = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  try {
    return decodeURIComponent(unwrapped);
  } catch {
    return unwrapped;
  }
}

function stripLinkFragment(target: string): string {
  const hashIndex = target.indexOf("#");
  const base = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  return base.trim();
}

function resolveVaultRelativePath(baseDir: string, target: string): string {
  const segments = target.startsWith("/") ? [] : baseDir.split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/");
}

function encodeMarkdownLinkTarget(target: string): string {
  const encoded = target.replace(/[\s()<>"'`]/gu, (char) => encodeURIComponent(char));
  return encoded;
}

// Inline HTML images, e.g. <img src="https://host/pic.png"> — common in Obsidian notes.
const ZIP_HTML_IMG_PATTERN = /<img\b[^>]*?\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>/giu;

function unwrapHtmlAttributeValue(raw: string): string {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function isRemoteHttpUrl(target: string): boolean {
  const value = target.trim().replace(/^<|>$/gu, "");
  return /^https?:\/\//i.test(value) || value.startsWith("//");
}

function normalizeRemoteUrl(target: string): string {
  const value = target.trim().replace(/^<|>$/gu, "");
  return value.startsWith("//") ? `https:${value}` : value;
}

const REMOTE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "application/pdf": "pdf"
};

const REMOTE_SAFE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "tiff", "tif", "ico", "pdf"
]);

function sanitizeZipFileName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#]+/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s-]+|[.\s-]+$/gu, "")
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/** Derives a stable, filesystem-safe base name + extension for a downloaded remote asset. */
function deriveRemoteAssetName(url: string, contentType: string, index: number): { base: string; extension: string } {
  let pathname = "";
  let hostname = "";
  try {
    const parsed = new URL(normalizeRemoteUrl(url));
    pathname = decodeURIComponent(parsed.pathname);
    hostname = parsed.hostname;
  } catch {
    pathname = normalizeRemoteUrl(url).split(/[?#]/u)[0] ?? "";
  }

  const lastSegment = pathname.split("/").filter(Boolean).pop() ?? "";
  const dotIndex = lastSegment.lastIndexOf(".");
  const rawBase = dotIndex > 0 ? lastSegment.slice(0, dotIndex) : lastSegment;
  const urlExtension = dotIndex > 0 ? lastSegment.slice(dotIndex + 1).toLowerCase() : "";

  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const mimeExtension = REMOTE_MIME_EXTENSIONS[mime] ?? "";

  const extension = REMOTE_SAFE_EXTENSIONS.has(urlExtension)
    ? urlExtension
    : mimeExtension || (urlExtension && /^[a-z0-9]{1,5}$/u.test(urlExtension) ? urlExtension : "png");

  const fallbackBase = hostname ? `${hostname.replace(/^www\./iu, "")}-${index + 1}` : `remote-image-${index + 1}`;
  const base = sanitizeZipFileName(rawBase, sanitizeZipFileName(fallbackBase, `remote-image-${index + 1}`));
  return { base, extension };
}

const PDF_ORIENTATIONS = ["portrait", "landscape"] as const;
type PdfOrientation = typeof PDF_ORIENTATIONS[number];

const PDF_COLOR_MODES = ["color", "grayscale"] as const;
type PdfColorMode = typeof PDF_COLOR_MODES[number];

type ObsidianExportWindow = Window & {
  createEl<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K];
  DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array>;
};

const OUTPUT_LOCATIONS = ["current", "folder"] as const;
type OutputLocation = typeof OUTPUT_LOCATIONS[number];

interface MobilePdfExporterSettings {
  language: UiLanguage;
  outputLocation: OutputLocation;
  outputFolder: string;
  marginMm: number;
  includeTitle: boolean;
  headerText: string;
  footerText: string;
  rememberLastExportOptions: boolean;
  shareAfterExport: boolean;
  openAfterExport: boolean;
  noteExportMode: NotePdfExportMode;
  pagePreset: PdfPagePreset;
  pageOrientation: PdfOrientation;
  colorMode: PdfColorMode;
  contentScalePercent: number;
  imageRasterScale: number;
  currentPageWidthPx: number;
  currentPageHeightPx: number;
  zipEmbedDepth: number;
}

interface RenderedPreview {
  rootEl: HTMLElement;
  pageEl: HTMLElement;
  renderComponent: Component;
}

interface LiveMarkdownSurface {
  rootEl: HTMLElement;
  scrollEl: HTMLElement;
  mode: "source" | "preview" | "generic";
}

interface LivePreviewRendererPosition {
  line?: number;
  col?: number;
  offset?: number;
}

interface LivePreviewRendererSection {
  rendered?: boolean;
  computed?: boolean;
  height?: number;
  shown?: boolean;
  el?: HTMLElement;
  render?: () => void;
  start?: LivePreviewRendererPosition;
  end?: LivePreviewRendererPosition;
}

interface LivePreviewRenderer {
  previewEl?: HTMLElement;
  sizerEl?: HTMLElement;
  sections: LivePreviewRendererSection[];
  topSpace?: number;
  measureSection?: (section: LivePreviewRendererSection) => void;
  updateVirtualDisplay?: (scrollTop?: number) => void;
}

interface CapturedLivePreviewSection {
  fragments: CapturedSurfaceFragments;
  documentLeft: number;
  measuredHeight: number;
}

interface CapturedSurfaceFragments {
  boxFragments: BoxFragment[];
  textFragments: TextFragment[];
  imageFragments: ImageFragment[];
  videoFragments: VideoFragment[];
  canvasFragments: CanvasFragment[];
  linkFragments: LinkFragment[];
  svgFragments: SvgFragment[];
  decorationFragments: DecorationFragment[];
  keepBlocks: KeepBlockFragment[];
}

interface ExportFileOptions {
  outputBaseName?: string;
  busyPrompt?: PdfExportBusyPrompt;
  signal?: AbortSignal;
  format?: ExportFormat;
  noteDrawSourcePath?: string;
  zipEmbedDepth?: number;
}

interface PdfLinkContext {
  app: App;
  sourcePath: string;
  vaultName: string;
}

interface TextFragment {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  fontSizePx: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  direction: "ltr" | "rtl";
  color: Color;
  underline: boolean;
  lineThrough: boolean;
  href: string | null;
  headingLevel?: number;
  officeDecoration?: boolean;
  mergeScope: Element;
}

interface TextLineDraft {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  fontSizePx: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  direction: "ltr" | "rtl";
  color: Color;
  underline: boolean;
  lineThrough: boolean;
  href: string | null;
  headingLevel?: number;
  mergeScope: Element;
}

interface ImageFragment {
  element: HTMLImageElement;
  sourcePath: string | null;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface VideoFragment {
  element: HTMLVideoElement;
  sourcePath: string | null;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface CanvasFragment {
  element: HTMLCanvasElement;
  sourceLeftPx: number;
  sourceTopPx: number;
  sourceRightPx: number;
  sourceBottomPx: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface LinkFragment {
  href: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface CssBorderFragment {
  color: string;
  widthPx: number;
}

interface BoxFragment {
  left: number;
  top: number;
  right: number;
  bottom: number;
  background: string | null;
  borderTop: CssBorderFragment | null;
  borderRight: CssBorderFragment | null;
  borderBottom: CssBorderFragment | null;
  borderLeft: CssBorderFragment | null;
  borderRadiusPx: number;
  keepTogether: boolean;
}

interface SvgFragment {
  element: SVGSVGElement;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type DecorationKind = "checkbox" | "bullet" | "marker" | "text";

interface DecorationFragment {
  kind: DecorationKind;
  left: number;
  top: number;
  right: number;
  bottom: number;
  color: Color;
  border: Color | null;
  background?: Color | null;
  borderWidthPx?: number;
  borderRadiusPx?: number;
  checked?: boolean;
  text?: string;
  fontSizePx: number;
}

interface KeepBlockFragment {
  left: number;
  top: number;
  right: number;
  bottom: number;
  priority: number;
}

interface PdfPageSizeMm {
  width: number;
  height: number;
}

interface PreviewPdfModel {
  ownerDocument: Document;
  pageWidthPt: number;
  pageHeightPt: number;
  sourceWidthPx: number;
  pxToPt: number;
  pageHeightPx: number;
  bodyTopInsetPx: number;
  bodyBottomInsetPx: number;
  bodyHeightPx: number;
  horizontalInsetPx: number;
  background: Color;
  foreground: Color;
  boxFragments: BoxFragment[];
  textFragments: TextFragment[];
  imageFragments: ImageFragment[];
  videoFragments: VideoFragment[];
  canvasFragments: CanvasFragment[];
  linkFragments: LinkFragment[];
  svgFragments: SvgFragment[];
  decorationFragments: DecorationFragment[];
  keepBlocks: KeepBlockFragment[];
  contentHeightPx: number;
  pageBreaks: number[];
  title: string;
  headerText: string;
  footerText: string;
  exportDate: string;
  noteDrawInkStrokes?: PdfInkStroke[];
  noteDrawElements?: PdfNoteDrawElement[];
  noteDrawSourceElements?: PdfNoteDrawElement[];
}

interface ExcalidrawAutomateRuntime {
  getAPI?: () => ExcalidrawAutomateRuntime;
  reset?: () => void;
  destroy?: () => void;
  createSVG?: (
    templatePath?: string,
    embedFont?: boolean,
    exportSettings?: unknown,
    loader?: unknown,
    theme?: string,
    padding?: number,
    convertMarkdownLinksToObsidianURLs?: boolean,
    includeInternalLinks?: boolean
  ) => Promise<SVGSVGElement>;
  createPNG?: (
    templatePath?: string,
    scale?: number,
    exportSettings?: unknown,
    loader?: unknown,
    theme?: string,
    padding?: number
  ) => Promise<Blob>;
  getExportSettings?: (withBackground: boolean, withTheme: boolean, isMask?: boolean) => unknown;
  getEmbeddedFilesLoader?: (isDark?: boolean) => unknown;
}

interface ExcalidrawAutomateLease {
  api: ExcalidrawAutomateRuntime;
  destroyAfterUse: boolean;
}

interface NoteDoodlePoint {
  x: number;
  y: number;
  t: number;
  anchor: {
    basis: "note-content-v1";
    x: number;
    y: number;
  } | null;
}

interface NoteDoodleStroke {
  brush: "pen" | "watercolor";
  color: string;
  width: number;
  opacity: number;
  count: number;
  points: NoteDoodlePoint[];
}

interface NoteDoodleData {
  version: number;
  sourcePath: string;
  strokes: NoteDoodleStroke[];
  updatedAt: string | null;
}

interface PdfInkStroke {
  brush: "pen" | "watercolor";
  color: string;
  widthPx: number;
  opacity: number;
  count: number;
  points: Array<{ x: number; y: number }>;
}

interface PreparedNoteDrawExportOverlay {
  cleanup: () => void;
  data: NoteDoodleData | null;
  elements: NoteDrawElementData[];
  sourceElements: NoteDrawElementData[];
  widthPx: number;
  heightPx: number;
  contentFrame: NoteDrawContentFrame;
}

interface NoteDrawContentFrame {
  left: number;
  width: number;
}

type NoteDrawElementKind = "text" | "image" | "video" | "file" | "connector";

interface NoteDrawElementData {
  kind: NoteDrawElementKind;
  text: string;
  color: string;
  opacity: number;
  width: number;
  fontSize: number;
  bold: boolean;
  code: boolean;
  boxed: boolean;
  buttonStyle: string;
  render: string;
  assetPath: string;
  assetName: string;
  assetMime: string;
  assetSize: number;
  previewWidth: number;
  previewHeight: number;
  textWidth: number | null;
  points: Array<{ x: number; y: number }>;
  layoutBox: { x: number; y: number; width: number; height: number } | null;
  layoutFrame: {
    surfaceWidth: number;
    contentLeft: number;
    contentWidth: number;
    documentHeight: number;
  } | null;
  media: HTMLImageElement | HTMLCanvasElement | null;
}

interface PdfNoteDrawElement extends Omit<NoteDrawElementData, "points" | "layoutBox" | "layoutFrame"> {
  left: number;
  top: number;
  right: number;
  bottom: number;
  points: Array<{ x: number; y: number }>;
}

interface NoteDoodleOverlaySource {
  data: NoteDoodleData | null;
  canvas: HTMLCanvasElement | null;
  surface: HTMLElement;
  kind: "note-doodle" | "notedraw";
  score: number;
}

interface LiveDrawingController {
  file?: TFile;
  doodleData?: unknown;
  drawingData?: unknown;
  canvas?: HTMLCanvasElement | null;
  render?: () => void;
  active?: boolean;
  surfaceType?: string;
}

interface NoteDrawApiRuntime {
  readDrawings?: (fileOrPath: TFile | string) => Promise<unknown>;
  injectExportSnapshot?: (fileOrPath: TFile | string, container: HTMLElement) => Promise<HTMLElement | null>;
}

const UI_TEXT = {
  zh: {
    ribbonTitle: "导出预览版 PDF",
    commandName: "Mobile PDF Exporter: 导出当前笔记为预览版 PDF",
    noMarkdownNotice: "先打开一个可导出的文件。",
    optionsTitle: "PDF 导出选项",
    exportModeName: "导出方式",
    exportModeDesc: "可复制文字版适合阅读、检索、复制；图片版适合保持视觉固定。",
    exportModeSelectable: "可复制文字版",
    exportModeImage: "图片版",
    pageSizeName: "页面大小",
    pageSizeCurrent: "当前页面大小（默认）",
    pageSizeMobile: "手机长页 104 x 225 mm",
    orientationName: "方向",
    orientationPortrait: "竖向",
    orientationLandscape: "横向",
    colorName: "色彩",
    colorOption: "彩色",
    grayscaleOption: "灰度",
    marginName: "页边距",
    contentScaleName: "内容缩放",
    imageQualityName: "图片版清晰度",
    imageQualityDesc: "只影响图片版普通笔记 PDF；越高清文件越大。",
    imageQualityStandard: "标准 / 小文件",
    imageQualityClear: "清晰 / 推荐",
    imageQualityHigh: "高清",
    imageQualityUltra: "超清 / 大文件",
    includeTitleName: "包含笔记标题",
    headerTextName: "页眉",
    headerTextDesc: "留空关闭；支持 {title}、{page}、{pages}、{date}。",
    footerTextName: "页脚",
    footerTextDesc: "留空关闭；支持 {title}、{page}、{pages}、{date}。",
    openAfterExportName: "导出后打开",
    openAfterExportDesc: "导出完成后自动打开生成的文件。",
    shareAfterExportName: "导出后分享",
    rememberLastExportOptionsName: "使用上次导出选项",
    rememberLastExportOptionsDesc: "默认开启。每次成功开始导出时保存本次选项，供下次直接使用。",
    outputLocationName: "导出位置",
    outputLocationCurrent: "当前笔记文件夹（默认）",
    outputLocationFolder: "指定文件夹",
    outputLocationCurrentDesc: "PDF 保存到当前笔记所在文件夹。",
    outputLocationFolderDesc: "PDF 保存到库内指定文件夹；不存在时自动创建。",
    outputFolderPlaceholder: "PDF Exports",
    pdfNameLabel: "PDF 名称",
    exportPdfButton: "导出 PDF",
    cancelButton: "导出其他格式",
    busyExporting: "正在导出 PDF",
    busyCancelButton: "取消导出",
    busyCancelledTitle: "已取消导出",
    busyCancelledStatus: "未保存 PDF。",
    busyCompleteTitle: "导出完成",
    busyCompleteStatus: "完成",
    busyFailedTitle: "PDF 导出失败",
    busyElapsedShort: "已用 {seconds} 秒",
    busyElapsedLong: "已用 {seconds} 秒，仍在处理，请不要关闭 Obsidian。",
    settingsIntro: "菜单和按钮会先打开 PDF 导出选项；普通 Markdown 笔记可选择可复制文字版或图片版。",
    settingsGeneralHeading: "通用",
    settingsNoteOptionsHeading: "普通笔记 PDF 选项",
    pageSizeDesc: "手机长页适合手机阅读；A4/A5/Letter 适合打印和归档。",
    orientationDesc: "横向会交换页面宽高。",
    colorDesc: "灰度适合打印、减小颜色干扰；彩色会保留主题色、链接色和图片颜色。",
    settingsSaveAndShareHeading: "保存和分享",
    languageName: "界面语言",
    languageDesc: "Auto 会跟随 Obsidian 语言；导出按钮、菜单、命令、选项面板和提示会使用所选语言。",
    languageAuto: "Auto / 跟随 Obsidian",
    languageChinese: "中文",
    languageEnglish: "English",
    formatPngLabel: "PNG 图片",
    codesTitle: "给我买咖啡",
    codesSubtitle: "如果这个插件帮到你，可以扫码打赏支持继续维护。",
    shareFailedNotice: "PDF 已保存，但系统分享面板没有打开。",
    fontMissingError: "缺少 PDF 中文字体，且无法从 GitHub 下载字体。请联网后重试，或把 NotoSansSC-Regular.gb2312-subset.ttf 放入插件目录的 fonts 文件夹。",
    uniqueFileNameError: "无法生成唯一 PDF 文件名。",
    excalidrawApiMissingError: "没有找到 Excalidraw 导出接口，请确认 Excalidraw 插件已启用。",
    excalidrawExportFailedError: "Excalidraw 图片过大或导出失败，已尝试降低分辨率和分页切片。",
    excalidrawPngNoImageError: "PNG {scale}x 没有返回图片。",
    lastErrorLabel: "最后错误：{error}",
    noUsableImageError: "未能取得可用图片。",
    excalidrawPreviewUnavailable: "Excalidraw 预览暂不可用，已跳过源码数据。",
    previewNoExportSizeError: "预览层没有可导出的尺寸。",
    previewNoContentError: "预览没有可导出的内容。",
    pdfRuntimeMissingError: "PDF 引擎尚未加载。",
    fontkitMissingError: "PDF 字体组件初始化失败：fontkit.create 不存在。",
    imagePdfCanvasError: "图片版 PDF 渲染失败：canvas 不可用。",
    imageSliceError: "图片切片失败：canvas 不可用。"
  },
  en: {
    ribbonTitle: "Export preview PDF",
    commandName: "Mobile PDF Exporter: Export preview PDF",
    noMarkdownNotice: "Open an exportable file first.",
    optionsTitle: "PDF export options",
    exportModeName: "Export mode",
    exportModeDesc: "Selectable text is best for reading, search, and copy; image PDF keeps a fixed visual layout.",
    exportModeSelectable: "Selectable text",
    exportModeImage: "Image PDF",
    pageSizeName: "Page size",
    pageSizeCurrent: "Current page size (default)",
    pageSizeMobile: "Mobile long page 104 x 225 mm",
    orientationName: "Orientation",
    orientationPortrait: "Portrait",
    orientationLandscape: "Landscape",
    colorName: "Color",
    colorOption: "Color",
    grayscaleOption: "Grayscale",
    marginName: "Margin",
    contentScaleName: "Content scale",
    imageQualityName: "Image PDF quality",
    imageQualityDesc: "Only affects ordinary-note image PDFs. Higher quality creates larger files.",
    imageQualityStandard: "Standard / smaller file",
    imageQualityClear: "Clear / recommended",
    imageQualityHigh: "High",
    imageQualityUltra: "Ultra / large file",
    includeTitleName: "Include note title",
    headerTextName: "Header",
    headerTextDesc: "Leave blank to disable. Supports {title}, {page}, {pages}, and {date}.",
    footerTextName: "Footer",
    footerTextDesc: "Leave blank to disable. Supports {title}, {page}, {pages}, and {date}.",
    openAfterExportName: "Open after export",
    openAfterExportDesc: "Open the generated file when export finishes.",
    shareAfterExportName: "Show mobile share sheet",
    rememberLastExportOptionsName: "Use last export options",
    rememberLastExportOptionsDesc: "Enabled by default. Saves the options used for this export for next time.",
    outputLocationName: "Export location",
    outputLocationCurrent: "Current note folder (default)",
    outputLocationFolder: "Custom folder",
    outputLocationCurrentDesc: "Save the PDF beside the current note.",
    outputLocationFolderDesc: "Save the PDF to a custom vault folder, creating it when needed.",
    outputFolderPlaceholder: "PDF Exports",
    pdfNameLabel: "PDF name",
    exportPdfButton: "Export PDF",
    cancelButton: "Other formats",
    busyExporting: "Exporting PDF",
    busyCancelButton: "Cancel export",
    busyCancelledTitle: "Export cancelled",
    busyCancelledStatus: "No PDF was saved.",
    busyCompleteTitle: "Export complete",
    busyCompleteStatus: "Done",
    busyFailedTitle: "PDF export failed",
    busyElapsedShort: "{seconds}s elapsed",
    busyElapsedLong: "{seconds}s elapsed. Still working; do not close Obsidian.",
    settingsIntro: "Menus and buttons open the PDF export options first. Ordinary Markdown notes can export as selectable-text PDFs or image PDFs.",
    settingsGeneralHeading: "General",
    settingsNoteOptionsHeading: "Ordinary note PDF options",
    pageSizeDesc: "Mobile long page is good for phone reading. A4/A5/Letter are useful for printing and archiving.",
    orientationDesc: "Landscape swaps the page width and height.",
    colorDesc: "Grayscale is useful for printing; color keeps theme colors, link colors, and image colors.",
    settingsSaveAndShareHeading: "Save and share",
    languageName: "Interface language",
    languageDesc: "Auto follows Obsidian's language. Export buttons, menus, commands, options, and prompts use the selected language.",
    languageAuto: "Auto / follow Obsidian",
    languageChinese: "Chinese",
    languageEnglish: "English",
    formatPngLabel: "PNG image",
    codesTitle: "Buy me a coffee",
    codesSubtitle: "If this tool helps, tips are appreciated and support ongoing maintenance.",
    shareFailedNotice: "The PDF was saved, but the system share sheet did not open.",
    fontMissingError: "Missing PDF font, and the plugin could not download it from GitHub. Try again online, or place NotoSansSC-Regular.gb2312-subset.ttf in the plugin fonts folder.",
    uniqueFileNameError: "Could not generate a unique PDF filename.",
    excalidrawApiMissingError: "Excalidraw export API was not found. Make sure the Excalidraw plugin is enabled.",
    excalidrawExportFailedError: "The Excalidraw image was too large or export failed. Lower resolutions and page slicing were already tried.",
    excalidrawPngNoImageError: "PNG {scale}x returned no image.",
    lastErrorLabel: "Last error: {error}",
    noUsableImageError: "No usable image was produced.",
    excalidrawPreviewUnavailable: "Excalidraw preview is unavailable, so source data was skipped.",
    previewNoExportSizeError: "The preview layer has no exportable size.",
    previewNoContentError: "The preview has no exportable content.",
    pdfRuntimeMissingError: "The PDF engine has not loaded.",
    fontkitMissingError: "PDF font initialization failed because fontkit.create is unavailable.",
    imagePdfCanvasError: "Image PDF rendering failed because canvas is unavailable.",
    imageSliceError: "Image slicing failed because canvas is unavailable."
  },
  ja: {
    ribbonTitle: "PDFプレビューを書き出す",
    commandName: "Mobile PDF Exporter: 現在のファイルをPDFプレビューとして書き出す",
    noMarkdownNotice: "書き出せるファイルを先に開いてください。",
    optionsTitle: "PDF書き出しオプション",
    exportModeName: "書き出しモード",
    exportModeDesc: "選択可能なテキストは閲覧・検索・コピー向け、画像PDFは見た目を固定します。",
    exportModeSelectable: "選択可能なテキスト",
    exportModeImage: "画像PDF",
    pageSizeName: "ページサイズ",
    pageSizeCurrent: "現在のページサイズ（既定）",
    pageSizeMobile: "モバイル長ページ 104 x 225 mm",
    orientationName: "向き",
    orientationPortrait: "縦",
    orientationLandscape: "横",
    colorName: "カラー",
    colorOption: "カラー",
    grayscaleOption: "グレースケール",
    marginName: "余白",
    contentScaleName: "コンテンツ倍率",
    imageQualityName: "画像PDFの品質",
    imageQualityDesc: "通常ノートの画像PDFにのみ影響します。高品質ほどファイルが大きくなります。",
    imageQualityStandard: "標準 / 小さいファイル",
    imageQualityClear: "鮮明 / 推奨",
    imageQualityHigh: "高品質",
    imageQualityUltra: "最高品質 / 大きいファイル",
    includeTitleName: "ノートタイトルを含める",
    headerTextName: "ヘッダー",
    headerTextDesc: "空欄で無効。{title}、{page}、{pages}、{date} を使用できます。",
    footerTextName: "フッター",
    footerTextDesc: "空欄で無効。{title}、{page}、{pages}、{date} を使用できます。",
    openAfterExportName: "書き出し後に開く",
    openAfterExportDesc: "書き出し完了後に生成ファイルを開きます。",
    shareAfterExportName: "書き出し後に共有",
    rememberLastExportOptionsName: "前回の書き出し設定を使用",
    rememberLastExportOptionsDesc: "既定で有効。今回の設定を次回用に保存します。",
    outputLocationName: "保存先",
    outputLocationCurrent: "現在のノートのフォルダー（既定）",
    outputLocationFolder: "指定フォルダー",
    outputLocationCurrentDesc: "PDFを現在のノートと同じフォルダーに保存します。",
    outputLocationFolderDesc: "PDFを指定したVault内フォルダーに保存し、必要なら作成します。",
    outputFolderPlaceholder: "PDF Exports",
    pdfNameLabel: "PDF名",
    exportPdfButton: "PDFを書き出す",
    cancelButton: "他の形式",
    busyExporting: "PDFを書き出しています",
    busyCancelButton: "書き出しをキャンセル",
    busyCancelledTitle: "書き出しをキャンセルしました",
    busyCancelledStatus: "PDFは保存されませんでした。",
    busyCompleteTitle: "書き出し完了",
    busyCompleteStatus: "完了",
    busyFailedTitle: "PDFの書き出しに失敗しました",
    busyElapsedShort: "{seconds}秒経過",
    busyElapsedLong: "{seconds}秒経過。処理中のためObsidianを閉じないでください。",
    settingsIntro: "メニューとボタンは最初にPDF書き出しオプションを開きます。通常のMarkdownノートはテキストPDFまたは画像PDFにできます。",
    settingsGeneralHeading: "一般",
    settingsNoteOptionsHeading: "通常ノートのPDFオプション",
    pageSizeDesc: "モバイル長ページはスマートフォン向け、A4/A5/Letterは印刷と保管向けです。",
    orientationDesc: "横向きではページの幅と高さを入れ替えます。",
    colorDesc: "グレースケールは印刷向け、カラーはテーマ・リンク・画像の色を保持します。",
    settingsSaveAndShareHeading: "保存と共有",
    languageName: "表示言語",
    languageDesc: "自動ではObsidianの言語に従います。ボタン、メニュー、コマンド、オプション、通知に選択言語を使います。",
    languageAuto: "自動 / Obsidianに従う",
    languageChinese: "中国語",
    languageEnglish: "英語",
    formatPngLabel: "PNG画像",
    codesTitle: "コーヒーをおごる",
    codesSubtitle: "このツールが役立った場合、継続的なメンテナンスへの支援を歓迎します。",
    shareFailedNotice: "PDFは保存されましたが、システムの共有画面を開けませんでした。",
    fontMissingError: "PDFフォントがなく、GitHubからも取得できませんでした。オンラインで再試行するか、NotoSansSC-Regular.gb2312-subset.ttf をプラグインのfontsフォルダーに置いてください。",
    uniqueFileNameError: "一意のPDFファイル名を生成できませんでした。",
    excalidrawApiMissingError: "Excalidrawの書き出しAPIが見つかりません。Excalidrawプラグインが有効か確認してください。",
    excalidrawExportFailedError: "Excalidraw画像が大きすぎるか書き出しに失敗しました。低解像度とページ分割も試行済みです。",
    excalidrawPngNoImageError: "PNG {scale}x から画像が返されませんでした。",
    lastErrorLabel: "最後のエラー: {error}",
    noUsableImageError: "使用できる画像を生成できませんでした。",
    excalidrawPreviewUnavailable: "Excalidrawプレビューを利用できないため、ソースデータを省略しました。",
    previewNoExportSizeError: "プレビュー層に書き出せるサイズがありません。",
    previewNoContentError: "プレビューに書き出せる内容がありません。",
    pdfRuntimeMissingError: "PDFエンジンが読み込まれていません。",
    fontkitMissingError: "fontkit.createを利用できないため、PDFフォントの初期化に失敗しました。",
    imagePdfCanvasError: "canvasを利用できないため、画像PDFの描画に失敗しました。",
    imageSliceError: "canvasを利用できないため、画像の分割に失敗しました。"
  },
  ko: {
    ribbonTitle: "미리보기 PDF 내보내기",
    commandName: "Mobile PDF Exporter: 현재 파일을 미리보기 PDF로 내보내기",
    noMarkdownNotice: "먼저 내보낼 수 있는 파일을 여세요.",
    optionsTitle: "PDF 내보내기 옵션",
    exportModeName: "내보내기 모드",
    exportModeDesc: "선택 가능한 텍스트는 읽기, 검색, 복사에 적합하고 이미지 PDF는 화면 배치를 고정합니다.",
    exportModeSelectable: "선택 가능한 텍스트",
    exportModeImage: "이미지 PDF",
    pageSizeName: "페이지 크기",
    pageSizeCurrent: "현재 페이지 크기(기본값)",
    pageSizeMobile: "모바일 긴 페이지 104 x 225 mm",
    orientationName: "방향",
    orientationPortrait: "세로",
    orientationLandscape: "가로",
    colorName: "색상",
    colorOption: "컬러",
    grayscaleOption: "회색조",
    marginName: "여백",
    contentScaleName: "콘텐츠 배율",
    imageQualityName: "이미지 PDF 품질",
    imageQualityDesc: "일반 노트의 이미지 PDF에만 적용됩니다. 품질이 높을수록 파일이 커집니다.",
    imageQualityStandard: "표준 / 작은 파일",
    imageQualityClear: "선명 / 권장",
    imageQualityHigh: "고품질",
    imageQualityUltra: "최고 품질 / 큰 파일",
    includeTitleName: "노트 제목 포함",
    headerTextName: "머리글",
    headerTextDesc: "비워 두면 꺼집니다. {title}, {page}, {pages}, {date}를 지원합니다.",
    footerTextName: "바닥글",
    footerTextDesc: "비워 두면 꺼집니다. {title}, {page}, {pages}, {date}를 지원합니다.",
    openAfterExportName: "내보낸 뒤 열기",
    openAfterExportDesc: "내보내기가 끝나면 생성된 파일을 엽니다.",
    shareAfterExportName: "내보낸 뒤 공유",
    rememberLastExportOptionsName: "마지막 내보내기 옵션 사용",
    rememberLastExportOptionsDesc: "기본적으로 켜집니다. 이번 옵션을 다음 내보내기에 사용하도록 저장합니다.",
    outputLocationName: "저장 위치",
    outputLocationCurrent: "현재 노트 폴더(기본값)",
    outputLocationFolder: "사용자 지정 폴더",
    outputLocationCurrentDesc: "PDF를 현재 노트와 같은 폴더에 저장합니다.",
    outputLocationFolderDesc: "PDF를 지정한 Vault 폴더에 저장하고 필요하면 폴더를 만듭니다.",
    outputFolderPlaceholder: "PDF Exports",
    pdfNameLabel: "PDF 이름",
    exportPdfButton: "PDF 내보내기",
    cancelButton: "다른 형식",
    busyExporting: "PDF 내보내는 중",
    busyCancelButton: "내보내기 취소",
    busyCancelledTitle: "내보내기 취소됨",
    busyCancelledStatus: "PDF가 저장되지 않았습니다.",
    busyCompleteTitle: "내보내기 완료",
    busyCompleteStatus: "완료",
    busyFailedTitle: "PDF 내보내기 실패",
    busyElapsedShort: "{seconds}초 경과",
    busyElapsedLong: "{seconds}초 경과. 처리 중이므로 Obsidian을 닫지 마세요.",
    settingsIntro: "메뉴와 버튼은 먼저 PDF 내보내기 옵션을 엽니다. 일반 Markdown 노트는 텍스트 PDF 또는 이미지 PDF로 내보낼 수 있습니다.",
    settingsGeneralHeading: "일반",
    settingsNoteOptionsHeading: "일반 노트 PDF 옵션",
    pageSizeDesc: "모바일 긴 페이지는 휴대폰 읽기에, A4/A5/Letter는 인쇄와 보관에 적합합니다.",
    orientationDesc: "가로 방향은 페이지 너비와 높이를 바꿉니다.",
    colorDesc: "회색조는 인쇄에 적합하고 컬러는 테마, 링크, 이미지 색상을 유지합니다.",
    settingsSaveAndShareHeading: "저장 및 공유",
    languageName: "인터페이스 언어",
    languageDesc: "자동은 Obsidian 언어를 따릅니다. 버튼, 메뉴, 명령, 옵션, 알림에 선택한 언어를 사용합니다.",
    languageAuto: "자동 / Obsidian 언어 따르기",
    languageChinese: "중국어",
    languageEnglish: "영어",
    formatPngLabel: "PNG 이미지",
    codesTitle: "커피 한 잔 후원",
    codesSubtitle: "이 도구가 유용했다면 지속적인 유지 관리를 위한 후원을 환영합니다.",
    shareFailedNotice: "PDF는 저장되었지만 시스템 공유 창을 열지 못했습니다.",
    fontMissingError: "PDF 글꼴이 없고 GitHub에서도 내려받지 못했습니다. 온라인에서 다시 시도하거나 NotoSansSC-Regular.gb2312-subset.ttf를 플러그인의 fonts 폴더에 넣으세요.",
    uniqueFileNameError: "고유한 PDF 파일 이름을 만들 수 없습니다.",
    excalidrawApiMissingError: "Excalidraw 내보내기 API를 찾지 못했습니다. Excalidraw 플러그인이 켜져 있는지 확인하세요.",
    excalidrawExportFailedError: "Excalidraw 이미지가 너무 크거나 내보내기에 실패했습니다. 낮은 해상도와 페이지 분할도 시도했습니다.",
    excalidrawPngNoImageError: "PNG {scale}x에서 이미지가 반환되지 않았습니다.",
    lastErrorLabel: "마지막 오류: {error}",
    noUsableImageError: "사용 가능한 이미지를 만들지 못했습니다.",
    excalidrawPreviewUnavailable: "Excalidraw 미리보기를 사용할 수 없어 원본 데이터를 건너뛰었습니다.",
    previewNoExportSizeError: "미리보기 레이어에 내보낼 수 있는 크기가 없습니다.",
    previewNoContentError: "미리보기에 내보낼 수 있는 내용이 없습니다.",
    pdfRuntimeMissingError: "PDF 엔진이 로드되지 않았습니다.",
    fontkitMissingError: "fontkit.create를 사용할 수 없어 PDF 글꼴 초기화에 실패했습니다.",
    imagePdfCanvasError: "canvas를 사용할 수 없어 이미지 PDF 렌더링에 실패했습니다.",
    imageSliceError: "canvas를 사용할 수 없어 이미지 분할에 실패했습니다."
  },
  es: {
    ribbonTitle: "Exportar PDF de vista previa",
    commandName: "Mobile PDF Exporter: Exportar el archivo actual como PDF de vista previa",
    noMarkdownNotice: "Abre primero un archivo que se pueda exportar.",
    optionsTitle: "Opciones de exportación a PDF",
    exportModeName: "Modo de exportación",
    exportModeDesc: "El texto seleccionable facilita la lectura, búsqueda y copia; el PDF de imagen conserva un diseño visual fijo.",
    exportModeSelectable: "Texto seleccionable",
    exportModeImage: "PDF de imagen",
    pageSizeName: "Tamaño de página",
    pageSizeCurrent: "Tamaño de página actual (predeterminado)",
    pageSizeMobile: "Página móvil larga 104 x 225 mm",
    orientationName: "Orientación",
    orientationPortrait: "Vertical",
    orientationLandscape: "Horizontal",
    colorName: "Color",
    colorOption: "Color",
    grayscaleOption: "Escala de grises",
    marginName: "Margen",
    contentScaleName: "Escala del contenido",
    imageQualityName: "Calidad del PDF de imagen",
    imageQualityDesc: "Solo afecta a los PDF de imagen de notas normales. Una calidad mayor crea archivos más grandes.",
    imageQualityStandard: "Estándar / archivo pequeño",
    imageQualityClear: "Nítida / recomendada",
    imageQualityHigh: "Alta",
    imageQualityUltra: "Ultra / archivo grande",
    includeTitleName: "Incluir el título de la nota",
    headerTextName: "Encabezado",
    headerTextDesc: "Déjalo vacío para desactivarlo. Admite {title}, {page}, {pages} y {date}.",
    footerTextName: "Pie de página",
    footerTextDesc: "Déjalo vacío para desactivarlo. Admite {title}, {page}, {pages} y {date}.",
    openAfterExportName: "Abrir después de exportar",
    openAfterExportDesc: "Abre el archivo generado cuando termina la exportación.",
    shareAfterExportName: "Compartir después de exportar",
    rememberLastExportOptionsName: "Usar las últimas opciones",
    rememberLastExportOptionsDesc: "Activado de forma predeterminada. Guarda estas opciones para la próxima exportación.",
    outputLocationName: "Ubicación de exportación",
    outputLocationCurrent: "Carpeta de la nota actual (predeterminada)",
    outputLocationFolder: "Carpeta personalizada",
    outputLocationCurrentDesc: "Guarda el PDF junto a la nota actual.",
    outputLocationFolderDesc: "Guarda el PDF en una carpeta del Vault y la crea cuando sea necesario.",
    outputFolderPlaceholder: "PDF Exports",
    pdfNameLabel: "Nombre del PDF",
    exportPdfButton: "Exportar PDF",
    cancelButton: "Otros formatos",
    busyExporting: "Exportando PDF",
    busyCancelButton: "Cancelar exportación",
    busyCancelledTitle: "Exportación cancelada",
    busyCancelledStatus: "No se guardó ningún PDF.",
    busyCompleteTitle: "Exportación completada",
    busyCompleteStatus: "Completado",
    busyFailedTitle: "Error al exportar el PDF",
    busyElapsedShort: "Han transcurrido {seconds} s",
    busyElapsedLong: "Han transcurrido {seconds} s. El proceso continúa; no cierres Obsidian.",
    settingsIntro: "Los menús y botones abren primero las opciones de PDF. Las notas Markdown normales pueden exportarse con texto seleccionable o como imagen.",
    settingsGeneralHeading: "General",
    settingsNoteOptionsHeading: "Opciones PDF para notas normales",
    pageSizeDesc: "La página móvil larga es adecuada para teléfonos; A4/A5/Letter sirven para imprimir y archivar.",
    orientationDesc: "La orientación horizontal intercambia el ancho y el alto.",
    colorDesc: "La escala de grises es útil para imprimir; el color conserva los colores del tema, enlaces e imágenes.",
    settingsSaveAndShareHeading: "Guardar y compartir",
    languageName: "Idioma de la interfaz",
    languageDesc: "Automático sigue el idioma de Obsidian. Los botones, menús, comandos, opciones y avisos usan el idioma elegido.",
    languageAuto: "Automático / seguir Obsidian",
    languageChinese: "Chino",
    languageEnglish: "Inglés",
    formatPngLabel: "Imagen PNG",
    codesTitle: "Invítame a un café",
    codesSubtitle: "Si esta herramienta te ayuda, puedes apoyar su mantenimiento continuo.",
    shareFailedNotice: "El PDF se guardó, pero no se abrió el panel de compartir del sistema.",
    fontMissingError: "Falta la fuente PDF y no pudo descargarse de GitHub. Reinténtalo con conexión o coloca NotoSansSC-Regular.gb2312-subset.ttf en la carpeta fonts del complemento.",
    uniqueFileNameError: "No se pudo generar un nombre de PDF único.",
    excalidrawApiMissingError: "No se encontró la API de exportación de Excalidraw. Comprueba que el complemento Excalidraw esté activado.",
    excalidrawExportFailedError: "La imagen de Excalidraw era demasiado grande o la exportación falló. Ya se probaron resoluciones menores y división por páginas.",
    excalidrawPngNoImageError: "PNG {scale}x no devolvió ninguna imagen.",
    lastErrorLabel: "Último error: {error}",
    noUsableImageError: "No se produjo ninguna imagen utilizable.",
    excalidrawPreviewUnavailable: "La vista previa de Excalidraw no está disponible; se omitieron los datos fuente.",
    previewNoExportSizeError: "La capa de vista previa no tiene un tamaño exportable.",
    previewNoContentError: "La vista previa no tiene contenido exportable.",
    pdfRuntimeMissingError: "El motor PDF aún no se ha cargado.",
    fontkitMissingError: "No se pudo iniciar la fuente PDF porque fontkit.create no está disponible.",
    imagePdfCanvasError: "No se pudo renderizar el PDF de imagen porque canvas no está disponible.",
    imageSliceError: "No se pudo dividir la imagen porque canvas no está disponible."
  },
  fr: {
    ribbonTitle: "Exporter le PDF d’aperçu",
    commandName: "Mobile PDF Exporter : Exporter le fichier actuel en PDF d’aperçu",
    noMarkdownNotice: "Ouvrez d’abord un fichier exportable.",
    optionsTitle: "Options d’export PDF",
    exportModeName: "Mode d’export",
    exportModeDesc: "Le texte sélectionnable convient à la lecture, la recherche et la copie ; le PDF image conserve une mise en page fixe.",
    exportModeSelectable: "Texte sélectionnable",
    exportModeImage: "PDF image",
    pageSizeName: "Taille de page",
    pageSizeCurrent: "Taille de page actuelle (par défaut)",
    pageSizeMobile: "Page mobile longue 104 x 225 mm",
    orientationName: "Orientation",
    orientationPortrait: "Portrait",
    orientationLandscape: "Paysage",
    colorName: "Couleur",
    colorOption: "Couleur",
    grayscaleOption: "Niveaux de gris",
    marginName: "Marge",
    contentScaleName: "Échelle du contenu",
    imageQualityName: "Qualité du PDF image",
    imageQualityDesc: "Concerne uniquement les PDF image des notes ordinaires. Une qualité supérieure produit un fichier plus volumineux.",
    imageQualityStandard: "Standard / petit fichier",
    imageQualityClear: "Nette / recommandée",
    imageQualityHigh: "Élevée",
    imageQualityUltra: "Ultra / gros fichier",
    includeTitleName: "Inclure le titre de la note",
    headerTextName: "En-tête",
    headerTextDesc: "Laissez vide pour désactiver. Accepte {title}, {page}, {pages} et {date}.",
    footerTextName: "Pied de page",
    footerTextDesc: "Laissez vide pour désactiver. Accepte {title}, {page}, {pages} et {date}.",
    openAfterExportName: "Ouvrir après l’export",
    openAfterExportDesc: "Ouvre le fichier généré à la fin de l’export.",
    shareAfterExportName: "Partager après l’export",
    rememberLastExportOptionsName: "Utiliser les dernières options",
    rememberLastExportOptionsDesc: "Activé par défaut. Enregistre ces options pour le prochain export.",
    outputLocationName: "Emplacement d’export",
    outputLocationCurrent: "Dossier de la note actuelle (par défaut)",
    outputLocationFolder: "Dossier personnalisé",
    outputLocationCurrentDesc: "Enregistre le PDF à côté de la note actuelle.",
    outputLocationFolderDesc: "Enregistre le PDF dans un dossier du Vault et le crée si nécessaire.",
    outputFolderPlaceholder: "PDF Exports",
    pdfNameLabel: "Nom du PDF",
    exportPdfButton: "Exporter le PDF",
    cancelButton: "Autres formats",
    busyExporting: "Export du PDF",
    busyCancelButton: "Annuler l’export",
    busyCancelledTitle: "Export annulé",
    busyCancelledStatus: "Aucun PDF n’a été enregistré.",
    busyCompleteTitle: "Export terminé",
    busyCompleteStatus: "Terminé",
    busyFailedTitle: "Échec de l’export PDF",
    busyElapsedShort: "{seconds} s écoulées",
    busyElapsedLong: "{seconds} s écoulées. Traitement en cours ; ne fermez pas Obsidian.",
    settingsIntro: "Les menus et boutons ouvrent d’abord les options PDF. Les notes Markdown ordinaires peuvent être exportées avec du texte sélectionnable ou comme image.",
    settingsGeneralHeading: "Général",
    settingsNoteOptionsHeading: "Options PDF des notes ordinaires",
    pageSizeDesc: "La page mobile longue convient au téléphone ; A4/A5/Letter conviennent à l’impression et à l’archivage.",
    orientationDesc: "Le mode paysage inverse la largeur et la hauteur.",
    colorDesc: "Les niveaux de gris conviennent à l’impression ; la couleur conserve les couleurs du thème, des liens et des images.",
    settingsSaveAndShareHeading: "Enregistrer et partager",
    languageName: "Langue de l’interface",
    languageDesc: "Automatique suit la langue d’Obsidian. Les boutons, menus, commandes, options et messages utilisent la langue choisie.",
    languageAuto: "Automatique / suivre Obsidian",
    languageChinese: "Chinois",
    languageEnglish: "Anglais",
    formatPngLabel: "Image PNG",
    codesTitle: "Offrez-moi un café",
    codesSubtitle: "Si cet outil vous aide, vous pouvez soutenir sa maintenance continue.",
    shareFailedNotice: "Le PDF a été enregistré, mais le panneau de partage du système ne s’est pas ouvert.",
    fontMissingError: "La police PDF manque et n’a pas pu être téléchargée depuis GitHub. Réessayez en ligne ou placez NotoSansSC-Regular.gb2312-subset.ttf dans le dossier fonts du module.",
    uniqueFileNameError: "Impossible de générer un nom de fichier PDF unique.",
    excalidrawApiMissingError: "L’API d’export Excalidraw est introuvable. Vérifiez que le module Excalidraw est activé.",
    excalidrawExportFailedError: "L’image Excalidraw était trop grande ou l’export a échoué. Des résolutions inférieures et le découpage en pages ont déjà été essayés.",
    excalidrawPngNoImageError: "PNG {scale}x n’a renvoyé aucune image.",
    lastErrorLabel: "Dernière erreur : {error}",
    noUsableImageError: "Aucune image exploitable n’a été produite.",
    excalidrawPreviewUnavailable: "L’aperçu Excalidraw est indisponible ; les données source ont été ignorées.",
    previewNoExportSizeError: "La couche d’aperçu n’a pas de taille exportable.",
    previewNoContentError: "L’aperçu ne contient aucun contenu exportable.",
    pdfRuntimeMissingError: "Le moteur PDF n’est pas encore chargé.",
    fontkitMissingError: "L’initialisation de la police PDF a échoué car fontkit.create est indisponible.",
    imagePdfCanvasError: "Le rendu du PDF image a échoué car canvas est indisponible.",
    imageSliceError: "Le découpage de l’image a échoué car canvas est indisponible."
  },
  de: {
    ribbonTitle: "Vorschau-PDF exportieren",
    commandName: "Mobile PDF Exporter: Aktuelle Datei als Vorschau-PDF exportieren",
    noMarkdownNotice: "Öffnen Sie zuerst eine exportierbare Datei.",
    optionsTitle: "PDF-Exportoptionen",
    exportModeName: "Exportmodus",
    exportModeDesc: "Auswählbarer Text eignet sich zum Lesen, Suchen und Kopieren; ein Bild-PDF bewahrt das feste Layout.",
    exportModeSelectable: "Auswählbarer Text",
    exportModeImage: "Bild-PDF",
    pageSizeName: "Seitengröße",
    pageSizeCurrent: "Aktuelle Seitengröße (Standard)",
    pageSizeMobile: "Lange Mobilseite 104 x 225 mm",
    orientationName: "Ausrichtung",
    orientationPortrait: "Hochformat",
    orientationLandscape: "Querformat",
    colorName: "Farbe",
    colorOption: "Farbe",
    grayscaleOption: "Graustufen",
    marginName: "Rand",
    contentScaleName: "Inhaltsskalierung",
    imageQualityName: "Qualität des Bild-PDFs",
    imageQualityDesc: "Betrifft nur Bild-PDFs normaler Notizen. Höhere Qualität erzeugt größere Dateien.",
    imageQualityStandard: "Standard / kleine Datei",
    imageQualityClear: "Klar / empfohlen",
    imageQualityHigh: "Hoch",
    imageQualityUltra: "Ultra / große Datei",
    includeTitleName: "Notiztitel einschließen",
    headerTextName: "Kopfzeile",
    headerTextDesc: "Leer lassen zum Deaktivieren. Unterstützt {title}, {page}, {pages} und {date}.",
    footerTextName: "Fußzeile",
    footerTextDesc: "Leer lassen zum Deaktivieren. Unterstützt {title}, {page}, {pages} und {date}.",
    openAfterExportName: "Nach dem Export öffnen",
    openAfterExportDesc: "Öffnet die erzeugte Datei nach Abschluss des Exports.",
    shareAfterExportName: "Nach dem Export teilen",
    rememberLastExportOptionsName: "Letzte Exportoptionen verwenden",
    rememberLastExportOptionsDesc: "Standardmäßig aktiviert. Speichert diese Optionen für den nächsten Export.",
    outputLocationName: "Exportziel",
    outputLocationCurrent: "Ordner der aktuellen Notiz (Standard)",
    outputLocationFolder: "Benutzerdefinierter Ordner",
    outputLocationCurrentDesc: "Speichert das PDF neben der aktuellen Notiz.",
    outputLocationFolderDesc: "Speichert das PDF in einem Vault-Ordner und erstellt ihn bei Bedarf.",
    outputFolderPlaceholder: "PDF Exports",
    pdfNameLabel: "PDF-Name",
    exportPdfButton: "PDF exportieren",
    cancelButton: "Andere Formate",
    busyExporting: "PDF wird exportiert",
    busyCancelButton: "Export abbrechen",
    busyCancelledTitle: "Export abgebrochen",
    busyCancelledStatus: "Es wurde kein PDF gespeichert.",
    busyCompleteTitle: "Export abgeschlossen",
    busyCompleteStatus: "Fertig",
    busyFailedTitle: "PDF-Export fehlgeschlagen",
    busyElapsedShort: "{seconds} s vergangen",
    busyElapsedLong: "{seconds} s vergangen. Verarbeitung läuft; Obsidian nicht schließen.",
    settingsIntro: "Menüs und Schaltflächen öffnen zuerst die PDF-Optionen. Normale Markdown-Notizen können mit auswählbarem Text oder als Bild exportiert werden.",
    settingsGeneralHeading: "Allgemein",
    settingsNoteOptionsHeading: "PDF-Optionen für normale Notizen",
    pageSizeDesc: "Die lange Mobilseite eignet sich fürs Smartphone; A4/A5/Letter für Druck und Archivierung.",
    orientationDesc: "Querformat vertauscht Seitenbreite und -höhe.",
    colorDesc: "Graustufen eignen sich zum Drucken; Farbe erhält Theme-, Link- und Bildfarben.",
    settingsSaveAndShareHeading: "Speichern und teilen",
    languageName: "Oberflächensprache",
    languageDesc: "Automatisch folgt der Obsidian-Sprache. Schaltflächen, Menüs, Befehle, Optionen und Hinweise verwenden die gewählte Sprache.",
    languageAuto: "Automatisch / Obsidian folgen",
    languageChinese: "Chinesisch",
    languageEnglish: "Englisch",
    formatPngLabel: "PNG-Bild",
    codesTitle: "Spendieren Sie mir einen Kaffee",
    codesSubtitle: "Wenn dieses Werkzeug hilft, können Sie die weitere Pflege unterstützen.",
    shareFailedNotice: "Das PDF wurde gespeichert, aber die Systemfreigabe konnte nicht geöffnet werden.",
    fontMissingError: "Die PDF-Schrift fehlt und konnte nicht von GitHub geladen werden. Versuchen Sie es online erneut oder legen Sie NotoSansSC-Regular.gb2312-subset.ttf im fonts-Ordner des Plugins ab.",
    uniqueFileNameError: "Es konnte kein eindeutiger PDF-Dateiname erzeugt werden.",
    excalidrawApiMissingError: "Die Excalidraw-Export-API wurde nicht gefunden. Prüfen Sie, ob das Excalidraw-Plugin aktiviert ist.",
    excalidrawExportFailedError: "Das Excalidraw-Bild war zu groß oder der Export ist fehlgeschlagen. Niedrigere Auflösungen und Seitenteilung wurden bereits versucht.",
    excalidrawPngNoImageError: "PNG {scale}x lieferte kein Bild.",
    lastErrorLabel: "Letzter Fehler: {error}",
    noUsableImageError: "Es wurde kein verwendbares Bild erzeugt.",
    excalidrawPreviewUnavailable: "Die Excalidraw-Vorschau ist nicht verfügbar; Quelldaten wurden übersprungen.",
    previewNoExportSizeError: "Die Vorschauebene hat keine exportierbare Größe.",
    previewNoContentError: "Die Vorschau enthält keinen exportierbaren Inhalt.",
    pdfRuntimeMissingError: "Die PDF-Engine wurde noch nicht geladen.",
    fontkitMissingError: "Die PDF-Schriftinitialisierung ist fehlgeschlagen, weil fontkit.create nicht verfügbar ist.",
    imagePdfCanvasError: "Das Bild-PDF konnte nicht gerendert werden, weil canvas nicht verfügbar ist.",
    imageSliceError: "Das Bild konnte nicht geteilt werden, weil canvas nicht verfügbar ist."
  },
  ru: {
    ribbonTitle: "Экспорт PDF-предпросмотра",
    commandName: "Mobile PDF Exporter: Экспортировать текущий файл как PDF-предпросмотр",
    noMarkdownNotice: "Сначала откройте файл, который можно экспортировать.",
    optionsTitle: "Параметры экспорта PDF",
    exportModeName: "Режим экспорта",
    exportModeDesc: "Выделяемый текст удобен для чтения, поиска и копирования; PDF-изображение сохраняет фиксированный вид.",
    exportModeSelectable: "Выделяемый текст",
    exportModeImage: "PDF-изображение",
    pageSizeName: "Размер страницы",
    pageSizeCurrent: "Текущий размер страницы (по умолчанию)",
    pageSizeMobile: "Длинная мобильная страница 104 x 225 мм",
    orientationName: "Ориентация",
    orientationPortrait: "Книжная",
    orientationLandscape: "Альбомная",
    colorName: "Цвет",
    colorOption: "Цветной",
    grayscaleOption: "Оттенки серого",
    marginName: "Поля",
    contentScaleName: "Масштаб содержимого",
    imageQualityName: "Качество PDF-изображения",
    imageQualityDesc: "Влияет только на PDF-изображения обычных заметок. Более высокое качество увеличивает файл.",
    imageQualityStandard: "Стандарт / малый файл",
    imageQualityClear: "Чётко / рекомендуется",
    imageQualityHigh: "Высокое",
    imageQualityUltra: "Ультра / большой файл",
    includeTitleName: "Включать заголовок заметки",
    headerTextName: "Верхний колонтитул",
    headerTextDesc: "Оставьте пустым для отключения. Поддерживаются {title}, {page}, {pages} и {date}.",
    footerTextName: "Нижний колонтитул",
    footerTextDesc: "Оставьте пустым для отключения. Поддерживаются {title}, {page}, {pages} и {date}.",
    openAfterExportName: "Открыть после экспорта",
    openAfterExportDesc: "Открывает созданный файл после завершения экспорта.",
    shareAfterExportName: "Поделиться после экспорта",
    rememberLastExportOptionsName: "Использовать последние параметры",
    rememberLastExportOptionsDesc: "Включено по умолчанию. Сохраняет эти параметры для следующего экспорта.",
    outputLocationName: "Папка экспорта",
    outputLocationCurrent: "Папка текущей заметки (по умолчанию)",
    outputLocationFolder: "Другая папка",
    outputLocationCurrentDesc: "Сохраняет PDF рядом с текущей заметкой.",
    outputLocationFolderDesc: "Сохраняет PDF в указанной папке Vault и создаёт её при необходимости.",
    outputFolderPlaceholder: "PDF Exports",
    pdfNameLabel: "Имя PDF",
    exportPdfButton: "Экспортировать PDF",
    cancelButton: "Другие форматы",
    busyExporting: "Экспорт PDF",
    busyCancelButton: "Отменить экспорт",
    busyCancelledTitle: "Экспорт отменён",
    busyCancelledStatus: "PDF не был сохранён.",
    busyCompleteTitle: "Экспорт завершён",
    busyCompleteStatus: "Готово",
    busyFailedTitle: "Ошибка экспорта PDF",
    busyElapsedShort: "Прошло {seconds} с",
    busyElapsedLong: "Прошло {seconds} с. Обработка продолжается; не закрывайте Obsidian.",
    settingsIntro: "Меню и кнопки сначала открывают параметры PDF. Обычные Markdown-заметки можно экспортировать с выделяемым текстом или как изображение.",
    settingsGeneralHeading: "Общие",
    settingsNoteOptionsHeading: "Параметры PDF для обычных заметок",
    pageSizeDesc: "Длинная мобильная страница удобна для телефона; A4/A5/Letter подходят для печати и архива.",
    orientationDesc: "Альбомная ориентация меняет местами ширину и высоту.",
    colorDesc: "Оттенки серого удобны для печати; цветной режим сохраняет цвета темы, ссылок и изображений.",
    settingsSaveAndShareHeading: "Сохранение и публикация",
    languageName: "Язык интерфейса",
    languageDesc: "Автоматически следует языку Obsidian. Кнопки, меню, команды, параметры и сообщения используют выбранный язык.",
    languageAuto: "Автоматически / как в Obsidian",
    languageChinese: "Китайский",
    languageEnglish: "Английский",
    formatPngLabel: "Изображение PNG",
    codesTitle: "Угостить кофе",
    codesSubtitle: "Если инструмент полезен, вы можете поддержать его дальнейшее развитие.",
    shareFailedNotice: "PDF сохранён, но системное окно публикации не открылось.",
    fontMissingError: "Шрифт PDF отсутствует и не был загружен с GitHub. Повторите попытку с сетью или поместите NotoSansSC-Regular.gb2312-subset.ttf в папку fonts плагина.",
    uniqueFileNameError: "Не удалось создать уникальное имя PDF-файла.",
    excalidrawApiMissingError: "API экспорта Excalidraw не найден. Убедитесь, что плагин Excalidraw включён.",
    excalidrawExportFailedError: "Изображение Excalidraw слишком велико или экспорт не удался. Уже проверены меньшие разрешения и разбиение на страницы.",
    excalidrawPngNoImageError: "PNG {scale}x не вернул изображение.",
    lastErrorLabel: "Последняя ошибка: {error}",
    noUsableImageError: "Не удалось получить пригодное изображение.",
    excalidrawPreviewUnavailable: "Предпросмотр Excalidraw недоступен; исходные данные пропущены.",
    previewNoExportSizeError: "У слоя предпросмотра нет экспортируемого размера.",
    previewNoContentError: "В предпросмотре нет экспортируемого содержимого.",
    pdfRuntimeMissingError: "Модуль PDF ещё не загружен.",
    fontkitMissingError: "Не удалось инициализировать шрифт PDF: fontkit.create недоступен.",
    imagePdfCanvasError: "Не удалось отрисовать PDF-изображение: canvas недоступен.",
    imageSliceError: "Не удалось разделить изображение: canvas недоступен."
  },
  pt: {
    ribbonTitle: "Exportar PDF de pré-visualização",
    commandName: "Mobile PDF Exporter: Exportar PDF de pré-visualização",
    noMarkdownNotice: "Abra primeiro um ficheiro que possa ser exportado.",
    optionsTitle: "Opções de exportação para PDF",
    exportModeName: "Modo de exportação",
    exportModeDesc: "O texto selecionável é ideal para leitura, pesquisa e cópia; o PDF de imagem mantém o aspeto fixo.",
    exportModeSelectable: "Texto selecionável",
    exportModeImage: "PDF de imagem",
    pageSizeName: "Tamanho da página",
    pageSizeCurrent: "Tamanho atual da página (predefinição)",
    pageSizeMobile: "Página longa para telemóvel 104 x 225 mm",
    orientationName: "Orientação",
    orientationPortrait: "Vertical",
    orientationLandscape: "Horizontal",
    colorName: "Cor",
    colorOption: "A cores",
    grayscaleOption: "Escala de cinzentos",
    marginName: "Margem",
    contentScaleName: "Escala do conteúdo",
    imageQualityName: "Qualidade do PDF de imagem",
    imageQualityDesc: "Afeta apenas PDFs de imagem de notas comuns. Uma qualidade superior cria ficheiros maiores.",
    imageQualityStandard: "Padrão / ficheiro menor",
    imageQualityClear: "Nítida / recomendada",
    imageQualityHigh: "Alta",
    imageQualityUltra: "Ultra / ficheiro grande",
    includeTitleName: "Incluir título da nota",
    headerTextName: "Cabeçalho",
    headerTextDesc: "Deixe em branco para desativar. Suporta {title}, {page}, {pages} e {date}.",
    footerTextName: "Rodapé",
    footerTextDesc: "Deixe em branco para desativar. Suporta {title}, {page}, {pages} e {date}.",
    openAfterExportName: "Abrir após exportar",
    openAfterExportDesc: "Abrir o ficheiro gerado quando a exportação terminar.",
    shareAfterExportName: "Mostrar painel de partilha do telemóvel",
    rememberLastExportOptionsName: "Usar as últimas opções de exportação",
    rememberLastExportOptionsDesc: "Ativado por predefinição. Guarda estas opções para a próxima exportação.",
    outputLocationName: "Local de exportação",
    outputLocationCurrent: "Pasta da nota atual (predefinição)",
    outputLocationFolder: "Pasta personalizada",
    outputLocationCurrentDesc: "Guardar o PDF junto da nota atual.",
    outputLocationFolderDesc: "Guardar o PDF numa pasta personalizada do cofre, criando-a quando necessário.",
    outputFolderPlaceholder: "Exportações PDF",
    pdfNameLabel: "Nome do PDF",
    exportPdfButton: "Exportar PDF",
    cancelButton: "Outros formatos",
    busyExporting: "A exportar PDF",
    busyCancelButton: "Cancelar exportação",
    busyCancelledTitle: "Exportação cancelada",
    busyCancelledStatus: "Nenhum PDF foi guardado.",
    busyCompleteTitle: "Exportação concluída",
    busyCompleteStatus: "Concluído",
    busyFailedTitle: "Falha ao exportar PDF",
    busyElapsedShort: "Decorreram {seconds} s",
    busyElapsedLong: "Decorreram {seconds} s. O processamento continua; não feche o Obsidian.",
    settingsIntro: "Os menus e botões abrem primeiro as opções de exportação para PDF. As notas Markdown comuns podem ser exportadas como PDF de texto selecionável ou PDF de imagem.",
    settingsGeneralHeading: "Geral",
    settingsNoteOptionsHeading: "Opções de PDF para notas comuns",
    pageSizeDesc: "A página longa é adequada para leitura no telemóvel. A4/A5/Letter são úteis para impressão e arquivo.",
    orientationDesc: "A orientação horizontal troca a largura e a altura da página.",
    colorDesc: "A escala de cinzentos é útil para impressão; a opção a cores preserva as cores do tema, ligações e imagens.",
    settingsSaveAndShareHeading: "Guardar e partilhar",
    languageName: "Idioma da interface",
    languageDesc: "Automático segue o idioma do Obsidian. Botões, menus, comandos, opções e avisos usam o idioma selecionado.",
    languageAuto: "Automático / seguir Obsidian",
    languageChinese: "Chinês",
    languageEnglish: "Inglês",
    formatPngLabel: "Imagem PNG",
    codesTitle: "Pague-me um café",
    codesSubtitle: "Se esta ferramenta for útil, os donativos ajudam a manter o desenvolvimento.",
    shareFailedNotice: "O PDF foi guardado, mas o painel de partilha do sistema não abriu.",
    fontMissingError: "A fonte do PDF está em falta e o plugin não conseguiu transferi-la do GitHub. Tente novamente com ligação à Internet ou coloque NotoSansSC-Regular.gb2312-subset.ttf na pasta fonts do plugin.",
    uniqueFileNameError: "Não foi possível gerar um nome de ficheiro PDF exclusivo.",
    excalidrawApiMissingError: "A API de exportação do Excalidraw não foi encontrada. Confirme que o plugin Excalidraw está ativado.",
    excalidrawExportFailedError: "A imagem do Excalidraw era demasiado grande ou a exportação falhou. Já foram tentadas resoluções inferiores e divisão em páginas.",
    excalidrawPngNoImageError: "O PNG {scale}x não devolveu uma imagem.",
    lastErrorLabel: "Último erro: {error}",
    noUsableImageError: "Não foi produzida nenhuma imagem utilizável.",
    excalidrawPreviewUnavailable: "A pré-visualização do Excalidraw não está disponível, por isso os dados de origem foram ignorados.",
    previewNoExportSizeError: "A camada de pré-visualização não tem um tamanho exportável.",
    previewNoContentError: "A pré-visualização não tem conteúdo exportável.",
    pdfRuntimeMissingError: "O motor de PDF ainda não foi carregado.",
    fontkitMissingError: "A inicialização da fonte PDF falhou porque fontkit.create não está disponível.",
    imagePdfCanvasError: "A renderização do PDF de imagem falhou porque o canvas não está disponível.",
    imageSliceError: "A divisão da imagem falhou porque o canvas não está disponível."
  },
  it: {
    ribbonTitle: "Esporta PDF di anteprima",
    commandName: "Mobile PDF Exporter: Esporta PDF di anteprima",
    noMarkdownNotice: "Apri prima un file esportabile.",
    optionsTitle: "Opzioni di esportazione PDF",
    exportModeName: "Modalità di esportazione",
    exportModeDesc: "Il testo selezionabile è ideale per lettura, ricerca e copia; il PDF immagine mantiene fisso l'aspetto.",
    exportModeSelectable: "Testo selezionabile",
    exportModeImage: "PDF immagine",
    pageSizeName: "Dimensione pagina",
    pageSizeCurrent: "Dimensione pagina attuale (predefinita)",
    pageSizeMobile: "Pagina lunga per dispositivi mobili 104 x 225 mm",
    orientationName: "Orientamento",
    orientationPortrait: "Verticale",
    orientationLandscape: "Orizzontale",
    colorName: "Colore",
    colorOption: "Colore",
    grayscaleOption: "Scala di grigi",
    marginName: "Margine",
    contentScaleName: "Scala contenuto",
    imageQualityName: "Qualità PDF immagine",
    imageQualityDesc: "Influisce solo sui PDF immagine delle note normali. Una qualità maggiore crea file più grandi.",
    imageQualityStandard: "Standard / file più piccolo",
    imageQualityClear: "Nitida / consigliata",
    imageQualityHigh: "Alta",
    imageQualityUltra: "Ultra / file grande",
    includeTitleName: "Includi titolo della nota",
    headerTextName: "Intestazione",
    headerTextDesc: "Lascia vuoto per disattivare. Supporta {title}, {page}, {pages} e {date}.",
    footerTextName: "Piè di pagina",
    footerTextDesc: "Lascia vuoto per disattivare. Supporta {title}, {page}, {pages} e {date}.",
    openAfterExportName: "Apri dopo l'esportazione",
    openAfterExportDesc: "Apri il file generato al termine dell'esportazione.",
    shareAfterExportName: "Mostra pannello di condivisione mobile",
    rememberLastExportOptionsName: "Usa le ultime opzioni di esportazione",
    rememberLastExportOptionsDesc: "Attivo per impostazione predefinita. Salva queste opzioni per la prossima esportazione.",
    outputLocationName: "Posizione di esportazione",
    outputLocationCurrent: "Cartella della nota attuale (predefinita)",
    outputLocationFolder: "Cartella personalizzata",
    outputLocationCurrentDesc: "Salva il PDF accanto alla nota attuale.",
    outputLocationFolderDesc: "Salva il PDF in una cartella personalizzata del vault, creandola se necessario.",
    outputFolderPlaceholder: "Esportazioni PDF",
    pdfNameLabel: "Nome PDF",
    exportPdfButton: "Esporta PDF",
    cancelButton: "Altri formati",
    busyExporting: "Esportazione PDF",
    busyCancelButton: "Annulla esportazione",
    busyCancelledTitle: "Esportazione annullata",
    busyCancelledStatus: "Nessun PDF è stato salvato.",
    busyCompleteTitle: "Esportazione completata",
    busyCompleteStatus: "Completato",
    busyFailedTitle: "Esportazione PDF non riuscita",
    busyElapsedShort: "Trascorsi {seconds} s",
    busyElapsedLong: "Trascorsi {seconds} s. Elaborazione in corso; non chiudere Obsidian.",
    settingsIntro: "Menu e pulsanti aprono prima le opzioni di esportazione PDF. Le normali note Markdown possono essere esportate come PDF con testo selezionabile o PDF immagine.",
    settingsGeneralHeading: "Generali",
    settingsNoteOptionsHeading: "Opzioni PDF per note normali",
    pageSizeDesc: "La pagina lunga è adatta alla lettura su telefono. A4/A5/Letter sono utili per stampa e archiviazione.",
    orientationDesc: "L'orientamento orizzontale scambia larghezza e altezza della pagina.",
    colorDesc: "La scala di grigi è utile per la stampa; il colore conserva i colori del tema, dei collegamenti e delle immagini.",
    settingsSaveAndShareHeading: "Salvataggio e condivisione",
    languageName: "Lingua dell'interfaccia",
    languageDesc: "Automatico segue la lingua di Obsidian. Pulsanti, menu, comandi, opzioni e messaggi usano la lingua selezionata.",
    languageAuto: "Automatico / segui Obsidian",
    languageChinese: "Cinese",
    languageEnglish: "Inglese",
    formatPngLabel: "Immagine PNG",
    codesTitle: "Offrimi un caffè",
    codesSubtitle: "Se questo strumento ti è utile, le donazioni sostengono la manutenzione continua.",
    shareFailedNotice: "Il PDF è stato salvato, ma il pannello di condivisione del sistema non si è aperto.",
    fontMissingError: "Il carattere PDF manca e il plugin non è riuscito a scaricarlo da GitHub. Riprova online oppure inserisci NotoSansSC-Regular.gb2312-subset.ttf nella cartella fonts del plugin.",
    uniqueFileNameError: "Impossibile generare un nome file PDF univoco.",
    excalidrawApiMissingError: "L'API di esportazione di Excalidraw non è stata trovata. Verifica che il plugin Excalidraw sia attivo.",
    excalidrawExportFailedError: "L'immagine Excalidraw era troppo grande o l'esportazione non è riuscita. Sono già state provate risoluzioni inferiori e la suddivisione in pagine.",
    excalidrawPngNoImageError: "PNG {scale}x non ha restituito alcuna immagine.",
    lastErrorLabel: "Ultimo errore: {error}",
    noUsableImageError: "Non è stata prodotta alcuna immagine utilizzabile.",
    excalidrawPreviewUnavailable: "L'anteprima di Excalidraw non è disponibile, quindi i dati sorgente sono stati ignorati.",
    previewNoExportSizeError: "Il livello di anteprima non ha dimensioni esportabili.",
    previewNoContentError: "L'anteprima non contiene contenuti esportabili.",
    pdfRuntimeMissingError: "Il motore PDF non è ancora stato caricato.",
    fontkitMissingError: "Inizializzazione del carattere PDF non riuscita perché fontkit.create non è disponibile.",
    imagePdfCanvasError: "Rendering del PDF immagine non riuscito perché canvas non è disponibile.",
    imageSliceError: "Suddivisione dell'immagine non riuscita perché canvas non è disponibile."
  },
  ar: {
    ribbonTitle: "تصدير ملف PDF للمعاينة",
    commandName: "Mobile PDF Exporter: تصدير ملف PDF للمعاينة",
    noMarkdownNotice: "افتح أولاً ملفاً قابلاً للتصدير.",
    optionsTitle: "خيارات تصدير PDF",
    exportModeName: "وضع التصدير",
    exportModeDesc: "النص القابل للتحديد مناسب للقراءة والبحث والنسخ، بينما يحافظ PDF الصوري على التخطيط المرئي.",
    exportModeSelectable: "نص قابل للتحديد",
    exportModeImage: "PDF صوري",
    pageSizeName: "حجم الصفحة",
    pageSizeCurrent: "حجم الصفحة الحالي (الافتراضي)",
    pageSizeMobile: "صفحة طويلة للهاتف 104 × 225 مم",
    orientationName: "الاتجاه",
    orientationPortrait: "عمودي",
    orientationLandscape: "أفقي",
    colorName: "الألوان",
    colorOption: "ملون",
    grayscaleOption: "تدرج رمادي",
    marginName: "الهامش",
    contentScaleName: "مقياس المحتوى",
    imageQualityName: "جودة PDF الصوري",
    imageQualityDesc: "يؤثر فقط في ملفات PDF الصورية للملاحظات العادية. الجودة الأعلى تنشئ ملفات أكبر.",
    imageQualityStandard: "قياسية / ملف أصغر",
    imageQualityClear: "واضحة / موصى بها",
    imageQualityHigh: "عالية",
    imageQualityUltra: "فائقة / ملف كبير",
    includeTitleName: "تضمين عنوان الملاحظة",
    headerTextName: "رأس الصفحة",
    headerTextDesc: "اتركه فارغاً للتعطيل. يدعم {title} و{page} و{pages} و{date}.",
    footerTextName: "تذييل الصفحة",
    footerTextDesc: "اتركه فارغاً للتعطيل. يدعم {title} و{page} و{pages} و{date}.",
    openAfterExportName: "فتح بعد التصدير",
    openAfterExportDesc: "افتح الملف الناتج عند اكتمال التصدير.",
    shareAfterExportName: "إظهار لوحة المشاركة على الهاتف",
    rememberLastExportOptionsName: "استخدام آخر خيارات التصدير",
    rememberLastExportOptionsDesc: "مفعّل افتراضياً. يحفظ خيارات هذا التصدير للاستخدام في المرة القادمة.",
    outputLocationName: "موقع التصدير",
    outputLocationCurrent: "مجلد الملاحظة الحالية (الافتراضي)",
    outputLocationFolder: "مجلد مخصص",
    outputLocationCurrentDesc: "احفظ ملف PDF بجوار الملاحظة الحالية.",
    outputLocationFolderDesc: "احفظ ملف PDF في مجلد مخصص داخل الخزنة، مع إنشائه عند الحاجة.",
    outputFolderPlaceholder: "صادرات PDF",
    pdfNameLabel: "اسم ملف PDF",
    exportPdfButton: "تصدير PDF",
    cancelButton: "تنسيقات أخرى",
    busyExporting: "جارٍ تصدير PDF",
    busyCancelButton: "إلغاء التصدير",
    busyCancelledTitle: "تم إلغاء التصدير",
    busyCancelledStatus: "لم يتم حفظ ملف PDF.",
    busyCompleteTitle: "اكتمل التصدير",
    busyCompleteStatus: "تم",
    busyFailedTitle: "فشل تصدير PDF",
    busyElapsedShort: "انقضت {seconds} ث",
    busyElapsedLong: "انقضت {seconds} ث. ما زالت المعالجة جارية؛ لا تغلق Obsidian.",
    settingsIntro: "تفتح القوائم والأزرار خيارات تصدير PDF أولاً. يمكن تصدير ملاحظات Markdown العادية كملفات PDF بنص قابل للتحديد أو كملفات PDF صورية.",
    settingsGeneralHeading: "عام",
    settingsNoteOptionsHeading: "خيارات PDF للملاحظات العادية",
    pageSizeDesc: "الصفحة الطويلة مناسبة للقراءة على الهاتف. أحجام A4/A5/Letter مناسبة للطباعة والأرشفة.",
    orientationDesc: "يبدّل الاتجاه الأفقي عرض الصفحة وارتفاعها.",
    colorDesc: "التدرج الرمادي مناسب للطباعة، بينما يحافظ الوضع الملون على ألوان السمة والروابط والصور.",
    settingsSaveAndShareHeading: "الحفظ والمشاركة",
    languageName: "لغة الواجهة",
    languageDesc: "يتبع الوضع التلقائي لغة Obsidian. تستخدم الأزرار والقوائم والأوامر والخيارات والتنبيهات اللغة المحددة.",
    languageAuto: "تلقائي / اتباع Obsidian",
    languageChinese: "الصينية",
    languageEnglish: "الإنجليزية",
    formatPngLabel: "صورة PNG",
    codesTitle: "اشترِ لي قهوة",
    codesSubtitle: "إذا كانت هذه الأداة مفيدة، فالتبرعات تدعم استمرار صيانتها.",
    shareFailedNotice: "تم حفظ ملف PDF، لكن لوحة مشاركة النظام لم تفتح.",
    fontMissingError: "خط PDF مفقود وتعذر على الإضافة تنزيله من GitHub. أعد المحاولة مع الاتصال بالإنترنت أو ضع NotoSansSC-Regular.gb2312-subset.ttf في مجلد fonts الخاص بالإضافة.",
    uniqueFileNameError: "تعذر إنشاء اسم فريد لملف PDF.",
    excalidrawApiMissingError: "لم يتم العثور على واجهة تصدير Excalidraw. تأكد من تفعيل إضافة Excalidraw.",
    excalidrawExportFailedError: "كانت صورة Excalidraw كبيرة جداً أو فشل التصدير. تمت بالفعل تجربة دقات أقل وتقسيم الصفحات.",
    excalidrawPngNoImageError: "لم يُرجع PNG بمقياس {scale}x صورة.",
    lastErrorLabel: "آخر خطأ: {error}",
    noUsableImageError: "لم يتم إنشاء صورة قابلة للاستخدام.",
    excalidrawPreviewUnavailable: "معاينة Excalidraw غير متاحة، لذلك تم تخطي بيانات المصدر.",
    previewNoExportSizeError: "طبقة المعاينة ليس لها حجم قابل للتصدير.",
    previewNoContentError: "لا تحتوي المعاينة على محتوى قابل للتصدير.",
    pdfRuntimeMissingError: "لم يتم تحميل محرك PDF بعد.",
    fontkitMissingError: "فشلت تهيئة خط PDF لأن fontkit.create غير متاح.",
    imagePdfCanvasError: "فشل عرض PDF الصوري لأن canvas غير متاح.",
    imageSliceError: "فشل تقسيم الصورة لأن canvas غير متاح."
  },
  hi: {
    ribbonTitle: "पूर्वावलोकन PDF निर्यात करें",
    commandName: "Mobile PDF Exporter: पूर्वावलोकन PDF निर्यात करें",
    noMarkdownNotice: "पहले कोई निर्यात योग्य फ़ाइल खोलें।",
    optionsTitle: "PDF निर्यात विकल्प",
    exportModeName: "निर्यात मोड",
    exportModeDesc: "चयन योग्य पाठ पढ़ने, खोजने और कॉपी करने के लिए उपयुक्त है; चित्र PDF दृश्य लेआउट को स्थिर रखता है।",
    exportModeSelectable: "चयन योग्य पाठ",
    exportModeImage: "चित्र PDF",
    pageSizeName: "पृष्ठ आकार",
    pageSizeCurrent: "वर्तमान पृष्ठ आकार (डिफ़ॉल्ट)",
    pageSizeMobile: "मोबाइल लंबा पृष्ठ 104 x 225 मिमी",
    orientationName: "अभिमुखता",
    orientationPortrait: "लंबवत",
    orientationLandscape: "क्षैतिज",
    colorName: "रंग",
    colorOption: "रंगीन",
    grayscaleOption: "ग्रेस्केल",
    marginName: "हाशिया",
    contentScaleName: "सामग्री पैमाना",
    imageQualityName: "चित्र PDF गुणवत्ता",
    imageQualityDesc: "केवल सामान्य नोट के चित्र PDF को प्रभावित करता है। अधिक गुणवत्ता से बड़ी फ़ाइल बनती है।",
    imageQualityStandard: "मानक / छोटी फ़ाइल",
    imageQualityClear: "स्पष्ट / अनुशंसित",
    imageQualityHigh: "उच्च",
    imageQualityUltra: "अल्ट्रा / बड़ी फ़ाइल",
    includeTitleName: "नोट का शीर्षक शामिल करें",
    headerTextName: "शीर्षलेख",
    headerTextDesc: "अक्षम करने के लिए खाली छोड़ें। {title}, {page}, {pages} और {date} समर्थित हैं।",
    footerTextName: "पादलेख",
    footerTextDesc: "अक्षम करने के लिए खाली छोड़ें। {title}, {page}, {pages} और {date} समर्थित हैं।",
    openAfterExportName: "निर्यात के बाद खोलें",
    openAfterExportDesc: "निर्यात पूरा होने पर बनी फ़ाइल खोलें।",
    shareAfterExportName: "मोबाइल शेयर पैनल दिखाएँ",
    rememberLastExportOptionsName: "पिछले निर्यात विकल्प उपयोग करें",
    rememberLastExportOptionsDesc: "डिफ़ॉल्ट रूप से चालू। अगली बार के लिए इस निर्यात के विकल्प सहेजता है।",
    outputLocationName: "निर्यात स्थान",
    outputLocationCurrent: "वर्तमान नोट फ़ोल्डर (डिफ़ॉल्ट)",
    outputLocationFolder: "कस्टम फ़ोल्डर",
    outputLocationCurrentDesc: "PDF को वर्तमान नोट के पास सहेजें।",
    outputLocationFolderDesc: "PDF को वॉल्ट के कस्टम फ़ोल्डर में सहेजें और आवश्यकता होने पर उसे बनाएँ।",
    outputFolderPlaceholder: "PDF निर्यात",
    pdfNameLabel: "PDF नाम",
    exportPdfButton: "PDF निर्यात करें",
    cancelButton: "अन्य प्रारूप",
    busyExporting: "PDF निर्यात हो रहा है",
    busyCancelButton: "निर्यात रद्द करें",
    busyCancelledTitle: "निर्यात रद्द किया गया",
    busyCancelledStatus: "कोई PDF सहेजा नहीं गया।",
    busyCompleteTitle: "निर्यात पूरा हुआ",
    busyCompleteStatus: "पूरा हुआ",
    busyFailedTitle: "PDF निर्यात विफल",
    busyElapsedShort: "{seconds} सेकंड बीते",
    busyElapsedLong: "{seconds} सेकंड बीते। प्रक्रिया जारी है; Obsidian बंद न करें।",
    settingsIntro: "मेनू और बटन पहले PDF निर्यात विकल्प खोलते हैं। सामान्य Markdown नोट चयन योग्य पाठ PDF या चित्र PDF के रूप में निर्यात किए जा सकते हैं।",
    settingsGeneralHeading: "सामान्य",
    settingsNoteOptionsHeading: "सामान्य नोट PDF विकल्प",
    pageSizeDesc: "लंबा मोबाइल पृष्ठ फ़ोन पर पढ़ने के लिए उपयुक्त है। A4/A5/Letter मुद्रण और संग्रह के लिए उपयोगी हैं।",
    orientationDesc: "क्षैतिज अभिमुखता पृष्ठ की चौड़ाई और ऊँचाई बदल देती है।",
    colorDesc: "ग्रेस्केल मुद्रण के लिए उपयोगी है; रंगीन मोड थीम, लिंक और चित्रों के रंग बनाए रखता है।",
    settingsSaveAndShareHeading: "सहेजना और साझा करना",
    languageName: "इंटरफ़ेस भाषा",
    languageDesc: "स्वचालित विकल्प Obsidian की भाषा का अनुसरण करता है। बटन, मेनू, कमांड, विकल्प और संदेश चुनी हुई भाषा उपयोग करते हैं।",
    languageAuto: "स्वचालित / Obsidian का अनुसरण करें",
    languageChinese: "चीनी",
    languageEnglish: "अंग्रेज़ी",
    formatPngLabel: "PNG चित्र",
    codesTitle: "मुझे एक कॉफ़ी दिलाएँ",
    codesSubtitle: "यदि यह उपकरण उपयोगी है, तो सहयोग इसके निरंतर रखरखाव में मदद करता है।",
    shareFailedNotice: "PDF सहेजा गया, लेकिन सिस्टम शेयर पैनल नहीं खुला।",
    fontMissingError: "PDF फ़ॉन्ट उपलब्ध नहीं है और प्लगइन उसे GitHub से डाउनलोड नहीं कर सका। इंटरनेट के साथ फिर प्रयास करें या NotoSansSC-Regular.gb2312-subset.ttf को प्लगइन के fonts फ़ोल्डर में रखें।",
    uniqueFileNameError: "एक अद्वितीय PDF फ़ाइल नाम नहीं बनाया जा सका।",
    excalidrawApiMissingError: "Excalidraw निर्यात API नहीं मिला। सुनिश्चित करें कि Excalidraw प्लगइन चालू है।",
    excalidrawExportFailedError: "Excalidraw चित्र बहुत बड़ा था या निर्यात विफल हुआ। कम रिज़ॉल्यूशन और पृष्ठ विभाजन पहले ही आज़माए जा चुके हैं।",
    excalidrawPngNoImageError: "PNG {scale}x ने कोई चित्र नहीं लौटाया।",
    lastErrorLabel: "अंतिम त्रुटि: {error}",
    noUsableImageError: "कोई उपयोग योग्य चित्र नहीं बना।",
    excalidrawPreviewUnavailable: "Excalidraw पूर्वावलोकन उपलब्ध नहीं है, इसलिए स्रोत डेटा छोड़ दिया गया।",
    previewNoExportSizeError: "पूर्वावलोकन परत का कोई निर्यात योग्य आकार नहीं है।",
    previewNoContentError: "पूर्वावलोकन में निर्यात योग्य सामग्री नहीं है।",
    pdfRuntimeMissingError: "PDF इंजन अभी लोड नहीं हुआ है।",
    fontkitMissingError: "PDF फ़ॉन्ट आरंभ नहीं हो सका क्योंकि fontkit.create उपलब्ध नहीं है।",
    imagePdfCanvasError: "चित्र PDF रेंडर नहीं हो सका क्योंकि canvas उपलब्ध नहीं है।",
    imageSliceError: "चित्र विभाजित नहीं हो सका क्योंकि canvas उपलब्ध नहीं है।"
  },
  id: {
    ribbonTitle: "Ekspor PDF pratinjau",
    commandName: "Mobile PDF Exporter: Ekspor PDF pratinjau",
    noMarkdownNotice: "Buka dahulu file yang dapat diekspor.",
    optionsTitle: "Opsi ekspor PDF",
    exportModeName: "Mode ekspor",
    exportModeDesc: "Teks yang dapat dipilih cocok untuk membaca, mencari, dan menyalin; PDF gambar mempertahankan tata letak visual.",
    exportModeSelectable: "Teks dapat dipilih",
    exportModeImage: "PDF gambar",
    pageSizeName: "Ukuran halaman",
    pageSizeCurrent: "Ukuran halaman saat ini (bawaan)",
    pageSizeMobile: "Halaman panjang seluler 104 x 225 mm",
    orientationName: "Orientasi",
    orientationPortrait: "Potret",
    orientationLandscape: "Lanskap",
    colorName: "Warna",
    colorOption: "Berwarna",
    grayscaleOption: "Skala abu-abu",
    marginName: "Margin",
    contentScaleName: "Skala konten",
    imageQualityName: "Kualitas PDF gambar",
    imageQualityDesc: "Hanya memengaruhi PDF gambar untuk catatan biasa. Kualitas lebih tinggi menghasilkan file lebih besar.",
    imageQualityStandard: "Standar / file lebih kecil",
    imageQualityClear: "Jernih / disarankan",
    imageQualityHigh: "Tinggi",
    imageQualityUltra: "Ultra / file besar",
    includeTitleName: "Sertakan judul catatan",
    headerTextName: "Header",
    headerTextDesc: "Kosongkan untuk menonaktifkan. Mendukung {title}, {page}, {pages}, dan {date}.",
    footerTextName: "Footer",
    footerTextDesc: "Kosongkan untuk menonaktifkan. Mendukung {title}, {page}, {pages}, dan {date}.",
    openAfterExportName: "Buka setelah ekspor",
    openAfterExportDesc: "Buka file yang dihasilkan setelah ekspor selesai.",
    shareAfterExportName: "Tampilkan panel berbagi seluler",
    rememberLastExportOptionsName: "Gunakan opsi ekspor terakhir",
    rememberLastExportOptionsDesc: "Aktif secara bawaan. Menyimpan opsi ekspor ini untuk penggunaan berikutnya.",
    outputLocationName: "Lokasi ekspor",
    outputLocationCurrent: "Folder catatan saat ini (bawaan)",
    outputLocationFolder: "Folder khusus",
    outputLocationCurrentDesc: "Simpan PDF di samping catatan saat ini.",
    outputLocationFolderDesc: "Simpan PDF ke folder khusus di vault dan buat folder jika diperlukan.",
    outputFolderPlaceholder: "Ekspor PDF",
    pdfNameLabel: "Nama PDF",
    exportPdfButton: "Ekspor PDF",
    cancelButton: "Format lain",
    busyExporting: "Mengekspor PDF",
    busyCancelButton: "Batalkan ekspor",
    busyCancelledTitle: "Ekspor dibatalkan",
    busyCancelledStatus: "Tidak ada PDF yang disimpan.",
    busyCompleteTitle: "Ekspor selesai",
    busyCompleteStatus: "Selesai",
    busyFailedTitle: "Ekspor PDF gagal",
    busyElapsedShort: "{seconds} dtk berlalu",
    busyElapsedLong: "{seconds} dtk berlalu. Pemrosesan masih berjalan; jangan tutup Obsidian.",
    settingsIntro: "Menu dan tombol akan membuka opsi ekspor PDF terlebih dahulu. Catatan Markdown biasa dapat diekspor sebagai PDF teks yang dapat dipilih atau PDF gambar.",
    settingsGeneralHeading: "Umum",
    settingsNoteOptionsHeading: "Opsi PDF catatan biasa",
    pageSizeDesc: "Halaman panjang cocok untuk membaca di ponsel. A4/A5/Letter berguna untuk mencetak dan mengarsipkan.",
    orientationDesc: "Orientasi lanskap menukar lebar dan tinggi halaman.",
    colorDesc: "Skala abu-abu cocok untuk mencetak; warna mempertahankan warna tema, tautan, dan gambar.",
    settingsSaveAndShareHeading: "Simpan dan bagikan",
    languageName: "Bahasa antarmuka",
    languageDesc: "Otomatis mengikuti bahasa Obsidian. Tombol, menu, perintah, opsi, dan pesan menggunakan bahasa yang dipilih.",
    languageAuto: "Otomatis / ikuti Obsidian",
    languageChinese: "Bahasa Tionghoa",
    languageEnglish: "Bahasa Inggris",
    formatPngLabel: "Gambar PNG",
    codesTitle: "Traktir saya kopi",
    codesSubtitle: "Jika alat ini membantu, dukungan Anda membantu pemeliharaan berkelanjutan.",
    shareFailedNotice: "PDF telah disimpan, tetapi panel berbagi sistem tidak terbuka.",
    fontMissingError: "Font PDF tidak tersedia dan plugin tidak dapat mengunduhnya dari GitHub. Coba lagi saat tersambung ke internet atau letakkan NotoSansSC-Regular.gb2312-subset.ttf di folder fonts plugin.",
    uniqueFileNameError: "Tidak dapat membuat nama file PDF yang unik.",
    excalidrawApiMissingError: "API ekspor Excalidraw tidak ditemukan. Pastikan plugin Excalidraw aktif.",
    excalidrawExportFailedError: "Gambar Excalidraw terlalu besar atau ekspor gagal. Resolusi lebih rendah dan pemisahan halaman sudah dicoba.",
    excalidrawPngNoImageError: "PNG {scale}x tidak menghasilkan gambar.",
    lastErrorLabel: "Kesalahan terakhir: {error}",
    noUsableImageError: "Tidak ada gambar yang dapat digunakan.",
    excalidrawPreviewUnavailable: "Pratinjau Excalidraw tidak tersedia, sehingga data sumber dilewati.",
    previewNoExportSizeError: "Lapisan pratinjau tidak memiliki ukuran yang dapat diekspor.",
    previewNoContentError: "Pratinjau tidak memiliki konten yang dapat diekspor.",
    pdfRuntimeMissingError: "Mesin PDF belum dimuat.",
    fontkitMissingError: "Inisialisasi font PDF gagal karena fontkit.create tidak tersedia.",
    imagePdfCanvasError: "Perenderan PDF gambar gagal karena canvas tidak tersedia.",
    imageSliceError: "Pemisahan gambar gagal karena canvas tidak tersedia."
  },
  tr: {
    ribbonTitle: "Önizleme PDF'sini dışa aktar",
    commandName: "Mobile PDF Exporter: Önizleme PDF'sini dışa aktar",
    noMarkdownNotice: "Önce dışa aktarılabilir bir dosya açın.",
    optionsTitle: "PDF dışa aktarma seçenekleri",
    exportModeName: "Dışa aktarma modu",
    exportModeDesc: "Seçilebilir metin okuma, arama ve kopyalama için uygundur; görüntü PDF görsel düzeni sabit tutar.",
    exportModeSelectable: "Seçilebilir metin",
    exportModeImage: "Görüntü PDF",
    pageSizeName: "Sayfa boyutu",
    pageSizeCurrent: "Geçerli sayfa boyutu (varsayılan)",
    pageSizeMobile: "Mobil uzun sayfa 104 x 225 mm",
    orientationName: "Yönlendirme",
    orientationPortrait: "Dikey",
    orientationLandscape: "Yatay",
    colorName: "Renk",
    colorOption: "Renkli",
    grayscaleOption: "Gri tonlama",
    marginName: "Kenar boşluğu",
    contentScaleName: "İçerik ölçeği",
    imageQualityName: "Görüntü PDF kalitesi",
    imageQualityDesc: "Yalnızca normal notların görüntü PDF'lerini etkiler. Daha yüksek kalite daha büyük dosya oluşturur.",
    imageQualityStandard: "Standart / daha küçük dosya",
    imageQualityClear: "Net / önerilen",
    imageQualityHigh: "Yüksek",
    imageQualityUltra: "Ultra / büyük dosya",
    includeTitleName: "Not başlığını dahil et",
    headerTextName: "Üst bilgi",
    headerTextDesc: "Devre dışı bırakmak için boş bırakın. {title}, {page}, {pages} ve {date} desteklenir.",
    footerTextName: "Alt bilgi",
    footerTextDesc: "Devre dışı bırakmak için boş bırakın. {title}, {page}, {pages} ve {date} desteklenir.",
    openAfterExportName: "Dışa aktarmadan sonra aç",
    openAfterExportDesc: "Dışa aktarma tamamlandığında oluşturulan dosyayı açın.",
    shareAfterExportName: "Mobil paylaşım panelini göster",
    rememberLastExportOptionsName: "Son dışa aktarma seçeneklerini kullan",
    rememberLastExportOptionsDesc: "Varsayılan olarak etkin. Bu dışa aktarmanın seçeneklerini sonraki kullanım için kaydeder.",
    outputLocationName: "Dışa aktarma konumu",
    outputLocationCurrent: "Geçerli not klasörü (varsayılan)",
    outputLocationFolder: "Özel klasör",
    outputLocationCurrentDesc: "PDF'yi geçerli notun yanına kaydedin.",
    outputLocationFolderDesc: "PDF'yi kasadaki özel bir klasöre kaydedin ve gerekirse klasörü oluşturun.",
    outputFolderPlaceholder: "PDF Dışa Aktarımları",
    pdfNameLabel: "PDF adı",
    exportPdfButton: "PDF'yi dışa aktar",
    cancelButton: "Diğer biçimler",
    busyExporting: "PDF dışa aktarılıyor",
    busyCancelButton: "Dışa aktarmayı iptal et",
    busyCancelledTitle: "Dışa aktarma iptal edildi",
    busyCancelledStatus: "PDF kaydedilmedi.",
    busyCompleteTitle: "Dışa aktarma tamamlandı",
    busyCompleteStatus: "Tamamlandı",
    busyFailedTitle: "PDF dışa aktarma başarısız",
    busyElapsedShort: "{seconds} sn geçti",
    busyElapsedLong: "{seconds} sn geçti. İşlem sürüyor; Obsidian'ı kapatmayın.",
    settingsIntro: "Menüler ve düğmeler önce PDF dışa aktarma seçeneklerini açar. Normal Markdown notları seçilebilir metin PDF'si veya görüntü PDF'si olarak dışa aktarılabilir.",
    settingsGeneralHeading: "Genel",
    settingsNoteOptionsHeading: "Normal not PDF seçenekleri",
    pageSizeDesc: "Mobil uzun sayfa telefonda okumaya uygundur. A4/A5/Letter yazdırma ve arşivleme için kullanışlıdır.",
    orientationDesc: "Yatay yönlendirme sayfa genişliği ile yüksekliğini değiştirir.",
    colorDesc: "Gri tonlama yazdırma için kullanışlıdır; renkli mod tema, bağlantı ve görüntü renklerini korur.",
    settingsSaveAndShareHeading: "Kaydetme ve paylaşma",
    languageName: "Arayüz dili",
    languageDesc: "Otomatik seçenek Obsidian dilini izler. Düğmeler, menüler, komutlar, seçenekler ve iletiler seçilen dili kullanır.",
    languageAuto: "Otomatik / Obsidian'ı izle",
    languageChinese: "Çince",
    languageEnglish: "İngilizce",
    formatPngLabel: "PNG görüntüsü",
    codesTitle: "Bana bir kahve ısmarla",
    codesSubtitle: "Bu araç işinize yarıyorsa desteğiniz bakımın sürmesine yardımcı olur.",
    shareFailedNotice: "PDF kaydedildi, ancak sistem paylaşım paneli açılmadı.",
    fontMissingError: "PDF yazı tipi eksik ve eklenti bunu GitHub'dan indiremedi. Çevrimiçi olarak yeniden deneyin veya NotoSansSC-Regular.gb2312-subset.ttf dosyasını eklentinin fonts klasörüne yerleştirin.",
    uniqueFileNameError: "Benzersiz bir PDF dosya adı oluşturulamadı.",
    excalidrawApiMissingError: "Excalidraw dışa aktarma API'si bulunamadı. Excalidraw eklentisinin etkin olduğundan emin olun.",
    excalidrawExportFailedError: "Excalidraw görüntüsü çok büyüktü veya dışa aktarma başarısız oldu. Daha düşük çözünürlükler ve sayfa bölme zaten denendi.",
    excalidrawPngNoImageError: "PNG {scale}x görüntü döndürmedi.",
    lastErrorLabel: "Son hata: {error}",
    noUsableImageError: "Kullanılabilir bir görüntü oluşturulamadı.",
    excalidrawPreviewUnavailable: "Excalidraw önizlemesi kullanılamadığı için kaynak veriler atlandı.",
    previewNoExportSizeError: "Önizleme katmanının dışa aktarılabilir boyutu yok.",
    previewNoContentError: "Önizlemede dışa aktarılabilir içerik yok.",
    pdfRuntimeMissingError: "PDF motoru henüz yüklenmedi.",
    fontkitMissingError: "fontkit.create kullanılamadığı için PDF yazı tipi başlatılamadı.",
    imagePdfCanvasError: "canvas kullanılamadığı için görüntü PDF oluşturulamadı.",
    imageSliceError: "canvas kullanılamadığı için görüntü dilimlenemedi."
  },
  vi: {
    ribbonTitle: "Xuất PDF xem trước",
    commandName: "Mobile PDF Exporter: Xuất PDF xem trước",
    noMarkdownNotice: "Hãy mở một tệp có thể xuất trước.",
    optionsTitle: "Tùy chọn xuất PDF",
    exportModeName: "Chế độ xuất",
    exportModeDesc: "Văn bản có thể chọn phù hợp để đọc, tìm kiếm và sao chép; PDF dạng ảnh giữ nguyên bố cục hiển thị.",
    exportModeSelectable: "Văn bản có thể chọn",
    exportModeImage: "PDF dạng ảnh",
    pageSizeName: "Kích thước trang",
    pageSizeCurrent: "Kích thước trang hiện tại (mặc định)",
    pageSizeMobile: "Trang dài cho di động 104 x 225 mm",
    orientationName: "Hướng trang",
    orientationPortrait: "Dọc",
    orientationLandscape: "Ngang",
    colorName: "Màu sắc",
    colorOption: "Màu",
    grayscaleOption: "Thang xám",
    marginName: "Lề",
    contentScaleName: "Tỷ lệ nội dung",
    imageQualityName: "Chất lượng PDF dạng ảnh",
    imageQualityDesc: "Chỉ ảnh hưởng đến PDF dạng ảnh của ghi chú thông thường. Chất lượng cao hơn tạo tệp lớn hơn.",
    imageQualityStandard: "Tiêu chuẩn / tệp nhỏ hơn",
    imageQualityClear: "Rõ / khuyến nghị",
    imageQualityHigh: "Cao",
    imageQualityUltra: "Siêu cao / tệp lớn",
    includeTitleName: "Bao gồm tiêu đề ghi chú",
    headerTextName: "Đầu trang",
    headerTextDesc: "Để trống để tắt. Hỗ trợ {title}, {page}, {pages} và {date}.",
    footerTextName: "Chân trang",
    footerTextDesc: "Để trống để tắt. Hỗ trợ {title}, {page}, {pages} và {date}.",
    openAfterExportName: "Mở sau khi xuất",
    openAfterExportDesc: "Mở tệp đã tạo khi quá trình xuất hoàn tất.",
    shareAfterExportName: "Hiện bảng chia sẻ trên di động",
    rememberLastExportOptionsName: "Dùng tùy chọn xuất gần nhất",
    rememberLastExportOptionsDesc: "Bật theo mặc định. Lưu các tùy chọn của lần xuất này để dùng lần sau.",
    outputLocationName: "Vị trí xuất",
    outputLocationCurrent: "Thư mục ghi chú hiện tại (mặc định)",
    outputLocationFolder: "Thư mục tùy chỉnh",
    outputLocationCurrentDesc: "Lưu PDF bên cạnh ghi chú hiện tại.",
    outputLocationFolderDesc: "Lưu PDF vào thư mục tùy chỉnh trong kho và tạo thư mục khi cần.",
    outputFolderPlaceholder: "Tệp PDF đã xuất",
    pdfNameLabel: "Tên PDF",
    exportPdfButton: "Xuất PDF",
    cancelButton: "Định dạng khác",
    busyExporting: "Đang xuất PDF",
    busyCancelButton: "Hủy xuất",
    busyCancelledTitle: "Đã hủy xuất",
    busyCancelledStatus: "Không có PDF nào được lưu.",
    busyCompleteTitle: "Xuất hoàn tất",
    busyCompleteStatus: "Hoàn tất",
    busyFailedTitle: "Xuất PDF thất bại",
    busyElapsedShort: "Đã qua {seconds} giây",
    busyElapsedLong: "Đã qua {seconds} giây. Vẫn đang xử lý; đừng đóng Obsidian.",
    settingsIntro: "Menu và nút sẽ mở tùy chọn xuất PDF trước. Ghi chú Markdown thông thường có thể được xuất thành PDF văn bản có thể chọn hoặc PDF dạng ảnh.",
    settingsGeneralHeading: "Chung",
    settingsNoteOptionsHeading: "Tùy chọn PDF cho ghi chú thông thường",
    pageSizeDesc: "Trang dài phù hợp để đọc trên điện thoại. A4/A5/Letter hữu ích cho in và lưu trữ.",
    orientationDesc: "Hướng ngang hoán đổi chiều rộng và chiều cao của trang.",
    colorDesc: "Thang xám phù hợp để in; chế độ màu giữ màu chủ đề, liên kết và hình ảnh.",
    settingsSaveAndShareHeading: "Lưu và chia sẻ",
    languageName: "Ngôn ngữ giao diện",
    languageDesc: "Tự động sẽ theo ngôn ngữ của Obsidian. Nút, menu, lệnh, tùy chọn và thông báo dùng ngôn ngữ đã chọn.",
    languageAuto: "Tự động / theo Obsidian",
    languageChinese: "Tiếng Trung",
    languageEnglish: "Tiếng Anh",
    formatPngLabel: "Ảnh PNG",
    codesTitle: "Mời tôi một ly cà phê",
    codesSubtitle: "Nếu công cụ này hữu ích, sự ủng hộ của bạn giúp duy trì việc phát triển.",
    shareFailedNotice: "PDF đã được lưu nhưng bảng chia sẻ của hệ thống không mở.",
    fontMissingError: "Thiếu phông chữ PDF và plugin không thể tải xuống từ GitHub. Hãy thử lại khi có mạng hoặc đặt NotoSansSC-Regular.gb2312-subset.ttf vào thư mục fonts của plugin.",
    uniqueFileNameError: "Không thể tạo tên tệp PDF duy nhất.",
    excalidrawApiMissingError: "Không tìm thấy API xuất của Excalidraw. Hãy chắc chắn plugin Excalidraw đã được bật.",
    excalidrawExportFailedError: "Ảnh Excalidraw quá lớn hoặc xuất thất bại. Đã thử độ phân giải thấp hơn và chia trang.",
    excalidrawPngNoImageError: "PNG {scale}x không trả về hình ảnh.",
    lastErrorLabel: "Lỗi gần nhất: {error}",
    noUsableImageError: "Không tạo được hình ảnh có thể sử dụng.",
    excalidrawPreviewUnavailable: "Không có bản xem trước Excalidraw nên dữ liệu nguồn đã bị bỏ qua.",
    previewNoExportSizeError: "Lớp xem trước không có kích thước có thể xuất.",
    previewNoContentError: "Bản xem trước không có nội dung có thể xuất.",
    pdfRuntimeMissingError: "Bộ máy PDF chưa được tải.",
    fontkitMissingError: "Không thể khởi tạo phông chữ PDF vì fontkit.create không khả dụng.",
    imagePdfCanvasError: "Không thể kết xuất PDF dạng ảnh vì canvas không khả dụng.",
    imageSliceError: "Không thể cắt ảnh vì canvas không khả dụng."
  },
  th: {
    ribbonTitle: "ส่งออก PDF ตัวอย่าง",
    commandName: "Mobile PDF Exporter: ส่งออก PDF ตัวอย่าง",
    noMarkdownNotice: "เปิดไฟล์ที่สามารถส่งออกได้ก่อน",
    optionsTitle: "ตัวเลือกการส่งออก PDF",
    exportModeName: "โหมดการส่งออก",
    exportModeDesc: "ข้อความที่เลือกได้เหมาะสำหรับอ่าน ค้นหา และคัดลอก ส่วน PDF แบบภาพจะคงรูปแบบการแสดงผลไว้",
    exportModeSelectable: "ข้อความที่เลือกได้",
    exportModeImage: "PDF แบบภาพ",
    pageSizeName: "ขนาดหน้า",
    pageSizeCurrent: "ขนาดหน้าปัจจุบัน (ค่าเริ่มต้น)",
    pageSizeMobile: "หน้ายาวสำหรับมือถือ 104 x 225 มม.",
    orientationName: "การวางแนว",
    orientationPortrait: "แนวตั้ง",
    orientationLandscape: "แนวนอน",
    colorName: "สี",
    colorOption: "สี",
    grayscaleOption: "ระดับสีเทา",
    marginName: "ระยะขอบ",
    contentScaleName: "มาตราส่วนเนื้อหา",
    imageQualityName: "คุณภาพ PDF แบบภาพ",
    imageQualityDesc: "มีผลเฉพาะ PDF แบบภาพของโน้ตทั่วไป คุณภาพสูงขึ้นจะทำให้ไฟล์ใหญ่ขึ้น",
    imageQualityStandard: "มาตรฐาน / ไฟล์เล็กกว่า",
    imageQualityClear: "ชัดเจน / แนะนำ",
    imageQualityHigh: "สูง",
    imageQualityUltra: "สูงสุด / ไฟล์ใหญ่",
    includeTitleName: "รวมชื่อโน้ต",
    headerTextName: "หัวกระดาษ",
    headerTextDesc: "เว้นว่างเพื่อปิดใช้งาน รองรับ {title}, {page}, {pages} และ {date}",
    footerTextName: "ท้ายกระดาษ",
    footerTextDesc: "เว้นว่างเพื่อปิดใช้งาน รองรับ {title}, {page}, {pages} และ {date}",
    openAfterExportName: "เปิดหลังส่งออก",
    openAfterExportDesc: "เปิดไฟล์ที่สร้างขึ้นเมื่อส่งออกเสร็จ",
    shareAfterExportName: "แสดงแผงแชร์บนมือถือ",
    rememberLastExportOptionsName: "ใช้ตัวเลือกการส่งออกครั้งล่าสุด",
    rememberLastExportOptionsDesc: "เปิดตามค่าเริ่มต้น บันทึกตัวเลือกของการส่งออกนี้ไว้ใช้ครั้งถัดไป",
    outputLocationName: "ตำแหน่งส่งออก",
    outputLocationCurrent: "โฟลเดอร์ของโน้ตปัจจุบัน (ค่าเริ่มต้น)",
    outputLocationFolder: "โฟลเดอร์กำหนดเอง",
    outputLocationCurrentDesc: "บันทึก PDF ไว้ข้างโน้ตปัจจุบัน",
    outputLocationFolderDesc: "บันทึก PDF ในโฟลเดอร์กำหนดเองภายในคลัง และสร้างโฟลเดอร์เมื่อจำเป็น",
    outputFolderPlaceholder: "ไฟล์ PDF ที่ส่งออก",
    pdfNameLabel: "ชื่อ PDF",
    exportPdfButton: "ส่งออก PDF",
    cancelButton: "รูปแบบอื่น",
    busyExporting: "กำลังส่งออก PDF",
    busyCancelButton: "ยกเลิกการส่งออก",
    busyCancelledTitle: "ยกเลิกการส่งออกแล้ว",
    busyCancelledStatus: "ไม่ได้บันทึก PDF",
    busyCompleteTitle: "ส่งออกเสร็จแล้ว",
    busyCompleteStatus: "เสร็จสิ้น",
    busyFailedTitle: "ส่งออก PDF ไม่สำเร็จ",
    busyElapsedShort: "ผ่านไป {seconds} วินาที",
    busyElapsedLong: "ผ่านไป {seconds} วินาที ยังประมวลผลอยู่ โปรดอย่าปิด Obsidian",
    settingsIntro: "เมนูและปุ่มจะเปิดตัวเลือกการส่งออก PDF ก่อน โน้ต Markdown ทั่วไปสามารถส่งออกเป็น PDF ข้อความที่เลือกได้หรือ PDF แบบภาพ",
    settingsGeneralHeading: "ทั่วไป",
    settingsNoteOptionsHeading: "ตัวเลือก PDF สำหรับโน้ตทั่วไป",
    pageSizeDesc: "หน้ายาวเหมาะสำหรับอ่านบนโทรศัพท์ ส่วน A4/A5/Letter เหมาะสำหรับพิมพ์และเก็บถาวร",
    orientationDesc: "แนวนอนจะสลับความกว้างและความสูงของหน้า",
    colorDesc: "ระดับสีเทาเหมาะสำหรับพิมพ์ ส่วนโหมดสีจะคงสีธีม ลิงก์ และรูปภาพไว้",
    settingsSaveAndShareHeading: "บันทึกและแชร์",
    languageName: "ภาษาของส่วนติดต่อ",
    languageDesc: "อัตโนมัติจะใช้ภาษาของ Obsidian ปุ่ม เมนู คำสั่ง ตัวเลือก และข้อความจะใช้ภาษาที่เลือก",
    languageAuto: "อัตโนมัติ / ตาม Obsidian",
    languageChinese: "ภาษาจีน",
    languageEnglish: "ภาษาอังกฤษ",
    formatPngLabel: "ภาพ PNG",
    codesTitle: "เลี้ยงกาแฟฉัน",
    codesSubtitle: "หากเครื่องมือนี้มีประโยชน์ การสนับสนุนของคุณช่วยให้ดูแลต่อไปได้",
    shareFailedNotice: "บันทึก PDF แล้ว แต่แผงแชร์ของระบบไม่เปิด",
    fontMissingError: "ไม่พบแบบอักษร PDF และปลั๊กอินดาวน์โหลดจาก GitHub ไม่ได้ โปรดลองอีกครั้งเมื่อออนไลน์ หรือวาง NotoSansSC-Regular.gb2312-subset.ttf ไว้ในโฟลเดอร์ fonts ของปลั๊กอิน",
    uniqueFileNameError: "ไม่สามารถสร้างชื่อไฟล์ PDF ที่ไม่ซ้ำได้",
    excalidrawApiMissingError: "ไม่พบ API ส่งออกของ Excalidraw โปรดตรวจสอบว่าเปิดใช้ปลั๊กอิน Excalidraw แล้ว",
    excalidrawExportFailedError: "ภาพ Excalidraw ใหญ่เกินไปหรือส่งออกไม่สำเร็จ ได้ลองลดความละเอียดและแบ่งหน้าแล้ว",
    excalidrawPngNoImageError: "PNG {scale}x ไม่ส่งคืนภาพ",
    lastErrorLabel: "ข้อผิดพลาดล่าสุด: {error}",
    noUsableImageError: "ไม่สามารถสร้างภาพที่ใช้งานได้",
    excalidrawPreviewUnavailable: "ไม่สามารถใช้ตัวอย่าง Excalidraw ได้ จึงข้ามข้อมูลต้นฉบับ",
    previewNoExportSizeError: "เลเยอร์ตัวอย่างไม่มีขนาดที่ส่งออกได้",
    previewNoContentError: "ตัวอย่างไม่มีเนื้อหาที่ส่งออกได้",
    pdfRuntimeMissingError: "ยังไม่ได้โหลดเครื่องมือ PDF",
    fontkitMissingError: "เริ่มต้นแบบอักษร PDF ไม่สำเร็จ เนื่องจากไม่มี fontkit.create",
    imagePdfCanvasError: "แสดงผล PDF แบบภาพไม่สำเร็จ เนื่องจากไม่มี canvas",
    imageSliceError: "แบ่งภาพไม่สำเร็จ เนื่องจากไม่มี canvas"
  }
} as const;

type TranslationKey = keyof typeof UI_TEXT.en;

const DEFAULT_SETTINGS: MobilePdfExporterSettings = {
  language: "auto",
  outputLocation: "current",
  outputFolder: "PDF Exports",
  marginMm: 7,
  includeTitle: true,
  headerText: "",
  footerText: "",
  rememberLastExportOptions: true,
  shareAfterExport: true,
  openAfterExport: true,
  noteExportMode: "selectable",
  pagePreset: "current",
  pageOrientation: "portrait",
  colorMode: "color",
  contentScalePercent: 100,
  imageRasterScale: 3,
  currentPageWidthPx: 794,
  currentPageHeightPx: 1123,
  zipEmbedDepth: 0
};

const PDF_PAGE_SIZES_MM: Record<PdfPagePreset, PdfPageSizeMm> = {
  current: { width: 210, height: 297 },
  mobile: { width: 104, height: 225 },
  a4: { width: 210, height: 297 },
  a5: { width: 148, height: 210 },
  letter: { width: 215.9, height: 279.4 }
};

const PDF_SUBJECT = "Selectable preview PDF exported from Obsidian";
const IMAGE_PDF_SUBJECT = "Image preview PDF exported from Obsidian";
const EXCALIDRAW_IMAGE_PDF_SUBJECT = "Image PDF exported from Obsidian Excalidraw";
const MAX_SVG_FRAGMENTS_PER_PAGE = 24;
const SVG_IMAGE_LOAD_TIMEOUT_MS = 1800;
const IMAGE_WAIT_TIMEOUT_MS = 2500;
const REMOTE_IMAGE_CORS_TIMEOUT_MS = 5000;
const REMOTE_IMAGE_REQUEST_TIMEOUT_MS = 6000;
const PREVIEW_RENDER_TIMEOUT_MS = 12000;
const EXCALIDRAW_IMAGE_RENDER_TIMEOUT_MS = 45000;
const EXCALIDRAW_IMAGE_LOAD_TIMEOUT_MS = 15000;
const EXCALIDRAW_MIN_EXPORT_SCALE = 0.5;
const EXCALIDRAW_PREFERRED_MAX_PNG_BYTES = 24 * 1024 * 1024;
const EXCALIDRAW_MAX_SLICE_WIDTH_PX = 4096;
const EXCALIDRAW_MAX_SLICE_HEIGHT_PX = 8192;
const EXCALIDRAW_MAX_SLICE_PIXELS = 16_000_000;
const PREVIEW_IMAGE_MAX_CANVAS_PIXELS = 12_000_000;
const FRAME_WAIT_TIMEOUT_MS = 120;
const BUSY_PROMPT_PAINT_WAIT_MS = 80;
const PAGE_BREAK_PADDING_PX = 8;
const PAGE_BREAK_MIN_ADVANCE_PX = 72;
const HEADER_FOOTER_MIN_BAND_MM = 8;
const HEADER_FOOTER_FONT_SIZE_PX = 10;
const SELECTABLE_PREVIEW_BACKGROUND_MIN_SCALE = 2;
const SELECTABLE_TEXT_LAYER_OPACITY = 1;
const NOTE_DOODLE_MAX_PEN_COUNT = 5;
const NOTE_DOODLE_DEFAULT_OPACITY = 1;
const NOTE_DOODLE_WATERCOLOR = "watercolor";
const CJK_FONT_ASSET_FILE = "NotoSansSC-Regular.gb2312-subset.ttf";
const EMBEDDED_SCRIPT_FONT_BASE64: Record<Exclude<PdfScriptFont, "default">, string> = {
  latin: embeddedLatinFontGzipBase64,
  arabic: embeddedArabicFontGzipBase64,
  hebrew: embeddedHebrewFontGzipBase64,
  devanagari: embeddedDevanagariFontGzipBase64,
  thai: embeddedThaiFontGzipBase64
};
const CJK_FONT_RAW_ASSET_URL_BASE = "https://raw.githubusercontent.com/arias007/obsidian-mobile-pdf-exporter";
const CJK_FONT_JSDELIVR_URL_BASE = "https://cdn.jsdelivr.net/gh/arias007/obsidian-mobile-pdf-exporter";
const LOCAL_CJK_FONT_CANDIDATES = [
  `fonts/${CJK_FONT_ASSET_FILE}`,
  CJK_FONT_ASSET_FILE,
  "fonts/SimHei.ttf",
  "fonts/NotoSansSC-Regular.otf"
] as const;
const SETTINGS_EXTRA_CODE_ASSETS = [
  { src: `data:image/jpeg;base64,${supportCode1Base64}`, labelKey: "codesTitle", fileName: "buy-me-a-coffee.jpg" },
  { src: `data:image/png;base64,${supportCode2Base64}`, labelKey: "codesSubtitle", fileName: "support-this-tool.png" }
] as const;

class ExportCancelledError extends Error {
  constructor() {
    super("PDF export cancelled");
    this.name = "AbortError";
  }
}

function throwIfExportCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportCancelledError();
}

function isExportCancelledError(error: unknown): boolean {
  return error instanceof ExportCancelledError || (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error instanceof Error && error.name === "AbortError"
  );
}

function resolveUiLanguage(language: UiLanguage): ResolvedUiLanguage {
  if (language !== "auto") return language;
  const browserLanguage = (activeWindow.navigator.language || "").toLowerCase();
  const browserLanguages = (activeWindow.navigator.languages || []).map((item) => item.toLowerCase());
  for (const candidate of [browserLanguage, ...browserLanguages]) {
    const matched = UI_LANGUAGES.find((languageCode) => languageCode !== "auto" && candidate.startsWith(languageCode));
    if (matched && matched !== "auto") return matched;
  }
  return "en";
}

function translate(language: ResolvedUiLanguage, key: TranslationKey): string {
  return UI_TEXT[language][key];
}

function formatTranslation(
  language: ResolvedUiLanguage,
  key: TranslationKey,
  values: Record<string, string | number>
): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    translate(language, key)
  );
}

let runtimeUiLanguage: ResolvedUiLanguage = "en";

function getPageLabel(preset: PdfPagePreset, language: ResolvedUiLanguage): string {
  switch (preset) {
    case "current":
      return translate(language, "pageSizeCurrent");
    case "mobile":
      return translate(language, "pageSizeMobile");
    case "a4":
      return "A4 210 x 297 mm";
    case "a5":
      return "A5 148 x 210 mm";
    case "letter":
      return "Letter 8.5 x 11 in";
  }
}

function formatBusyElapsed(language: ResolvedUiLanguage, seconds: number): string {
  return formatTranslation(language, seconds >= 8 ? "busyElapsedLong" : "busyElapsedShort", { seconds });
}

type RegisteredFontkit = Parameters<PDFDocument["registerFontkit"]>[0];
type FontkitModuleShape = Partial<RegisteredFontkit> & { default?: Partial<RegisteredFontkit> };
type PdfLibRuntime = typeof import("pdf-lib");
type PdfFontkitRuntime = typeof import("@pdf-lib/fontkit");
interface PdfRuntime {
  PDFDocument: PdfLibRuntime["PDFDocument"];
  PDFString: PdfLibRuntime["PDFString"];
  StandardFonts: PdfLibRuntime["StandardFonts"];
  rgb: PdfLibRuntime["rgb"];
  fontkitModule: PdfFontkitRuntime;
}

interface ExportFont {
  font: PDFFont;
  supportsUnicode: boolean;
}

type PdfScriptFont = "default" | "latin" | "arabic" | "hebrew" | "devanagari" | "thai";

interface ExportFontSet {
  default: PDFFont;
  fallbacks: Partial<Record<Exclude<PdfScriptFont, "default">, PDFFont>>;
}

let pdfRuntimePromise: Promise<PdfRuntime> | null = null;
let pdfStringRuntime: PdfLibRuntime["PDFString"] | null = null;
let exportableElementCache: WeakMap<Element, boolean> | null = null;
const pdfCharEncodingCache = new WeakMap<PDFFont, Map<string, boolean>>();
const embeddedScriptFontBytes = new Map<PdfScriptFont, Promise<ArrayBuffer>>();
let pdfInkAnnotationSerial = 0;
let rgb: PdfLibRuntime["rgb"] = ((red: number, green: number, blue: number) => ({
  type: "RGB",
  red,
  green,
  blue
}) as Color) as PdfLibRuntime["rgb"];

async function loadPdfRuntime(): Promise<PdfRuntime> {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([import("pdf-lib"), import("@pdf-lib/fontkit")]).then(([pdfLib, fontkit]) => {
      const runtime: PdfRuntime = {
        PDFDocument: pdfLib.PDFDocument,
        PDFString: pdfLib.PDFString,
        StandardFonts: pdfLib.StandardFonts,
        rgb: pdfLib.rgb,
        fontkitModule: fontkit
      };
      rgb = runtime.rgb;
      pdfStringRuntime = runtime.PDFString;
      return runtime;
    });
  }
  return pdfRuntimePromise;
}

function getPdfStringRuntime(): PdfLibRuntime["PDFString"] {
  if (!pdfStringRuntime) {
    throw new Error(translate(runtimeUiLanguage, "pdfRuntimeMissingError"));
  }
  return pdfStringRuntime;
}

export default class MobilePdfExporterPlugin extends Plugin {
  settings: MobilePdfExporterSettings = DEFAULT_SETTINGS;
  private fontBytesPromise: Promise<ArrayBuffer> | null = null;
  private ribbonIconEl: HTMLElement | null = null;
  private exportCommand: { name: string } | null = null;
  private zipVaultFileIndex: TFile[] | null = null;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());

    this.ribbonIconEl = this.addRibbonIcon("file-output", this.t("ribbonTitle"), () => {
      void this.exportCurrentFile();
    });

    this.exportCommand = this.addCommand({
      id: "export-current-note-preview-pdf",
      name: this.t("commandName"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.openExportOptionsModal(file);
        return true;
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        menu.addItem((item) => {
          item
            .setTitle(this.t("ribbonTitle"))
            .setIcon("file-output")
            .onClick(() => this.openExportOptionsModal(file));
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        menu.addItem((item) => {
          item
            .setTitle(this.t("ribbonTitle"))
            .setIcon("file-output")
            .onClick(() => this.openExportOptionsModal(file));
        });
      })
    );

    this.addSettingTab(new MobilePdfExporterSettingTab(this.app, this));
    this.refreshLocalizedActions();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getResolvedLanguage(): ResolvedUiLanguage {
    runtimeUiLanguage = resolveUiLanguage(this.settings.language);
    return runtimeUiLanguage;
  }

  t(key: TranslationKey): string {
    return translate(this.getResolvedLanguage(), key);
  }

  refreshLocalizedActions(): void {
    const title = this.t("ribbonTitle");
    this.ribbonIconEl?.setAttribute("aria-label", title);
    this.ribbonIconEl?.setAttribute("title", title);
    if (this.exportCommand) this.exportCommand.name = this.t("commandName");
  }

  async exportCurrentFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice(this.t("noMarkdownNotice"));
      return;
    }

    this.openExportOptionsModal(file);
  }

  openExportOptionsModal(file: TFile): void {
    this.refreshCurrentPageSizeFromActiveSurface(file);
    new MobilePdfExportOptionsModal(this.app, this, file).open();
  }

  private refreshCurrentPageSizeFromActiveSurface(file: TFile): void {
    if (this.settings.pagePreset !== "current") return;
    const surface = this.getActiveExportSurface(file);
    if (!surface) return;
    const rect = surface.rootEl.getBoundingClientRect();
    this.settings.currentPageWidthPx = clampNumber(
      Math.max(surface.scrollEl.clientWidth || 0, rect.width || 0),
      240,
      4096,
      DEFAULT_SETTINGS.currentPageWidthPx
    );
    this.settings.currentPageHeightPx = clampNumber(
      Math.max(surface.scrollEl.clientHeight || 0, rect.height || 0),
      240,
      8192,
      DEFAULT_SETTINGS.currentPageHeightPx
    );
  }

  warmupExportRuntime(): void {
    void loadPdfRuntime().catch((error) => {
      console.warn("Mobile PDF Exporter PDF runtime warmup failed", error);
    });
  }

  async exportFile(file: TFile, exportSettings?: MobilePdfExporterSettings, options: ExportFileOptions = {}): Promise<void> {
    const previousSettings = this.settings;
    if (exportSettings) this.settings = cloneSettings(exportSettings);
    this.refreshCurrentPageSizeFromActiveSurface(file);
    const exportingPrompt = options.busyPrompt ?? new PdfExportBusyPrompt(file.basename, this.getResolvedLanguage());
    const signal = options.signal ?? exportingPrompt.signal;
    let rendered: RenderedPreview | null = null;
    let writtenOutputPath: string | null = null;

    try {
      await exportingPrompt.waitUntilPainted();
      throwIfExportCancelled(signal);
      cleanupRenderRoots();
      const format = options.format ?? "pdf";
      const isMarkdown = file.extension.toLowerCase() === "md";
      const markdown = isMarkdown ? await this.app.vault.cachedRead(file) : "";
      const noteDrawSource = options.noteDrawSourcePath
        ? this.app.vault.getAbstractFileByPath(normalizePath(options.noteDrawSourcePath))
        : file;
      const noteDrawFile = noteDrawSource instanceof TFile ? noteDrawSource : file;
      throwIfExportCancelled(signal);
      let outputBlob: Blob;
      let model: PreviewPdfModel | null = null;
      if (format === "zip" && isMarkdown) {
        outputBlob = await this.exportNotesToZip(file, markdown, options.zipEmbedDepth ?? this.settings.zipEmbedDepth, signal);
      } else if (format === "html" && isMarkdown) {
        rendered = await this.renderMarkdownPreview(file, markdown, "html");
        const noteDrawHost = rendered.pageEl.querySelector<HTMLElement>(".markdown-preview-view") ?? rendered.pageEl;
        const preparedNoteDraw = await this.prepareNoteDrawExportOverlay(noteDrawFile, noteDrawHost);
        try {
          await nextAnimationFrame();
          outputBlob = await buildRenderedDomHtml(
            this.app,
            file,
            rendered.pageEl,
            noteDrawHost,
            preparedNoteDraw,
            signal
          );
        } finally {
          preparedNoteDraw.cleanup();
        }
      } else if (format === "pdf" && isMarkdown && isExcalidrawMarkdownFile(file, markdown)) {
        outputBlob = await this.renderExcalidrawToImagePdf(file, signal);
      } else {
        const liveSurface = this.getActiveExportSurface(file);
        if (liveSurface) {
          model = await this.captureLiveViewPdfModel(file, liveSurface, signal);
        } else if (isMarkdown) {
          rendered = await this.renderMarkdownPreview(file, markdown);
          throwIfExportCancelled(signal);
          const noteDrawHost = rendered.pageEl.querySelector<HTMLElement>(".markdown-preview-view") ?? rendered.pageEl;
          const preparedNoteDraw = await this.prepareNoteDrawExportOverlay(noteDrawFile, noteDrawHost);
          try {
            await nextAnimationFrame();
            model = this.capturePreviewPdfModel(file, rendered.pageEl);
            const pageRect = rendered.pageEl.getBoundingClientRect();
            const hostRect = noteDrawHost.getBoundingClientRect();
            attachPreparedNoteDrawToModel(model, preparedNoteDraw, {
              offsetX: hostRect.left - pageRect.left,
              offsetY: hostRect.top - pageRect.top,
              scale: 1,
              linkContext: createPdfLinkContext(this.app, file)
            });
          } finally {
            preparedNoteDraw.cleanup();
          }
        } else {
          throw new Error(this.t("previewNoContentError"));
        }
        outputBlob = await this.renderModelToFormat(file, model, format, signal);
      }

      throwIfExportCancelled(signal);
      const outputFolder = resolveOutputFolder(file, this.settings);
      await this.ensureFolderExists(outputFolder);
      throwIfExportCancelled(signal);
      const outputPath = await this.getAvailableOutputPath(file, outputFolder, options.outputBaseName, format);
      throwIfExportCancelled(signal);
      await this.app.vault.adapter.writeBinary(outputPath, await outputBlob.arrayBuffer());
      writtenOutputPath = outputPath;
      throwIfExportCancelled(signal);

      if (this.settings.openAfterExport) {
        await this.app.workspace.openLinkText(outputPath, file.path, true);
      }

      throwIfExportCancelled(signal);
      if (this.settings.shareAfterExport) {
        await this.shareFileIfAvailable(outputBlob, outputPath);
      }
      exportingPrompt.done();
    } catch (error) {
      if (isExportCancelledError(error)) {
        if (writtenOutputPath && await this.app.vault.adapter.exists(writtenOutputPath)) {
          await this.app.vault.adapter.remove(writtenOutputPath).catch((cleanupError) => {
            console.warn("Mobile PDF Exporter could not remove a cancelled export", cleanupError);
          });
        }
        exportingPrompt.markCancelled();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("Mobile PDF Exporter failed", error);
      exportingPrompt.fail(message);
    } finally {
      if (rendered) {
        rendered.renderComponent.unload();
        rendered.rootEl.remove();
      }
      exportingPrompt.closeSoon();
      this.settings = previousSettings;
    }
  }

  private async exportNotesToZip(
    sourceFile: TFile,
    sourceMarkdown: string,
    embedDepth: number,
    signal?: AbortSignal
  ): Promise<Blob> {
    throwIfExportCancelled(signal);
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    // Refresh the vault file index for this export run so link fallbacks stay accurate.
    this.zipVaultFileIndex = null;

    // Collect all notes recursively
    type CollectedNote = {
      content: string;
      originalPath: string;
      level: number;
      zipName: string;
      zipPath: string;
    };
    type CollectedAsset = {
      file: TFile;
      level: number;
      zipName: string;
      zipPath: string;
    };

    const collected = new Map<string, CollectedNote>();
    const assetFiles = new Map<string, CollectedAsset>();
    const visited = new Set<string>();
    const usedZipPaths = new Set<string>();
    const remoteRefLevels = new Map<string, number>();

    // The source note (level 0) lives at the archive root. Every other collected file is nested
    // under src/levelN where N is its collection depth.
    const folderForLevel = (level: number): string => (level <= 0 ? "" : `src/level${level}`);

    const uniqueZipName = (baseName: string, extension: string, folder: string): string => {
      const suffix = extension ? `.${extension}` : "";
      const prefix = folder ? `${folder.replace(/\/$/u, "")}/` : "";
      let candidate = baseName;
      let counter = 1;
      while (usedZipPaths.has(`${prefix}${candidate}${suffix}`.toLowerCase())) {
        candidate = `${baseName}-${counter}`;
        counter += 1;
      }
      usedZipPaths.add(`${prefix}${candidate}${suffix}`.toLowerCase());
      return candidate;
    };

    const buildNoteEntry = (file: TFile, level: number): CollectedNote => {
      const ext = file.extension ? `.${file.extension}` : "";
      const name = uniqueZipName(file.basename, file.extension, folderForLevel(level));
      const folder = folderForLevel(level);
      const zipPath = folder ? `${folder}/${name}${ext}` : `${name}${ext}`;
      return { content: "", originalPath: file.path, level, zipName: name, zipPath };
    };

    const registerAsset = (file: TFile, level: number): void => {
      const key = normalizePath(file.path);
      if (assetFiles.has(key)) return;
      const ext = file.extension ? `.${file.extension}` : "";
      const name = uniqueZipName(file.basename, file.extension, folderForLevel(level));
      const folder = folderForLevel(level);
      const zipPath = folder ? `${folder}/${name}${ext}` : `${name}${ext}`;
      assetFiles.set(key, { file, level, zipName: name, zipPath });
    };

    const collectNote = async (file: TFile, level: number): Promise<void> => {
      throwIfExportCancelled(signal);
      const normalizedPath = normalizePath(file.path);
      if (visited.has(normalizedPath)) return;
      visited.add(normalizedPath);

      const content = file.path === sourceFile.path ? sourceMarkdown : await this.app.vault.cachedRead(file);
      const entry = buildNoteEntry(file, level);
      entry.content = content;
      collected.set(normalizedPath, entry);

      if (level >= embedDepth + 1) return;

      const isSourceNote = file.path === sourceFile.path;
      // The source note (level 0): at depth 0 only visible embeds are pulled in; at any higher
      // depth every link on the source note is exported so any link can be opened. Deeper notes
      // always export every link they contain.
      const links = this.parseMarkdownLinks(content);
      for (const link of links) {
        const shouldCollect = isSourceNote ? (embedDepth === 0 ? link.isEmbed : true) : true;
        if (!shouldCollect) continue;

        const maybeRemote = link.target.replace(/^<|>$/gu, "");
        if (isRemoteHttpUrl(maybeRemote)) {
          const url = normalizeRemoteUrl(maybeRemote);
          if (url) {
            const prev = remoteRefLevels.get(url);
            remoteRefLevels.set(url, prev === undefined ? level + 1 : Math.min(prev, level + 1));
          }
          continue;
        }

        const targetFile = this.resolveMarkdownLink(link.target, file.path);
        if (!targetFile) continue;
        if (targetFile.extension.toLowerCase() === "md") {
          if (!visited.has(normalizePath(targetFile.path))) {
            await collectNote(targetFile, level + 1);
          }
        } else {
          registerAsset(targetFile, level + 1);
        }
      }
    };

    await collectNote(sourceFile, 0);

    // Ensure the source note's NoteDraw raw data file is exported as-is (no rasterization).
    // NoteDraw keeps each drawing in a dedicated <note>.notedraw.md file; pulling it in as a
    // regular note preserves the native data so it can be reopened with the NoteDraw plugin.
    const noteDrawFile = await this.findNoteDrawDataFile(sourceFile);
    if (noteDrawFile && !visited.has(normalizePath(noteDrawFile.path))) {
      await collectNote(noteDrawFile, 1);
    }

    // Download remote (http/https) assets referenced by packed notes, nested by their level.
    const remoteAssets = new Map<string, { zipPath: string; data: ArrayBuffer }>();
    const failedRemoteUrls: string[] = [];
    const remoteUrlList = [...remoteRefLevels.entries()].sort((a, b) => a[1] - b[1]);
    const REMOTE_DOWNLOAD_CONCURRENCY = 4;
    for (let offset = 0; offset < remoteUrlList.length; offset += REMOTE_DOWNLOAD_CONCURRENCY) {
      throwIfExportCancelled(signal);
      const batch = remoteUrlList.slice(offset, offset + REMOTE_DOWNLOAD_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async ([url, level], batchIndex) => ({
          url,
          level,
          index: offset + batchIndex,
          result: await this.downloadRemoteAsset(url, signal)
        }))
      );
      for (const { url, level, index, result } of results) {
        if (!result) {
          failedRemoteUrls.push(url);
          continue;
        }
        const { base, extension } = deriveRemoteAssetName(url, result.contentType, index);
        const name = uniqueZipName(base, extension, folderForLevel(level));
        const folder = folderForLevel(level);
        const zipPath = folder ? `${folder}/${name}${extension ? `.${extension}` : ""}` : `${name}${extension ? `.${extension}` : ""}`;
        remoteAssets.set(url, { zipPath, data: result.data });
      }
    }

    // Write notes with links rewritten to their nested locations.
    for (const entry of collected.values()) {
      const fixedContent = this.fixMarkdownLinksForZip(entry, collected, assetFiles, remoteAssets);
      zip.file(entry.zipPath, fixedContent);
    }

    // Write binary asset files (images, attachments) to their nested locations.
    for (const { file: assetFile, zipPath } of assetFiles.values()) {
      throwIfExportCancelled(signal);
      const data = await this.app.vault.readBinary(assetFile);
      zip.file(zipPath, data);
    }

    // Write downloaded remote assets to their nested locations.
    for (const { zipPath, data } of remoteAssets.values()) {
      zip.file(zipPath, data);
    }

    if (failedRemoteUrls.length > 0) {
      console.warn("Mobile PDF Exporter kept the original URL for assets it could not download", failedRemoteUrls);
      new Notice(`ZIP: ${failedRemoteUrls.length} remote image(s) could not be downloaded; original URLs kept.`, 6000);
    }

    throwIfExportCancelled(signal);
    const zipData = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    this.zipVaultFileIndex = null;
    return new Blob([zipData.buffer as ArrayBuffer], { type: "application/zip" });
  }

  private parseMarkdownLinks(content: string): Array<{ target: string; isEmbed: boolean; raw: string }> {
    const links: Array<{ target: string; isEmbed: boolean; raw: string }> = [];
    const wikilinkRanges: Array<[number, number]> = [];

    // Match Obsidian wikilinks: ![[target]] or [[target]], with optional heading/alias
    const wikilinkRegex = new RegExp(ZIP_WIKILINK_PATTERN.source, ZIP_WIKILINK_PATTERN.flags);
    let match: RegExpExecArray | null;
    while ((match = wikilinkRegex.exec(content)) !== null) {
      wikilinkRanges.push([match.index, match.index + match[0].length]);
      const target = stripLinkFragment(decodeVaultLinkTarget(match[2]));
      if (!target || isExternalLinkTarget(target)) continue;
      links.push({ target, isEmbed: match[1] === "!", raw: match[0] });
    }

    // Match standard Markdown links/embeds: ![alt](target "title") or [text](target)
    const markdownRegex = new RegExp(ZIP_MARKDOWN_LINK_PATTERN.source, ZIP_MARKDOWN_LINK_PATTERN.flags);
    while ((match = markdownRegex.exec(content)) !== null) {
      const start = match.index;
      if (wikilinkRanges.some(([from, to]) => start >= from && start < to)) continue;
      const rawTarget = match[3];
      if (isExternalLinkTarget(rawTarget.replace(/^<|>$/gu, ""))) continue;
      const target = stripLinkFragment(decodeVaultLinkTarget(rawTarget));
      if (!target || isExternalLinkTarget(target)) continue;
      links.push({ target, isEmbed: match[1] === "!", raw: match[0] });
    }

    // Match inline HTML images: <img src="..."> — always treated as an embed.
    const htmlImgRegex = new RegExp(ZIP_HTML_IMG_PATTERN.source, ZIP_HTML_IMG_PATTERN.flags);
    while ((match = htmlImgRegex.exec(content)) !== null) {
      const rawSrc = unwrapHtmlAttributeValue(match[1] ?? "");
      if (!rawSrc || isExternalLinkTarget(rawSrc)) continue;
      const target = stripLinkFragment(decodeVaultLinkTarget(rawSrc));
      if (!target || isExternalLinkTarget(target)) continue;
      links.push({ target, isEmbed: true, raw: match[0] });
    }

    return links;
  }

  /**
   * Collects every remote (http/https) asset URL referenced by a note.
   * Markdown embeds `![](url)`, wiki embeds `![[url]]` and `<img src="url">` all count as embeds;
   * plain `[text](url)` links are only collected once the depth allows non-embed links.
   */
  private parseRemoteAssetUrls(content: string): Array<{ url: string; isEmbed: boolean }> {
    const found = new Map<string, boolean>();
    const wikilinkRanges: Array<[number, number]> = [];
    const remember = (rawUrl: string, isEmbed: boolean): void => {
      const url = normalizeRemoteUrl(rawUrl);
      if (!url) return;
      found.set(url, (found.get(url) ?? false) || isEmbed);
    };

    const wikilinkRegex = new RegExp(ZIP_WIKILINK_PATTERN.source, ZIP_WIKILINK_PATTERN.flags);
    let match: RegExpExecArray | null;
    while ((match = wikilinkRegex.exec(content)) !== null) {
      wikilinkRanges.push([match.index, match.index + match[0].length]);
      const raw = String(match[2] ?? "").trim();
      if (isRemoteHttpUrl(raw)) remember(raw, match[1] === "!");
    }

    const markdownRegex = new RegExp(ZIP_MARKDOWN_LINK_PATTERN.source, ZIP_MARKDOWN_LINK_PATTERN.flags);
    while ((match = markdownRegex.exec(content)) !== null) {
      const start = match.index;
      if (wikilinkRanges.some(([from, to]) => start >= from && start < to)) continue;
      const raw = String(match[3] ?? "").replace(/^<|>$/gu, "").trim();
      if (isRemoteHttpUrl(raw)) remember(raw, match[1] === "!");
    }

    const htmlImgRegex = new RegExp(ZIP_HTML_IMG_PATTERN.source, ZIP_HTML_IMG_PATTERN.flags);
    while ((match = htmlImgRegex.exec(content)) !== null) {
      const raw = unwrapHtmlAttributeValue(match[1] ?? "");
      if (isRemoteHttpUrl(raw)) remember(raw, true);
    }

    return [...found.entries()].map(([url, isEmbed]) => ({ url, isEmbed }));
  }

  /** Downloads a remote asset through Obsidian's requestUrl so CORS never blocks the export. */
  private async downloadRemoteAsset(
    url: string,
    signal?: AbortSignal
  ): Promise<{ data: ArrayBuffer; contentType: string } | null> {
    throwIfExportCancelled(signal);
    try {
      const response = await requestUrl({ url, method: "GET", throw: false });
      if (response.status < 200 || response.status >= 300) return null;
      const data = response.arrayBuffer;
      if (!data || data.byteLength === 0) return null;
      const headers = response.headers ?? {};
      const contentTypeKey = Object.keys(headers).find((key) => key.toLowerCase() === "content-type");
      const contentType = contentTypeKey ? String(headers[contentTypeKey] ?? "") : "";
      return { data, contentType };
    } catch (error) {
      console.warn(`Mobile PDF Exporter could not download remote asset: ${url}`, error);
      return null;
    }
  }

  private resolveMarkdownLink(target: string, sourcePath: string): TFile | null {
    const cleaned = stripLinkFragment(decodeVaultLinkTarget(target));
    if (!cleaned || isExternalLinkTarget(cleaned)) return null;

    const resolved = this.app.metadataCache.getFirstLinkpathDest(cleaned, sourcePath);
    if (resolved) return resolved;

    const sourceDir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    const relative = resolveVaultRelativePath(sourceDir, cleaned);
    const candidates = [cleaned, `${cleaned}.md`, relative, `${relative}.md`];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const file = this.app.vault.getAbstractFileByPath(normalizePath(candidate));
      if (file instanceof TFile) return file;
    }

    // Fallback: scan the whole vault so links still resolve even when the
    // metadata cache has not indexed the target yet (or the link uses a bare name).
    const normalizedTarget = normalizePath(cleaned).toLowerCase();
    const normalizedRelative = relative ? normalizePath(relative).toLowerCase() : "";
    const bareName = cleaned.includes("/") ? cleaned.slice(cleaned.lastIndexOf("/") + 1) : cleaned;
    const allFiles = (this.zipVaultFileIndex ??= this.app.vault.getFiles());
    const byPath = allFiles.find((file) => {
      const lower = file.path.toLowerCase();
      return (
        lower === normalizedTarget ||
        lower === `${normalizedTarget}.md` ||
        (normalizedRelative !== "" && (lower === normalizedRelative || lower === `${normalizedRelative}.md`))
      );
    });
    if (byPath) return byPath;
    const byName = allFiles.find(
      (file) => file.name.toLowerCase() === bareName.toLowerCase() || file.basename.toLowerCase() === bareName.toLowerCase()
    );
    return byName ?? null;
  }

  private relativeZipPath(fromZipPath: string, toZipPath: string): string {
    const fromParts = fromZipPath.split("/").slice(0, -1); // directory of the source file
    const toParts = toZipPath.split("/");
    let i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
    const up = fromParts.length - i;
    const down = toParts.slice(i);
    return [...Array(up).fill(".."), ...down].join("/");
  }

  private fixMarkdownLinksForZip(
    entry: { content: string; originalPath: string; zipPath: string },
    collected: Map<string, { originalPath: string; zipPath: string; zipName: string; level: number }>,
    assetFiles: Map<string, { file: TFile; zipPath: string; zipName: string; level: number }>,
    remoteAssets: Map<string, { zipPath: string }>
  ): string {
    const currentZipPath = entry.zipPath;

    const zipPathFor = (resolved: TFile): { zipPath: string; isNote: boolean } | null => {
      const key = normalizePath(resolved.path);
      const note = collected.get(key);
      if (note) return { zipPath: note.zipPath, isNote: true };
      const asset = assetFiles.get(key);
      if (asset) return { zipPath: asset.zipPath, isNote: false };
      return null;
    };
    const remotePathFor = (rawUrl: string): string | null => {
      if (!isRemoteHttpUrl(rawUrl)) return null;
      return remoteAssets.get(normalizeRemoteUrl(rawUrl))?.zipPath ?? null;
    };

    // Wikilinks: keep them clean (no .md), resolved relative to the current file's folder.
    const wikilinkRegex = new RegExp(ZIP_WIKILINK_PATTERN.source, ZIP_WIKILINK_PATTERN.flags);
    let output = entry.content.replace(wikilinkRegex, (fullMatch, bang, target, heading, alias) => {
      const rawTarget = String(target).trim();
      const remotePath = remotePathFor(rawTarget);
      if (remotePath) {
        const rel = this.relativeZipPath(currentZipPath, remotePath);
        return `${bang}[[${rel}${alias ?? ""}]]`;
      }
      const cleaned = stripLinkFragment(decodeVaultLinkTarget(rawTarget));
      if (!cleaned || isExternalLinkTarget(cleaned)) return fullMatch;
      const resolved = this.resolveMarkdownLink(cleaned, entry.originalPath);
      if (!resolved) return fullMatch;
      const zipPath = zipPathFor(resolved);
      if (!zipPath) return fullMatch;
      const rel = this.relativeZipPath(currentZipPath, zipPath.zipPath);
      // Strip the .md extension for note wikilinks so Obsidian resolves by name.
      const display = zipPath.isNote ? rel.replace(/\.md$/u, "") : rel;
      return `${bang}[[${display}${heading ?? ""}${alias ?? ""}]]`;
    });

    // Standard Markdown links: keep the real file name (with .md for notes).
    const markdownRegex = new RegExp(ZIP_MARKDOWN_LINK_PATTERN.source, ZIP_MARKDOWN_LINK_PATTERN.flags);
    output = output.replace(markdownRegex, (fullMatch, bang, label, rawTarget, title) => {
      const raw = String(rawTarget);
      const bare = raw.replace(/^<|>$/gu, "");
      const remotePath = remotePathFor(bare);
      if (remotePath) {
        const rel = this.relativeZipPath(currentZipPath, remotePath);
        return `${bang}[${label ?? ""}](${encodeMarkdownLinkTarget(rel)}${title ?? ""})`;
      }
      if (isExternalLinkTarget(bare)) return fullMatch;
      const decoded = decodeVaultLinkTarget(raw);
      const cleaned = stripLinkFragment(decoded);
      if (!cleaned || isExternalLinkTarget(cleaned)) return fullMatch;
      const resolved = this.resolveMarkdownLink(cleaned, entry.originalPath);
      if (!resolved) return fullMatch;
      const zipPath = zipPathFor(resolved);
      if (!zipPath) return fullMatch;
      const rel = this.relativeZipPath(currentZipPath, zipPath.zipPath);
      const hashIndex = decoded.indexOf("#");
      const fragment = hashIndex >= 0 ? decoded.slice(hashIndex) : "";
      const encoded = encodeMarkdownLinkTarget(`${rel}${fragment}`);
      return `${bang}[${label ?? ""}](${encoded}${title ?? ""})`;
    });

    // Rewrite inline HTML <img src="..."> so both vault assets and downloaded remote images resolve.
    const htmlImgRegex = new RegExp(ZIP_HTML_IMG_PATTERN.source, ZIP_HTML_IMG_PATTERN.flags);
    output = output.replace(htmlImgRegex, (fullMatch, rawSrc) => {
      const attributeValue = String(rawSrc ?? "");
      const src = unwrapHtmlAttributeValue(attributeValue);
      if (!src) return fullMatch;

      let replacement: string | null = remotePathFor(src);
      if (!replacement && !isExternalLinkTarget(src)) {
        const cleaned = stripLinkFragment(decodeVaultLinkTarget(src));
        if (cleaned && !isExternalLinkTarget(cleaned)) {
          const resolved = this.resolveMarkdownLink(cleaned, entry.originalPath);
          const zipPath = resolved ? zipPathFor(resolved) : null;
          if (zipPath) replacement = this.relativeZipPath(currentZipPath, zipPath.zipPath);
        }
      }
      if (!replacement) return fullMatch;

      const encoded = encodeMarkdownLinkTarget(replacement);
      // Replace only the src attribute value, keeping every other attribute untouched.
      const quote = attributeValue.trim().startsWith("'") ? "'" : '"';
      return fullMatch.replace(attributeValue, `${quote}${encoded}${quote}`);
    });

    return output;
  }

  /**
   * Returns the NoteDraw raw data file (a dedicated `<note>.notedraw.md`) associated with the
   * given note, or null when NoteDraw is unavailable or no drawing data exists. Exporting this
   * file as-is preserves the native drawing data so it can be reopened with the NoteDraw plugin.
   */
  private async findNoteDrawDataFile(file: TFile): Promise<TFile | null> {
    const plugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: { getStoragePaths?: (f: TFile) => { current?: string; legacy?: string } | null } }> };
    }).plugins?.plugins;
    const getStoragePaths = plugins?.notedraw?.api?.getStoragePaths;
    if (!getStoragePaths) return null;
    let paths: { current?: string; legacy?: string } | null = null;
    try {
      paths = getStoragePaths(file);
    } catch {
      return null;
    }
    if (!paths) return null;
    for (const candidate of [paths.current, paths.legacy]) {
      if (!candidate) continue;
      const resolved = this.app.vault.getAbstractFileByPath(normalizePath(candidate));
      if (resolved instanceof TFile) return resolved;
    }
    return null;
  }

  private async renderExcalidrawToImagePdf(file: TFile, signal?: AbortSignal): Promise<Blob> {
    throwIfExportCancelled(signal);
    const lease = this.getExcalidrawAutomateLease();
    if (!lease) {
      throw new Error(this.t("excalidrawApiMissingError"));
    }

    const errors: string[] = [];

    try {
      const exportSettings = lease.api.getExportSettings?.(true, true, false);
      const loader = lease.api.getEmbeddedFilesLoader?.(false);
      const preferredScale = Math.min(2, Math.max(1.25, activeWindow.devicePixelRatio || 1.5));
      const scales = getExcalidrawExportScaleCandidates(preferredScale);

      // Prefer SVG so Excalidraw's own createPNG path does not show "PNG too large" notices.
      if (lease.api.createSVG) {
        try {
          throwIfExportCancelled(signal);
          lease.api.reset?.();
          const svg = await waitForPromiseOrTimeout(
            lease.api.createSVG(file.path, false, exportSettings, loader, "light", 12, true, true),
            EXCALIDRAW_IMAGE_RENDER_TIMEOUT_MS
          );
          throwIfExportCancelled(signal);
          if (svg instanceof SVGSVGElement) {
            const renderedScaleKeys = new Set<number>();
            for (const scale of scales) {
              throwIfExportCancelled(signal);
              const actualScale = getSvgSafeRasterScale(svg, scale);
              const scaleKey = Math.round(actualScale * 1000) / 1000;
              if (renderedScaleKeys.has(scaleKey)) continue;
              renderedScaleKeys.add(scaleKey);

              const pngBytes = await svgElementToPngBytes(svg, scale, EXCALIDRAW_IMAGE_LOAD_TIMEOUT_MS, this.settings.colorMode);
              if (!pngBytes || pngBytes.byteLength <= 0) continue;
              if (pngBytes.byteLength > EXCALIDRAW_PREFERRED_MAX_PNG_BYTES && actualScale > EXCALIDRAW_MIN_EXPORT_SCALE) continue;

              const pdfBlob = await this.tryBuildExcalidrawImagePdf(file, pngBytes, `SVG ${actualScale}x`, signal);
              if (pdfBlob) return pdfBlob;
            }
          }
        } catch (error) {
          if (isExportCancelledError(error)) throw error;
          errors.push(formatErrorMessage(error));
          console.warn("Mobile PDF Exporter Excalidraw SVG fallback failed", error);
        }
      }

      if (lease.api.createPNG) {
        for (const scale of getExcalidrawPngFallbackScaleCandidates(Boolean(lease.api.createSVG))) {
          try {
            throwIfExportCancelled(signal);
            lease.api.reset?.();
            const pngBlob = await waitForPromiseOrTimeout(
              lease.api.createPNG(file.path, scale, exportSettings, loader, "light", 12),
              EXCALIDRAW_IMAGE_RENDER_TIMEOUT_MS
            );
            throwIfExportCancelled(signal);
            if (!pngBlob || pngBlob.size <= 0) {
              errors.push(formatTranslation(this.getResolvedLanguage(), "excalidrawPngNoImageError", { scale }));
              continue;
            }

            const pdfBlob = await this.tryBuildExcalidrawImagePdf(file, await blobToUint8Array(pngBlob), `PNG ${scale}x`, signal);
            if (pdfBlob) return pdfBlob;
          } catch (error) {
            if (isExportCancelledError(error)) throw error;
            errors.push(formatErrorMessage(error));
            console.warn(`Mobile PDF Exporter Excalidraw PNG ${scale}x failed`, error);
          }
        }
      }

      const suffix = errors.length > 0
        ? formatTranslation(this.getResolvedLanguage(), "lastErrorLabel", { error: errors[errors.length - 1] })
        : this.t("noUsableImageError");
      throw new Error(`${this.t("excalidrawExportFailedError")} ${suffix}`);
    } finally {
      if (lease.destroyAfterUse) lease.api.destroy?.();
    }
  }

  private async tryBuildExcalidrawImagePdf(
    file: TFile,
    imageBytes: Uint8Array,
    label: string,
    signal?: AbortSignal
  ): Promise<Blob | null> {
    try {
      return await this.imageBytesToSlicedExcalidrawPdf(file, imageBytes, signal);
    } catch (error) {
      if (isExportCancelledError(error)) throw error;
      console.warn(`Mobile PDF Exporter Excalidraw PDF build failed for ${label}`, error);
      return null;
    }
  }

  private async imageBytesToSlicedExcalidrawPdf(
    file: TFile,
    imageBytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<Blob> {
    throwIfExportCancelled(signal);
    const { PDFDocument: PDFDocumentRuntime, StandardFonts, fontkitModule } = await loadPdfRuntime();
    const sourceImage = await imageBytesToHtmlImage(imageBytes);
    const sourceWidthPx = Math.max(1, sourceImage.naturalWidth || sourceImage.width);
    const sourceHeightPx = Math.max(1, sourceImage.naturalHeight || sourceImage.height);
    const pdfDoc = await PDFDocumentRuntime.create();
    pdfDoc.setTitle(file.basename);
    pdfDoc.setSubject(EXCALIDRAW_IMAGE_PDF_SUBJECT);

    const pageSizeMm = getConfiguredPageSizeMm(this.settings);
    const pageWidthPt = mmToPt(pageSizeMm.width);
    const fixedPageHeightPt = mmToPt(pageSizeMm.height);
    const pageMarginPt = mmToPt(this.settings.marginMm);
    const { topMm, bottomMm } = getPageBodyInsetsMm(this.settings);
    const pageTopInsetPt = mmToPt(topMm);
    const pageBottomInsetPt = mmToPt(bottomMm);
    const usableWidthPt = Math.max(24, pageWidthPt - pageMarginPt * 2);
    const usableHeightPt = Math.max(24, fixedPageHeightPt - pageTopInsetPt - pageBottomInsetPt);
    const pxToPt = usableWidthPt / sourceWidthPx;
    const fullPageSourceHeightPx = Math.max(1, Math.floor(usableHeightPt / pxToPt));
    const pageCount = Math.max(1, Math.ceil(sourceHeightPx / fullPageSourceHeightPx));
    const exportDate = formatExportDate(new Date());
    const pageChromeFont = this.settings.headerText || this.settings.footerText
      ? (await this.loadExportFont(pdfDoc, fontkitModule, StandardFonts.Helvetica)).font
      : null;
    let sourceY = 0;
    let pageIndex = 0;

    while (sourceY < sourceHeightPx) {
      throwIfExportCancelled(signal);
      const sourceSliceHeightPx = Math.min(fullPageSourceHeightPx, sourceHeightPx - sourceY);
      const sliceBytes = await imageSliceToPngBytes(sourceImage, sourceY, sourceSliceHeightPx, this.settings.colorMode);
      const sliceImage = await pdfDoc.embedPng(sliceBytes);
      const drawHeightPt = Math.min(usableHeightPt, sourceSliceHeightPx * pxToPt);
      const pageHeightPt = fixedPageHeightPt;
      const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

      page.drawRectangle({
        x: 0,
        y: 0,
        width: pageWidthPt,
        height: pageHeightPt,
        color: rgb(1, 1, 1)
      });
      page.drawImage(sliceImage, {
        x: (pageWidthPt - usableWidthPt) / 2,
        y: pageHeightPt - pageTopInsetPt - drawHeightPt,
        width: usableWidthPt,
        height: drawHeightPt
      });

      if (pageChromeFont) {
        drawPdfHeaderFooter(page, pageChromeFont, this.settings, {
          title: file.basename,
          pageNumber: pageIndex + 1,
          pageCount,
          exportDate
        });
      }

      sourceY += sourceSliceHeightPx;
      pageIndex += 1;
      await nextAnimationFrame();
    }

    throwIfExportCancelled(signal);
    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    throwIfExportCancelled(signal);
    const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(pdfBuffer).set(pdfBytes);
    return new Blob([pdfBuffer], { type: "application/pdf" });
  }

  private getActiveMarkdownFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension.toLowerCase() !== "md") return null;
    return file;
  }

  private getActiveExportSurface(file: TFile): LiveMarkdownSurface | null {
    const markdownSurface = this.getActiveMarkdownSurface(file);
    if (markdownSurface) return markdownSurface;
    if (this.app.workspace.getActiveFile()?.path !== file.path) return null;
    const leafView = this.app.workspace.activeLeaf?.view as unknown as { containerEl?: HTMLElement };
    const containerEl = leafView?.containerEl;
    if (!containerEl) return null;
    const candidates = Array.from(containerEl.querySelectorAll<HTMLElement>(
      ".view-content, .pdf-viewer-container, .canvas-wrapper, .bases-view, .image-container"
    )).filter(isScreenVisibleElement);
    const rootEl = candidates.sort((left, right) => getVisibleElementScore(right) - getVisibleElementScore(left))[0];
    if (!rootEl) return null;
    const scrollEl = findScrollableExportSurface(rootEl);
    return { rootEl, scrollEl, mode: "generic" };
  }

  private getHtmlRenderGeometry(file: TFile): { width: number; paddingLeft: number; paddingRight: number } {
    const surface = this.getActiveMarkdownSurface(file);
    if (!surface) {
      const width = clampNumber(this.settings.currentPageWidthPx, 320, 1600, 960);
      const padding = clampNumber(width * 0.05, 16, 48, 48);
      return { width, paddingLeft: padding, paddingRight: padding };
    }

    const rect = surface.rootEl.getBoundingClientRect();
    const width = clampNumber(
      Math.max(surface.rootEl.clientWidth || 0, surface.scrollEl.clientWidth || 0, rect.width || 0),
      240,
      1600,
      960
    );
    const frame = measureNoteDrawTargetContentFrame(surface.rootEl, width);
    const paddingLeft = clampNumber(frame.left, 0, Math.max(0, width - 1), 0);
    const contentWidth = clampNumber(frame.width, 1, Math.max(1, width - paddingLeft), width - paddingLeft);
    const paddingRight = Math.max(0, width - paddingLeft - contentWidth);
    return { width, paddingLeft, paddingRight };
  }

  private getActiveMarkdownSurface(file: TFile): LiveMarkdownSurface | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || view.file.path !== file.path) return null;

    const mode = view.getMode();
    if (mode === "source") {
      const scrollEl = view.containerEl.querySelector<HTMLElement>(".markdown-source-view .cm-scroller");
      if (!scrollEl || !isScreenVisibleElement(scrollEl)) return null;
      return { rootEl: scrollEl, scrollEl, mode: "source" };
    }

    const previewCandidates = Array.from(
      view.containerEl.querySelectorAll<HTMLElement>(".markdown-reading-view > .markdown-preview-view, .markdown-preview-view")
    ).filter((element) => isScreenVisibleElement(element));
    const rootEl = previewCandidates
      .sort((left, right) => getVisibleElementScore(right) - getVisibleElementScore(left))[0];
    if (!rootEl) return null;
    return { rootEl, scrollEl: rootEl, mode: "preview" };
  }

  private async captureLiveViewPdfModel(
    file: TFile,
    surface: LiveMarkdownSurface,
    signal?: AbortSignal
  ): Promise<PreviewPdfModel> {
    throwIfExportCancelled(signal);
    const { rootEl, scrollEl } = surface;
    if (surface.mode === "preview" && !hasRenderedContent(rootEl)) {
      await waitForRenderedContent(rootEl, 1800);
      await waitForPreviewDomStable(rootEl, 900);
      throwIfExportCancelled(signal);
    }
    const rootRect = rootEl.getBoundingClientRect();
    const liveWidthPx = Math.max(1, scrollEl.clientWidth || rootRect.width);
    const originalScrollTop = scrollEl.scrollTop;
    const originalScrollLeft = scrollEl.scrollLeft;
    const preparedNoteDraw = await this.prepareNoteDrawExportOverlay(file, rootEl);
    const suppressedInlineTitles = this.settings.includeTitle
      ? []
      : Array.from(rootEl.querySelectorAll<HTMLElement>(".inline-title"))
        .filter((element) => !element.classList.contains("mobile-pdf-exporter-skip"));
    suppressedInlineTitles.forEach((element) => element.classList.add("mobile-pdf-exporter-skip"));
    const captured = createEmptySurfaceCapture();
    const seen = createSurfaceCaptureSeenState();
    const liveCaptureCache = createLiveSurfaceCaptureCache();
    const linkContext = createPdfLinkContext(this.app, file);
    const previewRenderer = surface.mode === "preview"
      ? getLivePreviewRenderer(this.app, rootEl)
      : null;
    const previewSectionCaptures = new Map<number, CapturedLivePreviewSection>();
    let capturedPreviewOverlays = false;
    let contentHeightPx = Math.max(1, scrollEl.scrollHeight, rootEl.scrollHeight, rootRect.height);

    try {
      if (previewRenderer) {
        await primeLivePreviewLayout(rootEl, scrollEl, previewRenderer, signal);
        contentHeightPx = Math.max(contentHeightPx, scrollEl.scrollHeight, rootEl.scrollHeight);
        captureConnectedLivePreviewSections(
          rootEl,
          scrollEl,
          previewRenderer,
          linkContext,
          previewSectionCaptures
        );
      }
      const viewportHeight = Math.max(160, scrollEl.clientHeight || rootRect.height || 640);
      const captureStep = Math.max(120, viewportHeight * 0.72);
      const overlapHeight = Math.max(0, viewportHeight - captureStep);
      const scrollPositions = surface.mode === "preview"
        ? previewRenderer
          ? buildLiveSurfaceCaptureScrollPositions(
            Math.max(0, scrollEl.scrollHeight - viewportHeight),
            viewportHeight
          )
          : [0]
        : buildLiveSurfaceCaptureScrollPositions(
          Math.max(0, scrollEl.scrollHeight - viewportHeight),
          viewportHeight
        );
      const capturedActualTops = new Set<number>();
      let appendedFinalWindows = false;
      scrollEl.scrollLeft = 0;

      for (let index = 0; index < scrollPositions.length; index += 1) {
        throwIfExportCancelled(signal);
        await settleLiveSurfaceAtScrollPosition(rootEl, scrollEl, scrollPositions[index], signal, previewRenderer);
        if (surface.mode === "preview" && index > 0 && !previewRenderer) {
          await waitForPreviewDomStable(rootEl, 360);
        }
        refreshLiveDrawingSurface(rootEl);
        await nextAnimationFrame();
        if (previewRenderer) {
          const connectedSections = getUncapturedConnectedPreviewSectionElements(
            rootEl,
            previewRenderer,
            previewSectionCaptures
          );
          const waitedForImages = await waitForImagesInElements(connectedSections, 900);
          if (waitedForImages) {
            await settleLiveSurfaceAtScrollPosition(rootEl, scrollEl, scrollPositions[index], signal, previewRenderer);
          }
        } else if (rootEl.querySelector("img")) {
          await waitForImages(rootEl, Math.min(IMAGE_WAIT_TIMEOUT_MS, 1100));
          await settleLiveSurfaceAtScrollPosition(rootEl, scrollEl, scrollPositions[index], signal);
        }
        throwIfExportCancelled(signal);

        const actualTop = scrollEl.scrollTop;
        const actualKey = Math.round(actualTop * 10) / 10;
        contentHeightPx = Math.max(contentHeightPx, scrollEl.scrollHeight, rootEl.scrollHeight);
        const maxScrollTop = Math.max(0, scrollEl.scrollHeight - viewportHeight);
        if (previewRenderer) {
          captureConnectedLivePreviewSections(
            rootEl,
            scrollEl,
            previewRenderer,
            linkContext,
            previewSectionCaptures
          );
        }
        if (!capturedActualTops.has(actualKey)) {
          capturedActualTops.add(actualKey);
          if (previewRenderer) {
            if (!capturedPreviewOverlays && actualTop <= 0.5) {
              capturedPreviewOverlays = true;
              appendSurfaceCapture(
                captured,
                captureLivePreviewRootOverlays(
                  rootEl,
                  previewRenderer,
                  linkContext,
                  liveCaptureCache,
                  actualTop,
                  scrollEl.scrollLeft
                ),
                0,
                0,
                seen
              );
            }
          } else {
            const isFirstWindow = actualTop <= 0.5;
            const isLastWindow = actualTop >= maxScrollTop - 0.5;
            const captureWholePreview = surface.mode === "preview" && index === 0;
            const bandTop = captureWholePreview || isFirstWindow ? 0 : actualTop + overlapHeight / 2;
            const bandBottom = captureWholePreview || isLastWindow
              ? contentHeightPx + 1
              : Math.min(contentHeightPx + 1, actualTop + viewportHeight - overlapHeight / 2);
            appendSurfaceCapture(
              captured,
              captureSurfaceFragments(rootEl, linkContext, {
                scrollTop: actualTop,
                scrollLeft: scrollEl.scrollLeft,
                bandTop,
                bandBottom,
                cache: liveCaptureCache
              }),
              actualTop,
              scrollEl.scrollLeft,
              seen
            );
          }

          if (surface.mode === "preview" && !previewRenderer) {
            const gapPositions = buildLivePreviewGapScrollPositions(captured, contentHeightPx, viewportHeight);
            for (const position of gapPositions) {
              if (!scrollPositions.includes(position)) scrollPositions.push(position);
            }
          }
        }

        if (surface.mode === "source" && !appendedFinalWindows && index === scrollPositions.length - 1) {
          appendedFinalWindows = true;
          const previousMaximum = scrollPositions[scrollPositions.length - 1] ?? 0;
          const finalPositions = buildLiveSurfaceCaptureScrollPositions(maxScrollTop, viewportHeight)
            .filter((position) => position > previousMaximum + 0.5);
          scrollPositions.push(...finalPositions);
        }

      }

      if (previewRenderer) {
        for (let retry = 0; retry < 4 && countMissingLivePreviewSections(previewRenderer, previewSectionCaptures) > 0; retry += 1) {
          const missingPositions = buildMissingLivePreviewSectionScrollPositions(
            previewRenderer,
            previewSectionCaptures,
            Math.max(0, scrollEl.scrollHeight - viewportHeight),
            viewportHeight
          );
          for (const position of missingPositions) {
            await settleLiveSurfaceAtScrollPosition(rootEl, scrollEl, position, signal, previewRenderer);
            const connectedSections = getUncapturedConnectedPreviewSectionElements(
              rootEl,
              previewRenderer,
              previewSectionCaptures
            );
            if (await waitForImagesInElements(connectedSections, 900)) {
              await settleLiveSurfaceAtScrollPosition(rootEl, scrollEl, position, signal, previewRenderer);
            }
            captureConnectedLivePreviewSections(
              rootEl,
              scrollEl,
              previewRenderer,
              linkContext,
              previewSectionCaptures
            );
          }
        }
        appendLivePreviewSectionCaptures(captured, previewRenderer, previewSectionCaptures, seen);
        const missingSections = countMissingLivePreviewSections(previewRenderer, previewSectionCaptures);
        if (missingSections > 0) {
          throw new Error(`Live reading view did not render ${missingSections} content section(s) during export.`);
        }
      }
    } finally {
      scrollEl.scrollTop = originalScrollTop;
      scrollEl.scrollLeft = originalScrollLeft;
      suppressedInlineTitles.forEach((element) => element.classList.remove("mobile-pdf-exporter-skip"));
      preparedNoteDraw.cleanup();
      refreshLiveDrawingSurface(rootEl);
      await nextAnimationFrame();
    }

    throwIfExportCancelled(signal);
    captured.textFragments = dedupeOverlappingLiveTextFragments(captured.textFragments);

    const pageSizeMm = getConfiguredPageSizeMm(this.settings);
    const pageWidthPt = mmToPt(pageSizeMm.width);
    const pageHeightPt = mmToPt(pageSizeMm.height);
    const sourceWidthPx = mmToPx(pageSizeMm.width);
    const pxToPt = pageWidthPt / sourceWidthPx;
    const pageHeightPx = pageHeightPt / pxToPt;
    const { bodyTopInsetPx, bodyBottomInsetPx, bodyHeightPx } = getPageBodyLayoutPx(this.settings, pageHeightPx);
    const horizontalInsetPx = mmToPx(this.settings.marginMm);
    const usableWidthPx = Math.max(24, sourceWidthPx - horizontalInsetPx * 2);
    const surfaceScale = (usableWidthPx / liveWidthPx) * (this.settings.contentScalePercent / 100);
    const transformed = transformSurfaceCapture(captured, horizontalInsetPx, surfaceScale);
    const capturedBottomPx = measureVisibleCapturedSurfaceBottom(transformed);
    const transformedContentHeight = Math.max(1, capturedBottomPx);
    const pageBreaks = computePageBreaks(transformedContentHeight, bodyHeightPx, transformed.keepBlocks);
    const rootStyle = getComputedStyle(rootEl);

    const model: PreviewPdfModel = {
      ownerDocument: rootEl.ownerDocument,
      pageWidthPt,
      pageHeightPt,
      sourceWidthPx,
      pxToPt,
      pageHeightPx,
      bodyTopInsetPx,
      bodyBottomInsetPx,
      bodyHeightPx,
      horizontalInsetPx,
      background: findOpaqueBackgroundColor(rootEl) ?? rgb(1, 1, 1),
      foreground: parseCssColor(rootStyle.color) ?? rgb(0.12, 0.12, 0.12),
      ...transformed,
      contentHeightPx: transformedContentHeight,
      pageBreaks,
      title: file.basename,
      headerText: this.settings.headerText,
      footerText: this.settings.footerText,
      exportDate: formatExportDate(new Date())
    };
    attachPreparedNoteDrawToModel(model, preparedNoteDraw, {
      offsetX: horizontalInsetPx,
      offsetY: 0,
      scale: surfaceScale,
      linkContext
    });
    return model;
  }

  private async renderMarkdownPreview(
    file: TFile,
    markdown: string,
    layout: "pdf" | "html" = "pdf"
  ): Promise<RenderedPreview> {
    const pageSizeMm = getConfiguredPageSizeMm(this.settings);
    const htmlGeometry = layout === "html" ? this.getHtmlRenderGeometry(file) : null;
    const renderWidthPx = htmlGeometry?.width ?? mmToPx(pageSizeMm.width);
    const paddingPx = mmToPx(this.settings.marginMm);
    const paddingLeftPx = htmlGeometry?.paddingLeft ?? paddingPx;
    const paddingRightPx = htmlGeometry?.paddingRight ?? paddingPx;
    const pageHeightPx = mmToPx(pageSizeMm.height);
    const { bodyHeightPx } = getPageBodyLayoutPx(this.settings, pageHeightPx);
    const isExcalidrawFile = isExcalidrawMarkdownFile(file, markdown);
    const markdownToRender = isExcalidrawFile
      ? sanitizeExcalidrawMarkdownForPreview(markdown)
      : markdown;

    cleanupRenderRoots();
    const renderComponent = new Component();
    renderComponent.load();
    const rootEl = appendElement(activeDocument.body, "div", {
      cls: "mobile-pdf-exporter-render-root"
    });

    try {
      rootEl.setCssProps({
        "--mobile-pdf-exporter-width": `${renderWidthPx}px`,
        "--mobile-pdf-exporter-padding": `${paddingPx}px`,
        "--mobile-pdf-exporter-padding-left": `${paddingLeftPx}px`,
        "--mobile-pdf-exporter-padding-right": `${paddingRightPx}px`,
        "--mobile-pdf-exporter-page-height": `${pageHeightPx}px`,
        "--mobile-pdf-exporter-body-height": `${bodyHeightPx}px`,
        "--mobile-pdf-exporter-font-scale": String(this.settings.contentScalePercent / 100)
      });

      const pageEl = appendElement(rootEl, "div", {
        cls: "mobile-pdf-exporter-page markdown-reading-view"
      });

      if (this.settings.includeTitle) {
        appendElement(pageEl, "h1", {
          cls: "mobile-pdf-exporter-title",
          text: file.basename
        });
      }

      const markdownEl = appendElement(pageEl, "div", {
        cls: "markdown-preview-view markdown-rendered"
      });

      const rendered = await waitForPromiseOrTimeout(
        MarkdownRenderer.render(this.app, markdownToRender, markdownEl, file.path, renderComponent),
        PREVIEW_RENDER_TIMEOUT_MS
      );

      hideExcalidrawSourceBlocks(markdownEl);

      if (isExcalidrawFile) {
        const renderedSvg = await this.renderExcalidrawFilePreview(file, markdownEl);
        hideExcalidrawSourceBlocks(markdownEl);
        if (!renderedSvg && !hasExportableContent(markdownEl)) {
          appendElement(markdownEl, "p", {
            cls: "mobile-pdf-exporter-excalidraw-fallback",
            text: this.t("excalidrawPreviewUnavailable")
          });
        }
      }

      if (!rendered) {
        await waitForRenderedContent(markdownEl, 1000);
      }

      const previewWaitProfile = getPreviewWaitProfile(markdownEl);
      await waitForRenderedContent(markdownEl, previewWaitProfile.renderedContentMs);
      await waitForPreviewDomStable(pageEl, previewWaitProfile.initialStableMs);
      await waitForImages(pageEl, IMAGE_WAIT_TIMEOUT_MS);
      await waitForPreviewDomStable(pageEl, previewWaitProfile.finalStableMs);
      this.injectNoteDoodleOverlay(file, markdownEl);
      await nextAnimationFrame(FRAME_WAIT_TIMEOUT_MS);

      const rect = pageEl.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || pageEl.scrollHeight < 1 || !hasExportableContent(markdownEl)) {
        throw new Error(this.t("previewNoExportSizeError"));
      }

      return { rootEl, pageEl, renderComponent };
    } catch (error) {
      renderComponent.unload();
      rootEl.remove();
      throw error;
    }
  }

  private async renderExcalidrawFilePreview(file: TFile, markdownEl: HTMLElement): Promise<boolean> {
    const lease = this.getExcalidrawAutomateLease();
    if (!lease) return false;

    try {
      lease.api.reset?.();
      const exportSettings = lease.api.getExportSettings?.(true, true, false);
      const loader = lease.api.getEmbeddedFilesLoader?.(false);
      const svg = await waitForPromiseOrTimeout(
        lease.api.createSVG?.(file.path, false, exportSettings, loader, "light", 12, true, true) ??
          Promise.resolve(null),
        PREVIEW_RENDER_TIMEOUT_MS
      );
      if (!(svg instanceof SVGSVGElement)) return false;

      svg.classList.add("mobile-pdf-exporter-excalidraw-svg");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.setCssStyles({
        display: "block",
        width: "100%",
        maxWidth: "100%",
        height: "auto"
      });
      const viewBox = svg.viewBox.baseVal;
      if (viewBox.width > 0 && viewBox.height > 0) {
        svg.setCssStyles({ aspectRatio: `${viewBox.width} / ${viewBox.height}` });
      }

      const previewEl = appendElement(markdownEl, "div", {
        cls: "mobile-pdf-exporter-excalidraw-preview"
      });
      previewEl.appendChild(svg);
      return true;
    } catch (error) {
      console.warn("Mobile PDF Exporter Excalidraw preview failed", error);
      return false;
    } finally {
      if (lease.destroyAfterUse) lease.api.destroy?.();
    }
  }

  private getExcalidrawAutomateLease(): ExcalidrawAutomateLease | null {
    const globalApi = (activeWindow as unknown as { ExcalidrawAutomate?: ExcalidrawAutomateRuntime }).ExcalidrawAutomate;
    if (globalApi?.getAPI) {
      const api = globalApi.getAPI();
      if (api?.createPNG || api?.createSVG) return { api, destroyAfterUse: true };
    }

    const plugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins?.plugins;
    const excalidrawPlugin = plugins?.["obsidian-excalidraw-plugin"] as
      | { ea?: ExcalidrawAutomateRuntime }
      | undefined;
    const pluginApi = excalidrawPlugin?.ea;

    if (pluginApi?.getAPI) {
      const api = pluginApi.getAPI();
      if (api?.createPNG || api?.createSVG) return { api, destroyAfterUse: true };
    }

    if (pluginApi?.createPNG || pluginApi?.createSVG) return { api: pluginApi, destroyAfterUse: false };
    return null;
  }

  private injectNoteDoodleOverlay(file: TFile, markdownEl: HTMLElement): void {
    const overlay = getVisibleLiveDrawingOverlay(file);
    if (!overlay?.canvas && !overlay?.data?.strokes.length) return;
    const noteDrawApi = (this.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: NoteDrawApiRuntime }> };
    }).plugins?.plugins?.notedraw?.api;
    if (overlay.kind === "notedraw" && noteDrawApi?.readDrawings) return;

    const rect = markdownEl.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(markdownEl.scrollWidth || rect.width || 1));
    const height = Math.max(1, Math.ceil(markdownEl.scrollHeight || rect.height || 1));
    const maxPixelScale = Math.sqrt(PREVIEW_IMAGE_MAX_CANVAS_PIXELS / Math.max(1, width * height));
    const ratio = clampNumber(Math.min(activeWindow.devicePixelRatio || 1, maxPixelScale), 0.5, 2, 1);
    const previousPosition = getComputedStyle(markdownEl).position;
    if (previousPosition === "static") markdownEl.setCssStyles({ position: "relative" });

    markdownEl.addClass("mobile-pdf-exporter-note-doodle-host");
    const canvas = appendElement(markdownEl, "canvas", {
      cls: `mobile-pdf-exporter-note-doodle-canvas mobile-pdf-exporter-live-drawing-canvas note-doodle-canvas ${overlay.kind === "notedraw" ? "notedraw-canvas" : ""}`
    });
    canvas.width = Math.max(1, Math.ceil(width * ratio));
    canvas.height = Math.max(1, Math.ceil(height * ratio));
    canvas.setCssStyles({
      width: `${width}px`,
      height: `${height}px`,
      position: "absolute",
      left: "0",
      top: "0",
      pointerEvents: "none",
      zIndex: "60"
    });
    canvas.setAttribute("aria-hidden", "true");

    const context = canvas.getContext("2d");
    if (!context) {
      canvas.remove();
      return;
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (overlay.canvas && drawLiveDrawingCanvas(context, overlay.canvas, overlay.surface, markdownEl, width, height)) return;
    if (overlay.data?.strokes.length) drawNoteDoodleStrokes(context, overlay.data.strokes, width, height);
  }

  private async prepareNoteDrawExportOverlay(
    file: TFile,
    host: HTMLElement
  ): Promise<PreparedNoteDrawExportOverlay> {
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(host.scrollWidth || rect.width || 1));
    const height = Math.max(1, Math.ceil(host.scrollHeight || rect.height || 1));
    const contentFrame = measureNoteDrawTargetContentFrame(host, width);
    const empty = (): PreparedNoteDrawExportOverlay => ({
      cleanup: () => undefined,
      data: null,
      elements: [],
      sourceElements: [],
      widthPx: width,
      heightPx: height,
      contentFrame
    });
    const plugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: NoteDrawApiRuntime }> };
    }).plugins?.plugins;
    const api = plugins?.notedraw?.api;
    if (!api?.readDrawings) return empty();

    let rawData: unknown;
    try {
      rawData = await api.readDrawings(file);
    } catch (error) {
      console.warn("Mobile PDF Exporter could not read NoteDraw data", error);
      return empty();
    }

    if ((rawData as { visible?: unknown } | null)?.visible === false) return empty();
    const data = normalizeNoteDoodleData(rawData, file);
    const hasLiveCanvas = Array.from(host.querySelectorAll<HTMLCanvasElement>(
      ".notedraw-canvas, .note-doodle-canvas"
    )).some((canvas) => {
      const surface = canvas.closest<HTMLElement>(".notedraw-shell, .note-doodle-shell");
      if (!surface) return false;
      const kind = surface.classList.contains("notedraw-shell") ? "notedraw" : "note-doodle";
      const controller = getLiveDrawingController(surface, kind);
      return controller?.file?.path === file.path &&
        isVisibleLiveDrawingSurface(surface, kind) &&
        isVisibleLiveDrawingCanvas(canvas);
    });

    const existingImageLayers = new Set(host.querySelectorAll(".notedraw-export-image-canvas-layer"));
    if (api.injectExportSnapshot) {
      try {
        await api.injectExportSnapshot(file, host);
      } catch (error) {
        console.warn("Mobile PDF Exporter could not inject NoteDraw export assets", error);
      }
    }
    const injectedImageLayers = Array.from(host.querySelectorAll<HTMLElement>(
      ".notedraw-export-image-canvas-layer"
    )).filter((element) => !existingImageLayers.has(element));
    const sourceElements = await prepareNoteDrawElementData(this.app, host.ownerDocument, rawData);
    const elements = hasLiveCanvas ? [] : sourceElements;

    let canvas: HTMLCanvasElement | null = null;
    let changedPosition = false;
    const previousInlinePosition = host.style.position;
    if (!hasLiveCanvas && (data?.strokes.length || elements.length)) {
      const maxPixelScale = Math.sqrt(PREVIEW_IMAGE_MAX_CANVAS_PIXELS / Math.max(1, width * height));
      const ratio = clampNumber(Math.min(activeWindow.devicePixelRatio || 1, maxPixelScale), 0.5, 2, 1);
      if (getComputedStyle(host).position === "static") {
        host.setCssStyles({ position: "relative" });
        changedPosition = true;
      }

      canvas = appendElement(host, "canvas", {
        cls: "mobile-pdf-exporter-note-doodle-canvas mobile-pdf-exporter-live-drawing-canvas notedraw-canvas"
      });
      canvas.width = Math.max(1, Math.ceil(width * ratio));
      canvas.height = Math.max(1, Math.ceil(height * ratio));
      canvas.setCssStyles({
        width: `${width}px`,
        height: `${height}px`,
        position: "absolute",
        left: "0",
        top: "0",
        pointerEvents: "none",
        zIndex: "60"
      });
      canvas.setAttribute("aria-hidden", "true");
      const context = canvas.getContext("2d");
      if (context) {
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        if (data?.strokes.length) drawNoteDoodleStrokes(context, data.strokes, width, height, contentFrame);
        const projectedElements = projectNoteDrawElements(
          elements,
          width,
          height,
          contentFrame,
          0,
          0,
          1
        );
        const htmlFallbackElements = injectedImageLayers.length > 0
          ? projectedElements.filter((element) => element.kind !== "image")
          : projectedElements;
        drawCanvasNoteDrawElementLayer(context, htmlFallbackElements, {
          pageTopPx: 0,
          pageBottomPx: height,
          sourceWidthPx: width
        });
      } else {
        canvas.remove();
        canvas = null;
      }
    }

    return {
      cleanup: () => {
        canvas?.remove();
        for (const layer of injectedImageLayers) layer.remove();
        if (changedPosition) {
          if (previousInlinePosition) host.style.position = previousInlinePosition;
          else host.style.removeProperty("position");
        }
      },
      data,
      elements,
      sourceElements,
      widthPx: width,
      heightPx: height,
      contentFrame
    };
  }

  private async renderPreviewToSelectablePdf(
    file: TFile,
    model: PreviewPdfModel,
    signal?: AbortSignal
  ): Promise<Blob> {
    throwIfExportCancelled(signal);
    const { PDFDocument: PDFDocumentRuntime, StandardFonts, fontkitModule } = await loadPdfRuntime();

    if (
      model.textFragments.length === 0 &&
      model.imageFragments.length === 0 &&
      model.videoFragments.length === 0 &&
      model.canvasFragments.length === 0 &&
      model.svgFragments.length === 0 &&
      !hasExplicitNoteDrawContent(model)
    ) {
      throw new Error(this.t("previewNoContentError"));
    }

    const pdfDoc = await PDFDocumentRuntime.create();
    pdfDoc.setTitle(file.basename);
    pdfDoc.setSubject(PDF_SUBJECT);
    const fonts = await this.loadExportFontSet(
      pdfDoc,
      fontkitModule,
      StandardFonts.Helvetica,
      model.textFragments.map((fragment) => fragment.text).join("\n")
    );
    const rasterTextFragments = collectVisualRasterTextFragments(model.textFragments);
    const hiddenVisualTextFragments = new Set(rasterTextFragments);
    const hasNoteDrawCanvas = model.canvasFragments.some(isNoteDrawCanvasFragment);
    const visualModel = {
      ...model,
      textFragments: rasterTextFragments,
      canvasFragments: hasNoteDrawCanvas
        ? model.canvasFragments.filter((fragment) => !isNoteDrawCanvasFragment(fragment))
        : model.canvasFragments
    };

    for (let index = 0; index < model.pageBreaks.length - 1; index += 1) {
      throwIfExportCancelled(signal);
      const pageTopPx = model.pageBreaks[index];
      const pageBottomPx = model.pageBreaks[index + 1];
      const pdfPage = pdfDoc.addPage([model.pageWidthPt, model.pageHeightPt]);
      const pngBytes = await renderPreviewPageToPngBytes(visualModel, index, {
        colorMode: this.settings.colorMode,
        rasterScale: Math.max(this.settings.imageRasterScale, SELECTABLE_PREVIEW_BACKGROUND_MIN_SCALE),
        includeText: rasterTextFragments.length > 0
      });
      throwIfExportCancelled(signal);
      const pageImage = await pdfDoc.embedPng(pngBytes);
      pdfPage.drawImage(pageImage, {
        x: 0,
        y: 0,
        width: model.pageWidthPt,
        height: model.pageHeightPt
      });

      drawTextLayer(pdfPage, model.textFragments, {
        fonts,
        pageTopPx,
        pageBottomPx,
        pageWidthPt: model.pageWidthPt,
        pageHeightPt: model.pageHeightPt,
        pxToPt: model.pxToPt,
        contentTopInsetPx: model.bodyTopInsetPx,
        colorMode: this.settings.colorMode,
        opacity: SELECTABLE_TEXT_LAYER_OPACITY,
        drawUnderlines: true,
        hiddenVisualTextFragments
      });

      drawLinkAnnotationLayer(pdfPage, model.linkFragments, {
        pageTopPx,
        pageBottomPx,
        pageWidthPt: model.pageWidthPt,
        pageHeightPt: model.pageHeightPt,
        pxToPt: model.pxToPt,
        contentTopInsetPx: model.bodyTopInsetPx
      });
      drawNoteDrawInkAnnotationLayer(pdfPage, model.noteDrawInkStrokes ?? [], {
        pageTopPx,
        pageBottomPx,
        pageHeightPt: model.pageHeightPt,
        pxToPt: model.pxToPt,
        contentTopInsetPx: model.bodyTopInsetPx
      });
    }

    throwIfExportCancelled(signal);
    await attachEmbeddedAssetsToPdf(pdfDoc, this.app, file.path, model);
    throwIfExportCancelled(signal);
    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    throwIfExportCancelled(signal);
    const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(pdfBuffer).set(pdfBytes);
    return new Blob([pdfBuffer], { type: "application/pdf" });
  }

  private async renderPreviewToImagePdf(
    file: TFile,
    model: PreviewPdfModel,
    signal?: AbortSignal
  ): Promise<Blob> {
    throwIfExportCancelled(signal);
    const { PDFDocument: PDFDocumentRuntime } = await loadPdfRuntime();

    if (
      model.textFragments.length === 0 &&
      model.imageFragments.length === 0 &&
      model.videoFragments.length === 0 &&
      model.canvasFragments.length === 0 &&
      model.svgFragments.length === 0 &&
      !hasExplicitNoteDrawContent(model)
    ) {
      throw new Error(this.t("previewNoContentError"));
    }

    const pdfDoc = await PDFDocumentRuntime.create();
    pdfDoc.setTitle(file.basename);
    pdfDoc.setSubject(IMAGE_PDF_SUBJECT);
    const visualModel = model.canvasFragments.some(isNoteDrawCanvasFragment)
      ? { ...model, canvasFragments: model.canvasFragments.filter((fragment) => !isNoteDrawCanvasFragment(fragment)) }
      : model;

    for (let index = 0; index < model.pageBreaks.length - 1; index += 1) {
      throwIfExportCancelled(signal);
      const pngBytes = await renderPreviewPageToPngBytes(visualModel, index, {
        colorMode: this.settings.colorMode,
        rasterScale: this.settings.imageRasterScale
      });
      throwIfExportCancelled(signal);
      const pageImage = await pdfDoc.embedPng(pngBytes);
      const pdfPage = pdfDoc.addPage([model.pageWidthPt, model.pageHeightPt]);
      pdfPage.drawImage(pageImage, {
        x: 0,
        y: 0,
        width: model.pageWidthPt,
        height: model.pageHeightPt
      });

      drawLinkAnnotationLayer(pdfPage, model.linkFragments, {
        pageTopPx: model.pageBreaks[index],
        pageBottomPx: model.pageBreaks[index + 1],
        pageWidthPt: model.pageWidthPt,
        pageHeightPt: model.pageHeightPt,
        pxToPt: model.pxToPt,
        contentTopInsetPx: model.bodyTopInsetPx
      });
      drawNoteDrawInkAnnotationLayer(pdfPage, model.noteDrawInkStrokes ?? [], {
        pageTopPx: model.pageBreaks[index],
        pageBottomPx: model.pageBreaks[index + 1],
        pageHeightPt: model.pageHeightPt,
        pxToPt: model.pxToPt,
        contentTopInsetPx: model.bodyTopInsetPx
      });
    }

    throwIfExportCancelled(signal);
    await attachEmbeddedAssetsToPdf(pdfDoc, this.app, file.path, model);
    throwIfExportCancelled(signal);
    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    throwIfExportCancelled(signal);
    const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(pdfBuffer).set(pdfBytes);
    return new Blob([pdfBuffer], { type: "application/pdf" });
  }

  private async renderModelToFormat(
    file: TFile,
    model: PreviewPdfModel,
    format: ExportFormat,
    signal?: AbortSignal
  ): Promise<Blob> {
    if (format === "pdf") {
      return this.settings.noteExportMode === "image"
        ? this.renderPreviewToImagePdf(file, model, signal)
        : this.renderPreviewToSelectablePdf(file, model, signal);
    }
    const needsExplicitNoteDraw = format === "docx" || format === "pptx" || format === "png";
    const needsSourceNoteDrawElements = format === "docx" && Boolean(model.noteDrawSourceElements?.length);
    const pageModel = needsExplicitNoteDraw && (hasExplicitNoteDrawContent(model) || needsSourceNoteDrawElements)
      ? { ...model, canvasFragments: model.canvasFragments.filter((fragment) => !isNoteDrawCanvasFragment(fragment)) }
      : model;
    if (format === "pptx") {
      return buildEditablePptx(file, pageModel, {
        colorMode: this.settings.colorMode,
        rasterScale: this.settings.imageRasterScale,
        app: this.app,
        sourcePath: file.path
      });
    }
    if (format === "docx") {
      return buildEditableDocx(file, pageModel, {
        colorMode: this.settings.colorMode,
        rasterScale: this.settings.imageRasterScale,
        app: this.app,
        sourcePath: file.path
      });
    }
    if (format === "html") {
      return buildSemanticHtml(file, model);
    }
    const pages = await this.renderModelPagesToPng(model, signal, true, true);
    if (format === "png") return combinePngPages(pages);
    throw new Error("Unsupported export format.");
  }

  private async renderModelPagesToPng(
    model: PreviewPdfModel,
    signal?: AbortSignal,
    includeText = true,
    includeDecorations = true
  ): Promise<Uint8Array[]> {
    const pages: Uint8Array[] = [];
    for (let index = 0; index < model.pageBreaks.length - 1; index += 1) {
      throwIfExportCancelled(signal);
      pages.push(await renderPreviewPageToPngBytes(model, index, {
        colorMode: this.settings.colorMode,
        rasterScale: this.settings.imageRasterScale,
        includeText,
        includeDecorations,
        includeNoteDraw: true
      }));
      await nextAnimationFrame();
    }
    return pages;
  }

  private capturePreviewPdfModel(file: TFile, pageEl: HTMLElement): PreviewPdfModel {
    return withExportableElementCache(() => {
      const linkContext = createPdfLinkContext(this.app, file);
      const pageSizeMm = getConfiguredPageSizeMm(this.settings);
      const pageWidthPt = mmToPt(pageSizeMm.width);
      const pageHeightPt = mmToPt(pageSizeMm.height);
      const sourceWidthPx = Math.max(pageEl.getBoundingClientRect().width, 1);
      const pxToPt = pageWidthPt / sourceWidthPx;
      const pageHeightPx = pageHeightPt / pxToPt;
      const { bodyTopInsetPx, bodyBottomInsetPx, bodyHeightPx } = getPageBodyLayoutPx(this.settings, pageHeightPx);
      const boxFragments = captureBoxFragments(pageEl);
      const textFragments = captureTextFragments(pageEl, linkContext);
      const imageFragments = captureImageFragments(pageEl);
      const videoFragments = captureVideoFragments(pageEl);
      const canvasFragments = captureCanvasFragments(pageEl);
      const linkFragments = [
        ...captureLinkFragments(pageEl, linkContext),
        ...captureVideoLinkFragments(videoFragments, linkContext)
      ];
      const svgFragments = captureSvgFragments(pageEl);
      const decorationFragments = captureDecorationFragments(pageEl);
      const keepBlocks = captureKeepBlockFragments(
        pageEl,
        textFragments,
        imageFragments,
        videoFragments,
        canvasFragments,
        boxFragments,
        svgFragments,
        decorationFragments
      );
      const contentHeightPx = measureExportContentHeight(
        pageEl,
        textFragments,
        imageFragments,
        videoFragments,
        canvasFragments,
        boxFragments,
        svgFragments,
        decorationFragments,
        keepBlocks
      );
      const pageBreaks = computePageBreaks(contentHeightPx, bodyHeightPx, keepBlocks);

      const model: PreviewPdfModel = {
        ownerDocument: pageEl.ownerDocument,
        pageWidthPt,
        pageHeightPt,
        sourceWidthPx,
        pxToPt,
        pageHeightPx,
        bodyTopInsetPx,
        bodyBottomInsetPx,
        bodyHeightPx,
        horizontalInsetPx: mmToPx(this.settings.marginMm),
        background: parseCssColor(getComputedStyle(pageEl).backgroundColor) ?? rgb(1, 1, 1),
        foreground: parseCssColor(getComputedStyle(pageEl).color) ?? rgb(0.12, 0.12, 0.12),
        boxFragments,
        textFragments,
        imageFragments,
        videoFragments,
        canvasFragments,
        linkFragments,
        svgFragments,
        decorationFragments,
        keepBlocks,
        contentHeightPx,
        pageBreaks,
        title: file.basename,
        headerText: this.settings.headerText,
        footerText: this.settings.footerText,
        exportDate: formatExportDate(new Date())
      };
      model.pageBreaks = removeEmptyTrailingPageBreaks(model);
      return model;
    });
  }

  private async loadFontBytes(): Promise<ArrayBuffer> {
    if (!this.fontBytesPromise) {
      this.fontBytesPromise = this.resolveFontBytes().catch((error) => {
        this.fontBytesPromise = null;
        throw error;
      });
    }
    return this.fontBytesPromise;
  }

  private async resolveFontBytes(): Promise<ArrayBuffer> {
    let embeddedError: unknown = null;
    try {
      return await this.loadEmbeddedCompressedFontBytes();
    } catch (error) {
      embeddedError = error;
    }

    try {
      return await this.loadLocalFontBytes();
    } catch (localError) {
      try {
        const fontBytes = await this.downloadRemoteFontBytes();
        void this.cacheRemoteFontBytes(fontBytes);
        return fontBytes;
      } catch (downloadError) {
        console.warn("Mobile PDF Exporter CJK font unavailable.", { embeddedError, localError, downloadError });
        throw new Error(this.t("fontMissingError"));
      }
    }
  }

  private async loadEmbeddedCompressedFontBytes(): Promise<ArrayBuffer> {
    return decompressEmbeddedFont(embeddedCjkFontGzipBase64, "default");
  }

  private async loadLocalFontBytes(): Promise<ArrayBuffer> {
    let lastError: unknown = null;
    for (const relativePath of LOCAL_CJK_FONT_CANDIDATES) {
      try {
        return await this.app.vault.adapter.readBinary(this.getPluginAssetPath(relativePath));
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(typeof lastError === "string" && lastError ? lastError : "No local CJK font asset found.");
  }

  private async downloadRemoteFontBytes(): Promise<ArrayBuffer> {
    let lastError: unknown = null;
    for (const url of this.getRemoteFontUrls()) {
      try {
        const response = await requestUrl({ url, method: "GET" });
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Font download failed with HTTP ${response.status}.`);
        }
        return response.arrayBuffer;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(typeof lastError === "string" && lastError ? lastError : "Font download failed.");
  }

  private getRemoteFontUrls(): string[] {
    const fontPath = `fonts/${encodeURIComponent(CJK_FONT_ASSET_FILE)}`;
    const version = encodeURIComponent(this.manifest.version);
    return [
      `${CJK_FONT_RAW_ASSET_URL_BASE}/${version}/${fontPath}`,
      `${CJK_FONT_JSDELIVR_URL_BASE}@${version}/${fontPath}`,
      `${CJK_FONT_RAW_ASSET_URL_BASE}/main/${fontPath}`,
      `${CJK_FONT_JSDELIVR_URL_BASE}@main/${fontPath}`
    ];
  }

  private async cacheRemoteFontBytes(fontBytes: ArrayBuffer): Promise<void> {
    const fontDir = this.getPluginAssetPath("fonts");
    const fontPath = this.getPluginAssetPath(`fonts/${CJK_FONT_ASSET_FILE}`);
    try {
      if (!(await this.app.vault.adapter.exists(fontDir))) {
        await this.app.vault.adapter.mkdir(fontDir);
      }
      await this.app.vault.adapter.writeBinary(fontPath, fontBytes.slice(0));
    } catch (error) {
      console.warn("Mobile PDF Exporter could not cache the downloaded CJK font.", error);
    }
  }

  private async loadExportFont(
    pdfDoc: PDFDocument,
    fontkitModule: PdfFontkitRuntime,
    standardFont: string
  ): Promise<ExportFont> {
    try {
      pdfDoc.registerFontkit(resolvePdfFontkit(fontkitModule));
      return {
        font: await pdfDoc.embedFont(await this.loadFontBytes(), {
          subset: false,
          features: { locl: false }
        }),
        supportsUnicode: true
      };
    } catch (error) {
      console.warn("Mobile PDF Exporter custom PDF font unavailable; falling back to a standard PDF font.", error);
      return {
        font: await pdfDoc.embedFont(standardFont),
        supportsUnicode: false
      };
    }
  }

  private async loadExportFontSet(
    pdfDoc: PDFDocument,
    fontkitModule: PdfFontkitRuntime,
    standardFont: string,
    text: string
  ): Promise<ExportFontSet> {
    const primary = await this.loadExportFont(pdfDoc, fontkitModule, standardFont);
    const fallbacks: ExportFontSet["fallbacks"] = {};
    const required = detectRequiredPdfScriptFonts(text);
    if (required.length === 0) return { default: primary.font, fallbacks };

    try {
      pdfDoc.registerFontkit(resolvePdfFontkit(fontkitModule));
      await Promise.all(required.map(async (script) => {
        try {
          const bytes = await decompressEmbeddedFont(EMBEDDED_SCRIPT_FONT_BASE64[script], script);
          fallbacks[script] = await pdfDoc.embedFont(bytes, { subset: false });
        } catch (error) {
          console.warn(`Mobile PDF Exporter ${script} PDF font unavailable`, error);
        }
      }));
    } catch (error) {
      console.warn("Mobile PDF Exporter multilingual PDF fonts unavailable", error);
    }

    return { default: primary.font, fallbacks };
  }

  private getPluginAssetPath(relativePath: string): string {
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return normalizePath(`${pluginDir}/${relativePath}`);
  }

  async getOptionalAssetResourcePath(relativePath: string): Promise<string | null> {
    const assetPath = this.getPluginAssetPath(relativePath);
    if (!(await this.app.vault.adapter.exists(assetPath))) return null;
    return this.app.vault.adapter.getResourcePath(assetPath);
  }

  private async getAvailableOutputPath(
    file: TFile,
    outputFolder: string,
    requestedBaseName?: string,
    format: ExportFormat = "pdf"
  ): Promise<string> {
    const folder = normalizeVaultFolderPath(outputFolder);
    const date = new Date();
    const stamp = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
    const baseName = sanitizePdfBaseName(requestedBaseName) || sanitizeFileName(`${file.basename}-preview-${stamp}`);

    for (let index = 0; index < 1000; index += 1) {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      const path = normalizePath(`${folder ? `${folder}/` : ""}${baseName}${suffix}.${format}`);
      if (!(await this.app.vault.adapter.exists(path))) return path;
    }

    throw new Error(this.t("uniqueFileNameError"));
  }

  private async ensureFolderExists(outputFolder: string): Promise<void> {
    const folder = normalizeVaultFolderPath(outputFolder);
    if (!folder) return;
    const parts = folder.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = await this.app.vault.adapter.exists(current);
      if (!exists) await this.app.vault.createFolder(current);
    }
  }

  private async shareFileIfAvailable(blob: Blob, outputPath: string): Promise<void> {
    const share = navigator.share?.bind(navigator);
    const canShare = navigator.canShare?.bind(navigator);
    if (!share || !canShare || typeof File === "undefined") return;

    const fileName = outputPath.split("/").pop() ?? "export";
    const file = new File([blob], fileName, { type: blob.type || "application/octet-stream" });
    const shareData: ShareData = {
      files: [file],
      title: fileName
    };

    if (!canShare(shareData)) return;

    try {
      await share(shareData);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Mobile PDF Exporter share failed", error);
      new Notice(this.t("shareFailedNotice"), 5000);
    }
  }
}

class MobilePdfExportOptionsModal extends Modal {
  private draft: MobilePdfExporterSettings;
  private exporting = false;
  private outputBaseName: string;

  constructor(
    app: App,
    private plugin: MobilePdfExporterPlugin,
    private file: TFile
  ) {
    super(app);
    this.draft = cloneSettings(plugin.settings);
    this.outputBaseName = defaultPdfBaseName(file);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mobile-pdf-exporter-options-modal");
    this.plugin.warmupExportRuntime();

    this.addActionToolbar(contentEl);

    appendElement(contentEl, "h2", { text: this.plugin.t("optionsTitle") });
    appendElement(contentEl, "p", {
      cls: "mobile-pdf-exporter-options-subtitle",
      text: this.file.basename
    });

    this.addOutputLocationSetting(contentEl);

    new Setting(contentEl)
      .setName(this.plugin.t("exportModeName"))
      .setDesc(this.plugin.t("exportModeDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("selectable", this.plugin.t("exportModeSelectable"))
          .addOption("image", this.plugin.t("exportModeImage"))
          .setValue(this.draft.noteExportMode)
          .onChange((value) => {
            this.draft.noteExportMode = normalizeChoice(value, NOTE_PDF_EXPORT_MODES, DEFAULT_SETTINGS.noteExportMode);
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("pageSizeName"))
      .addDropdown((dropdown) => {
        for (const preset of PDF_PAGE_PRESETS) dropdown.addOption(preset, getPageLabel(preset, this.plugin.getResolvedLanguage()));
        dropdown
          .setValue(this.draft.pagePreset)
          .onChange((value) => {
            this.draft.pagePreset = normalizeChoice(value, PDF_PAGE_PRESETS, DEFAULT_SETTINGS.pagePreset);
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("orientationName"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("portrait", this.plugin.t("orientationPortrait"))
          .addOption("landscape", this.plugin.t("orientationLandscape"))
          .setValue(this.draft.pageOrientation)
          .onChange((value) => {
            this.draft.pageOrientation = normalizeChoice(value, PDF_ORIENTATIONS, DEFAULT_SETTINGS.pageOrientation);
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("colorName"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("color", this.plugin.t("colorOption"))
          .addOption("grayscale", this.plugin.t("grayscaleOption"))
          .setValue(this.draft.colorMode)
          .onChange((value) => {
            this.draft.colorMode = normalizeChoice(value, PDF_COLOR_MODES, DEFAULT_SETTINGS.colorMode);
          });
      });

    const marginSetting = new Setting(contentEl)
      .setName(this.plugin.t("marginName"))
      .setDesc(`${this.draft.marginMm} mm`);
    marginSetting.addSlider((slider) => {
      slider
        .setLimits(0, 18, 1)
        .setDynamicTooltip()
        .setValue(this.draft.marginMm)
        .onChange((value) => {
          this.draft.marginMm = value;
          marginSetting.setDesc(`${value} mm`);
        });
    });

    const scaleSetting = new Setting(contentEl)
      .setName(this.plugin.t("contentScaleName"))
      .setDesc(`${this.draft.contentScalePercent}%`);
    scaleSetting.addSlider((slider) => {
      slider
        .setLimits(80, 125, 5)
        .setDynamicTooltip()
        .setValue(this.draft.contentScalePercent)
        .onChange((value) => {
          this.draft.contentScalePercent = value;
          scaleSetting.setDesc(`${value}%`);
        });
    });

    new Setting(contentEl)
      .setName(this.plugin.t("imageQualityName"))
      .setDesc(this.plugin.t("imageQualityDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("1", this.plugin.t("imageQualityStandard"))
          .addOption("1.5", this.plugin.t("imageQualityClear"))
          .addOption("2", this.plugin.t("imageQualityHigh"))
          .addOption("3", this.plugin.t("imageQualityUltra"))
          .setValue(String(this.draft.imageRasterScale))
          .onChange((value) => {
            this.draft.imageRasterScale = clampNumber(Number.parseFloat(value), 1, 3, DEFAULT_SETTINGS.imageRasterScale);
          });
      });

    const zipDepthSetting = new Setting(contentEl)
      .setName("ZIP \u5d4c\u5165\u6df1\u5ea6")
      .setDesc(`\u5bfc\u51fa ZIP \u65f6\u5305\u542b\u7684\u5d4c\u5165\u7b14\u8bb0\u94fe\u63a5\u6df1\u5ea6\uff08\u5f53\u524d: ${this.draft.zipEmbedDepth} \u7ea7\uff09`);
    zipDepthSetting.addSlider((slider) => {
      slider
        .setLimits(0, 5, 1)
        .setDynamicTooltip()
        .setValue(this.draft.zipEmbedDepth)
        .onChange((value) => {
          this.draft.zipEmbedDepth = value;
          zipDepthSetting.setDesc(`\u5bfc\u51fa ZIP \u65f6\u5305\u542b\u7684\u5d4c\u5165\u7b14\u8bb0\u94fe\u63a5\u6df1\u5ea6\uff08\u5f53\u524d: ${value} \u7ea7\uff09`);
        });
    });

    new Setting(contentEl)
      .setName(this.plugin.t("includeTitleName"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.draft.includeTitle)
          .onChange((value) => {
            this.draft.includeTitle = value;
          });
      });

    this.addHeaderFooterSetting(contentEl, "headerText");
    this.addHeaderFooterSetting(contentEl, "footerText");

    new Setting(contentEl)
      .setName(this.plugin.t("openAfterExportName"))
      .setDesc(this.plugin.t("openAfterExportDesc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.draft.openAfterExport)
          .onChange((value) => {
            this.draft.openAfterExport = value;
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("shareAfterExportName"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.draft.shareAfterExport)
          .onChange((value) => {
            this.draft.shareAfterExport = value;
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("rememberLastExportOptionsName"))
      .setDesc(this.plugin.t("rememberLastExportOptionsDesc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.draft.rememberLastExportOptions)
          .onChange((value) => {
            this.draft.rememberLastExportOptions = value;
          });
      });

  }

  private addOutputLocationSetting(parent: HTMLElement): void {
    const setting = new Setting(parent).setName(this.plugin.t("outputLocationName"));
    let refreshFolderInput = (): void => undefined;

    setting.addDropdown((dropdown) => {
      dropdown
        .addOption("current", this.plugin.t("outputLocationCurrent"))
        .addOption("folder", this.plugin.t("outputLocationFolder"))
        .setValue(this.draft.outputLocation)
        .onChange((value) => {
          this.draft.outputLocation = normalizeChoice(value, OUTPUT_LOCATIONS, DEFAULT_SETTINGS.outputLocation);
          refreshFolderInput();
        });
    });

    setting.addText((text) => {
      text
        .setPlaceholder(this.plugin.t("outputFolderPlaceholder"))
        .setValue(this.draft.outputFolder)
        .onChange((value) => {
          this.draft.outputFolder = value;
        });
      refreshFolderInput = () => {
        const usesCustomFolder = this.draft.outputLocation === "folder";
        text.setDisabled(!usesCustomFolder);
        setting.setDesc(this.plugin.t(usesCustomFolder ? "outputLocationFolderDesc" : "outputLocationCurrentDesc"));
      };
      refreshFolderInput();
    });
  }

  private addHeaderFooterSetting(parent: HTMLElement, field: "headerText" | "footerText"): void {
    const isHeader = field === "headerText";
    new Setting(parent)
      .setName(this.plugin.t(isHeader ? "headerTextName" : "footerTextName"))
      .setDesc(this.plugin.t(isHeader ? "headerTextDesc" : "footerTextDesc"))
      .addText((text) => {
        text
          .setPlaceholder(isHeader ? "{title}" : "{page} / {pages}")
          .setValue(this.draft[field])
          .onChange((value) => {
            this.draft[field] = value;
          });
        text.inputEl.maxLength = 240;
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async exportWithDraft(format: ExportFormat = "pdf"): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;
    const exportSettings = cloneSettings(this.draft);
    const outputBaseName = sanitizePdfBaseName(this.outputBaseName) || defaultPdfBaseName(this.file);
    const exportingPrompt = new PdfExportBusyPrompt(this.file.basename, this.plugin.getResolvedLanguage());

    try {
      await exportingPrompt.waitUntilPainted();
      this.close();

      const exportOptions: ExportFileOptions = {
        outputBaseName,
        busyPrompt: exportingPrompt,
        format,
        zipEmbedDepth: this.draft.zipEmbedDepth
      };

      if (exportSettings.rememberLastExportOptions) {
        this.plugin.settings = cloneSettings(exportSettings);
        await this.plugin.saveSettings();
        await this.plugin.exportFile(this.file, undefined, exportOptions);
        return;
      }

      if (this.plugin.settings.rememberLastExportOptions) {
        this.plugin.settings.rememberLastExportOptions = false;
        await this.plugin.saveSettings();
      }

      await this.plugin.exportFile(this.file, exportSettings, exportOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      exportingPrompt.fail(message);
      exportingPrompt.closeSoon();
      throw error;
    }
  }

  private addActionToolbar(parent: HTMLElement): void {
    const toolbarEl = appendElement(parent, "div", {
      cls: "mobile-pdf-exporter-options-toolbar"
    });
    const innerEl = appendElement(toolbarEl, "div", {
      cls: "mobile-pdf-exporter-options-toolbar-inner"
    });

    const nameWrapEl = appendElement(innerEl, "label", {
      cls: "mobile-pdf-exporter-options-name"
    });
    appendElement(nameWrapEl, "span", {
      cls: "mobile-pdf-exporter-options-name-label",
      text: this.plugin.t("pdfNameLabel")
    });
    const nameInput = appendElement(nameWrapEl, "input", {
      cls: "mobile-pdf-exporter-options-name-input"
    });
    nameInput.type = "text";
    nameInput.value = this.outputBaseName;
    nameInput.placeholder = defaultPdfBaseName(this.file);
    nameInput.enterKeyHint = "done";
    nameInput.addEventListener("input", () => {
      this.outputBaseName = nameInput.value;
    });
    nameInput.addEventListener("blur", () => {
      const normalized = sanitizePdfBaseName(nameInput.value) || defaultPdfBaseName(this.file);
      this.outputBaseName = normalized;
      nameInput.value = normalized;
    });

    const exportButton = appendElement(innerEl, "button", {
      cls: "mod-cta mobile-pdf-exporter-options-button",
      text: this.plugin.t("exportPdfButton")
    });
    exportButton.type = "button";
    exportButton.addEventListener("click", () => {
      exportButton.disabled = true;
      void this.exportWithDraft().catch(() => {
        exportButton.disabled = false;
      });
    });

    // Icon buttons for the secondary export formats, listed below the PDF button.
    const formatButtons: Array<{ value: ExportFormat; icon: string; label: string }> = [
      { value: "docx", icon: "file-text", label: "docx" },
      { value: "pptx", icon: "presentation", label: "pptx" },
      { value: "png", icon: "image-file", label: "png" },
      { value: "html", icon: "file-code", label: "html" },
      { value: "zip", icon: "file-zip", label: "zip" }
    ];
    const formatButtonRow = appendElement(innerEl, "div", {
      cls: "mobile-pdf-exporter-format-buttons"
    });
    for (const fmt of formatButtons) {
      const button = appendElement(formatButtonRow, "button", {
        cls: "mobile-pdf-exporter-format-button"
      });
      button.type = "button";
      const iconEl = appendElement(button, "span", { cls: "mobile-pdf-exporter-format-icon" });
      setIcon(iconEl, fmt.icon);
      appendElement(button, "span", { cls: "mobile-pdf-exporter-format-label", text: fmt.label });
      button.addEventListener("click", () => {
        button.disabled = true;
        void this.exportWithDraft(fmt.value).catch(() => {
          button.disabled = false;
        });
      });
    }
  }
}

class PdfExportBusyPrompt {
  private readonly rootEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly elapsedEl: HTMLElement;
  private readonly cancelButtonEl: HTMLButtonElement;
  private readonly abortController = new AbortController();
  private readonly startedAt = Date.now();
  private readonly timer: number;
  private closeTimer = 0;
  private closed = false;
  private failed = false;
  private cancelled = false;
  private painted = false;
  readonly signal = this.abortController.signal;

  constructor(noteName: string, private readonly language: ResolvedUiLanguage) {
    this.rootEl = appendElement(activeDocument.body, "div", {
      cls: "mobile-pdf-exporter-busy"
    });
    this.titleEl = appendElement(this.rootEl, "div", {
      cls: "mobile-pdf-exporter-busy-title",
      text: translate(this.language, "busyExporting")
    });
    appendElement(this.rootEl, "div", {
      cls: "mobile-pdf-exporter-busy-file",
      text: noteName
    });
    this.elapsedEl = appendElement(this.rootEl, "div", {
      cls: "mobile-pdf-exporter-busy-elapsed",
      text: formatBusyElapsed(this.language, 0)
    });
    this.cancelButtonEl = appendElement(this.rootEl, "button", {
      cls: "mobile-pdf-exporter-busy-cancel",
      text: translate(this.language, "busyCancelButton")
    });
    this.cancelButtonEl.type = "button";
    this.cancelButtonEl.addEventListener("click", () => this.requestCancel());
    this.timer = activeWindow.setInterval(() => this.updateElapsed(), 1000);
  }

  async waitUntilPainted(): Promise<void> {
    if (this.closed || this.painted) return;
    this.rootEl.setCssStyles({ display: "grid" });
    this.rootEl.addClass("is-visible");
    this.rootEl.getBoundingClientRect();
    this.updateElapsed();
    await nextAnimationFrame(FRAME_WAIT_TIMEOUT_MS);
    await delay(BUSY_PROMPT_PAINT_WAIT_MS);
    this.painted = true;
  }

  done(): void {
    if (this.closed || this.cancelled) return;
    this.rootEl.addClass("is-complete");
    this.titleEl.textContent = translate(this.language, "busyCompleteTitle");
    this.elapsedEl.textContent = translate(this.language, "busyCompleteStatus");
    this.cancelButtonEl.disabled = true;
    this.cancelButtonEl.setCssStyles({ display: "none" });
    activeWindow.clearInterval(this.timer);
  }

  fail(message: string): void {
    if (this.closed || this.cancelled) return;
    this.failed = true;
    this.rootEl.addClass("is-error");
    this.titleEl.textContent = translate(this.language, "busyFailedTitle");
    this.elapsedEl.textContent = message;
    this.cancelButtonEl.disabled = true;
    this.cancelButtonEl.setCssStyles({ display: "none" });
    this.updateElapsed();
  }

  markCancelled(): void {
    if (this.closed || this.cancelled) return;
    this.cancelled = true;
    this.rootEl.addClass("is-cancelled");
    this.titleEl.textContent = translate(this.language, "busyCancelledTitle");
    this.elapsedEl.textContent = translate(this.language, "busyCancelledStatus");
    this.cancelButtonEl.disabled = true;
    this.cancelButtonEl.setCssStyles({ display: "none" });
    activeWindow.clearInterval(this.timer);
  }

  closeSoon(): void {
    if (this.closed || this.closeTimer) return;
    this.closeTimer = activeWindow.setTimeout(() => this.close(), this.failed ? 5200 : this.cancelled ? 1800 : 1400);
  }

  private updateElapsed(): void {
    if (this.failed || this.cancelled) return;
    const seconds = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
    if (this.rootEl.classList.contains("is-complete")) {
      this.elapsedEl.textContent = translate(this.language, "busyCompleteStatus");
      return;
    }
    this.elapsedEl.textContent = formatBusyElapsed(this.language, seconds);
  }

  private requestCancel(): void {
    if (this.closed || this.cancelled || this.signal.aborted) return;
    this.abortController.abort();
    this.markCancelled();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    activeWindow.clearInterval(this.timer);
    if (this.closeTimer) activeWindow.clearTimeout(this.closeTimer);
    this.rootEl.remove();
  }
}

class MobilePdfExporterSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MobilePdfExporterPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.replaceChildren();
    appendElement(containerEl, "p", { text: this.plugin.t("settingsIntro") });

    new Setting(containerEl).setName(this.plugin.t("settingsGeneralHeading")).setHeading();

    new Setting(containerEl)
      .setName(this.plugin.t("languageName"))
      .setDesc(this.plugin.t("languageDesc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("auto", this.plugin.t("languageAuto"));
        for (const [language, label] of Object.entries(UI_LANGUAGE_LABELS)) {
          dropdown.addOption(language, label);
        }
        dropdown
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = normalizeChoice(value, UI_LANGUAGES, DEFAULT_SETTINGS.language);
            await this.plugin.saveSettings();
            this.plugin.refreshLocalizedActions();
            this.display();
          });
      });

    new Setting(containerEl).setName(this.plugin.t("settingsNoteOptionsHeading")).setHeading();

    new Setting(containerEl)
      .setName(this.plugin.t("exportModeName"))
      .setDesc(this.plugin.t("exportModeDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("selectable", this.plugin.t("exportModeSelectable"))
          .addOption("image", this.plugin.t("exportModeImage"))
          .setValue(this.plugin.settings.noteExportMode)
          .onChange(async (value) => {
            this.plugin.settings.noteExportMode = normalizeChoice(value, NOTE_PDF_EXPORT_MODES, DEFAULT_SETTINGS.noteExportMode);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("pageSizeName"))
      .setDesc(this.plugin.t("pageSizeDesc"))
      .addDropdown((dropdown) => {
        for (const preset of PDF_PAGE_PRESETS) dropdown.addOption(preset, getPageLabel(preset, this.plugin.getResolvedLanguage()));
        dropdown
          .setValue(this.plugin.settings.pagePreset)
          .onChange(async (value) => {
            this.plugin.settings.pagePreset = normalizeChoice(value, PDF_PAGE_PRESETS, DEFAULT_SETTINGS.pagePreset);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("orientationName"))
      .setDesc(this.plugin.t("orientationDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("portrait", this.plugin.t("orientationPortrait"))
          .addOption("landscape", this.plugin.t("orientationLandscape"))
          .setValue(this.plugin.settings.pageOrientation)
          .onChange(async (value) => {
            this.plugin.settings.pageOrientation = normalizeChoice(value, PDF_ORIENTATIONS, DEFAULT_SETTINGS.pageOrientation);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("colorName"))
      .setDesc(this.plugin.t("colorDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("color", this.plugin.t("colorOption"))
          .addOption("grayscale", this.plugin.t("grayscaleOption"))
          .setValue(this.plugin.settings.colorMode)
          .onChange(async (value) => {
            this.plugin.settings.colorMode = normalizeChoice(value, PDF_COLOR_MODES, DEFAULT_SETTINGS.colorMode);
            await this.plugin.saveSettings();
          });
      });

    const marginSetting = new Setting(containerEl)
      .setName(this.plugin.t("marginName"))
      .setDesc(`${this.plugin.settings.marginMm} mm`);
    marginSetting.addSlider((slider) => {
      slider
        .setLimits(0, 18, 1)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.marginMm)
        .onChange(async (value) => {
          this.plugin.settings.marginMm = value;
          marginSetting.setDesc(`${value} mm`);
          await this.plugin.saveSettings();
        });
    });

    const scaleSetting = new Setting(containerEl)
      .setName(this.plugin.t("contentScaleName"))
      .setDesc(`${this.plugin.settings.contentScalePercent}%`);
    scaleSetting.addSlider((slider) => {
      slider
        .setLimits(80, 125, 5)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.contentScalePercent)
        .onChange(async (value) => {
          this.plugin.settings.contentScalePercent = value;
          scaleSetting.setDesc(`${value}%`);
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl)
      .setName(this.plugin.t("imageQualityName"))
      .setDesc(this.plugin.t("imageQualityDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("1", this.plugin.t("imageQualityStandard"))
          .addOption("1.5", this.plugin.t("imageQualityClear"))
          .addOption("2", this.plugin.t("imageQualityHigh"))
          .addOption("3", this.plugin.t("imageQualityUltra"))
          .setValue(String(this.plugin.settings.imageRasterScale))
          .onChange(async (value) => {
            this.plugin.settings.imageRasterScale = clampNumber(Number.parseFloat(value), 1, 3, DEFAULT_SETTINGS.imageRasterScale);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("includeTitleName"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.includeTitle)
          .onChange(async (value) => {
            this.plugin.settings.includeTitle = value;
            await this.plugin.saveSettings();
          });
      });

    this.addHeaderFooterSettings(containerEl);

    new Setting(containerEl).setName(this.plugin.t("settingsSaveAndShareHeading")).setHeading();

    this.addOutputLocationSetting(containerEl);

    new Setting(containerEl)
      .setName(this.plugin.t("rememberLastExportOptionsName"))
      .setDesc(this.plugin.t("rememberLastExportOptionsDesc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.rememberLastExportOptions)
          .onChange(async (value) => {
            this.plugin.settings.rememberLastExportOptions = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("openAfterExportName"))
      .setDesc(this.plugin.t("openAfterExportDesc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.openAfterExport)
          .onChange(async (value) => {
            this.plugin.settings.openAfterExport = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("shareAfterExportName"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.shareAfterExport)
          .onChange(async (value) => {
            this.plugin.settings.shareAfterExport = value;
            await this.plugin.saveSettings();
          });
      });

    const codesContainer = appendElement(containerEl, "div", {
      cls: "mobile-pdf-exporter-settings-codes"
    });
    this.renderExtraCodes(codesContainer);
  }

  private addOutputLocationSetting(containerEl: HTMLElement): void {
    const setting = new Setting(containerEl).setName(this.plugin.t("outputLocationName"));
    let refreshFolderInput = (): void => undefined;

    setting.addDropdown((dropdown) => {
      dropdown
        .addOption("current", this.plugin.t("outputLocationCurrent"))
        .addOption("folder", this.plugin.t("outputLocationFolder"))
        .setValue(this.plugin.settings.outputLocation)
        .onChange(async (value) => {
          this.plugin.settings.outputLocation = normalizeChoice(value, OUTPUT_LOCATIONS, DEFAULT_SETTINGS.outputLocation);
          refreshFolderInput();
          await this.plugin.saveSettings();
        });
    });

    setting.addText((text) => {
      text
        .setPlaceholder(this.plugin.t("outputFolderPlaceholder"))
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value;
          await this.plugin.saveSettings();
        });
      refreshFolderInput = () => {
        const usesCustomFolder = this.plugin.settings.outputLocation === "folder";
        text.setDisabled(!usesCustomFolder);
        setting.setDesc(this.plugin.t(usesCustomFolder ? "outputLocationFolderDesc" : "outputLocationCurrentDesc"));
      };
      refreshFolderInput();
    });
  }

  private addHeaderFooterSettings(containerEl: HTMLElement): void {
    for (const field of ["headerText", "footerText"] as const) {
      const isHeader = field === "headerText";
      new Setting(containerEl)
        .setName(this.plugin.t(isHeader ? "headerTextName" : "footerTextName"))
        .setDesc(this.plugin.t(isHeader ? "headerTextDesc" : "footerTextDesc"))
        .addText((text) => {
          text
            .setPlaceholder(isHeader ? "{title}" : "{page} / {pages}")
            .setValue(this.plugin.settings[field])
            .onChange(async (value) => {
              this.plugin.settings[field] = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.maxLength = 240;
        });
    }
  }

  private renderExtraCodes(containerEl: HTMLElement): void {
    appendElement(containerEl, "div", {
      cls: "mobile-pdf-exporter-settings-codes-title",
      text: this.plugin.t("codesTitle")
    });
    appendElement(containerEl, "div", {
      cls: "mobile-pdf-exporter-settings-codes-subtitle",
      text: this.plugin.t("codesSubtitle")
    });

    const gridEl = appendElement(containerEl, "div", {
      cls: "mobile-pdf-exporter-settings-codes-grid"
    });

    for (const item of SETTINGS_EXTRA_CODE_ASSETS) {
      const label = this.plugin.t(item.labelKey);
      const codeEl = appendElement(gridEl, "div", {
        cls: "mobile-pdf-exporter-settings-code"
      });
      const linkEl = appendElement(codeEl, "a", {
        cls: "mobile-pdf-exporter-settings-code-link"
      });
      linkEl.href = item.src;
      linkEl.target = "_blank";
      linkEl.rel = "noopener";
      linkEl.setAttribute("download", item.fileName);
      linkEl.setAttribute("aria-label", label);
      const imageEl = appendElement(linkEl, "img", {
        cls: "mobile-pdf-exporter-settings-code-image"
      });
      imageEl.src = item.src;
      imageEl.alt = label;
      imageEl.loading = "lazy";
      imageEl.decoding = "async";
      appendElement(codeEl, "div", {
        cls: "mobile-pdf-exporter-settings-code-label",
        text: label
      });
    }
  }
}

function normalizeSettings(raw: unknown): MobilePdfExporterSettings {
  const saved = (raw && typeof raw === "object" ? raw : {}) as Partial<MobilePdfExporterSettings>;
  const hasLegacyOutputFolder = saved.outputLocation === undefined && typeof saved.outputFolder === "string";
  return {
    language: normalizeChoice(saved.language, UI_LANGUAGES, DEFAULT_SETTINGS.language),
    outputLocation: normalizeChoice(
      saved.outputLocation,
      OUTPUT_LOCATIONS,
      hasLegacyOutputFolder ? "folder" : DEFAULT_SETTINGS.outputLocation
    ),
    outputFolder: typeof saved.outputFolder === "string" && saved.outputFolder.trim()
      ? saved.outputFolder.trim()
      : DEFAULT_SETTINGS.outputFolder,
    marginMm: clampNumber(saved.marginMm, 0, 18, DEFAULT_SETTINGS.marginMm),
    includeTitle: typeof saved.includeTitle === "boolean" ? saved.includeTitle : DEFAULT_SETTINGS.includeTitle,
    headerText: normalizeHeaderFooterTemplate(saved.headerText),
    footerText: normalizeHeaderFooterTemplate(saved.footerText),
    rememberLastExportOptions: typeof saved.rememberLastExportOptions === "boolean"
      ? saved.rememberLastExportOptions
      : DEFAULT_SETTINGS.rememberLastExportOptions,
    shareAfterExport: typeof saved.shareAfterExport === "boolean"
      ? saved.shareAfterExport
      : DEFAULT_SETTINGS.shareAfterExport,
    openAfterExport: typeof saved.openAfterExport === "boolean"
      ? saved.openAfterExport
      : DEFAULT_SETTINGS.openAfterExport,
    noteExportMode: normalizeChoice(saved.noteExportMode, NOTE_PDF_EXPORT_MODES, DEFAULT_SETTINGS.noteExportMode),
    pagePreset: normalizeChoice(saved.pagePreset, PDF_PAGE_PRESETS, DEFAULT_SETTINGS.pagePreset),
    pageOrientation: normalizeChoice(saved.pageOrientation, PDF_ORIENTATIONS, DEFAULT_SETTINGS.pageOrientation),
    colorMode: normalizeChoice(saved.colorMode, PDF_COLOR_MODES, DEFAULT_SETTINGS.colorMode),
    contentScalePercent: clampNumber(saved.contentScalePercent, 80, 125, DEFAULT_SETTINGS.contentScalePercent),
    imageRasterScale: clampNumber(saved.imageRasterScale, 1, 3, DEFAULT_SETTINGS.imageRasterScale),
    currentPageWidthPx: clampNumber(saved.currentPageWidthPx, 240, 4096, DEFAULT_SETTINGS.currentPageWidthPx),
    currentPageHeightPx: clampNumber(saved.currentPageHeightPx, 240, 8192, DEFAULT_SETTINGS.currentPageHeightPx),
    // Accept the legacy "zipLinkDepth" key so settings written by other builds carry over.
    zipEmbedDepth: clampNumber(
      saved.zipEmbedDepth ?? (saved as { zipLinkDepth?: number }).zipLinkDepth,
      0,
      10,
      DEFAULT_SETTINGS.zipEmbedDepth
    )
  };
}

function cloneSettings(settings: MobilePdfExporterSettings): MobilePdfExporterSettings {
  return {
    language: settings.language,
    outputLocation: settings.outputLocation,
    outputFolder: settings.outputFolder,
    marginMm: settings.marginMm,
    includeTitle: settings.includeTitle,
    headerText: normalizeHeaderFooterTemplate(settings.headerText),
    footerText: normalizeHeaderFooterTemplate(settings.footerText),
    rememberLastExportOptions: settings.rememberLastExportOptions,
    shareAfterExport: settings.shareAfterExport,
    openAfterExport: settings.openAfterExport,
    noteExportMode: settings.noteExportMode,
    pagePreset: settings.pagePreset,
    pageOrientation: settings.pageOrientation,
    colorMode: settings.colorMode,
    contentScalePercent: settings.contentScalePercent,
    imageRasterScale: settings.imageRasterScale,
    currentPageWidthPx: settings.currentPageWidthPx,
    currentPageHeightPx: settings.currentPageHeightPx,
    zipEmbedDepth: settings.zipEmbedDepth
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function normalizeChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : fallback;
}

function normalizeHeaderFooterTemplate(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim().slice(0, 240) : "";
}

function resolvePdfFontkit(moduleValue: unknown): RegisteredFontkit {
  const moduleShape = moduleValue as FontkitModuleShape;
  const candidate = typeof moduleShape.create === "function" ? moduleShape : moduleShape.default;
  if (!candidate || typeof candidate.create !== "function") {
    throw new Error(translate(runtimeUiLanguage, "fontkitMissingError"));
  }
  return candidate as RegisteredFontkit;
}

function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function decompressEmbeddedFont(base64: string, script: PdfScriptFont): Promise<ArrayBuffer> {
  const cached = embeddedScriptFontBytes.get(script);
  if (cached) return cached;

  const promise = (async () => {
    const DecompressionStreamCtor = (activeWindow as ObsidianExportWindow).DecompressionStream;
    if (!DecompressionStreamCtor) {
      throw new Error("This WebView does not support DecompressionStream.");
    }
    const compressedBytes = decodeBase64ToArrayBuffer(base64);
    const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStreamCtor("gzip"));
    return new Response(stream).arrayBuffer();
  })().catch((error) => {
    embeddedScriptFontBytes.delete(script);
    throw error;
  });
  embeddedScriptFontBytes.set(script, promise);
  return promise;
}

function detectRequiredPdfScriptFonts(text: string): Array<Exclude<PdfScriptFont, "default">> {
  const required: Array<Exclude<PdfScriptFont, "default">> = [];
  if (containsCodePointInRanges(text, [[0x00c0, 0x024f], [0x0370, 0x052f], [0x1e00, 0x1eff]])) required.push("latin");
  if (containsCodePointInRanges(text, [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]])) required.push("arabic");
  if (containsCodePointInRanges(text, [[0x0590, 0x05ff], [0xfb1d, 0xfb4f]])) required.push("hebrew");
  if (containsCodePointInRanges(text, [[0x0900, 0x097f], [0xa8e0, 0xa8ff]])) required.push("devanagari");
  if (containsCodePointInRanges(text, [[0x0e00, 0x0e7f]])) required.push("thai");
  return required;
}

function getPdfScriptFont(text: string): PdfScriptFont {
  if (containsCodePointInRanges(text, [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]])) return "arabic";
  if (containsCodePointInRanges(text, [[0x0590, 0x05ff], [0xfb1d, 0xfb4f]])) return "hebrew";
  if (containsCodePointInRanges(text, [[0x0900, 0x097f], [0xa8e0, 0xa8ff]])) return "devanagari";
  if (containsCodePointInRanges(text, [[0x0e00, 0x0e7f]])) return "thai";
  if (containsCodePointInRanges(text, [[0x00c0, 0x024f], [0x0370, 0x052f], [0x1e00, 0x1eff]])) return "latin";
  return "default";
}

function selectPdfFont(fonts: ExportFontSet, text: string): PDFFont {
  const script = getPdfScriptFont(text);
  return script === "default" ? fonts.default : (fonts.fallbacks[script] ?? fonts.default);
}

function requiresRasterTextFallback(text: string): boolean {
  return isEmojiLikeText(text) || /[:：]/u.test(text) || containsCodePointInRanges(text, [
    [0x0590, 0x0e7f],
    [0x1100, 0x11ff],
    [0x1780, 0x18af],
    [0x2000, 0x2bff],
    [0x2e00, 0x2e7f],
    [0x3000, 0x303f],
    [0x3040, 0x30ff],
    [0xac00, 0xd7af],
    [0xfe00, 0xfe6f],
    [0xff01, 0xff65],
    [0x1f000, 0x1faff]
  ]);
}

function collectVisualRasterTextFragments(fragments: TextFragment[]): TextFragment[] {
  const linkedFragments = fragments.filter((fragment) => Boolean(fragment.href));
  return fragments.filter((fragment) => (
    requiresRasterTextFallback(fragment.text) ||
    linkedFragments.some((linked) => areTextFragmentsOnSameVisualLine(fragment, linked)) ||
    // Rasterize bold and italic text so font weight/style is preserved as-is from the DOM.
    // The PDF text layer uses a single font without bold/italic variants, so without
    // rasterization, bold/italic formatting would be lost in the exported PDF.
    Number.parseInt(fragment.fontWeight, 10) >= 600 ||
    fragment.fontStyle === "italic"
  ));
}

function areTextFragmentsOnSameVisualLine(left: TextFragment, right: TextFragment): boolean {
  if (left.mergeScope !== right.mergeScope) return false;
  const leftCenter = (left.top + left.bottom) / 2;
  const rightCenter = (right.top + right.bottom) / 2;
  const tolerance = Math.max(3, Math.min(left.fontSizePx, right.fontSizePx) * 0.45);
  return Math.abs(leftCenter - rightCenter) <= tolerance;
}

function containsCodePointInRanges(text: string, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && ranges.some(([start, end]) => codePoint >= start && codePoint <= end)) {
      return true;
    }
  }
  return false;
}

function appendElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tagName: K,
  options: { cls?: string; text?: string } = {}
): HTMLElementTagNameMap[K] {
  const element = parent.ownerDocument.createElement(tagName);
  if (options.cls) element.className = options.cls;
  if (options.text !== undefined) element.textContent = options.text;
  parent.appendChild(element);
  return element;
}

function normalizeOutputFolder(folder: string): string {
  return normalizeVaultFolderPath(folder.trim() || DEFAULT_SETTINGS.outputFolder);
}

function normalizeVaultFolderPath(folder: string): string {
  const clean = folder.trim().replace(/^\/+|\/+$/g, "");
  return clean ? normalizePath(clean) : "";
}

function resolveOutputFolder(file: TFile, settings: MobilePdfExporterSettings): string {
  if (settings.outputLocation === "current") {
    return normalizeVaultFolderPath(file.parent?.path ?? "");
  }
  return normalizeOutputFolder(settings.outputFolder);
}

function getVisibleLiveDrawingOverlay(file: TFile): NoteDoodleOverlaySource | null {
  const candidates: NoteDoodleOverlaySource[] = [];

  for (const surface of Array.from(activeDocument.querySelectorAll<HTMLElement>(".note-doodle-shell, .notedraw-shell"))) {
    if (surface.closest(".mobile-pdf-exporter-render-root")) continue;
    const kind = surface.classList.contains("notedraw-shell") ? "notedraw" : "note-doodle";
    const controller = getLiveDrawingController(surface, kind);
    if (controller?.file?.path !== file.path) continue;
    if (!isVisibleLiveDrawingSurface(surface, kind)) continue;

    try {
      controller.render?.();
    } catch (error) {
      console.warn("Mobile PDF Exporter live drawing render refresh failed", error);
    }

    const canvas = getLiveDrawingCanvas(surface, controller, kind);
    if (!canvas || !isVisibleLiveDrawingCanvas(canvas)) continue;

    const data = normalizeNoteDoodleData(
      kind === "notedraw" ? controller.drawingData : controller.doodleData,
      file
    );
    candidates.push({
      data,
      canvas,
      surface,
      kind,
      score: scoreLiveDrawingOverlay(surface, canvas, controller)
    });
  }

  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

function getLiveDrawingController(surface: HTMLElement, kind: "note-doodle" | "notedraw"): LiveDrawingController | null {
  const holder = surface as unknown as {
    _noteDoodleController?: LiveDrawingController;
    _noteDrawController?: LiveDrawingController;
  };
  return kind === "notedraw"
    ? holder._noteDrawController ?? null
    : holder._noteDoodleController ?? null;
}

function getLiveDrawingCanvas(
  surface: HTMLElement,
  controller: LiveDrawingController,
  kind: "note-doodle" | "notedraw"
): HTMLCanvasElement | null {
  if (controller.canvas instanceof HTMLCanvasElement) return controller.canvas;
  return surface.querySelector<HTMLCanvasElement>(kind === "notedraw" ? ".notedraw-canvas" : ".note-doodle-canvas");
}

function isVisibleLiveDrawingSurface(surface: HTMLElement, kind: "note-doodle" | "notedraw"): boolean {
  if (!surface.isConnected) return false;
  if (kind === "notedraw" && surface.classList.contains("is-drawing-hidden")) return false;
  if (kind === "note-doodle" && surface.classList.contains("is-doodle-hidden")) return false;
  return isScreenVisibleElement(surface);
}

function isVisibleLiveDrawingCanvas(canvas: HTMLCanvasElement): boolean {
  if (canvas.width < 1 || canvas.height < 1) return false;
  return isScreenVisibleElement(canvas);
}

function scoreLiveDrawingOverlay(surface: HTMLElement, canvas: HTMLCanvasElement, controller: LiveDrawingController): number {
  const rect = canvas.getBoundingClientRect();
  const surfaceRect = surface.getBoundingClientRect();
  const ownerDocument = surface.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? activeWindow;
  const viewportWidth = Math.max(1, ownerWindow.innerWidth || ownerDocument.documentElement.clientWidth || rect.width || 1);
  const viewportHeight = Math.max(1, ownerWindow.innerHeight || ownerDocument.documentElement.clientHeight || rect.height || 1);
  const visibleLeft = Math.max(0, Math.min(viewportWidth, rect.left));
  const visibleRight = Math.max(0, Math.min(viewportWidth, rect.right));
  const visibleTop = Math.max(0, Math.min(viewportHeight, rect.top));
  const visibleBottom = Math.max(0, Math.min(viewportHeight, rect.bottom));
  const visibleArea = Math.max(0, visibleRight - visibleLeft) * Math.max(0, visibleBottom - visibleTop);
  const canvasArea = Math.max(1, rect.width * rect.height);
  const surfaceArea = Math.max(1, surfaceRect.width * surfaceRect.height);
  const visibleRatio = visibleArea / canvasArea;
  const activeBonus = controller.active ? 10_000 : 0;
  const sourceBonus = controller.surfaceType === "source" ? 400 : 0;
  return activeBonus + sourceBonus + visibleRatio * 1000 + Math.min(surfaceArea, 2_000_000) / 10_000;
}

function isScreenVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;

  let current: HTMLElement | null = element;
  while (current) {
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    current = current.parentElement;
  }

  return true;
}

function normalizeNoteDoodleData(data: unknown, file: TFile): NoteDoodleData | null {
  const candidate = data && typeof data === "object" ? data as {
    version?: unknown;
    strokes?: unknown;
    updatedAt?: unknown;
  } : null;
  const rawStrokes = Array.isArray(candidate?.strokes) ? candidate.strokes : [];
  const strokes = rawStrokes
    .map(normalizeNoteDoodleStroke)
    .filter((stroke): stroke is NoteDoodleStroke => Boolean(stroke && stroke.points.length));

  if (!strokes.length) return null;

  return {
    version: Number.isFinite(Number(candidate?.version)) ? Number(candidate?.version) : 1,
    sourcePath: file.path,
    strokes,
    updatedAt: typeof candidate?.updatedAt === "string" ? candidate.updatedAt : null
  };
}

function projectNoteDrawInkStrokes(
  data: NoteDoodleData | null,
  widthPx: number,
  heightPx: number,
  contentFrame: NoteDrawContentFrame,
  offsetX: number,
  offsetY: number,
  scale: number
): PdfInkStroke[] {
  if (!data?.strokes.length) return [];
  return data.strokes
    .map((stroke) => ({
      brush: stroke.brush,
      color: stroke.color,
      widthPx: Math.max(0.5, stroke.width * scale),
      opacity: stroke.opacity,
      count: stroke.count,
      points: stroke.points.map((point) => ({
        x: offsetX + noteDoodlePointToCanvas(point, widthPx, heightPx, contentFrame).x * scale,
        y: offsetY + point.y * heightPx * scale
      }))
    }))
    .filter((stroke) => stroke.points.length > 0);
}

function normalizeNoteDoodleStroke(stroke: unknown): NoteDoodleStroke | null {
  const candidate = stroke && typeof stroke === "object" ? stroke as {
    kind?: unknown;
    connector?: unknown;
    brush?: unknown;
    color?: unknown;
    width?: unknown;
    opacity?: unknown;
    count?: unknown;
    points?: unknown;
  } : null;
  if (candidate?.kind === "text" || candidate?.kind === "embed" || candidate?.connector) return null;
  const points = Array.isArray(candidate?.points) ? candidate.points : [];
  const normalizedPoints = points
    .map(normalizeNoteDoodlePoint)
    .filter((point): point is NoteDoodlePoint => Boolean(point));

  if (!normalizedPoints.length) return null;

  return {
    brush: candidate?.brush === NOTE_DOODLE_WATERCOLOR ? "watercolor" : "pen",
    color: typeof candidate?.color === "string" ? candidate.color : "#e53935",
    width: clampNumber(Number(candidate?.width), 0.5, 48, 3),
    opacity: clampNumber(Number(candidate?.opacity ?? NOTE_DOODLE_DEFAULT_OPACITY), 0.08, 1, NOTE_DOODLE_DEFAULT_OPACITY),
    count: Math.round(clampNumber(Number(candidate?.count ?? 1), 1, NOTE_DOODLE_MAX_PEN_COUNT, 1)),
    points: normalizedPoints
  };
}

function normalizeNoteDoodlePoint(point: unknown): NoteDoodlePoint | null {
  const candidate = point && typeof point === "object"
    ? point as { x?: unknown; y?: unknown; t?: unknown; anchor?: unknown }
    : null;
  const x = Number(candidate?.x);
  const y = Number(candidate?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const rawAnchor = candidate?.anchor && typeof candidate.anchor === "object"
    ? candidate.anchor as { basis?: unknown; x?: unknown; y?: unknown }
    : null;
  const anchorX = Number(rawAnchor?.x);
  const anchorY = Number(rawAnchor?.y);
  const anchor = rawAnchor?.basis === "note-content-v1" && Number.isFinite(anchorX) && Number.isFinite(anchorY)
    ? {
      basis: "note-content-v1" as const,
      x: clampNumber(anchorX, -1, 2, 0),
      y: clampNumber(anchorY, 0, 1, y)
    }
    : null;
  return {
    x: clampNumber(x, 0, 1, 0),
    y: clampNumber(y, 0, 1, 0),
    t: Number.isFinite(Number(candidate?.t)) ? Number(candidate?.t) : Date.now(),
    anchor
  };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim() || "export";
}

function sanitizePdfBaseName(name: unknown): string {
  if (typeof name !== "string") return "";
  return sanitizeFileName(name.replace(/\.pdf$/i, "")).slice(0, 120);
}

function defaultPdfBaseName(file: TFile): string {
  return sanitizePdfBaseName(file.basename) || "export";
}

function mmToPx(mm: number): number {
  return Math.round((mm / 25.4) * 96);
}

function mmToPt(mm: number): number {
  return (mm / 25.4) * 72;
}

function getPageBodyLayoutPx(
  settings: Pick<MobilePdfExporterSettings, "marginMm" | "headerText" | "footerText">,
  pageHeightPx: number
): { bodyTopInsetPx: number; bodyBottomInsetPx: number; bodyHeightPx: number } {
  const { topMm, bottomMm } = getPageBodyInsetsMm(settings);
  const bodyTopInsetPx = mmToPx(topMm);
  const bodyBottomInsetPx = mmToPx(bottomMm);
  return {
    bodyTopInsetPx,
    bodyBottomInsetPx,
    bodyHeightPx: Math.max(24, pageHeightPx - bodyTopInsetPx - bodyBottomInsetPx)
  };
}

function getPageBodyInsetsMm(
  settings: Pick<MobilePdfExporterSettings, "marginMm" | "headerText" | "footerText">
): { topMm: number; bottomMm: number } {
  return {
    topMm: Math.max(settings.marginMm, settings.headerText ? HEADER_FOOTER_MIN_BAND_MM : settings.marginMm),
    bottomMm: Math.max(settings.marginMm, settings.footerText ? HEADER_FOOTER_MIN_BAND_MM : settings.marginMm)
  };
}

function formatExportDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function getConfiguredPageSizeMm(settings: MobilePdfExporterSettings): PdfPageSizeMm {
  const preset = settings.pagePreset === "current"
    ? {
      width: Math.max(50, settings.currentPageWidthPx / 96 * 25.4),
      height: Math.max(50, settings.currentPageHeightPx / 96 * 25.4)
    }
    : PDF_PAGE_SIZES_MM[settings.pagePreset] ?? PDF_PAGE_SIZES_MM.mobile;
  if (settings.pageOrientation === "landscape") {
    return {
      width: Math.max(preset.width, preset.height),
      height: Math.min(preset.width, preset.height)
    };
  }
  return {
    width: Math.min(preset.width, preset.height),
    height: Math.max(preset.width, preset.height)
  };
}

function findScrollableExportSurface(rootEl: HTMLElement): HTMLElement {
  const candidates = [rootEl, ...Array.from(rootEl.querySelectorAll<HTMLElement>("*"))];
  return candidates
    .filter((element) => element.scrollHeight > element.clientHeight + 2 || element.scrollWidth > element.clientWidth + 2)
    .sort((left, right) => (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight))[0] ?? rootEl;
}

function bytesToDataUrl(bytes: Uint8Array, mime = "image/png"): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function loadPngBytesAsImage(bytes: Uint8Array): Promise<HTMLImageElement> {
  const image = activeDocument.createElement("img");
  image.decoding = "async";
  image.src = bytesToDataUrl(bytes);
  await image.decode();
  return image;
}

async function combinePngPages(pages: Uint8Array[]): Promise<Blob> {
  if (pages.length === 1) return new Blob([new Uint8Array(pages[0]).buffer], { type: "image/png" });
  const images = await Promise.all(pages.map(loadPngBytesAsImage));
  const width = Math.max(...images.map((image) => image.naturalWidth));
  const height = images.reduce((sum, image) => sum + image.naturalHeight, 0);
  const scale = Math.min(1, Math.sqrt(PREVIEW_IMAGE_MAX_CANVAS_PIXELS / Math.max(1, width * height)));
  const canvas = activeDocument.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create PNG export canvas.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  let top = 0;
  for (const image of images) {
    const drawHeight = image.naturalHeight * scale;
    context.drawImage(image, 0, top, image.naturalWidth * scale, drawHeight);
    top += drawHeight;
  }
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("PNG export failed.")),
    "image/png"
  ));
}

function getPageTextFragments(model: PreviewPdfModel, pageIndex: number): TextFragment[] {
  const top = model.pageBreaks[pageIndex];
  const bottom = model.pageBreaks[pageIndex + 1];
  const text = model.textFragments.filter((fragment) => (
    fragment.bottom > top && fragment.top < bottom && fragment.text.trim()
  ));
  const decorations = model.decorationFragments
    .filter((fragment) => fragment.bottom > top && fragment.top < bottom)
    .map((fragment) => decorationToOfficeTextFragment(model, fragment))
    .filter((fragment): fragment is TextFragment => Boolean(fragment));
  return [...text, ...decorations];
}

function decorationToOfficeTextFragment(
  model: PreviewPdfModel,
  decoration: DecorationFragment
): TextFragment | null {
  const text = decoration.kind === "checkbox"
    ? (decoration.checked ? "☑" : "☐")
    : decoration.kind === "bullet"
      ? "•"
      : decoration.text?.trim() ?? "";
  if (!text) return null;

  return {
    text,
    left: decoration.left,
    top: decoration.top,
    right: decoration.right,
    bottom: decoration.bottom,
    fontSizePx: decoration.fontSizePx,
    fontFamily: decoration.kind === "checkbox"
      ? '"Segoe UI Symbol", "Noto Sans Symbols 2", "Noto Sans SC"'
      : '"Noto Sans SC"',
    fontWeight: "400",
    fontStyle: "normal",
    direction: "ltr",
    color: decoration.color,
    underline: false,
    lineThrough: false,
    href: null,
    officeDecoration: true,
    mergeScope: model.ownerDocument.body
  };
}

interface OfficeTextLine {
  fragments: TextFragment[];
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface OfficeTextBoxLayout {
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}

function getPageOfficeTextLines(model: PreviewPdfModel, pageIndex: number): OfficeTextLine[] {
  const fragments = getPageTextFragments(model, pageIndex)
    .sort((left, right) => left.top - right.top || left.left - right.left);
  const lines: OfficeTextLine[] = [];

  for (const fragment of fragments) {
    const matchingLine = [...lines].reverse().find((line) => {
      const fragmentHeight = Math.max(1, fragment.bottom - fragment.top);
      const lineHeight = Math.max(1, line.bottom - line.top);
      const overlap = Math.max(0, Math.min(fragment.bottom, line.bottom) - Math.max(fragment.top, line.top));
      const minimumHeight = Math.min(fragmentHeight, lineHeight);
      const fragmentCenter = (fragment.top + fragment.bottom) / 2;
      const lineCenter = (line.top + line.bottom) / 2;
      const centerTolerance = Math.max(2, Math.min(fragment.fontSizePx, lineHeight) * 0.55);
      return overlap >= minimumHeight * 0.32 || Math.abs(fragmentCenter - lineCenter) <= centerTolerance;
    });

    if (matchingLine) {
      matchingLine.fragments.push(fragment);
      matchingLine.left = Math.min(matchingLine.left, fragment.left);
      matchingLine.top = Math.min(matchingLine.top, fragment.top);
      matchingLine.right = Math.max(matchingLine.right, fragment.right);
      matchingLine.bottom = Math.max(matchingLine.bottom, fragment.bottom);
      continue;
    }

    lines.push({
      fragments: [fragment],
      left: fragment.left,
      top: fragment.top,
      right: fragment.right,
      bottom: fragment.bottom
    });
  }

  return lines
    .map((line) => ({
      ...line,
      fragments: line.fragments.sort((left, right) => left.left - right.left)
    }))
    .sort((left, right) => left.top - right.top || left.left - right.left);
}

function getOfficeTextFragmentLayout(
  model: PreviewPdfModel,
  pageIndex: number,
  fragment: TextFragment
): OfficeTextBoxLayout {
  const pageTop = model.pageBreaks[pageIndex];
  const fontSizePt = fragment.fontSizePx * model.pxToPt;
  return {
    xPt: Math.max(0, fragment.left * model.pxToPt),
    yPt: Math.max(0, (fragment.top - pageTop + model.bodyTopInsetPx) * model.pxToPt),
    widthPt: Math.max(4, (fragment.right - fragment.left) * model.pxToPt + 2),
    heightPt: Math.max(5, (fragment.bottom - fragment.top) * model.pxToPt * 1.35, fontSizePt * 1.4)
  };
}

function getPptTextBoxLayout(
  model: PreviewPdfModel,
  pageIndex: number,
  fragment: TextFragment
): OfficeTextBoxLayout {
  const layout = getOfficeTextFragmentLayout(model, pageIndex, fragment);
  const fontSizePt = fragment.fontSizePx * model.pxToPt;
  return {
    ...layout,
    yPt: Math.max(0, layout.yPt - fontSizePt * 0.12)
  };
}

function getOfficeFontFamily(fragment: TextFragment): string {
  const candidates = fragment.fontFamily
    .split(",")
    .map((candidate) => candidate.trim().replace(/^["']|["']$/gu, ""))
    .filter(Boolean);
  const firstCandidate = candidates[0] ?? "";
  if (/^(?:\?+|-apple-system|blinkmacsystemfont|ui-(?:sans-serif|serif|monospace|rounded)|system-ui|sans-serif)$/iu.test(firstCandidate)) {
    return "Noto Sans SC";
  }
  const usable = candidates.find((candidate) => (
    !/^(?:\?+|-apple-system|blinkmacsystemfont|inherit|initial|unset|serif|sans-serif|monospace|system-ui|ui-(?:sans-serif|serif|monospace|rounded))$/iu.test(candidate) &&
    !candidate.startsWith("var(")
  ));
  return usable || "Noto Sans SC";
}

function colorToHex(color: Color): string {
  const candidate = color as unknown as { red?: number; green?: number; blue?: number };
  return [candidate.red, candidate.green, candidate.blue]
    .map((value) => Math.round(clampNumber(value, 0, 1, 0) * 255).toString(16).padStart(2, "0"))
    .join("");
}

interface OfficeMediaFragment {
  data: Uint8Array;
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
  assetPath?: string;
}

interface OfficeRenderOptions {
  colorMode: PdfColorMode;
  rasterScale: number;
  app?: App;
  sourcePath?: string;
}

type EmbeddedExportAssetUse = "video" | "file";

interface EmbeddedExportAsset {
  path: string;
  name: string;
  extension: string;
  mimeType: string;
  bytes: Uint8Array;
  sourceLinks: string[];
  uses: EmbeddedExportAssetUse[];
}

async function collectEmbeddedExportAssets(
  app: App | undefined,
  sourcePath: string | undefined,
  model: PreviewPdfModel
): Promise<EmbeddedExportAsset[]> {
  if (!app || !sourcePath) return [];
  const candidates: Array<{ linkPath: string; mimeType?: string; use: EmbeddedExportAssetUse }> = [];
  for (const fragment of model.videoFragments) {
    if (fragment.sourcePath) candidates.push({ linkPath: fragment.sourcePath, use: "video" });
  }
  for (const element of model.noteDrawSourceElements ?? model.noteDrawElements ?? []) {
    if (!element.assetPath || (element.kind !== "video" && element.kind !== "file")) continue;
    candidates.push({
      linkPath: element.assetPath,
      mimeType: element.assetMime || undefined,
      use: element.kind
    });
  }

  const assets = new Map<string, EmbeddedExportAsset>();
  for (const candidate of candidates) {
    const loaded = await readVaultEmbeddedAsset(app, sourcePath, candidate.linkPath, candidate.mimeType);
    if (!loaded) continue;
    const existing = assets.get(loaded.path);
    if (existing) {
      if (!existing.sourceLinks.includes(candidate.linkPath)) existing.sourceLinks.push(candidate.linkPath);
      if (!existing.uses.includes(candidate.use)) existing.uses.push(candidate.use);
      continue;
    }
    assets.set(loaded.path, {
      ...loaded,
      sourceLinks: [candidate.linkPath],
      uses: [candidate.use]
    });
  }
  return Array.from(assets.values());
}

async function readVaultEmbeddedAsset(
  app: App,
  sourcePath: string,
  linkPath: string,
  preferredMimeType?: string
): Promise<Omit<EmbeddedExportAsset, "sourceLinks" | "uses"> | null> {
  const file = resolveVaultAssetFile(app, sourcePath, linkPath);
  if (!file) return null;
  try {
    const bytes = new Uint8Array(await app.vault.readBinary(file));
    return {
      path: file.path,
      name: file.name,
      extension: file.extension.toLowerCase(),
      mimeType: preferredMimeType || getEmbeddedAssetMimeType(file.extension),
      bytes
    };
  } catch (error) {
    console.warn(`Mobile PDF Exporter could not embed asset ${file.path}`, error);
    return null;
  }
}

function resolveVaultAssetFile(app: App, sourcePath: string, rawLinkPath: string): TFile | null {
  let clean = rawLinkPath.trim();
  if (!clean || /^(?:data|blob|https?):/iu.test(clean)) return null;
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // Keep non-URI-encoded Vault paths unchanged.
  }
  clean = clean
    .replace(/^app:\/\/obsidian\.md\//iu, "")
    .replace(/[?#].*$/u, "")
    .replace(/^\/+|^\.\//u, "")
    .replace(/\\/gu, "/")
    .trim();
  if (!clean) return null;

  const direct = app.vault.getAbstractFileByPath(normalizePath(clean));
  if (direct instanceof TFile) return direct;
  const sourceDir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  const relativePath = collapseVaultPathSegments(normalizePath(sourceDir ? `${sourceDir}/${clean}` : clean));
  const relative = app.vault.getAbstractFileByPath(relativePath);
  if (relative instanceof TFile) return relative;
  const resolved = app.metadataCache.getFirstLinkpathDest(clean, sourcePath);
  return resolved instanceof TFile ? resolved : null;
}

function getEmbeddedAssetMimeType(extension: string): string {
  const normalized = extension.toLowerCase().replace(/^\./u, "");
  return ({
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    ogv: "video/ogg",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml"
  } as Record<string, string>)[normalized] ?? "application/octet-stream";
}

function findEmbeddedExportAsset(
  assets: EmbeddedExportAsset[],
  linkPath: string | null
): EmbeddedExportAsset | null {
  if (!linkPath) return null;
  return assets.find((asset) => asset.sourceLinks.includes(linkPath)) ?? null;
}

async function attachEmbeddedAssetsToPdf(
  pdfDoc: PDFDocument,
  app: App,
  sourcePath: string,
  model: PreviewPdfModel
): Promise<void> {
  const assets = await collectEmbeddedExportAssets(app, sourcePath, model);
  const usedNames = new Set<string>();
  for (const asset of assets) {
    const name = getUniqueEmbeddedAssetName(asset.name, usedNames);
    await pdfDoc.attach(asset.bytes, name, {
      mimeType: asset.mimeType,
      description: `Embedded source asset: ${asset.path}`
    });
  }
}

function getUniqueEmbeddedAssetName(rawName: string, usedNames: Set<string>): string {
  const printableName = Array.from(rawName, (character) => character.charCodeAt(0) < 32 ? "_" : character).join("");
  const cleanName = printableName.replace(/[\\/:*?"<>|]/gu, "_").trim() || "attachment.bin";
  const dotIndex = cleanName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? cleanName.slice(0, dotIndex) : cleanName;
  const extension = dotIndex > 0 ? cleanName.slice(dotIndex) : "";
  let candidate = cleanName;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${baseName}-${suffix}${extension}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

async function getOfficeMediaFragments(
  model: PreviewPdfModel,
  pageIndex: number,
  renderOptions: OfficeRenderOptions
): Promise<OfficeMediaFragment[]> {
  const pageTopPx = model.pageBreaks[pageIndex];
  const pageBottomPx = model.pageBreaks[pageIndex + 1];
  const options = {
    pageTopPx,
    pageBottomPx,
    sourceWidthPx: model.sourceWidthPx,
    pageHeightPx: model.bodyHeightPx
  };
  const media: OfficeMediaFragment[] = [];
  const append = (data: Uint8Array | null, slice: MediaPageSlice): void => {
    if (!data || data.length === 0) return;
    media.push({
      data,
      leftPx: slice.x,
      topPx: model.bodyTopInsetPx + slice.y,
      widthPx: slice.width,
      heightPx: slice.height
    });
  };

  for (const fragment of model.imageFragments) {
    const slice = getMediaPageSlice(fragment, options);
    if (!slice) continue;
    try {
      append(await imageFragmentSliceToPngBytes(
        fragment.element,
        slice.offsetTopPx,
        slice.height,
        slice.fragmentHeightPx,
        renderOptions.colorMode,
        renderOptions.app && renderOptions.sourcePath
          ? { app: renderOptions.app, sourcePath: renderOptions.sourcePath, linkPath: fragment.sourcePath }
          : undefined
      ), slice);
    } catch (error) {
      console.warn("Mobile PDF Exporter Office image export failed", error);
    }
  }

  for (const fragment of model.canvasFragments) {
    const slice = getMediaPageSlice(fragment, options);
    if (!slice) continue;
    try {
      append(canvasFragmentSliceToPngBytes(fragment, slice), slice);
    } catch (error) {
      console.warn("Mobile PDF Exporter Office canvas export failed", error);
    }
  }

  for (const fragment of model.svgFragments) {
    const slice = getMediaPageSlice(fragment, options);
    if (!slice) continue;
    try {
      const fullBytes = await svgElementToPngBytes(fragment.element, 1.5, SVG_IMAGE_LOAD_TIMEOUT_MS, "color");
      if (!fullBytes) continue;
      const image = await imageBytesToHtmlImage(fullBytes);
      const sourceHeight = Math.max(1, image.naturalHeight || image.height);
      const sourceY = (slice.offsetTopPx / slice.fragmentHeightPx) * sourceHeight;
      const sourceSliceHeight = (slice.height / slice.fragmentHeightPx) * sourceHeight;
      append(await imageSliceToPngBytes(image, sourceY, sourceSliceHeight), slice);
    } catch (error) {
      console.warn("Mobile PDF Exporter Office SVG export failed", error);
    }
  }

  return media;
}

async function getDocxVideoCoverFragments(
  model: PreviewPdfModel,
  pageIndex: number
): Promise<OfficeMediaFragment[]> {
  const pageTopPx = model.pageBreaks[pageIndex];
  const pageBottomPx = model.pageBreaks[pageIndex + 1];
  const options = {
    pageTopPx,
    pageBottomPx,
    sourceWidthPx: model.sourceWidthPx,
    pageHeightPx: model.bodyHeightPx
  };
  const media: OfficeMediaFragment[] = [];

  for (const fragment of model.videoFragments) {
    const slice = getMediaPageSlice(fragment, options);
    if (!slice || !fragment.sourcePath) continue;
    try {
      const cover = await getVideoCoverDataUrl(fragment.element);
      if (!cover) continue;
      const fullBytes = dataUrlToUint8Array(cover);
      const image = await imageBytesToHtmlImage(fullBytes);
      const sourceHeight = Math.max(1, image.naturalHeight || image.height);
      const sourceY = (slice.offsetTopPx / slice.fragmentHeightPx) * sourceHeight;
      const sourceSliceHeight = (slice.height / slice.fragmentHeightPx) * sourceHeight;
      media.push({
        data: await imageSliceToPngBytes(image, sourceY, sourceSliceHeight),
        leftPx: slice.x,
        topPx: model.bodyTopInsetPx + slice.y,
        widthPx: slice.width,
        heightPx: slice.height,
        assetPath: fragment.sourcePath
      });
    } catch (error) {
      console.warn("Mobile PDF Exporter DOCX video cover export failed", error);
    }
  }

  return media;
}

async function getOfficeNoteDrawFragments(
  model: PreviewPdfModel,
  pageIndex: number,
  renderOptions: OfficeRenderOptions
): Promise<OfficeMediaFragment[]> {
  const pageTopPx = model.pageBreaks[pageIndex];
  const pageBottomPx = model.pageBreaks[pageIndex + 1];
  const media: OfficeMediaFragment[] = [];
  const appendRegion = (
    left: number,
    top: number,
    right: number,
    bottom: number,
    draw: (context: CanvasRenderingContext2D) => void,
    assetPath?: string
  ): void => {
    const clippedLeft = clampNumber(left, 0, model.sourceWidthPx, 0);
    const clippedRight = clampNumber(right, 0, model.sourceWidthPx, model.sourceWidthPx);
    const clippedTop = clampNumber(top, pageTopPx, pageBottomPx, pageTopPx);
    const clippedBottom = clampNumber(bottom, pageTopPx, pageBottomPx, pageBottomPx);
    if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return;
    const widthPx = clippedRight - clippedLeft;
    const heightPx = clippedBottom - clippedTop;
    const requestedScale = clampNumber(renderOptions.rasterScale, 1, 3, 1.5);
    const safeScale = Math.min(
      requestedScale,
      Math.sqrt(PREVIEW_IMAGE_MAX_CANVAS_PIXELS / Math.max(1, widthPx * heightPx))
    );
    const scale = Math.max(0.75, safeScale);
    const canvas = createCanvas(model.ownerDocument);
    canvas.width = Math.max(1, Math.ceil(widthPx * scale));
    canvas.height = Math.max(1, Math.ceil(heightPx * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.translate(-clippedLeft, -(clippedTop - pageTopPx));
    draw(context);
    if (renderOptions.colorMode === "grayscale") {
      context.setTransform(1, 0, 0, 1, 0, 0);
      applyCanvasGrayscale(context, canvas.width, canvas.height);
    }
    media.push({
      data: dataUrlToUint8Array(canvas.toDataURL("image/png")),
      leftPx: clippedLeft,
      topPx: model.bodyTopInsetPx + clippedTop - pageTopPx,
      widthPx,
      heightPx,
      assetPath
    });
  };

  for (const element of model.noteDrawSourceElements ?? model.noteDrawElements ?? []) {
    if (element.bottom <= pageTopPx || element.top >= pageBottomPx) continue;
    const padding = Math.max(3, element.width * 2);
    appendRegion(
      element.left - padding,
      element.top - padding,
      element.right + padding,
      element.bottom + padding,
      (context) => drawCanvasNoteDrawElementLayer(context, [element], {
        pageTopPx,
        pageBottomPx,
        sourceWidthPx: model.sourceWidthPx
      }),
      element.kind === "video" ? element.assetPath : undefined
    );
  }

  for (const stroke of model.noteDrawInkStrokes ?? []) {
    if (stroke.points.length === 0) continue;
    const left = Math.min(...stroke.points.map((point) => point.x));
    const top = Math.min(...stroke.points.map((point) => point.y));
    const right = Math.max(...stroke.points.map((point) => point.x));
    const bottom = Math.max(...stroke.points.map((point) => point.y));
    if (bottom <= pageTopPx || top >= pageBottomPx) continue;
    const padding = Math.max(4, stroke.widthPx * Math.max(2, stroke.count + 1));
    appendRegion(left - padding, top - padding, right + padding, bottom + padding, (context) => {
      drawCanvasNoteDrawInkLayer(context, [stroke], { pageTopPx, pageBottomPx });
    });
  }

  return media;
}

function canvasFragmentSliceToPngBytes(fragment: CanvasFragment, slice: MediaPageSlice): Uint8Array | null {
  const cssWidth = Math.max(1, fragment.right - fragment.left);
  const cssHeight = Math.max(1, fragment.bottom - fragment.top);
  const sourceWidth = Math.max(1, fragment.sourceRightPx - fragment.sourceLeftPx);
  const sourceHeight = Math.max(1, fragment.sourceBottomPx - fragment.sourceTopPx);
  const ratioX = sourceWidth / cssWidth;
  const ratioY = sourceHeight / cssHeight;
  const sourceX = fragment.sourceLeftPx;
  const sourceY = Math.max(fragment.sourceTopPx, Math.floor(fragment.sourceTopPx + slice.offsetTopPx * ratioY));
  const cropWidth = Math.max(1, Math.min(sourceWidth, Math.ceil(slice.width * ratioX)));
  const cropHeight = Math.max(1, Math.min(fragment.sourceBottomPx - sourceY, Math.ceil(slice.height * ratioY)));
  const canvas = createCanvas(fragment.element);
  canvas.width = Math.max(1, Math.ceil(slice.width));
  canvas.height = Math.max(1, Math.ceil(slice.height));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(fragment.element, sourceX, sourceY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
  return dataUrlToUint8Array(canvas.toDataURL("image/png"));
}

interface PptxVideoPlacement {
  asset: EmbeddedExportAsset;
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
  cover?: string;
}

async function getPptxVideoPlacements(
  model: PreviewPdfModel,
  pageIndex: number,
  assets: EmbeddedExportAsset[]
): Promise<PptxVideoPlacement[]> {
  const pageTopPx = model.pageBreaks[pageIndex];
  const pageBottomPx = model.pageBreaks[pageIndex + 1];
  const sliceOptions = {
    pageTopPx,
    pageBottomPx,
    sourceWidthPx: model.sourceWidthPx,
    pageHeightPx: model.bodyHeightPx
  };
  const placements: PptxVideoPlacement[] = [];

  for (const fragment of model.videoFragments) {
    const asset = findEmbeddedExportAsset(assets, fragment.sourcePath);
    const slice = getMediaPageSlice(fragment, sliceOptions);
    if (!asset || !slice) continue;
    placements.push({
      asset,
      leftPx: slice.x,
      topPx: model.bodyTopInsetPx + slice.y,
      widthPx: slice.width,
      heightPx: slice.height,
      cover: await getVideoCoverDataUrl(fragment.element)
    });
  }

  for (const element of model.noteDrawSourceElements ?? model.noteDrawElements ?? []) {
    if (element.kind !== "video") continue;
    const asset = findEmbeddedExportAsset(assets, element.assetPath);
    const slice = getMediaPageSlice(element, sliceOptions);
    if (!asset || !slice) continue;
    placements.push({
      asset,
      leftPx: slice.x,
      topPx: model.bodyTopInsetPx + slice.y,
      widthPx: slice.width,
      heightPx: slice.height,
      cover: noteDrawMediaToPngDataUrl(element.media)
    });
  }

  return placements;
}

async function getVideoCoverDataUrl(video: HTMLVideoElement): Promise<string | undefined> {
  try {
    const source = await getVideoExportFrame(video);
    if (!source) return undefined;
    const sourceWidth = source.instanceOf(HTMLVideoElement) ? source.videoWidth : source.naturalWidth;
    const sourceHeight = source.instanceOf(HTMLVideoElement) ? source.videoHeight : source.naturalHeight;
    if (sourceWidth <= 0 || sourceHeight <= 0) return undefined;
    const scale = Math.min(1, 1280 / sourceWidth, 720 / sourceHeight);
    const canvas = createCanvas(video);
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch (error) {
    console.warn("Mobile PDF Exporter could not create a PowerPoint video cover", error);
    return undefined;
  }
}

function noteDrawMediaToPngDataUrl(media: HTMLImageElement | HTMLCanvasElement | null): string | undefined {
  if (!media) return undefined;
  try {
    if (media.instanceOf(HTMLCanvasElement)) return media.toDataURL("image/png");
    const width = Math.max(1, media.naturalWidth || media.width);
    const height = Math.max(1, media.naturalHeight || media.height);
    const canvas = createCanvas(media);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(media, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } catch (error) {
    console.warn("Mobile PDF Exporter could not create a NoteDraw media cover", error);
    return undefined;
  }
}

async function buildEditablePptx(
  file: TFile,
  model: PreviewPdfModel,
  options: OfficeRenderOptions
): Promise<Blob> {
  const module = await import("pptxgenjs");
  const PptxGenJS = module.default;
  const pptx = new PptxGenJS();
  const widthIn = model.pageWidthPt / 72;
  const heightIn = model.pageHeightPt / 72;
  pptx.defineLayout({ name: "OBSIDIAN_EXPORT", width: widthIn, height: heightIn });
  pptx.layout = "OBSIDIAN_EXPORT";
  pptx.author = "Obsidian Mobile PDF Exporter";
  pptx.subject = file.basename;
  pptx.title = file.basename;
  const embeddedAssets = await collectEmbeddedExportAssets(options.app, options.sourcePath, model);
  const pageCount = Math.max(0, model.pageBreaks.length - 1);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const slide = pptx.addSlide();
    slide.background = { color: colorToHex(model.background) };
    const visualBackground = await renderOfficePageVisualBackground(model, pageIndex, options);
    slide.addImage({
      data: bytesToDataUrl(visualBackground),
      x: 0,
      y: 0,
      w: widthIn,
      h: heightIn
    });
    for (const media of await getOfficeMediaFragments(model, pageIndex, options)) {
      slide.addImage({
        data: bytesToDataUrl(media.data),
        x: media.leftPx * model.pxToPt / 72,
        y: media.topPx * model.pxToPt / 72,
        w: media.widthPx * model.pxToPt / 72,
        h: media.heightPx * model.pxToPt / 72
      });
    }
    for (const placement of await getPptxVideoPlacements(model, pageIndex, embeddedAssets)) {
      slide.addMedia({
        type: "video",
        data: bytesToDataUrl(placement.asset.bytes, placement.asset.mimeType),
        extn: placement.asset.extension || "mp4",
        cover: placement.cover,
        objectName: placement.asset.name,
        x: placement.leftPx * model.pxToPt / 72,
        y: placement.topPx * model.pxToPt / 72,
        w: placement.widthPx * model.pxToPt / 72,
        h: placement.heightPx * model.pxToPt / 72
      });
    }
    for (const line of getPageOfficeTextLines(model, pageIndex)) {
      for (const group of groupPptTextLine(line)) {
        const layout = getPptTextGroupLayout(model, pageIndex, group);
        const richText = buildPptRichTextRuns(model, group.fragments);
        slide.addText(richText, {
          x: layout.xPt / 72,
          y: layout.yPt / 72,
          w: layout.widthPt / 72,
          h: layout.heightPt / 72,
          margin: 0,
          valign: "top",
          paraSpaceAfter: 0,
          isTextBox: true,
          fit: "shrink",
          wrap: false,
          breakLine: false,
          autoFit: false
        });
      }
    }
  }
  const result = await pptx.write({ outputType: "blob" });
  let blob: Blob;
  if (result instanceof Blob) {
    blob = result;
  } else {
    const content = result instanceof Uint8Array
      ? Uint8Array.from(result).buffer
      : result;
    blob = new Blob([content], {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    });
  }
  return injectOfficePreviewPages(
    blob,
    model,
    await renderOfficePreviewPages(model, options),
    embeddedAssets.filter((asset) => asset.uses.includes("file"))
  );
}

interface WordPageDrawingOverlay {
  data: Uint8Array;
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
}

interface WordEmbeddedVideo {
  marker: string;
  asset: EmbeddedExportAsset;
}

async function buildEditableDocx(
  file: TFile,
  model: PreviewPdfModel,
  options: OfficeRenderOptions
): Promise<Blob> {
  const {
    Document,
    HorizontalPositionRelativeFrom,
    ImageRun,
    Packer,
    Paragraph,
    TextRun,
    TextWrappingType,
    VerticalPositionRelativeFrom
  } = await import("docx");
  const pageCount = Math.max(0, model.pageBreaks.length - 1);
  const embeddedAssets = await collectEmbeddedExportAssets(options.app, options.sourcePath, model);
  const sectionResults = await Promise.all(Array.from({ length: pageCount }, async (_, pageIndex) => {
    const pageMedia = [
      ...await getOfficeMediaFragments(model, pageIndex, options),
      ...await getDocxVideoCoverFragments(model, pageIndex),
      ...await getOfficeNoteDrawFragments(model, pageIndex, options)
    ];
    const videos: WordEmbeddedVideo[] = [];
    const imageRuns = pageMedia.map((media, mediaIndex) => {
      const videoAsset = media.assetPath
        ? findEmbeddedExportAsset(embeddedAssets, media.assetPath)
        : null;
      const marker = videoAsset?.uses.includes("video")
        ? `MPE_VIDEO_${pageIndex}_${mediaIndex}`
        : null;
      if (marker && videoAsset) videos.push({ marker, asset: videoAsset });
      return new ImageRun({
        type: "png",
        data: media.data,
        transformation: {
          width: Math.max(1, Math.round(toWordPixel(model, media.widthPx))),
          height: Math.max(1, Math.round(toWordPixel(model, media.heightPx)))
        },
        ...(marker && videoAsset ? {
          altText: {
            name: marker,
            title: videoAsset.name,
            description: `Embedded video: ${videoAsset.name}`
          }
        } : {}),
        floating: {
          horizontalPosition: {
            relative: HorizontalPositionRelativeFrom.PAGE,
            offset: Math.round(toWordPixel(model, media.leftPx) * 9525)
          },
          verticalPosition: {
            relative: VerticalPositionRelativeFrom.PAGE,
            offset: Math.round(toWordPixel(model, media.topPx) * 9525)
          },
          wrap: { type: TextWrappingType.NONE },
          behindDocument: false,
          allowOverlap: true,
          lockAnchor: true,
          zIndex: 2
        }
      });
    });
    return {
      section: {
        properties: {
          page: {
            size: { width: Math.round(model.pageWidthPt * 20), height: Math.round(model.pageHeightPt * 20) },
            margin: { top: 360, right: 360, bottom: 360, left: 360 }
          }
        },
        children: [
          new Paragraph({ children: [...imageRuns, new TextRun(`__MPE_PAGE_${pageIndex}__`)] })
        ]
      },
      videos
    };
  }));
  const document = new Document({
    creator: "Obsidian Mobile PDF Exporter",
    title: file.basename,
    description: "High-fidelity export with an editable text layer.",
    sections: sectionResults.map((result) => result.section)
  });
  const packed = await Packer.toBlob(document);
  const editable = await injectEditableWordTextBoxes(
    packed,
    model,
    sectionResults.flatMap((result) => result.videos)
  );
  return injectOfficePreviewPages(
    editable,
    model,
    await renderOfficePreviewPages(model, options),
    embeddedAssets
  );
}

function toWordPixel(model: PreviewPdfModel, valuePx: number): number {
  return valuePx * model.pxToPt / 72 * 96;
}

interface PptTextGroup {
  fragments: TextFragment[];
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function groupPptTextLine(line: OfficeTextLine): PptTextGroup[] {
  const groups: PptTextGroup[] = [];
  for (const fragment of line.fragments) {
    const previous = groups[groups.length - 1];
    const joinsPrevious = Boolean(
      previous &&
      !fragment.officeDecoration &&
      !previous.fragments.some((item) => item.officeDecoration) &&
      previous.fragments[0]?.mergeScope === fragment.mergeScope
    );
    if (joinsPrevious) {
      previous.fragments.push(fragment);
      previous.left = Math.min(previous.left, fragment.left);
      previous.top = Math.min(previous.top, fragment.top);
      previous.right = Math.max(previous.right, fragment.right);
      previous.bottom = Math.max(previous.bottom, fragment.bottom);
    } else {
      groups.push({
        fragments: [fragment],
        left: fragment.left,
        top: fragment.top,
        right: fragment.right,
        bottom: fragment.bottom
      });
    }
  }
  return groups;
}

function getPptTextGroupLayout(
  model: PreviewPdfModel,
  pageIndex: number,
  group: PptTextGroup
): OfficeTextBoxLayout {
  const first = group.fragments[0];
  const pageTop = model.pageBreaks[pageIndex];
  const maxFontSizePt = Math.max(...group.fragments.map((fragment) => fragment.fontSizePx * model.pxToPt));
  const xPt = Math.max(0, group.left * model.pxToPt);
  const yPt = Math.max(0, (group.top - pageTop + model.bodyTopInsetPx) * model.pxToPt - maxFontSizePt * 0.12);
  const availableWidthPt = Math.max(4, model.pageWidthPt - xPt);
  const naturalWidthPt = Math.max(4, (group.right - group.left) * model.pxToPt);
  const widthSlackPt = first?.officeDecoration ? 2 : Math.max(12, maxFontSizePt * 1.25);
  return {
    xPt,
    yPt,
    widthPt: Math.min(availableWidthPt, naturalWidthPt + widthSlackPt),
    heightPt: Math.max(5, (group.bottom - group.top) * model.pxToPt * 1.42, maxFontSizePt * 1.48)
  };
}

function buildPptRichTextRuns(
  model: PreviewPdfModel,
  fragments: TextFragment[]
): Array<{ text: string; options: Record<string, unknown> }> {
  return fragments.map((fragment, index) => {
    const previous = fragments[index - 1];
    const visibleGap = previous && fragment.left - previous.right > Math.max(
      1.5,
      Math.min(fragment.fontSizePx, previous.fontSizePx) * 0.18
    );
    return {
      text: `${visibleGap ? " " : ""}${fragment.text}`,
      options: {
        fontFace: getOfficeFontFamily(fragment),
        fontSize: Math.max(4, fragment.fontSizePx * model.pxToPt),
        bold: Number.parseInt(fragment.fontWeight, 10) >= 600,
        italic: fragment.fontStyle === "italic",
        underline: fragment.underline ? { color: colorToHex(fragment.color) } : undefined,
        strike: fragment.lineThrough ? "sngStrike" : undefined,
        color: colorToHex(fragment.color),
        hyperlink: fragment.href ? { url: fragment.href } : undefined,
        breakLine: false
      }
    };
  });
}

async function renderOfficePageVisualBackground(
  model: PreviewPdfModel,
  pageIndex: number,
  options: OfficeRenderOptions
): Promise<Uint8Array> {
  const visualModel: PreviewPdfModel = {
    ...model,
    textFragments: [],
    imageFragments: model.imageFragments,
    videoFragments: model.videoFragments,
    canvasFragments: model.canvasFragments,
    linkFragments: [],
    svgFragments: model.svgFragments,
    decorationFragments: []
  };
  return renderPreviewPageToPngBytes(visualModel, pageIndex, {
    colorMode: options.colorMode,
    rasterScale: options.rasterScale,
    includeText: false,
    includeDecorations: false,
    includeNoteDraw: true
  });
}

async function renderOfficePreviewPages(
  model: PreviewPdfModel,
  options: OfficeRenderOptions
): Promise<Uint8Array[]> {
  return Promise.all(Array.from({ length: model.pageBreaks.length - 1 }, (_, pageIndex) => (
    renderPreviewPageToPngBytes(model, pageIndex, {
      colorMode: options.colorMode,
      rasterScale: options.rasterScale,
      includeText: true,
      includeDecorations: true,
      includeNoteDraw: true
    })
  )));
}

async function injectOfficePreviewPages(
  blob: Blob,
  model: PreviewPdfModel,
  pages: Uint8Array[],
  embeddedAssets: EmbeddedExportAsset[] = []
): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  zip.file("mpe/preview/manifest.json", JSON.stringify({
    schemaVersion: 1,
    generator: "Obsidian Mobile PDF Exporter",
    pageCount: pages.length,
    pageWidthPt: model.pageWidthPt,
    pageHeightPt: model.pageHeightPt
  }));
  pages.forEach((page, pageIndex) => {
    zip.file(`mpe/preview/page-${String(pageIndex + 1).padStart(4, "0")}.png`, page);
  });
  if (embeddedAssets.length > 0) {
    const usedNames = new Set<string>();
    const manifest = embeddedAssets.map((asset) => {
      const name = getUniqueEmbeddedAssetName(asset.name, usedNames);
      const archivePath = `mpe/attachments/${name}`;
      zip.file(archivePath, asset.bytes);
      return {
        name,
        sourcePath: asset.path,
        mimeType: asset.mimeType,
        size: asset.bytes.byteLength,
        archivePath
      };
    });
    zip.file("mpe/attachments/manifest.json", JSON.stringify({
      schemaVersion: 1,
      generator: "Obsidian Mobile PDF Exporter",
      files: manifest
    }));
  }
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return new Blob([new Uint8Array(bytes).buffer], { type: blob.type });
}

async function renderNoteDrawPageOverlayToPngBytes(
  model: PreviewPdfModel,
  pageIndex: number,
  colorMode: PdfColorMode,
  rasterScale: number
): Promise<WordPageDrawingOverlay | null> {
  const pageTopPx = model.pageBreaks[pageIndex];
  const pageBottomPx = model.pageBreaks[pageIndex + 1];
  const fragments = model.canvasFragments.filter((fragment) => (
    isNoteDrawCanvasFragment(fragment) &&
    fragment.bottom > pageTopPx &&
    fragment.top < pageBottomPx
  ));
  if (fragments.length === 0) return null;

  const paddingPx = 2;
  const leftPx = Math.max(0, Math.min(...fragments.map((fragment) => fragment.left)) - paddingPx);
  const rightPx = Math.min(
    model.sourceWidthPx,
    Math.max(...fragments.map((fragment) => fragment.right)) + paddingPx
  );
  const contentTopPx = Math.max(pageTopPx, Math.min(...fragments.map((fragment) => fragment.top)));
  const contentBottomPx = Math.min(pageBottomPx, Math.max(...fragments.map((fragment) => fragment.bottom)));
  const topPx = Math.max(0, model.bodyTopInsetPx + contentTopPx - pageTopPx - paddingPx);
  const bottomPx = Math.min(
    model.pageHeightPx,
    model.bodyTopInsetPx + contentBottomPx - pageTopPx + paddingPx
  );
  if (rightPx <= leftPx || bottomPx <= topPx) return null;

  const scale = getSafePreviewImageScale(model.sourceWidthPx, model.pageHeightPx, rasterScale);
  const pageCanvas = createCanvas(model.ownerDocument);
  const pageContext = pageCanvas.getContext("2d");
  if (!pageContext) return null;
  pageCanvas.width = Math.max(1, Math.ceil(model.sourceWidthPx * scale));
  pageCanvas.height = Math.max(1, Math.ceil(model.pageHeightPx * scale));
  pageContext.setTransform(scale, 0, 0, scale, 0, 0);
  pageContext.save();
  pageContext.beginPath();
  pageContext.rect(0, model.bodyTopInsetPx, model.sourceWidthPx, model.bodyHeightPx);
  pageContext.clip();
  pageContext.translate(0, model.bodyTopInsetPx);
  drawCanvasBitmapLayer(pageContext, fragments, {
    pageTopPx,
    pageBottomPx,
    sourceWidthPx: model.sourceWidthPx,
    pageHeightPx: model.bodyHeightPx
  });
  pageContext.restore();
  if (colorMode === "grayscale") applyCanvasGrayscale(pageContext, pageCanvas.width, pageCanvas.height);

  const sourceLeft = Math.max(0, Math.floor(leftPx * scale));
  const sourceTop = Math.max(0, Math.floor(topPx * scale));
  const sourceRight = Math.min(pageCanvas.width, Math.ceil(rightPx * scale));
  const sourceBottom = Math.min(pageCanvas.height, Math.ceil(bottomPx * scale));
  const overlayCanvas = createCanvas(model.ownerDocument);
  overlayCanvas.width = Math.max(1, sourceRight - sourceLeft);
  overlayCanvas.height = Math.max(1, sourceBottom - sourceTop);
  const overlayContext = overlayCanvas.getContext("2d");
  if (!overlayContext) return null;
  overlayContext.drawImage(
    pageCanvas,
    sourceLeft,
    sourceTop,
    overlayCanvas.width,
    overlayCanvas.height,
    0,
    0,
    overlayCanvas.width,
    overlayCanvas.height
  );

  return {
    data: dataUrlToUint8Array(overlayCanvas.toDataURL("image/png")),
    leftPx: sourceLeft / scale,
    topPx: sourceTop / scale,
    widthPx: overlayCanvas.width / scale,
    heightPx: overlayCanvas.height / scale
  };
}

async function injectEditableWordTextBoxes(
  blob: Blob,
  model: PreviewPdfModel,
  embeddedVideos: WordEmbeddedVideo[] = []
): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const documentFile = zip.file("word/document.xml");
  if (!documentFile) throw new Error("DOCX document.xml is missing.");
  let xml = await documentFile.async("string");
  const hyperlinkIds = buildWordHyperlinkIdMap(model.textFragments);
  const videoParts = buildWordEmbeddedVideoParts(embeddedVideos);
  let videoObjectIndex = 0;
  for (let pageIndex = 0; pageIndex < model.pageBreaks.length - 1; pageIndex += 1) {
    const marker = `__MPE_PAGE_${pageIndex}__`;
    const markerParagraph = new RegExp(`<w:p(?=[ >])(?:(?!<\\/w:p>)[\\s\\S])*?${marker}(?:(?!<\\/w:p>)[\\s\\S])*?<\\/w:p>`, "u");
    const markerMatch = xml.match(markerParagraph);
    if (!markerMatch) throw new Error(`DOCX page marker ${pageIndex + 1} is missing.`);
    const markerXml = markerMatch[0];
    const drawingRuns = markerXml.match(/<w:r(?=[ >])[\s\S]*?<w:drawing[\s\S]*?<\/w:r>/gu) ?? [];
    const floatingRuns = drawingRuns.map((runXml) => {
      const videoMarker = runXml.match(/\bname="(MPE_VIDEO_\d+_\d+)"/u)?.[1];
      const videoPart = videoMarker ? videoParts.byMarker.get(videoMarker) : undefined;
      if (!videoPart) return runXml;
      videoObjectIndex += 1;
      return buildWordOleVideoRun(runXml, videoPart, videoObjectIndex) ?? runXml;
    });
    const floatingParagraph = floatingRuns.length > 0
      ? `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/></w:pPr>${floatingRuns.join("")}</w:p>`
      : "";
    const paragraphs = `${floatingParagraph}${buildWordFlowTextParagraphsXml(model, pageIndex, hyperlinkIds)}`;
    xml = xml.replace(markerParagraph, paragraphs);
  }
  zip.file("word/document.xml", xml);
  await injectWordHyperlinkRelationships(zip, hyperlinkIds);
  await injectWordEmbeddedVideoParts(zip, videoParts.parts);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return new Blob([new Uint8Array(bytes).buffer], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
}

interface WordEmbeddedVideoPart {
  asset: EmbeddedExportAsset;
  relationshipId: string;
  archivePath: string;
}

function buildWordEmbeddedVideoParts(videos: WordEmbeddedVideo[]): {
  parts: WordEmbeddedVideoPart[];
  byMarker: Map<string, WordEmbeddedVideoPart>;
} {
  const partsByPath = new Map<string, WordEmbeddedVideoPart>();
  const byMarker = new Map<string, WordEmbeddedVideoPart>();
  for (const video of videos) {
    let part = partsByPath.get(video.asset.path);
    if (!part) {
      const index = partsByPath.size + 1;
      part = {
        asset: video.asset,
        relationshipId: `rIdMpeVideo${index}`,
        archivePath: `word/embeddings/mpe-video-${index}.bin`
      };
      partsByPath.set(video.asset.path, part);
    }
    byMarker.set(video.marker, part);
  }
  return { parts: Array.from(partsByPath.values()), byMarker };
}

function buildWordOleVideoRun(
  runXml: string,
  video: WordEmbeddedVideoPart,
  objectIndex: number
): string | null {
  const anchor = runXml.match(/<wp:anchor(?=[ >])[^>]*>([\s\S]*?)<\/wp:anchor>/u);
  if (!anchor) return null;
  const body = anchor[1];
  const positionH = Number.parseInt(body.match(/<wp:positionH(?=[ >])[\s\S]*?<wp:posOffset>(-?\d+)<\/wp:posOffset>[\s\S]*?<\/wp:positionH>/u)?.[1] ?? "0", 10);
  const positionV = Number.parseInt(body.match(/<wp:positionV(?=[ >])[\s\S]*?<wp:posOffset>(-?\d+)<\/wp:posOffset>[\s\S]*?<\/wp:positionV>/u)?.[1] ?? "0", 10);
  const extent = body.match(/<wp:extent cx="(\d+)" cy="(\d+)"\s*\/>/u);
  const imageRelationshipId = body.match(/<a:blip(?=[ >])[^>]*\br:embed="([^"]+)"/u)?.[1];
  if (!extent || !imageRelationshipId) return null;
  const leftPt = positionH / 12700;
  const topPt = positionV / 12700;
  const widthPt = Math.max(1, Number.parseInt(extent[1], 10) / 12700);
  const heightPt = Math.max(1, Number.parseInt(extent[2], 10) / 12700);
  const shapeId = `_x0000_i${1024 + objectIndex}`;
  const shapeTypeId = `_x0000_t75_${objectIndex}`;
  const objectId = `_${100000000 + objectIndex}`;
  const shapeStyle = [
    "position:absolute",
    `margin-left:${formatWordPoint(leftPt)}pt`,
    `margin-top:${formatWordPoint(topPt)}pt`,
    `width:${formatWordPoint(widthPt)}pt`,
    `height:${formatWordPoint(heightPt)}pt`,
    "z-index:3",
    "mso-position-horizontal-relative:page",
    "mso-position-vertical-relative:page",
    "mso-wrap-style:none"
  ].join(";");
  const shapeType = `<v:shapetype id="${shapeTypeId}" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f"><v:stroke joinstyle="miter"/><v:formulas><v:f eqn="if lineDrawn pixelLineWidth 0"/><v:f eqn="sum @0 1 0"/><v:f eqn="sum 0 0 @1"/><v:f eqn="prod @2 1 2"/><v:f eqn="prod @3 21600 pixelWidth"/><v:f eqn="sum @0 0 1"/><v:f eqn="prod @6 1 2"/><v:f eqn="prod @7 21600 pixelWidth"/><v:f eqn="sum @8 21600 0"/><v:f eqn="prod @7 21600 pixelHeight"/><v:f eqn="sum @10 21600 0"/></v:formulas><v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype>`;
  return `<w:r><w:object w:dxaOrig="${Math.round(widthPt * 20)}" w:dyaOrig="${Math.round(heightPt * 20)}">${shapeType}<v:shape id="${shapeId}" type="#${shapeTypeId}" style="${shapeStyle}" o:allowoverlap="t" o:ole=""><v:imagedata r:id="${imageRelationshipId}" o:title="${escapeXml(video.asset.name)}"/></v:shape><o:OLEObject Type="Embed" ProgID="Package" ShapeID="${shapeId}" DrawAspect="Content" ObjectID="${objectId}" r:id="${video.relationshipId}"/></w:object></w:r>`;
}

function formatWordPoint(value: number): string {
  return value.toFixed(3).replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}

function buildWordFlowTextParagraphsXml(
  model: PreviewPdfModel,
  pageIndex: number,
  hyperlinkIds: ReadonlyMap<string, string>
): string {
  const pageTop = model.pageBreaks[pageIndex];
  const pageMarginTwips = 360;
  let cursorPt = pageMarginTwips / 20 + 1;
  const entries: Array<{ topPt: number; order: number; render: () => string }> = [];

  for (const line of getPageOfficeTextLines(model, pageIndex)) {
    const fragments = line.fragments.filter((fragment) => fragment.text.trim());
    if (fragments.length === 0) continue;

    const lineTopPt = Math.max(0, (line.top - pageTop + model.bodyTopInsetPx) * model.pxToPt);
    const lineHeightPt = Math.max(
      5,
      (line.bottom - line.top) * model.pxToPt * 1.18,
      ...fragments.map((fragment) => fragment.fontSizePx * model.pxToPt * 1.18)
    );
    const lineHeightTwips = Math.max(100, Math.round(lineHeightPt * 20));
    const leftTwips = Math.max(-pageMarginTwips, Math.round(line.left * model.pxToPt * 20) - pageMarginTwips);
    const separators = fragments.map((fragment, fragmentIndex): "none" | "space" | "tab" => {
      if (fragmentIndex === 0) return "none";
      const previous = fragments[fragmentIndex - 1];
      const gapPx = fragment.left - previous.right;
      const visibleGap = gapPx > Math.max(2, Math.min(fragment.fontSizePx, previous.fontSizePx) * 0.35);
      if (!visibleGap) return "none";
      const distinctScopes = fragment.mergeScope !== previous.mergeScope;
      const columnGap = gapPx > Math.max(10, Math.min(fragment.fontSizePx, previous.fontSizePx) * 2.5);
      return distinctScopes && columnGap && !fragment.officeDecoration && !previous.officeDecoration ? "tab" : "space";
    });
    const tabStops = fragments.slice(1).map((fragment, fragmentIndex) => {
      if (separators[fragmentIndex + 1] !== "tab") return "";
      const position = Math.max(0, Math.round(fragment.left * model.pxToPt * 20) - pageMarginTwips);
      return `<w:tab w:val="left" w:pos="${position}"/>`;
    }).join("");
    const tabs = tabStops ? `<w:tabs>${tabStops}</w:tabs>` : "";
    const runs = fragments.map((fragment, fragmentIndex) => {
      const separator = separators[fragmentIndex] === "tab"
        ? "<w:r><w:tab/></w:r>"
        : separators[fragmentIndex] === "space"
          ? '<w:r><w:t xml:space="preserve"> </w:t></w:r>'
          : "";
      const run = buildWordTextRunXml(model, fragment, fragment.text);
      const relationshipId = fragment.href ? hyperlinkIds.get(fragment.href) : undefined;
      const linkedRun = relationshipId
        ? `<w:hyperlink r:id="${relationshipId}" w:history="1">${run}</w:hyperlink>`
        : run;
      return `${separator}${linkedRun}`;
    }).join("");

    const headingLevel = Math.min(...fragments.map((fragment) => fragment.headingLevel ?? 7));
    const paragraphStyle = headingLevel <= 6 ? `<w:pStyle w:val="Heading${headingLevel}"/>` : "";
    entries.push({
      topPt: lineTopPt,
      order: 1,
      render: () => {
        const beforeTwips = Math.max(0, Math.round((lineTopPt - cursorPt) * 20));
        cursorPt = Math.max(cursorPt, lineTopPt) + lineHeightPt;
        return `<w:p><w:pPr>${paragraphStyle}${tabs}<w:spacing w:before="${beforeTwips}" w:after="0" w:line="${lineHeightTwips}" w:lineRule="exact"/><w:ind w:left="${leftTwips}"/></w:pPr>${runs}</w:p>`;
      }
    });
  }

  return entries
    .sort((left, right) => left.topPt - right.topPt || left.order - right.order)
    .map((entry) => entry.render())
    .join("");
}

function buildWordHyperlinkIdMap(fragments: TextFragment[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const fragment of fragments) {
    if (!fragment.href || result.has(fragment.href)) continue;
    result.set(fragment.href, `rIdMpeLink${result.size + 1}`);
  }
  return result;
}

interface WordZipArchive {
  file(path: string): { async(type: "string"): Promise<string> } | null;
  file(
    path: string,
    data: string | Uint8Array,
    options?: { compression?: "STORE" | "DEFLATE" }
  ): unknown;
}

async function injectWordHyperlinkRelationships(
  zip: WordZipArchive,
  hyperlinkIds: ReadonlyMap<string, string>
): Promise<void> {
  if (hyperlinkIds.size === 0) return;
  const relationshipFile = zip.file("word/_rels/document.xml.rels");
  if (!relationshipFile) throw new Error("DOCX document relationships are missing.");
  let relationships = await relationshipFile.async("string");
  const additions = Array.from(hyperlinkIds, ([href, relationshipId]) => (
    `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(href)}" TargetMode="External"/>`
  )).join("");
  if (!/<\/Relationships>/u.test(relationships)) throw new Error("DOCX relationships XML is invalid.");
  relationships = relationships.replace(/<\/Relationships>/u, `${additions}</Relationships>`);
  zip.file("word/_rels/document.xml.rels", relationships);
}

async function injectWordEmbeddedVideoParts(
  zip: WordZipArchive,
  parts: WordEmbeddedVideoPart[]
): Promise<void> {
  if (parts.length === 0) return;
  const relationshipFile = zip.file("word/_rels/document.xml.rels");
  const contentTypesFile = zip.file("[Content_Types].xml");
  if (!relationshipFile || !contentTypesFile) throw new Error("DOCX package metadata is missing.");

  let relationships = await relationshipFile.async("string");
  const relationshipAdditions = parts.map((part) => (
    `<Relationship Id="${part.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/${part.archivePath.split("/").pop()}"/>`
  )).join("");
  if (!/<\/Relationships>/u.test(relationships)) throw new Error("DOCX relationships XML is invalid.");
  relationships = relationships.replace(/<\/Relationships>/u, `${relationshipAdditions}</Relationships>`);
  zip.file("word/_rels/document.xml.rels", relationships);

  let contentTypes = await contentTypesFile.async("string");
  if (!/<Default\s+Extension="bin"\b/iu.test(contentTypes)) {
    const oleType = '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>';
    if (!/<\/Types>/u.test(contentTypes)) throw new Error("DOCX content types XML is invalid.");
    contentTypes = contentTypes.replace(/<\/Types>/u, `${oleType}</Types>`);
    zip.file("[Content_Types].xml", contentTypes);
  }

  for (const part of parts) {
    zip.file(part.archivePath, buildOlePackage(part.asset.name, part.asset.bytes), { compression: "STORE" });
  }
}

const OLE_FREE_SECTOR = 0xffffffff;
const OLE_END_OF_CHAIN = 0xfffffffe;
const OLE_FAT_SECTOR = 0xfffffffd;
const OLE_DIFAT_SECTOR = 0xfffffffc;
const OLE_MARKER_BYTES = new Uint8Array([
  1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
]);
const OLE_COMP_OBJ_BYTES = oleBytesFromHex(
  "0100feff030a0000ffffffff0c00030000000000c0000000000000460c000000" +
  "4f4c45205061636b6167650000000000080000005061636b61676500f439b271" +
  "000000000000000000000000"
);
const OLE_OBJ_INFO_BYTES = oleBytesFromHex("000003000d00");
const OLE_PACKAGE_CLSID = oleBytesFromHex("0c00030000000000c000000000000046");

interface OleDirectoryStream {
  name: string;
  start: number;
  size: number;
  sectorCount: number;
}

function buildOlePackage(filename: string, payload: Uint8Array): Uint8Array {
  const safeName = getOleSafeFilename(filename);
  return buildOleCompoundFile([
    ["\x01Ole", OLE_MARKER_BYTES],
    ["\x01CompObj", OLE_COMP_OBJ_BYTES],
    ["\x03ObjInfo", OLE_OBJ_INFO_BYTES],
    ["\x01Ole10Native", buildOle10Native(safeName, payload)]
  ]);
}

function buildOle10Native(filename: string, payload: Uint8Array): Uint8Array {
  const safeName = getOleSafeFilename(filename);
  const tempPath = `C:\\Users\\Public\\AppData\\Local\\Temp\\{00000000-0000-0000-0000-000000000000}\\${safeName}`;
  const sourcePath = `C:\\Users\\Public\\Desktop\\${safeName}`;
  const body = oleConcatBytes([
    oleUint16(2),
    oleAnsi(safeName),
    new Uint8Array([0]),
    oleAnsi(sourcePath),
    new Uint8Array([0]),
    oleUint16(0),
    oleUint16(3),
    oleUint32(tempPath.length + 1),
    oleAnsi(tempPath),
    new Uint8Array([0]),
    oleUint32(payload.length),
    payload,
    oleUint32(tempPath.length),
    oleUtf16Le(tempPath),
    oleUint32(safeName.length),
    oleUtf16Le(safeName),
    oleUint32(sourcePath.length),
    oleUtf16Le(sourcePath)
  ]);
  return oleConcatBytes([oleUint32(body.length), body]);
}

function buildOleCompoundFile(streams: Array<[string, Uint8Array]>): Uint8Array {
  const sectorSize = 512;
  const sectors: Uint8Array[] = [];
  const directoryStreams: OleDirectoryStream[] = [];

  for (const [name, data] of streams) {
    const storedSize = Math.max(data.length, 4096);
    const paddedSize = Math.ceil(storedSize / sectorSize) * sectorSize;
    const padded = olePadBytes(data, paddedSize);
    const start = sectors.length;
    for (let offset = 0; offset < padded.length; offset += sectorSize) {
      sectors.push(padded.slice(offset, offset + sectorSize));
    }
    directoryStreams.push({
      name,
      start,
      size: padded.length,
      sectorCount: padded.length / sectorSize
    });
  }

  const directoryStart = sectors.length;
  const directoryData = buildOleDirectoryStream(directoryStreams);
  for (let offset = 0; offset < directoryData.length; offset += sectorSize) {
    sectors.push(directoryData.slice(offset, offset + sectorSize));
  }
  const directorySectorCount = directoryData.length / sectorSize;
  const nonFatSectorCount = sectors.length;
  let fatSectorCount = 1;
  let difatSectorCount = 0;
  while (true) {
    const nextFatCount = Math.max(
      1,
      Math.ceil((nonFatSectorCount + fatSectorCount + difatSectorCount) / 128)
    );
    const nextDifatCount = Math.max(0, Math.ceil((nextFatCount - 109) / 127));
    if (nextFatCount === fatSectorCount && nextDifatCount === difatSectorCount) break;
    fatSectorCount = nextFatCount;
    difatSectorCount = nextDifatCount;
  }

  const fatStart = nonFatSectorCount;
  const fatSectorIds = oleRange(fatStart, fatStart + fatSectorCount);
  const difatStart = fatStart + fatSectorCount;
  const difatSectorIds = oleRange(difatStart, difatStart + difatSectorCount);
  const fatEntries = new Array<number>(fatSectorCount * 128).fill(OLE_FREE_SECTOR);
  for (const stream of directoryStreams) {
    markOleSectorChain(fatEntries, stream.start, stream.sectorCount);
  }
  markOleSectorChain(fatEntries, directoryStart, directorySectorCount);
  for (const sector of fatSectorIds) fatEntries[sector] = OLE_FAT_SECTOR;
  for (const sector of difatSectorIds) fatEntries[sector] = OLE_DIFAT_SECTOR;

  const fatBytes = new Uint8Array(fatSectorCount * sectorSize);
  const fatView = new DataView(fatBytes.buffer);
  fatEntries.forEach((value, index) => fatView.setUint32(index * 4, value, true));
  const difatBytes = buildOleDifatSectors(fatSectorIds.slice(109), difatSectorIds);
  return oleConcatBytes([
    buildOleCompoundHeader(fatSectorCount, directoryStart, fatSectorIds, difatSectorIds),
    ...sectors,
    fatBytes,
    difatBytes
  ]);
}

function buildOleDirectoryStream(streams: OleDirectoryStream[]): Uint8Array {
  const entries = [
    buildOleDirectoryEntry("Root Entry", 5, OLE_FREE_SECTOR, OLE_FREE_SECTOR, 1, OLE_END_OF_CHAIN, 0, OLE_PACKAGE_CLSID),
    buildOleDirectoryEntry(streams[0].name, 2, OLE_FREE_SECTOR, 2, OLE_FREE_SECTOR, streams[0].start, streams[0].size),
    buildOleDirectoryEntry(streams[1].name, 2, OLE_FREE_SECTOR, 3, OLE_FREE_SECTOR, streams[1].start, streams[1].size),
    buildOleDirectoryEntry(streams[2].name, 2, OLE_FREE_SECTOR, 4, OLE_FREE_SECTOR, streams[2].start, streams[2].size),
    buildOleDirectoryEntry(streams[3].name, 2, OLE_FREE_SECTOR, OLE_FREE_SECTOR, OLE_FREE_SECTOR, streams[3].start, streams[3].size)
  ];
  const bytes = oleConcatBytes(entries);
  return olePadBytes(bytes, Math.ceil(bytes.length / 512) * 512);
}

function buildOleDirectoryEntry(
  name: string,
  type: number,
  left: number,
  right: number,
  child: number,
  start: number,
  size: number,
  clsid?: Uint8Array
): Uint8Array {
  const output = new Uint8Array(128);
  const encodedName = oleConcatBytes([oleUtf16Le(name), new Uint8Array([0, 0])]).slice(0, 64);
  output.set(encodedName, 0);
  output.set(oleUint16(encodedName.length), 64);
  output[66] = type;
  output[67] = 1;
  output.set(oleUint32(left), 68);
  output.set(oleUint32(right), 72);
  output.set(oleUint32(child), 76);
  if (clsid) output.set(clsid, 80);
  output.set(oleUint32(start), 116);
  output.set(oleUint64(BigInt(size)), 120);
  return output;
}

function buildOleCompoundHeader(
  fatSectorCount: number,
  firstDirectorySector: number,
  fatSectorIds: number[],
  difatSectorIds: number[]
): Uint8Array {
  const output = new Uint8Array(512);
  output.set(oleBytesFromHex("d0cf11e0a1b11ae1"), 0);
  output.set(oleUint16(0x003e), 24);
  output.set(oleUint16(0x0003), 26);
  output.set(oleUint16(0xfffe), 28);
  output.set(oleUint16(9), 30);
  output.set(oleUint16(6), 32);
  output.set(oleUint32(0), 40);
  output.set(oleUint32(fatSectorCount), 44);
  output.set(oleUint32(firstDirectorySector), 48);
  output.set(oleUint32(0), 52);
  output.set(oleUint32(4096), 56);
  output.set(oleUint32(OLE_END_OF_CHAIN), 60);
  output.set(oleUint32(0), 64);
  output.set(oleUint32(difatSectorIds[0] ?? OLE_END_OF_CHAIN), 68);
  output.set(oleUint32(difatSectorIds.length), 72);
  const headerDifat = [
    ...fatSectorIds.slice(0, 109),
    ...new Array<number>(Math.max(0, 109 - fatSectorIds.length)).fill(OLE_FREE_SECTOR)
  ];
  headerDifat.forEach((sector, index) => output.set(oleUint32(sector), 76 + index * 4));
  return output;
}

function buildOleDifatSectors(fatSectorIds: number[], difatSectorIds: number[]): Uint8Array {
  if (difatSectorIds.length === 0) return new Uint8Array();
  const output = new Uint8Array(difatSectorIds.length * 512);
  const view = new DataView(output.buffer);
  for (let sectorIndex = 0; sectorIndex < difatSectorIds.length; sectorIndex += 1) {
    const sectorOffset = sectorIndex * 512;
    const ids = fatSectorIds.slice(sectorIndex * 127, (sectorIndex + 1) * 127);
    for (let entryIndex = 0; entryIndex < 127; entryIndex += 1) {
      view.setUint32(
        sectorOffset + entryIndex * 4,
        ids[entryIndex] ?? OLE_FREE_SECTOR,
        true
      );
    }
    view.setUint32(
      sectorOffset + 127 * 4,
      difatSectorIds[sectorIndex + 1] ?? OLE_END_OF_CHAIN,
      true
    );
  }
  return output;
}

function markOleSectorChain(fat: number[], start: number, count: number): void {
  for (let offset = 0; offset < count; offset += 1) {
    fat[start + offset] = offset < count - 1 ? start + offset + 1 : OLE_END_OF_CHAIN;
  }
}

function oleConcatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function olePadBytes(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length >= length) return bytes;
  const output = new Uint8Array(length);
  output.set(bytes);
  return output;
}

function oleUint16(value: number): Uint8Array {
  const output = new Uint8Array(2);
  new DataView(output.buffer).setUint16(0, value, true);
  return output;
}

function oleUint32(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, true);
  return output;
}

function oleUint64(value: bigint): Uint8Array {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, value, true);
  return output;
}

function oleUtf16Le(value: string): Uint8Array {
  const output = new Uint8Array(value.length * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < value.length; index += 1) {
    view.setUint16(index * 2, value.charCodeAt(index), true);
  }
  return output;
}

function oleAnsi(value: string): Uint8Array {
  return Uint8Array.from(Array.from(value, (character) => character.charCodeAt(0)));
}

function oleBytesFromHex(hex: string): Uint8Array {
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    output[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return output;
}

function oleRange(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, index) => start + index);
}

function getOleSafeFilename(filename: string): string {
  const basename = filename.split(/[\\/]/u).pop() ?? "video.mp4";
  return basename.replace(/[^A-Za-z0-9._ &-]+/gu, "_").trim() || "video.mp4";
}

function buildWordTextRunXml(model: PreviewPdfModel, fragment: TextFragment, text: string): string {
  const fontSizeHalfPt = Math.max(8, Math.round(fragment.fontSizePx * model.pxToPt * 2));
  const fontFamily = escapeXml(getOfficeFontFamily(fragment));
  const bold = Number.parseInt(fragment.fontWeight, 10) >= 600 ? "<w:b/>" : "";
  const italic = fragment.fontStyle === "italic" ? "<w:i/>" : "";
  const underline = fragment.underline ? '<w:u w:val="single"/>' : "";
  const strike = fragment.lineThrough ? "<w:strike/>" : "";
  return `<w:r><w:rPr><w:rFonts w:ascii="${fontFamily}" w:hAnsi="${fontFamily}" w:eastAsia="${fontFamily}"/>${bold}${italic}${underline}${strike}<w:color w:val="${colorToHex(fragment.color)}"/><w:sz w:val="${fontSizeHalfPt}"/><w:szCs w:val="${fontSizeHalfPt}"/></w:rPr>${buildWordTextPayloadXml(text)}</w:r>`;
}

function buildWordTextPayloadXml(text: string): string {
  let xml = "";
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    xml += `<w:t xml:space="preserve">${escapeXml(buffer)}</w:t>`;
    buffer = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const previous = index > 0 ? text[index - 1] : "";
    const next = index < text.length - 1 ? text[index + 1] : "";
    if (character === "-" && isAsciiDigit(previous) && isAsciiDigit(next)) {
      flush();
      xml += "<w:noBreakHyphen/>";
    } else {
      buffer += character;
    }
  }
  flush();
  return xml || '<w:t xml:space="preserve"></w:t>';
}

function isAsciiDigit(value: string): boolean {
  return value >= "0" && value <= "9";
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;"
  })[character] ?? character);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

const HTML_INLINE_STYLE_PROPERTIES = [
  "display", "visibility", "position", "float", "clear", "box-sizing",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "overflow", "overflow-x", "overflow-y", "color", "background-color",
  "background-image", "background-position", "background-size", "background-repeat",
  "border-top", "border-right", "border-bottom", "border-left", "border-radius", "box-shadow",
  "font-family", "font-size", "font-weight", "font-style", "font-variant", "line-height",
  "letter-spacing", "word-spacing", "text-align", "text-indent", "text-decoration",
  "text-transform", "white-space", "word-break", "overflow-wrap", "vertical-align",
  "list-style-type", "list-style-position", "table-layout", "border-collapse", "border-spacing",
  "object-fit", "object-position", "opacity", "filter", "transform", "transform-origin",
  "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-auto-flow",
  "align-items", "justify-content", "align-content", "flex-direction", "flex-wrap",
  "flex-grow", "flex-shrink", "flex-basis", "order", "z-index", "top", "right", "bottom", "left"
] as const;

const HTML_FLOW_SIZE_PROPERTIES = new Set<string>([
  "width", "min-width", "max-width", "height", "min-height", "max-height"
]);
const HTML_POSITION_OFFSET_PROPERTIES = new Set<string>(["top", "right", "bottom", "left"]);

async function buildRenderedDomHtml(
  app: App,
  file: TFile,
  pageEl: HTMLElement,
  noteDrawHost: HTMLElement,
  preparedNoteDraw: PreparedNoteDrawExportOverlay,
  signal?: AbortSignal
): Promise<Blob> {
  throwIfExportCancelled(signal);
  await waitForImages(pageEl, IMAGE_WAIT_TIMEOUT_MS);
  const clone = pageEl.cloneNode(true) as HTMLElement;
  const sourceElements = [pageEl, ...Array.from(pageEl.querySelectorAll<HTMLElement>("*"))];
  const clonedElements = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))];
  for (let index = 0; index < Math.min(sourceElements.length, clonedElements.length); index += 1) {
    copyRenderedHtmlStyle(sourceElements[index], clonedElements[index]);
  }
  await inlineRenderedHtmlMedia(app, file.path, sourceElements, clonedElements, signal);
  await injectRenderedHtmlNoteDrawAssets(
    app,
    file.path,
    noteDrawHost,
    preparedNoteDraw,
    sourceElements,
    clonedElements,
    signal
  );
  clone.querySelectorAll("script,style,link,button,.collapse-indicator,.heading-collapse-indicator,.markdown-embed-link,.edit-block-button,.copy-code-button,.notedraw-toolbar,.note-doodle-toolbar").forEach((element) => element.remove());
  removeObsidianOnlyHtmlUrls(clone);
  clone.querySelectorAll<HTMLAnchorElement>("a").forEach((anchor) => {
    const dataHref = anchor.getAttribute("data-href");
    if (dataHref && /^(?:app|obsidian):\/\//iu.test(anchor.href)) anchor.setAttribute("href", dataHref);
    if (/^https?:\/\//iu.test(anchor.href)) {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    }
  });
  const widthPx = Math.max(320, Math.ceil(pageEl.getBoundingClientRect().width || pageEl.scrollWidth));
  clone.classList.add("mpe-rendered-document");
  clone.setAttribute("contenteditable", "true");
  clone.setAttribute("spellcheck", "false");
  clone.setCssProps({ "--mpe-export-max-width": `${widthPx}px` });
  const html = `<!doctype html><html lang="zh-CN" data-mpe-format="rendered-dom"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(file.basename)}</title><style>*{box-sizing:border-box}html{background:#eef1f5}body{margin:0;padding:24px;background:#eef1f5;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.mpe-rendered-document{width:100%!important;max-width:var(--mpe-export-max-width)!important;height:auto!important;min-height:0!important;overflow:visible!important;transform:none!important;margin:0 auto!important;background:#fff;box-shadow:0 8px 28px #0002}.mpe-rendered-document .markdown-preview-view{width:100%!important;max-width:100%!important;height:auto!important;overflow:visible!important}.mpe-rendered-document img{max-width:100%;height:auto!important}.mpe-rendered-document .mpe-export-canvas.mobile-pdf-exporter-note-doodle-canvas{display:block!important}.mpe-rendered-document table{width:100%;max-width:100%;}.mpe-rendered-document:focus{outline:none}@media(max-width:${widthPx + 48}px){body{padding:12px}.mpe-rendered-document{box-shadow:none}}@media print{html,body{padding:0;background:#fff}.mpe-rendered-document{max-width:none!important;box-shadow:none}}</style></head><body><main>${clone.outerHTML}</main></body></html>`;
  return new Blob([html], { type: "text/html;charset=utf-8" });
}

function removeObsidianOnlyHtmlUrls(root: HTMLElement): void {
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  for (const element of elements) {
    for (const property of Array.from(element.style)) {
      if (/(?:app|obsidian):\/\//iu.test(element.style.getPropertyValue(property))) {
        element.style.removeProperty(property);
      }
    }
    for (const attribute of ["src", "srcset", "poster", "data", "aria-label"]) {
      const value = element.getAttribute(attribute);
      if (value && /^(?:app|obsidian):\/\//iu.test(value.trim())) element.removeAttribute(attribute);
    }
  }
  root.querySelectorAll<HTMLAnchorElement>("a").forEach((anchor) => {
    const href = anchor.getAttribute("href");
    if (href && /^(?:app|obsidian):\/\//iu.test(href.trim())) anchor.removeAttribute("href");
  });
}

function copyRenderedHtmlStyle(source: HTMLElement, target: HTMLElement): void {
  const style = getComputedStyle(source);
  const preservesSize = source.matches("img,picture,svg,canvas,video,iframe,object,embed") ||
    style.position === "absolute" || style.position === "fixed";
  for (const property of HTML_INLINE_STYLE_PROPERTIES) {
    if (!preservesSize && HTML_FLOW_SIZE_PROPERTIES.has(property)) continue;
    if (style.position !== "absolute" && style.position !== "fixed" && HTML_POSITION_OFFSET_PROPERTIES.has(property)) continue;
    const value = style.getPropertyValue(property);
    if (value) target.style.setProperty(property, value);
  }
}

async function inlineRenderedHtmlMedia(
  app: App,
  sourcePath: string,
  sourceElements: HTMLElement[],
  clonedElements: HTMLElement[],
  signal?: AbortSignal
): Promise<void> {
  for (let index = 0; index < Math.min(sourceElements.length, clonedElements.length); index += 1) {
    throwIfExportCancelled(signal);
    const source = sourceElements[index];
    const target = clonedElements[index];
    if (source.instanceOf(HTMLImageElement) && target.instanceOf(HTMLImageElement)) {
      try {
        const height = Math.max(1, source.getBoundingClientRect().height || source.height || source.naturalHeight);
        const bytes = await imageFragmentSliceToPngBytes(source, 0, height, height, "color");
        target.src = bytesToDataUrl(bytes);
        target.removeAttribute("srcset");
        target.removeAttribute("loading");
      } catch (error) {
        console.warn("Mobile PDF Exporter HTML image inline failed", error);
      }
      continue;
    }
    if (source.instanceOf(HTMLVideoElement) && target.instanceOf(HTMLVideoElement)) {
      const sourceUrl = source.currentSrc || source.src;
      try {
        const wrapper = source.closest(".internal-embed, .media-embed");
        const linkPath = wrapper?.getAttribute("src")?.trim() || source.getAttribute("src")?.trim() || "";
        const vaultAsset = linkPath ? await readVaultEmbeddedAsset(app, sourcePath, linkPath) : null;
        const response = !vaultAsset && sourceUrl
          ? await source.ownerDocument.win.fetch(sourceUrl, { signal })
          : null;
        const bytes = vaultAsset?.bytes ?? (response?.ok ? new Uint8Array(await response.arrayBuffer()) : null);
        const mimeType = vaultAsset?.mimeType ?? response?.headers.get("content-type")?.split(";", 1)[0] ?? "video/mp4";
        if (bytes?.byteLength) {
          target.src = bytesToDataUrl(bytes, mimeType);
          target.querySelectorAll("source").forEach((element) => element.remove());
          target.controls = true;
          target.setAttribute("playsinline", "true");
          target.setAttribute("preload", "metadata");
          continue;
        }
      } catch (error) {
        console.warn("Mobile PDF Exporter HTML video inline failed", error);
      }

      const frame = await getVideoExportFrame(source);
      if (frame) {
        const width = frame.instanceOf(HTMLVideoElement) ? frame.videoWidth : frame.naturalWidth;
        const height = frame.instanceOf(HTMLVideoElement) ? frame.videoHeight : frame.naturalHeight;
        const canvas = createCanvas(target);
        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        const context = canvas.getContext("2d");
        context?.drawImage(frame, 0, 0, canvas.width, canvas.height);
        const image = (target.ownerDocument.win as ObsidianExportWindow).createEl("img");
        image.className = `${target.className} mpe-export-video-poster`;
        image.style.cssText = target.style.cssText;
        image.src = canvas.toDataURL("image/png");
        image.alt = source.getAttribute("aria-label") || "Video";
        target.replaceWith(image);
      }
      continue;
    }
    if (source.instanceOf(HTMLCanvasElement) && target.instanceOf(HTMLCanvasElement)) {
      try {
        const image = (target.ownerDocument.win as ObsidianExportWindow).createEl("img");
        image.className = `${target.className} mpe-export-canvas`;
        image.style.cssText = target.style.cssText;
        image.src = source.toDataURL("image/png");
        target.replaceWith(image);
      } catch (error) {
        console.warn("Mobile PDF Exporter HTML canvas inline failed", error);
      }
      continue;
    }
    if (source.instanceOf(SVGSVGElement) && target.instanceOf(SVGSVGElement)) {
      try {
        const bytes = await svgElementToPngBytes(source, 2, SVG_IMAGE_LOAD_TIMEOUT_MS, "color");
        if (!bytes) continue;
        const image = (target.ownerDocument.win as ObsidianExportWindow).createEl("img");
        image.className = `${target.getAttribute("class") ?? ""} mpe-export-svg`;
        image.style.cssText = target.style.cssText;
        image.src = bytesToDataUrl(bytes);
        target.replaceWith(image);
      } catch (error) {
        console.warn("Mobile PDF Exporter HTML SVG inline failed", error);
      }
      continue;
    }
    if (source.instanceOf(HTMLInputElement) && target.instanceOf(HTMLInputElement)) {
      target.checked = source.checked;
      target.value = source.value;
      if (source.checked) target.setAttribute("checked", "");
    }
    if (source.instanceOf(HTMLDetailsElement) && target.instanceOf(HTMLDetailsElement)) target.open = source.open;
  }
}

function buildSelfContainedHtml(file: TFile, model: PreviewPdfModel, pages: Uint8Array[]): Blob {
  const pageMarkup = pages.map((page, pageIndex) => {
    const pageTop = model.pageBreaks[pageIndex];
    const text = getPageTextFragments(model, pageIndex).map((fragment) => {
      const left = fragment.left * model.pxToPt / model.pageWidthPt * 100;
      const top = (fragment.top - pageTop + model.bodyTopInsetPx) * model.pxToPt / model.pageHeightPt * 100;
      const width = (fragment.right - fragment.left) * model.pxToPt / model.pageWidthPt * 100;
      const height = (fragment.bottom - fragment.top) * model.pxToPt / model.pageHeightPt * 100;
      return `<span contenteditable="true" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%;font:${escapeHtml(fragment.fontStyle)} ${escapeHtml(fragment.fontWeight)} ${fragment.fontSizePx * model.pxToPt}px/${height}% ${escapeHtml(fragment.fontFamily)};color:#${colorToHex(fragment.color)}">${escapeHtml(fragment.text)}</span>`;
    }).join("");
    return `<section class="page"><img alt="Page ${pageIndex + 1}" src="${bytesToDataUrl(page)}">${text}</section>`;
  }).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(file.basename)}</title><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#e9edf2;font-family:system-ui,sans-serif}.page{position:relative;width:min(100%,${model.pageWidthPt / 72 * 96}px);aspect-ratio:${model.pageWidthPt}/${model.pageHeightPt};margin:0 auto 24px;background:#fff;box-shadow:0 8px 28px #0002;overflow:hidden}.page img{display:block;width:100%;height:100%}.page span{position:absolute;display:block;overflow:hidden;white-space:pre-wrap;outline:none;opacity:.01}.page span:focus{opacity:1;background:#fff;box-shadow:0 0 0 2px #2f6feb}@media print{body{padding:0;background:#fff}.page{width:100%;margin:0;box-shadow:none;break-after:page}}</style></head><body>${pageMarkup}</body></html>`;
  return new Blob([html], { type: "text/html;charset=utf-8" });
}

function isExcalidrawMarkdownFile(file: TFile, markdown: string): boolean {
  const path = file.path.toLowerCase();
  return (
    path.endsWith(".excalidraw.md") ||
    /(^|\n)excalidraw-plugin:\s*/u.test(markdown) ||
    /(^|\n)# Excalidraw Data\s*$/mu.test(markdown) ||
    /(^|\n)```compressed-json\s*$/mu.test(markdown)
  );
}

function sanitizeExcalidrawMarkdownForPreview(markdown: string): string {
  let clean = markdown.replace(/^==⚠[\s\S]*?under 'Saving'\s*(?:\r?\n|$)/mu, "");

  const dataIndex = clean.search(/^# Excalidraw Data\s*$/mu);
  if (dataIndex >= 0) clean = clean.slice(0, dataIndex);

  const drawingIndex = clean.search(/^%%\s*\r?\n## Drawing\s*$/mu);
  if (drawingIndex >= 0) clean = clean.slice(0, drawingIndex);

  const compressedJsonIndex = clean.search(/^```compressed-json\s*$/mu);
  if (compressedJsonIndex >= 0) clean = clean.slice(0, compressedJsonIndex);

  const withoutFrontmatter = clean.replace(/^---\s*[\s\S]*?\r?\n---\s*/u, "").trim();
  return withoutFrontmatter;
}

function hideExcalidrawSourceBlocks(root: HTMLElement): void {
  const sourceBlocks = Array.from(root.querySelectorAll<HTMLElement>("pre, code"));
  for (const block of sourceBlocks) {
    if (isExcalidrawSourceText(block.textContent ?? "") || block.matches(".language-compressed-json")) {
      markSkipElement(block.closest<HTMLElement>("pre") ?? block);
    }
  }

  const lineBlocks = Array.from(root.querySelectorAll<HTMLElement>("p, li, blockquote, h1, h2, h3, h4, h5, h6"));
  for (const block of lineBlocks) {
    const text = normalizeLineText(block.textContent ?? "");
    if (!text) continue;

    if (/Switch to EXCALIDRAW VIEW/iu.test(text)) {
      markSkipElement(block);
      continue;
    }

    if (/^#?\s*Excalidraw Data$/iu.test(text) || /^##?\s*(Text Elements|Element Links|Embedded Files|Drawing)$/iu.test(text)) {
      markElementAndFollowingSourceSiblings(root, block);
    }
  }
}

function markSkipElement(element: HTMLElement): void {
  element.classList.add("mobile-pdf-exporter-skip");
  element.setAttribute("aria-hidden", "true");
  element.setCssStyles({ display: "none" });
}

function markElementAndFollowingSourceSiblings(root: HTMLElement, element: HTMLElement): void {
  const boundary = element.closest<HTMLElement>(".markdown-embed, .internal-embed, .markdown-preview-view") ?? root;
  let current: HTMLElement = element;
  while (current.parentElement && current.parentElement !== boundary && current.parentElement !== root) {
    current = current.parentElement;
  }

  let sibling: Element | null = current;
  while (sibling instanceof HTMLElement) {
    if (sibling.classList.contains("mobile-pdf-exporter-excalidraw-preview")) break;
    markSkipElement(sibling);
    sibling = sibling.nextElementSibling;
  }
}

function isExcalidrawSourceText(text: string): boolean {
  return (
    /```compressed-json/iu.test(text) ||
    /\bcompressed-json\b/iu.test(text) ||
    /\bN4KAkAR[A-Za-z0-9+/]{12,}/u.test(text) ||
    /# Excalidraw Data\s+## Text Elements/iu.test(text)
  );
}

interface SurfaceCaptureSeenState {
  boxes: Set<string>;
  text: Set<string>;
  images: Set<string>;
  videos: Set<string>;
  canvases: Set<string>;
  links: Set<string>;
  svgs: Set<string>;
  decorations: Set<string>;
  keepBlocks: Set<string>;
}

function getLivePreviewRenderer(app: App, rootEl: HTMLElement): LivePreviewRenderer | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const previewMode = view?.previewMode as unknown as { renderer?: LivePreviewRenderer } | undefined;
  const renderer = previewMode?.renderer;
  if (!renderer?.sections?.length) return null;

  const previewEl = renderer.previewEl;
  if (previewEl && previewEl !== rootEl) return null;
  if (renderer.sizerEl && !rootEl.contains(renderer.sizerEl)) return null;
  return renderer;
}

function getLivePreviewSectionHeight(section: LivePreviewRendererSection): number {
  const height = Number(section.height);
  return Number.isFinite(height) ? Math.max(0, height) : 0;
}

function getLivePreviewSectionLayoutHeight(
  section: LivePreviewRendererSection,
  capture?: CapturedLivePreviewSection
): number {
  const cachedHeight = getLivePreviewSectionHeight(section);
  const measuredHeight = capture && Number.isFinite(capture.measuredHeight)
    ? Math.max(0, capture.measuredHeight)
    : 0;
  return Math.max(cachedHeight, measuredHeight);
}

function getLivePreviewTopSpace(
  renderer: LivePreviewRenderer,
  captures?: Map<number, CapturedLivePreviewSection>
): number {
  const topSpace = Number(renderer.topSpace);
  if (Number.isFinite(topSpace)) return Math.max(0, topSpace);

  let precedingHeight = 0;
  for (let index = 0; index < renderer.sections.length; index += 1) {
    const section = renderer.sections[index];
    const element = section.el;
    if (element?.isConnected) {
      return Math.max(0, element.offsetTop - precedingHeight);
    }
    precedingHeight += getLivePreviewSectionLayoutHeight(section, captures?.get(index));
  }
  return 0;
}

function captureConnectedLivePreviewSections(
  rootEl: HTMLElement,
  scrollEl: HTMLElement,
  renderer: LivePreviewRenderer,
  linkContext: PdfLinkContext,
  captures: Map<number, CapturedLivePreviewSection>
): void {
  const rootRect = rootEl.getBoundingClientRect();

  for (let index = 0; index < renderer.sections.length; index += 1) {
    if (captures.has(index)) continue;
    const section = renderer.sections[index];
    const element = section.el;
    if (
      section.shown === false ||
      section.rendered === false ||
      !element?.isConnected ||
      !rootEl.contains(element)
    ) continue;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0.5) continue;
    const fragments = captureSurfaceFragments(element, linkContext);

    captures.set(index, {
      fragments,
      documentLeft: rect.left - rootRect.left + scrollEl.scrollLeft,
      measuredHeight: Math.max(0, rect.height)
    });
  }
}

function getUncapturedConnectedPreviewSectionElements(
  rootEl: HTMLElement,
  renderer: LivePreviewRenderer,
  captures: Map<number, CapturedLivePreviewSection>
): HTMLElement[] {
  return renderer.sections.flatMap((section, index) => {
    const element = section.el;
    if (
      captures.has(index) ||
      section.shown === false ||
      section.rendered === false ||
      !element?.isConnected ||
      !rootEl.contains(element)
    ) return [];
    return [element];
  });
}

function buildMissingLivePreviewSectionScrollPositions(
  renderer: LivePreviewRenderer,
  captures: Map<number, CapturedLivePreviewSection>,
  maxScrollTop: number,
  viewportHeight: number
): number[] {
  const positions = new Set<number>();
  const maximum = Math.max(0, maxScrollTop);
  let sectionTop = getLivePreviewTopSpace(renderer, captures);

  for (let index = 0; index < renderer.sections.length; index += 1) {
    const section = renderer.sections[index];
    const sectionHeight = getLivePreviewSectionHeight(section);
    if (section.shown !== false && sectionHeight > 0.5 && !captures.has(index)) {
      const target = clampNumber(sectionTop - viewportHeight * 0.18, 0, maximum, 0);
      positions.add(Math.round(target));
    }
    sectionTop += getLivePreviewSectionLayoutHeight(section, captures.get(index));
  }

  return [...positions].sort((left, right) => left - right);
}

function countMissingLivePreviewSections(
  renderer: LivePreviewRenderer,
  captures: Map<number, CapturedLivePreviewSection>
): number {
  return renderer.sections.filter((section, index) => (
    section.shown !== false &&
    getLivePreviewSectionHeight(section) > 0.5 &&
    !captures.has(index)
  )).length;
}

function appendLivePreviewSectionCaptures(
  target: CapturedSurfaceFragments,
  renderer: LivePreviewRenderer,
  captures: Map<number, CapturedLivePreviewSection>,
  seen: SurfaceCaptureSeenState
): void {
  let sectionTop = getLivePreviewTopSpace(renderer, captures);

  for (let index = 0; index < renderer.sections.length; index += 1) {
    const section = renderer.sections[index];
    const capture = captures.get(index);
    if (capture) {
      appendSurfaceCapture(
        target,
        capture.fragments,
        sectionTop,
        capture.documentLeft,
        seen
      );
    }
    sectionTop += getLivePreviewSectionLayoutHeight(section, capture);
  }
}

function captureLivePreviewRootOverlays(
  rootEl: HTMLElement,
  renderer: LivePreviewRenderer,
  linkContext: PdfLinkContext,
  liveCache: LiveSurfaceCaptureCache,
  scrollTop: number,
  scrollLeft: number
): CapturedSurfaceFragments {
  const captured = createEmptySurfaceCapture();
  const seen = createSurfaceCaptureSeenState();
  const rootRect = rootEl.getBoundingClientRect();
  const sizerEl = renderer.sizerEl;

  for (const child of Array.from(rootEl.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child === sizerEl || sizerEl?.contains(child)) continue;

    const rect = child.getBoundingClientRect();
    appendSurfaceCapture(
      captured,
      captureSurfaceFragments(child, linkContext),
      rect.top - rootRect.top + scrollTop,
      rect.left - rootRect.left + scrollLeft,
      seen
    );
  }

  const isOutsideSizer = (element: Element): boolean => !sizerEl?.contains(element);
  const imageFragments = captureImageFragments(rootEl).filter((fragment) => isOutsideSizer(fragment.element));
  const videoFragments = captureVideoFragments(rootEl).filter((fragment) => isOutsideSizer(fragment.element));
  const canvasFragments = captureCanvasFragments(rootEl, liveCache)
    .filter((fragment) => isOutsideSizer(fragment.element));
  const svgFragments = captureSvgFragments(rootEl).filter((fragment) => isOutsideSizer(fragment.element));
  const directMediaCapture = createEmptySurfaceCapture();
  directMediaCapture.imageFragments = imageFragments;
  directMediaCapture.videoFragments = videoFragments;
  directMediaCapture.canvasFragments = canvasFragments;
  directMediaCapture.svgFragments = svgFragments;
  directMediaCapture.keepBlocks = [
    ...imageFragments.map((fragment) => ({ ...fragment, priority: 6 })),
    ...videoFragments.map((fragment) => ({ ...fragment, priority: 6 })),
    ...canvasFragments
      .filter((fragment) => !fragment.element.classList.contains("mobile-pdf-exporter-note-doodle-canvas"))
      .map((fragment) => ({ ...fragment, priority: 4 })),
    ...svgFragments.map((fragment) => ({
      ...fragment,
      priority: isLargeOrExcalidrawSvg(fragment.element) ? 6 : 3
    }))
  ];
  appendSurfaceCapture(captured, directMediaCapture, scrollTop, scrollLeft, seen);
  return captured;
}

function createEmptySurfaceCapture(): CapturedSurfaceFragments {
  return {
    boxFragments: [],
    textFragments: [],
    imageFragments: [],
    videoFragments: [],
    canvasFragments: [],
    linkFragments: [],
    svgFragments: [],
    decorationFragments: [],
    keepBlocks: []
  };
}

function createSurfaceCaptureSeenState(): SurfaceCaptureSeenState {
  return {
    boxes: new Set(),
    text: new Set(),
    images: new Set(),
    videos: new Set(),
    canvases: new Set(),
    links: new Set(),
    svgs: new Set(),
    decorations: new Set(),
    keepBlocks: new Set()
  };
}

interface CachedLiveTextCapture {
  signature: string;
  documentFragments: TextFragment[];
}

interface LiveSurfaceCaptureCache {
  textNodes: WeakMap<Text, CachedLiveTextCapture>;
  canvasBounds: WeakMap<HTMLCanvasElement, CanvasPixelBounds | null>;
}

interface LiveSurfaceCaptureWindow {
  scrollTop: number;
  scrollLeft: number;
  bandTop: number;
  bandBottom: number;
  cache: LiveSurfaceCaptureCache;
}

function createLiveSurfaceCaptureCache(): LiveSurfaceCaptureCache {
  return {
    textNodes: new WeakMap(),
    canvasBounds: new WeakMap()
  };
}

function captureSurfaceFragments(
  rootEl: HTMLElement,
  linkContext: PdfLinkContext,
  liveWindow?: LiveSurfaceCaptureWindow
): CapturedSurfaceFragments {
  return withExportableElementCache(() => {
    const boxFragments = captureBoxFragments(rootEl);
    const textFragments = captureTextFragments(rootEl, linkContext, liveWindow);
    const imageFragments = captureImageFragments(rootEl);
    const videoFragments = captureVideoFragments(rootEl);
    const canvasFragments = captureCanvasFragments(rootEl, liveWindow?.cache);
    const linkFragments = [
      ...captureLinkFragments(rootEl, linkContext),
      ...captureVideoLinkFragments(videoFragments, linkContext)
    ];
    const svgFragments = captureSvgFragments(rootEl);
    const decorationFragments = captureDecorationFragments(rootEl);
    const keepBlocks = captureKeepBlockFragments(
      rootEl,
      textFragments,
      imageFragments,
      videoFragments,
      canvasFragments,
      boxFragments,
      svgFragments,
      decorationFragments
    );
    const capture = {
      boxFragments,
      textFragments,
      imageFragments,
      videoFragments,
      canvasFragments,
      linkFragments,
      svgFragments,
      decorationFragments,
      keepBlocks
    };
    return liveWindow ? filterSurfaceCaptureToBand(capture, liveWindow) : capture;
  });
}

function filterSurfaceCaptureToBand(
  capture: CapturedSurfaceFragments,
  liveWindow: LiveSurfaceCaptureWindow
): CapturedSurfaceFragments {
  const bandHeight = Math.max(1, liveWindow.bandBottom - liveWindow.bandTop);
  const ownsRect = (fragment: { top: number; bottom: number }): boolean => {
    const documentTop = fragment.top + liveWindow.scrollTop;
    const documentBottom = fragment.bottom + liveWindow.scrollTop;
    const center = (documentTop + documentBottom) / 2;
    const tallFragment = documentBottom - documentTop >= bandHeight * 0.9;
    return (
      (center >= liveWindow.bandTop - 0.5 && center < liveWindow.bandBottom - 0.5) ||
      (tallFragment && documentBottom > liveWindow.bandTop && documentTop < liveWindow.bandBottom)
    );
  };

  return {
    boxFragments: capture.boxFragments.filter(ownsRect),
    textFragments: capture.textFragments.filter(ownsRect),
    imageFragments: capture.imageFragments.filter(ownsRect),
    videoFragments: capture.videoFragments.filter(ownsRect),
    canvasFragments: capture.canvasFragments.filter(ownsRect),
    linkFragments: capture.linkFragments.filter(ownsRect),
    svgFragments: capture.svgFragments.filter(ownsRect),
    decorationFragments: capture.decorationFragments.filter(ownsRect),
    keepBlocks: capture.keepBlocks.filter(ownsRect)
  };
}

function appendSurfaceCapture(
  target: CapturedSurfaceFragments,
  snapshot: CapturedSurfaceFragments,
  scrollTop: number,
  scrollLeft: number,
  seen: SurfaceCaptureSeenState
): void {
  const offsetRect = <T extends { left: number; top: number; right: number; bottom: number }>(fragment: T): T => ({
    ...fragment,
    left: fragment.left + scrollLeft,
    right: fragment.right + scrollLeft,
    top: fragment.top + scrollTop,
    bottom: fragment.bottom + scrollTop
  });
  const geometryKey = (fragment: { left: number; top: number; right: number; bottom: number }): string =>
    [fragment.left, fragment.top, fragment.right, fragment.bottom].map((value) => Math.round(value * 10) / 10).join("|");
  const appendUnique = <T>(items: T[], source: T[], keys: Set<string>, keyFor: (item: T) => string): void => {
    for (const item of source) {
      const key = keyFor(item);
      if (keys.has(key)) continue;
      keys.add(key);
      items.push(item);
    }
  };

  const boxes = snapshot.boxFragments.map(offsetRect);
  appendUnique(target.boxFragments, boxes, seen.boxes, (fragment) => [
    geometryKey(fragment),
    fragment.background ?? "",
    fragment.borderTop?.color ?? "",
    fragment.borderRight?.color ?? "",
    fragment.borderBottom?.color ?? "",
    fragment.borderLeft?.color ?? ""
  ].join("|"));

  const text = snapshot.textFragments.map(offsetRect);
  appendUnique(target.textFragments, text, seen.text, (fragment) => [
    geometryKey(fragment),
    fragment.text,
    fragment.fontFamily,
      fragment.fontWeight,
      fragment.fontStyle,
      fragment.headingLevel ?? "",
      fragment.officeDecoration ? "d" : "",
      JSON.stringify(fragment.color)
  ].join("|"));

  const images = snapshot.imageFragments.map(offsetRect);
  appendUnique(target.imageFragments, images, seen.images, (fragment) => [
    geometryKey(fragment),
    fragment.element.currentSrc || fragment.element.src,
    fragment.element.naturalWidth,
    fragment.element.naturalHeight
  ].join("|"));

  const videos = snapshot.videoFragments.map(offsetRect);
  appendUnique(target.videoFragments, videos, seen.videos, (fragment) => [
    geometryKey(fragment),
    fragment.element.currentSrc || fragment.element.src,
    fragment.element.videoWidth,
    fragment.element.videoHeight
  ].join("|"));

  const canvases = snapshot.canvasFragments.map(offsetRect);
  appendUnique(target.canvasFragments, canvases, seen.canvases, (fragment) => [
    geometryKey(fragment),
    fragment.element.className,
    fragment.element.width,
    fragment.element.height,
    fragment.sourceLeftPx,
    fragment.sourceTopPx,
    fragment.sourceRightPx,
    fragment.sourceBottomPx
  ].join("|"));

  const links = snapshot.linkFragments.map(offsetRect);
  appendUnique(target.linkFragments, links, seen.links, (fragment) => `${geometryKey(fragment)}|${fragment.href}`);

  const svgs = snapshot.svgFragments.map(offsetRect);
  appendUnique(target.svgFragments, svgs, seen.svgs, (fragment) => [
    geometryKey(fragment),
    fragment.element.getAttribute("viewBox") ?? "",
    fragment.element.classList.value
  ].join("|"));

  const decorations = snapshot.decorationFragments.map(offsetRect);
  appendUnique(target.decorationFragments, decorations, seen.decorations, (fragment) => [
    geometryKey(fragment),
    fragment.kind,
    fragment.text ?? "",
    fragment.checked ? "1" : "0",
    JSON.stringify(fragment.color)
  ].join("|"));

  const keepBlocks = snapshot.keepBlocks.map(offsetRect);
  appendUnique(target.keepBlocks, keepBlocks, seen.keepBlocks, (fragment) => `${geometryKey(fragment)}|${fragment.priority}`);
}

function dedupeOverlappingLiveTextFragments(fragments: TextFragment[]): TextFragment[] {
  const kept: TextFragment[] = [];
  const byAppearance = new Map<string, TextFragment[]>();

  for (const fragment of fragments) {
    const key = [
      normalizeLineText(fragment.text),
      fragment.fontFamily,
      fragment.fontWeight,
      fragment.fontStyle,
      fragment.headingLevel ?? "",
      fragment.officeDecoration ? "d" : "",
      fragment.href ?? "",
      fragment.underline ? "u" : "",
      fragment.lineThrough ? "s" : "",
      JSON.stringify(fragment.color)
    ].join("|");
    const candidates = byAppearance.get(key) ?? [];
    if (candidates.some((candidate) => areOverlappingDuplicateTextFragments(candidate, fragment))) continue;

    candidates.push(fragment);
    byAppearance.set(key, candidates);
    kept.push(fragment);
  }

  return kept;
}

function areOverlappingDuplicateTextFragments(left: TextFragment, right: TextFragment): boolean {
  const overlapWidth = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const overlapHeight = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const minWidth = Math.max(0.5, Math.min(left.right - left.left, right.right - right.left));
  const minHeight = Math.max(0.5, Math.min(left.bottom - left.top, right.bottom - right.top));
  const horizontalRatio = overlapWidth / minWidth;
  const verticalRatio = overlapHeight / minHeight;
  const nearlyAligned = (
    Math.abs(left.left - right.left) <= 2.5 &&
    Math.abs(left.top - right.top) <= 3.5 &&
    Math.abs(left.right - right.right) <= 5 &&
    Math.abs(left.bottom - right.bottom) <= 4
  );
  return nearlyAligned || (horizontalRatio >= 0.82 && verticalRatio >= 0.72);
}

function transformSurfaceCapture(
  capture: CapturedSurfaceFragments,
  offsetLeftPx: number,
  scale: number
): CapturedSurfaceFragments {
  const transformRect = <T extends { left: number; top: number; right: number; bottom: number }>(fragment: T): T => ({
    ...fragment,
    left: offsetLeftPx + fragment.left * scale,
    right: offsetLeftPx + fragment.right * scale,
    top: fragment.top * scale,
    bottom: fragment.bottom * scale
  });
  const transformBorder = (border: CssBorderFragment | null): CssBorderFragment | null =>
    border ? { ...border, widthPx: Math.max(0.5, border.widthPx * scale) } : null;

  const boxFragments = capture.boxFragments.map((fragment) => ({
    ...transformRect(fragment),
    borderTop: transformBorder(fragment.borderTop),
    borderRight: transformBorder(fragment.borderRight),
    borderBottom: transformBorder(fragment.borderBottom),
    borderLeft: transformBorder(fragment.borderLeft),
    borderRadiusPx: fragment.borderRadiusPx * scale
  }));
  const textFragments = sortTextFragmentsForDrawing(capture.textFragments.map((fragment) => ({
    ...transformRect(fragment),
    fontSizePx: fragment.fontSizePx * scale
  })));
  const imageFragments = capture.imageFragments.map(transformRect);
  const videoFragments = capture.videoFragments.map(transformRect);
  const canvasFragments = capture.canvasFragments.map(transformRect);
  const linkFragments = capture.linkFragments.map(transformRect);
  const svgFragments = capture.svgFragments.map(transformRect);
  const decorationFragments = capture.decorationFragments.map((fragment) => ({
    ...transformRect(fragment),
    fontSizePx: fragment.fontSizePx * scale,
    borderWidthPx: fragment.borderWidthPx === undefined ? undefined : fragment.borderWidthPx * scale,
    borderRadiusPx: fragment.borderRadiusPx === undefined ? undefined : fragment.borderRadiusPx * scale
  }));
  const keepBlocks = capture.keepBlocks.map(transformRect);

  return {
    boxFragments,
    textFragments,
    imageFragments,
    videoFragments,
    canvasFragments,
    linkFragments,
    svgFragments,
    decorationFragments,
    keepBlocks
  };
}

function measureCapturedSurfaceBottom(capture: CapturedSurfaceFragments): number {
  return Math.max(
    0,
    ...capture.boxFragments.map((fragment) => fragment.bottom),
    ...capture.textFragments.map((fragment) => fragment.bottom),
    ...capture.imageFragments.map((fragment) => fragment.bottom),
    ...capture.videoFragments.map((fragment) => fragment.bottom),
    ...capture.canvasFragments.map((fragment) => fragment.bottom),
    ...capture.svgFragments.map((fragment) => fragment.bottom),
    ...capture.decorationFragments.map((fragment) => fragment.bottom),
    ...capture.keepBlocks.map((fragment) => fragment.bottom)
  );
}

function measureVisibleCapturedSurfaceBottom(capture: CapturedSurfaceFragments): number {
  return Math.max(
    0,
    ...capture.textFragments.map((fragment) => fragment.bottom),
    ...capture.imageFragments.map((fragment) => fragment.bottom),
    ...capture.videoFragments.map((fragment) => fragment.bottom),
    ...capture.canvasFragments.map((fragment) => fragment.bottom),
    ...capture.svgFragments.map((fragment) => fragment.bottom),
    ...capture.decorationFragments.map((fragment) => fragment.bottom)
  );
}

function buildLiveSurfaceCaptureScrollPositions(maxScrollTop: number, viewportHeight: number): number[] {
  const maximum = Math.max(0, Math.round(maxScrollTop));
  if (maximum <= 0) return [0];

  const positions = new Set<number>([0, maximum]);
  const step = Math.max(120, viewportHeight * 0.72);
  for (let index = 1; ; index += 1) {
    const next = Math.min(maximum, Math.round(index * step));
    positions.add(next);
    if (next >= maximum) break;
  }

  return [...positions].sort((a, b) => a - b);
}

async function primeLivePreviewLayout(
  rootEl: HTMLElement,
  scrollEl: HTMLElement,
  renderer: LivePreviewRenderer,
  signal?: AbortSignal
): Promise<void> {
  const viewportHeight = Math.max(160, scrollEl.clientHeight || rootEl.getBoundingClientRect().height || 640);
  let previousHeight = 0;

  const sectionElements = renderer.sections.flatMap((section) => {
    try {
      section.render?.();
    } catch (error) {
      console.warn("Mobile PDF Exporter could not render a reading-view section", error);
    }
    return section.el ? [section.el] : [];
  });
  if (renderer.sizerEl && sectionElements.length > 0) {
    renderer.sizerEl.append(...sectionElements);
    await nextAnimationFrame();
    await waitForImagesInElements(sectionElements, IMAGE_WAIT_TIMEOUT_MS);
    for (const section of renderer.sections) {
      try {
        renderer.measureSection?.(section);
      } catch (error) {
        console.warn("Mobile PDF Exporter could not measure a reading-view section", error);
      }
    }
    await nextAnimationFrame();
  }

  for (let pass = 0; pass < 3; pass += 1) {
    const positions = buildLiveSurfaceCaptureScrollPositions(
      Math.max(0, scrollEl.scrollHeight - viewportHeight),
      viewportHeight
    );
    for (const position of positions) {
      await settleLiveSurfaceAtScrollPosition(rootEl, scrollEl, position, signal, renderer);
      const connectedSections = getUncapturedConnectedPreviewSectionElements(rootEl, renderer, new Map());
      if (await waitForImagesInElements(connectedSections, 900)) {
        await settleLiveSurfaceAtScrollPosition(rootEl, scrollEl, position, signal, renderer);
      }
    }

    const currentHeight = Math.max(scrollEl.scrollHeight, rootEl.scrollHeight);
    const hasUnmeasuredSection = renderer.sections.some((section) => (
      section.shown !== false && getLivePreviewSectionHeight(section) <= 0.5
    ));
    if (!hasUnmeasuredSection && Math.abs(currentHeight - previousHeight) <= 1) break;
    previousHeight = currentHeight;
  }

  await settleLiveSurfaceAtScrollPosition(rootEl, scrollEl, 0, signal, renderer);
}

function buildLivePreviewGapScrollPositions(
  capture: CapturedSurfaceFragments,
  contentHeight: number,
  viewportHeight: number
): number[] {
  const visibleRanges = [
    ...capture.textFragments,
    ...capture.imageFragments,
    ...capture.canvasFragments,
    ...capture.svgFragments,
    ...capture.decorationFragments
  ]
    .filter((fragment) => fragment.bottom > fragment.top + 0.5)
    .map((fragment) => ({ top: Math.max(0, fragment.top), bottom: Math.max(0, fragment.bottom) }))
    .sort((left, right) => left.top - right.top || left.bottom - right.bottom);
  if (!visibleRanges.length) return buildLiveSurfaceCaptureScrollPositions(
    Math.max(0, contentHeight - viewportHeight),
    viewportHeight
  );

  const gapThreshold = Math.max(160, viewportHeight * 0.42);
  const maximum = Math.max(0, contentHeight - viewportHeight);
  const positions = new Set<number>();
  let coveredBottom = 0;

  const addGap = (gapTop: number, gapBottom: number): void => {
    if (gapBottom - gapTop < gapThreshold) return;
    const centeredTop = (gapTop + gapBottom - viewportHeight) / 2;
    positions.add(Math.round(clampNumber(centeredTop, 0, maximum, 0)));
  };

  for (const range of visibleRanges) {
    if (range.top > coveredBottom) addGap(coveredBottom, range.top);
    coveredBottom = Math.max(coveredBottom, range.bottom);
  }
  if (contentHeight > coveredBottom) addGap(coveredBottom, contentHeight);

  return [...positions].sort((left, right) => left - right);
}

async function settleLiveSurfaceAtScrollPosition(
  rootEl: HTMLElement,
  scrollEl: HTMLElement,
  requestedTop: number,
  signal?: AbortSignal,
  previewRenderer?: LivePreviewRenderer | null
): Promise<void> {
  throwIfExportCancelled(signal);
  const maximum = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  let expectedTop = clampNumber(requestedTop, 0, maximum, 0);
  scrollEl.scrollTop = expectedTop;
  scrollEl.dispatchEvent(new Event("scroll"));
  if (previewRenderer) {
    await waitForLivePreviewRendererSettled(scrollEl, previewRenderer, signal);
  } else {
    await waitForLiveSurfaceSettled(rootEl, scrollEl, signal);
  }
  if (Math.abs(scrollEl.scrollTop - expectedTop) <= 1.5) return;

  await waitForPromiseOrTimeout(new Promise<void>((resolve) => activeWindow.setTimeout(resolve, 40)), 80);
  throwIfExportCancelled(signal);
  expectedTop = clampNumber(requestedTop, 0, Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight), 0);
  scrollEl.scrollTop = expectedTop;
  scrollEl.dispatchEvent(new Event("scroll"));
  await nextAnimationFrame(Math.min(180, FRAME_WAIT_TIMEOUT_MS));
}

async function waitForLivePreviewRendererSettled(
  scrollEl: HTMLElement,
  renderer: LivePreviewRenderer,
  signal?: AbortSignal
): Promise<void> {
  let previousSignature = "";
  let stableFrames = 0;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    throwIfExportCancelled(signal);
    await nextAnimationFrame();
    const sectionSignature = renderer.sections.map((section, index) => [
      index,
      section.el?.isConnected ? 1 : 0,
      Math.round(getLivePreviewSectionHeight(section)),
      section.rendered === false ? 0 : 1
    ].join(":")).join(";");
    const signature = [
      Math.round(scrollEl.scrollTop * 10) / 10,
      Math.round(scrollEl.scrollHeight),
      sectionSignature
    ].join("|");
    if (signature === previousSignature) {
      stableFrames += 1;
      if (stableFrames >= 2) return;
    } else {
      previousSignature = signature;
      stableFrames = 0;
    }
  }
}

async function waitForLiveSurfaceSettled(
  rootEl: HTMLElement,
  scrollEl: HTMLElement,
  signal?: AbortSignal
): Promise<void> {
  let previousSignature = "";
  let stableFrames = 0;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    throwIfExportCancelled(signal);
    await nextAnimationFrame();
    const content = rootEl.querySelector<HTMLElement>(".cm-content, .markdown-preview-sizer, .markdown-preview-section");
    const rootRect = rootEl.getBoundingClientRect();
    const imageSignature = Array.from(rootEl.querySelectorAll("img")).map((image) => {
      const rect = image.getBoundingClientRect();
      return [
        image.complete ? 1 : 0,
        image.naturalWidth,
        image.naturalHeight,
        Math.round(rect.left - rootRect.left),
        Math.round(rect.top - rootRect.top + scrollEl.scrollTop),
        Math.round(rect.width),
        Math.round(rect.height)
      ].join(":");
    }).join(";");
    const signature = [
      Math.round(scrollEl.scrollTop * 10) / 10,
      Math.round(scrollEl.scrollHeight),
      content?.childElementCount ?? rootEl.childElementCount,
      rootEl.querySelectorAll(".cm-line, .markdown-preview-section").length,
      imageSignature
    ].join("|");
    if (signature === previousSignature) {
      stableFrames += 1;
      if (stableFrames >= 2) return;
    } else {
      previousSignature = signature;
      stableFrames = 0;
    }
  }
}

function refreshLiveDrawingSurface(rootEl: HTMLElement): void {
  for (const surface of Array.from(rootEl.matches(".note-doodle-shell, .notedraw-shell")
    ? [rootEl]
    : rootEl.querySelectorAll<HTMLElement>(".note-doodle-shell, .notedraw-shell"))) {
    const kind = surface.classList.contains("notedraw-shell") ? "notedraw" : "note-doodle";
    try {
      getLiveDrawingController(surface, kind)?.render?.();
    } catch (error) {
      console.warn("Mobile PDF Exporter live surface refresh failed", error);
    }
  }
}

function getVisibleElementScore(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const ownerWindow = element.ownerDocument.defaultView ?? activeWindow;
  const visibleWidth = Math.max(0, Math.min(rect.right, ownerWindow.innerWidth) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, ownerWindow.innerHeight) - Math.max(rect.top, 0));
  return visibleWidth * visibleHeight + Math.min(element.scrollHeight, 1_000_000);
}

function findOpaqueBackgroundColor(element: HTMLElement): Color | null {
  let current: HTMLElement | null = element;
  while (current) {
    const value = normalizeVisibleCssColor(getComputedStyle(current).backgroundColor);
    const color = value ? parseCssColor(value) : null;
    if (color) return color;
    current = current.parentElement;
  }
  return null;
}

function captureTextFragments(
  pageEl: HTMLElement,
  linkContext?: PdfLinkContext,
  liveWindow?: LiveSurfaceCaptureWindow
): TextFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const fragments: TextFragment[] = [];
  const walker = pageEl.ownerDocument.createTreeWalker(pageEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (!isExportableElement(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    if (parent) {
      if (!liveWindow) {
        fragments.push(...measureTextNode(textNode, parent, pageRect, linkContext));
      } else {
        const parentRect = parent.getBoundingClientRect();
        const signature = [
          textNode.nodeValue ?? "",
          Math.round((parentRect.left + liveWindow.scrollLeft) * 10) / 10,
          Math.round((parentRect.top + liveWindow.scrollTop) * 10) / 10,
          Math.round(parentRect.width * 10) / 10,
          Math.round(parentRect.height * 10) / 10,
          parent.className
        ].join("|");
        let cached = liveWindow.cache.textNodes.get(textNode);
        if (!cached || cached.signature !== signature) {
          const documentFragments = measureTextNode(textNode, parent, pageRect, linkContext).map((fragment) => ({
            ...fragment,
            left: fragment.left + liveWindow.scrollLeft,
            right: fragment.right + liveWindow.scrollLeft,
            top: fragment.top + liveWindow.scrollTop,
            bottom: fragment.bottom + liveWindow.scrollTop
          }));
          cached = { signature, documentFragments };
          liveWindow.cache.textNodes.set(textNode, cached);
        }

        for (const fragment of cached.documentFragments) {
          const center = (fragment.top + fragment.bottom) / 2;
          if (center < liveWindow.bandTop - 0.5 || center >= liveWindow.bandBottom - 0.5) continue;
          fragments.push({
            ...fragment,
            left: fragment.left - liveWindow.scrollLeft,
            right: fragment.right - liveWindow.scrollLeft,
            top: fragment.top - liveWindow.scrollTop,
            bottom: fragment.bottom - liveWindow.scrollTop
          });
        }
      }
    }
    node = walker.nextNode();
  }

  return sortTextFragmentsForDrawing(fragments);
}

function captureImageFragments(pageEl: HTMLElement): ImageFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  return Array.from(pageEl.querySelectorAll("img"))
    .filter((image) => isExportableElement(image) && image.naturalWidth > 0 && image.naturalHeight > 0)
    .map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        element: image,
        sourcePath: getImageFragmentSourcePath(image),
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top
      };
    })
    .filter((fragment) => fragment.right > fragment.left && fragment.bottom > fragment.top);
}

function getImageFragmentSourcePath(image: HTMLImageElement): string | null {
  const wrapper = image.closest(".internal-embed.image-embed, .image-embed, .media-embed");
  return wrapper?.getAttribute("src")?.trim() || null;
}

async function prepareNoteDrawElementData(
  app: App,
  ownerDocument: Document,
  data: unknown
): Promise<NoteDrawElementData[]> {
  const candidate = data && typeof data === "object" ? data as { strokes?: unknown } : null;
  const rawStrokes = Array.isArray(candidate?.strokes) ? candidate.strokes : [];
  const elements = rawStrokes
    .map(normalizeNoteDrawElement)
    .filter((element): element is NoteDrawElementData => Boolean(element));

  for (const element of elements) {
    if (element.kind === "image") {
      element.media = await loadNoteDrawImageMedia(app, element);
    } else if (element.kind === "video") {
      element.media = await loadNoteDrawVideoFrame(app, ownerDocument, element);
    }
  }
  return elements;
}

function measureNoteDrawTargetContentFrame(host: HTMLElement, surfaceWidth: number): NoteDrawContentFrame {
  const content = host.querySelector<HTMLElement>(".cm-content") ??
    host.querySelector<HTMLElement>(":scope > .markdown-preview-sizer") ??
    host.querySelector<HTMLElement>(".markdown-preview-sizer") ??
    host.querySelector<HTMLElement>(".cm-sizer") ??
    host;
  const hostRect = host.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const visualScale = host.clientWidth > 1 && hostRect.width > 1
    ? clampNumber(hostRect.width / host.clientWidth, 0.1, 10, 1)
    : 1;
  const measuredLeft = (contentRect.left - hostRect.left + host.scrollLeft * visualScale) / visualScale;
  const left = clampNumber(measuredLeft, -surfaceWidth, surfaceWidth * 2, 0);
  const availableWidth = Math.max(1, surfaceWidth - Math.max(0, left));
  let width = clampNumber(contentRect.width / visualScale, 1, surfaceWidth * 2, availableWidth);
  const isMobile = Boolean(host.ownerDocument.body?.matches(".is-mobile, .mod-mobile"));
  if (!isMobile && surfaceWidth >= 900 && width / surfaceWidth >= 0.78) {
    const laneLimit = clampNumber(surfaceWidth * 0.72, 720, 860, 720);
    width = Math.min(width, laneLimit, availableWidth);
  }
  return { left, width };
}

function normalizeNoteDrawElement(value: unknown): NoteDrawElementData | null {
  const stroke = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!stroke) return null;
  const embedType = typeof stroke.embedType === "string" ? stroke.embedType.toLowerCase() : "";
  const kind = stroke.kind === "text"
    ? "text"
    : stroke.kind === "embed"
      ? embedType === "image"
        ? "image"
        : embedType === "video"
          ? "video"
          : "file"
      : stroke.connector && typeof stroke.connector === "object"
        ? "connector"
        : null;
  if (!kind) return null;

  const points = Array.isArray(stroke.points)
    ? stroke.points.flatMap((point) => {
      if (!point || typeof point !== "object") return [];
      const rawPoint = point as Record<string, unknown>;
      const x = Number(rawPoint.x);
      const y = Number(rawPoint.y);
      return Number.isFinite(x) && Number.isFinite(y)
        ? [{ x: clampNumber(x, 0, 1, 0), y: clampNumber(y, 0, 1, 0) }]
        : [];
    })
    : [];
  if (points.length === 0) return null;

  const layout = stroke.layout && typeof stroke.layout === "object"
    ? stroke.layout as Record<string, unknown>
    : null;
  const rawBox = layout?.box && typeof layout.box === "object"
    ? layout.box as Record<string, unknown>
    : null;
  const rawFrame = layout?.sourceFrame && typeof layout.sourceFrame === "object"
    ? layout.sourceFrame as Record<string, unknown>
    : null;
  const layoutBox = rawBox && [rawBox.x, rawBox.y, rawBox.width, rawBox.height].every((item) => Number.isFinite(Number(item)))
    ? {
      x: Number(rawBox.x),
      y: Number(rawBox.y),
      width: Math.max(1, Number(rawBox.width)),
      height: Math.max(1, Number(rawBox.height))
    }
    : null;
  const frameWidth = Number(rawFrame?.surfaceWidth);
  const frameContentLeft = Number(rawFrame?.contentLeft);
  const frameContentWidth = Number(rawFrame?.contentWidth);
  const frameHeight = Number(rawFrame?.documentHeight);
  const layoutFrame = frameWidth >= 24 && frameHeight >= 24 && (
    !layoutBox || (layoutBox.width <= frameWidth * 4 && layoutBox.height <= frameHeight * 4)
  )
    ? {
      surfaceWidth: frameWidth,
      contentLeft: Number.isFinite(frameContentLeft) ? frameContentLeft : 0,
      contentWidth: frameContentWidth >= 1 ? frameContentWidth : frameWidth,
      documentHeight: frameHeight
    }
    : null;

  return {
    kind,
    text: typeof stroke.text === "string" ? stroke.text : "",
    color: typeof stroke.color === "string" ? stroke.color : "#e53935",
    opacity: clampNumber(Number(stroke.opacity ?? 1), 0, 1, 1),
    width: clampNumber(Number(stroke.width ?? 2), 0.5, 48, 2),
    fontSize: clampNumber(Number(stroke.fontSize ?? 18), 8, 96, 18),
    bold: Boolean(stroke.bold),
    code: Boolean(stroke.code),
    boxed: Boolean(stroke.boxed),
    buttonStyle: typeof stroke.buttonStyle === "string" ? stroke.buttonStyle : "",
    render: typeof stroke.render === "string" ? stroke.render : "plain",
    assetPath: typeof stroke.assetPath === "string" ? stroke.assetPath : "",
    assetName: typeof stroke.assetName === "string" ? stroke.assetName : "",
    assetMime: typeof stroke.assetMime === "string" ? stroke.assetMime : "",
    assetSize: Math.max(0, Number(stroke.assetSize) || 0),
    previewWidth: clampNumber(Number(stroke.previewWidth ?? 260), 24, 2000, 260),
    previewHeight: clampNumber(Number(stroke.previewHeight ?? 160), 20, 2000, 160),
    textWidth: Number(stroke.textWidth) > 0 ? Number(stroke.textWidth) : null,
    points,
    layoutBox,
    layoutFrame,
    media: null
  };
}

async function loadNoteDrawImageMedia(
  app: App,
  element: NoteDrawElementData
): Promise<HTMLImageElement | null> {
  const source = await getNoteDrawAssetResourcePath(app, element.assetPath);
  if (!source) return null;
  try {
    return await loadImage(source, 2400);
  } catch (error) {
    console.warn("Mobile PDF Exporter could not load a NoteDraw image element", error);
    return null;
  }
}

async function injectRenderedHtmlNoteDrawAssets(
  app: App,
  sourcePath: string,
  noteDrawHost: HTMLElement,
  prepared: PreparedNoteDrawExportOverlay,
  sourceElements: HTMLElement[],
  clonedElements: HTMLElement[],
  signal?: AbortSignal
): Promise<void> {
  const hostIndex = sourceElements.indexOf(noteDrawHost);
  const targetHost = hostIndex >= 0 ? clonedElements[hostIndex] : null;
  if (!targetHost) return;
  if (!targetHost.style.position || targetHost.style.position === "static") {
    targetHost.setCssStyles({ position: "relative" });
  }
  const projectedElements = projectNoteDrawElements(
    prepared.sourceElements,
    prepared.widthPx,
    prepared.heightPx,
    prepared.contentFrame,
    0,
    0,
    1
  );
  for (const element of projectedElements) {
    if ((element.kind !== "video" && element.kind !== "file") || !element.assetPath) continue;
    throwIfExportCancelled(signal);
    const asset = await readVaultEmbeddedAsset(app, sourcePath, element.assetPath, element.assetMime || undefined);
    if (!asset) continue;
    const commonStyles = {
      position: "absolute",
      left: `${element.left}px`,
      top: `${element.top}px`,
      width: `${Math.max(1, element.right - element.left)}px`,
      height: `${Math.max(1, element.bottom - element.top)}px`,
      zIndex: "61"
    };
    if (element.kind === "video") {
      const video = (targetHost.ownerDocument.win as ObsidianExportWindow).createEl("video");
      video.className = "mpe-notedraw-embedded-video";
      video.src = bytesToDataUrl(asset.bytes, asset.mimeType);
      video.controls = true;
      video.playsInline = true;
      video.preload = "metadata";
      const poster = noteDrawMediaToPngDataUrl(element.media);
      if (poster) video.poster = poster;
      video.setCssStyles({ ...commonStyles, objectFit: "contain" });
      targetHost.appendChild(video);
      continue;
    }
    const anchor = (targetHost.ownerDocument.win as ObsidianExportWindow).createEl("a");
    anchor.className = "mpe-notedraw-embedded-file";
    anchor.href = bytesToDataUrl(asset.bytes, asset.mimeType);
    anchor.download = asset.name;
    anchor.setAttribute("aria-label", asset.name);
    anchor.title = asset.name;
    anchor.setCssStyles({ ...commonStyles, display: "block", color: "transparent", background: "transparent" });
    targetHost.appendChild(anchor);
  }
}

async function loadNoteDrawVideoFrame(
  app: App,
  ownerDocument: Document,
  element: NoteDrawElementData
): Promise<HTMLCanvasElement | null> {
  const source = await getNoteDrawAssetResourcePath(app, element.assetPath);
  if (!source) return null;
  const video = (ownerDocument.win as ObsidianExportWindow).createEl("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = source;
  try {
    await waitForVideoFrame(video, 2600);
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
    const canvas = createCanvas(ownerDocument);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch (error) {
    console.warn("Mobile PDF Exporter could not capture a NoteDraw video frame", error);
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

async function getNoteDrawAssetResourcePath(app: App, assetPath: string): Promise<string | null> {
  const path = normalizePath(assetPath.trim());
  if (!path || !(await app.vault.adapter.exists(path))) return null;
  return app.vault.adapter.getResourcePath(path);
}

function projectNoteDrawElements(
  elements: NoteDrawElementData[],
  widthPx: number,
  heightPx: number,
  contentFrame: NoteDrawContentFrame,
  offsetX: number,
  offsetY: number,
  scale: number
): PdfNoteDrawElement[] {
  return elements.flatMap((element) => {
    const sourceFrame = element.layoutFrame;
    const targetContentLeft = clampNumber(contentFrame.left, -widthPx, widthPx * 2, 0);
    const targetContentWidth = clampNumber(contentFrame.width, 1, widthPx * 2, widthPx);
    const frameScaleX = sourceFrame ? targetContentWidth / sourceFrame.contentWidth : 1;
    const frameScaleY = sourceFrame ? heightPx / sourceFrame.documentHeight : 1;
    const projectPointX = (normalizedX: number): number => sourceFrame
      ? targetContentLeft + (normalizedX * sourceFrame.surfaceWidth - sourceFrame.contentLeft) * frameScaleX
      : normalizedX * widthPx;
    const first = element.points[0];
    const rawLeft = element.layoutBox
      ? sourceFrame
        ? targetContentLeft + (element.layoutBox.x - sourceFrame.contentLeft) * frameScaleX
        : element.layoutBox.x
      : projectPointX(first.x);
    const rawTop = element.layoutBox ? element.layoutBox.y * frameScaleY : first.y * heightPx;
    const fallbackWidth = element.kind === "text"
      ? element.textWidth ?? Math.max(28, element.text.length * element.fontSize * 0.62)
      : element.previewWidth;
    const fallbackHeight = element.kind === "text"
      ? Math.max(element.fontSize * 1.35, element.previewHeight && element.render !== "plain" ? element.previewHeight : 0)
      : element.previewHeight;
    const rawWidth = element.layoutBox ? element.layoutBox.width * frameScaleX : fallbackWidth * frameScaleX;
    const rawHeight = element.layoutBox ? element.layoutBox.height * frameScaleY : fallbackHeight * frameScaleY;
    const projectedPoints = element.points.map((point) => ({
      x: offsetX + projectPointX(point.x) * scale,
      y: offsetY + point.y * heightPx * scale
    }));
    const pointBounds = element.kind === "connector"
      ? {
        left: Math.min(...projectedPoints.map((point) => point.x)),
        top: Math.min(...projectedPoints.map((point) => point.y)),
        right: Math.max(...projectedPoints.map((point) => point.x)),
        bottom: Math.max(...projectedPoints.map((point) => point.y))
      }
      : null;
    const left = pointBounds?.left ?? offsetX + rawLeft * scale;
    const top = pointBounds?.top ?? offsetY + rawTop * scale;
    const right = pointBounds?.right ?? left + Math.max(1, rawWidth * scale);
    const bottom = pointBounds?.bottom ?? top + Math.max(1, rawHeight * scale);
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return [];
    return [{
      ...element,
      width: element.width * scale,
      fontSize: element.fontSize * scale,
      previewWidth: element.previewWidth * scale,
      previewHeight: element.previewHeight * scale,
      textWidth: element.textWidth === null ? null : element.textWidth * scale,
      points: projectedPoints,
      left,
      top,
      right,
      bottom
    }];
  });
}

function attachPreparedNoteDrawToModel(
  model: PreviewPdfModel,
  prepared: PreparedNoteDrawExportOverlay,
  options: {
    offsetX: number;
    offsetY: number;
    scale: number;
    linkContext: PdfLinkContext;
  }
): void {
  const ink = projectNoteDrawInkStrokes(
    prepared.data,
    prepared.widthPx,
    prepared.heightPx,
    prepared.contentFrame,
    options.offsetX,
    options.offsetY,
    options.scale
  );
  const elements = projectNoteDrawElements(
    prepared.elements,
    prepared.widthPx,
    prepared.heightPx,
    prepared.contentFrame,
    options.offsetX,
    options.offsetY,
    options.scale
  );
  const sourceElements = prepared.sourceElements === prepared.elements
    ? elements
    : projectNoteDrawElements(
      prepared.sourceElements,
      prepared.widthPx,
      prepared.heightPx,
      prepared.contentFrame,
      options.offsetX,
      options.offsetY,
      options.scale
    );
  model.noteDrawInkStrokes = ink;
  model.noteDrawElements = elements;
  model.noteDrawSourceElements = sourceElements;

  for (const element of elements) {
    if (!element.assetPath || element.kind === "text" || element.kind === "connector") continue;
    const href = resolveInternalPdfHref(element.assetPath, options.linkContext);
    if (href) {
      model.linkFragments.push({
        href,
        left: element.left,
        top: element.top,
        right: element.right,
        bottom: element.bottom
      });
    }
    model.keepBlocks.push({ ...element, priority: 6 });
  }

  // Filter out text fragments that overlap with NoteDraw elements to prevent ghosting.
  // NoteDraw text elements are rendered both as DOM text (captured as text fragments)
  // and as NoteDraw elements (drawn via drawCanvasNoteDrawElementLayer). Without filtering,
  // the text appears twice — once in the text layer and once in the NoteDraw element layer.
  if (elements.length > 0) {
    model.textFragments = model.textFragments.filter((fragment) =>
      !elements.some((element) =>
        fragment.left < element.right + 2 &&
        fragment.right > element.left - 2 &&
        fragment.top < element.bottom + 2 &&
        fragment.bottom > element.top - 2
      )
    );
  }

  const inkBottom = Math.max(0, ...ink.flatMap((stroke) => stroke.points.map((point) => point.y + stroke.widthPx)));
  const elementBottom = Math.max(0, ...elements.map((element) => element.bottom));
  const contentHeight = Math.ceil(Math.max(model.contentHeightPx, inkBottom, elementBottom));
  if (contentHeight !== model.contentHeightPx) {
    model.contentHeightPx = contentHeight;
    model.pageBreaks = computePageBreaks(contentHeight, model.bodyHeightPx, model.keepBlocks);
  }
  model.pageBreaks = removeEmptyTrailingPageBreaks(model);
}

function hasExplicitNoteDrawContent(model: PreviewPdfModel): boolean {
  return Boolean(model.noteDrawInkStrokes?.length || model.noteDrawElements?.length);
}

function captureVideoFragments(pageEl: HTMLElement): VideoFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  return Array.from(pageEl.querySelectorAll("video"))
    .filter((video) => isExportableElement(video))
    .map((video) => {
      const rect = video.getBoundingClientRect();
      const wrapper = video.closest(".internal-embed, .media-embed");
      return {
        element: video,
        sourcePath: wrapper?.getAttribute("src")?.trim() || video.getAttribute("src")?.trim() || null,
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top
      };
    })
    .filter((fragment) => fragment.right > fragment.left && fragment.bottom > fragment.top);
}

interface CanvasPixelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function captureCanvasFragments(
  pageEl: HTMLElement,
  liveCache?: LiveSurfaceCaptureCache
): CanvasFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  return Array.from(pageEl.querySelectorAll("canvas"))
    .filter((canvas) => isExportableElement(canvas) && canvas.width > 0 && canvas.height > 0)
    .map((canvas) => {
      const rect = canvas.getBoundingClientRect();
      let pixelBounds = liveCache?.canvasBounds.get(canvas);
      if (pixelBounds === undefined) {
        pixelBounds = getCanvasVisiblePixelBounds(canvas);
        liveCache?.canvasBounds.set(canvas, pixelBounds);
      }
      if (!pixelBounds) return null;

      const scaleX = rect.width / Math.max(1, canvas.width);
      const scaleY = rect.height / Math.max(1, canvas.height);
      return {
        element: canvas,
        sourceLeftPx: pixelBounds.left,
        sourceTopPx: pixelBounds.top,
        sourceRightPx: pixelBounds.right,
        sourceBottomPx: pixelBounds.bottom,
        left: rect.left - pageRect.left + pixelBounds.left * scaleX,
        top: rect.top - pageRect.top + pixelBounds.top * scaleY,
        right: rect.left - pageRect.left + pixelBounds.right * scaleX,
        bottom: rect.top - pageRect.top + pixelBounds.bottom * scaleY
      };
    })
    .filter((fragment): fragment is CanvasFragment => Boolean(
      fragment && fragment.right > fragment.left && fragment.bottom > fragment.top
    ));
}

function getCanvasVisiblePixelBounds(canvas: HTMLCanvasElement): CanvasPixelBounds | null {
  const fullBounds = { left: 0, top: 0, right: canvas.width, bottom: canvas.height };
  const drawingSurface = canvas.closest<HTMLElement>(".notedraw-shell, .note-doodle-shell");
  if (drawingSurface) {
    const kind = drawingSurface.classList.contains("notedraw-shell") ? "notedraw" : "note-doodle";
    const controller = getLiveDrawingController(drawingSurface, kind);
    const drawingData = kind === "notedraw" ? controller?.drawingData : controller?.doodleData;
    const strokes = (drawingData as { strokes?: unknown[] } | null | undefined)?.strokes;
    if (Array.isArray(strokes) && strokes.length === 0) return null;
  }

  const pixelCount = canvas.width * canvas.height;

  try {
    const inspectionScale = pixelCount > 2_000_000
      ? Math.min(1, Math.sqrt(1_000_000 / pixelCount))
      : 1;
    const inspectionCanvas = inspectionScale < 1
      ? createCanvas(canvas.ownerDocument)
      : canvas;
    if (inspectionScale < 1) {
      inspectionCanvas.width = Math.max(1, Math.ceil(canvas.width * inspectionScale));
      inspectionCanvas.height = Math.max(1, Math.ceil(canvas.height * inspectionScale));
      const previewContext = inspectionCanvas.getContext("2d", { willReadFrequently: true });
      if (!previewContext) return fullBounds;
      previewContext.drawImage(canvas, 0, 0, inspectionCanvas.width, inspectionCanvas.height);
    }
    const context = inspectionCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) return fullBounds;
    const pixels = context.getImageData(0, 0, inspectionCanvas.width, inspectionCanvas.height).data;
    let minX = inspectionCanvas.width;
    let minY = inspectionCanvas.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < inspectionCanvas.height; y += 1) {
      for (let x = 0; x < inspectionCanvas.width; x += 1) {
        if (pixels[(y * inspectionCanvas.width + x) * 4 + 3] <= 1) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    if (maxX < minX || maxY < minY) return null;
    const inverseScale = 1 / inspectionScale;
    const padding = Math.max(2, Math.ceil(inverseScale * 2));
    return {
      left: Math.max(0, Math.floor(minX * inverseScale) - padding),
      top: Math.max(0, Math.floor(minY * inverseScale) - padding),
      right: Math.min(canvas.width, Math.ceil((maxX + 1) * inverseScale) + padding),
      bottom: Math.min(canvas.height, Math.ceil((maxY + 1) * inverseScale) + padding)
    };
  } catch {
    return fullBounds;
  }
}

function captureLinkFragments(pageEl: HTMLElement, linkContext?: PdfLinkContext): LinkFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const fragments: LinkFragment[] = [];
  const seen = new Set<string>();
  const selectors = [
    "a[href]",
    "a[data-href]",
    ".external-link",
    ".internal-link"
  ].join(",");

  for (const element of Array.from(pageEl.querySelectorAll<HTMLElement>(selectors))) {
    if (!isExportableElement(element)) continue;
    const href = resolveLinkHref(element, linkContext);
    if (!href || !isPdfJumpHref(href)) continue;

    for (const rect of Array.from(element.getClientRects())) {
      if (rect.width <= 0.5 || rect.height <= 0.5) continue;
      const fragment = {
        href,
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top
      };
      if (fragment.right <= fragment.left || fragment.bottom <= fragment.top) continue;

      const key = [
        href,
        Math.round(fragment.left),
        Math.round(fragment.top),
        Math.round(fragment.right),
        Math.round(fragment.bottom)
      ].join("|");
      if (seen.has(key)) continue;

      seen.add(key);
      fragments.push(fragment);
    }
  }

  return fragments;
}

function captureBoxFragments(pageEl: HTMLElement): BoxFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const fragments: BoxFragment[] = [];

  for (const element of Array.from(pageEl.querySelectorAll<HTMLElement>("*"))) {
    if (!isExportableElement(element)) continue;
    if (element.matches("input[type='checkbox']")) continue;

    const style = getComputedStyle(element);
    const background = normalizeVisibleCssColor(style.backgroundColor);
    const borderTop = captureCssBorder(style.borderTopColor, style.borderTopWidth, style.borderTopStyle);
    const borderRight = captureCssBorder(style.borderRightColor, style.borderRightWidth, style.borderRightStyle);
    const borderBottom = captureCssBorder(style.borderBottomColor, style.borderBottomWidth, style.borderBottomStyle);
    const borderLeft = captureCssBorder(style.borderLeftColor, style.borderLeftWidth, style.borderLeftStyle);
    if (!background && !borderTop && !borderRight && !borderBottom && !borderLeft) continue;

    const borderRadiusPx = clampNumber(parseFloat(style.borderRadius), 0, 64, 0);
    const keepTogether = element.matches(
      "pre, blockquote, table, .callout, .markdown-embed, .internal-embed, .HyperMD-codeblock"
    );

    for (const rect of Array.from(element.getClientRects())) {
      if (rect.width <= 0.5 || rect.height <= 0.5) continue;
      fragments.push({
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top,
        background,
        borderTop,
        borderRight,
        borderBottom,
        borderLeft,
        borderRadiusPx,
        keepTogether
      });
    }
  }

  return fragments;
}

function captureCssBorder(color: string, width: string, style: string): CssBorderFragment | null {
  if (!style || style === "none" || style === "hidden") return null;
  const widthPx = parseFloat(width);
  const visibleColor = normalizeVisibleCssColor(color);
  if (!visibleColor || !Number.isFinite(widthPx) || widthPx <= 0) return null;
  return { color: visibleColor, widthPx: clampNumber(widthPx, 0.5, 24, 1) };
}

function normalizeVisibleCssColor(value: string): string | null {
  const clean = value.trim();
  if (!clean || clean === "transparent") return null;

  const alphaMatch = clean.match(/(?:rgba?\([^)]*[,/]\s*|color\([^)]*\/\s*)([\d.]+%?)\s*\)$/iu);
  if (alphaMatch) {
    const alpha = alphaMatch[1].endsWith("%")
      ? Number.parseFloat(alphaMatch[1]) / 100
      : Number.parseFloat(alphaMatch[1]);
    if (Number.isFinite(alpha) && alpha <= 0.001) return null;
  }

  return clean;
}

function captureSvgFragments(pageEl: HTMLElement): SvgFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  return Array.from(pageEl.querySelectorAll<SVGSVGElement>("svg"))
    .filter((svg) => isExportableElement(svg as unknown as HTMLElement))
    .map((svg) => {
      const rect = svg.getBoundingClientRect();
      return {
        element: svg,
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top
      };
    })
    .filter((fragment) => fragment.right > fragment.left && fragment.bottom > fragment.top);
}

function captureDecorationFragments(pageEl: HTMLElement): DecorationFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const decorations: DecorationFragment[] = [];
  const itemsWithVisibleCheckbox = new Set<HTMLElement>();

  for (const checkbox of Array.from(pageEl.querySelectorAll<HTMLInputElement>("input[type='checkbox']"))) {
    if (!isExportableElement(checkbox)) continue;
    const rect = checkbox.getBoundingClientRect();
    const style = getComputedStyle(checkbox);
    if (rect.width <= 0 || rect.height <= 0) continue;
    const item = checkbox.closest<HTMLElement>("li");
    if (item) itemsWithVisibleCheckbox.add(item);
    const itemStyle = item ? getComputedStyle(item) : style;
    const fontSizePx = parseFloat(itemStyle.fontSize) || parseFloat(style.fontSize) || 16;
    const size = Math.max(7, Math.min(rect.width, rect.height));
    const left = rect.left - pageRect.left + Math.max(0, (rect.width - size) / 2);
    const top = rect.top - pageRect.top + Math.max(0, (rect.height - size) / 2);
    const visibleBackground = normalizeVisibleCssColor(style.backgroundColor);
    const background = visibleBackground ? parseCssColor(visibleBackground) : null;
    const borderWidthPx = Math.max(0.75, Math.min(3, parseFloat(style.borderTopWidth) || 1));
    const borderRadiusPx = Math.max(0, Math.min(size / 2, parseFloat(style.borderRadius) || size * 0.18));

    decorations.push({
      kind: "checkbox",
      left,
      top,
      right: left + size,
      bottom: top + size,
      color: parseCssColor(style.accentColor) ?? parseCssColor(style.color) ?? rgb(0.12, 0.12, 0.12),
      border: parseCssColor(style.borderColor) ?? parseCssColor(style.color) ?? rgb(0.35, 0.35, 0.35),
      background,
      borderWidthPx,
      borderRadiusPx,
      checked: checkbox.checked,
      text: getTaskStatusText(checkbox),
      fontSizePx
    });
  }

  for (const item of Array.from(pageEl.querySelectorAll<HTMLElement>("li.task-list-item, li[data-task]"))) {
    if (!isExportableElement(item) || itemsWithVisibleCheckbox.has(item)) continue;
    const firstRect = firstTextRectInside(item);
    if (!firstRect) continue;

    const style = getComputedStyle(item);
    const fontSizePx = parseFloat(style.fontSize) || 16;
    const size = Math.max(9, Math.min(16, fontSizePx * 0.88));
    const textLeft = firstRect.left - pageRect.left;
    const top = firstRect.top - pageRect.top + firstRect.height * 0.5 - size / 2;
    const left = Math.max(0, textLeft - fontSizePx * 1.55);
    const checkbox = item.querySelector<HTMLInputElement>("input[type='checkbox']");
    const status = getTaskStatusFromElement(checkbox ?? item);
    const color = parseCssColor(style.accentColor) ??
      parseCssColor(style.getPropertyValue("--checkbox-color")) ??
      parseCssColor(style.color) ??
      rgb(0.12, 0.12, 0.12);
    const border = parseCssColor(style.getPropertyValue("--checkbox-border-color")) ??
      parseCssColor(style.borderColor) ??
      parseCssColor(style.color) ??
      rgb(0.35, 0.35, 0.35);

    decorations.push({
      kind: "checkbox",
      left,
      top,
      right: left + size,
      bottom: top + size,
      color,
      border,
      background: normalizeVisibleCssColor(style.backgroundColor)
        ? parseCssColor(style.backgroundColor)
        : null,
      borderWidthPx: Math.max(0.75, Math.min(3, parseFloat(style.borderTopWidth) || 1)),
      borderRadiusPx: Math.max(0, Math.min(size / 2, parseFloat(style.borderRadius) || size * 0.18)),
      checked: isTaskChecked(item, checkbox, status),
      text: getTaskStatusTextFromStatus(status, item),
      fontSizePx
    });
  }

  for (const item of Array.from(pageEl.querySelectorAll<HTMLLIElement>("li"))) {
    if (!isExportableElement(item)) continue;
    if (item.querySelector("input[type='checkbox']")) continue;

    const firstRect = firstTextRectInside(item);
    if (!firstRect) continue;

    const style = getComputedStyle(item);
    const fontSizePx = parseFloat(style.fontSize) || 16;
    const color = parseCssColor(style.color) ?? rgb(0.12, 0.12, 0.12);
    const textLeft = firstRect.left - pageRect.left;
    const centerY = firstRect.top - pageRect.top + firstRect.height * 0.52;
    const parent = item.parentElement;
    const isOrdered = parent?.tagName.toLowerCase() === "ol";

    if (isOrdered) {
      const text = getOrderedListMarkerText(item);
      const markerWidth = Math.max(fontSizePx * 1.2, text.length * fontSizePx * 0.65);
      const right = Math.max(0, textLeft - fontSizePx * 0.35);
      decorations.push({
        kind: "marker",
        left: Math.max(0, right - markerWidth),
        top: centerY - fontSizePx * 0.72,
        right,
        bottom: centerY + fontSizePx * 0.32,
        color,
        border: null,
        text,
        fontSizePx
      });
    } else {
      const markerText = getUnorderedListMarkerText(item);
      if (markerText) {
        const markerWidth = Math.max(fontSizePx * 0.9, markerText.length * fontSizePx * 0.65);
        const right = Math.max(0, textLeft - fontSizePx * 0.35);
        decorations.push({
          kind: "marker",
          left: Math.max(0, right - markerWidth),
          top: centerY - fontSizePx * 0.72,
          right,
          bottom: centerY + fontSizePx * 0.32,
          color,
          border: null,
          text: markerText,
          fontSizePx
        });
        continue;
      }

      const size = Math.max(3, fontSizePx * 0.36);
      const centerX = Math.max(size, textLeft - fontSizePx * 0.72);
      decorations.push({
        kind: "bullet",
        left: centerX - size / 2,
        top: centerY - size / 2,
        right: centerX + size / 2,
        bottom: centerY + size / 2,
        color,
        border: null,
        fontSizePx
      });
    }
  }

  decorations.push(...capturePseudoTextDecorations(pageEl, pageRect));

  return decorations;
}

function captureKeepBlockFragments(
  pageEl: HTMLElement,
  textFragments: TextFragment[],
  imageFragments: ImageFragment[],
  videoFragments: VideoFragment[],
  canvasFragments: CanvasFragment[],
  boxFragments: BoxFragment[],
  svgFragments: SvgFragment[],
  decorationFragments: DecorationFragment[]
): KeepBlockFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const selectors = [
    "img",
    "video",
    "picture",
    "figure",
    ".image-embed",
    "pre",
    "blockquote",
    "table",
    "tr",
    ".callout",
    ".markdown-embed",
    ".internal-embed",
    "li",
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6"
  ].join(",");

  const blocks = Array.from(pageEl.querySelectorAll<HTMLElement>(selectors))
    .filter((element) => isExportableElement(element))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top,
        priority: getKeepBlockPriority(element)
      };
    })
    .filter((block) => block.right > block.left && block.bottom > block.top);

  for (const image of imageFragments) blocks.push({ ...image, priority: 6 });
  for (const video of videoFragments) blocks.push({ ...video, priority: 6 });
  for (const canvas of canvasFragments) {
    if (!canvas.element.classList.contains("mobile-pdf-exporter-note-doodle-canvas")) {
      blocks.push({ ...canvas, priority: 4 });
    }
  }
  for (const box of boxFragments) {
    if (box.keepTogether) blocks.push({ ...box, priority: 3 });
  }
  for (const svg of svgFragments) blocks.push({ ...svg, priority: isLargeOrExcalidrawSvg(svg.element) ? 6 : 3 });
  for (const decoration of decorationFragments) blocks.push({ ...decoration, priority: 2 });
  for (const text of textFragments) blocks.push({ ...text, priority: 1 });

  return blocks;
}

function firstTextRectInside(element: HTMLElement): DOMRect | null {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (!isExportableElement(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const range = element.ownerDocument.createRange();
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const text = textNode.nodeValue ?? "";
    const start = text.search(/\S/u);
    if (start >= 0) {
      range.setStart(textNode, start);
      range.setEnd(textNode, Math.min(start + 1, text.length));
      const rect = firstUsefulRect(range);
      if (rect) {
        range.detach();
        return rect;
      }
    }
    node = walker.nextNode();
  }

  range.detach();
  return null;
}

function getOrderedListMarkerText(item: HTMLLIElement): string {
  const parent = item.parentElement as HTMLOListElement | null;
  const value = item.value > 0 ? item.value : null;
  const start = parent?.start && parent.start > 0 ? parent.start : 1;
  const siblings = parent
    ? Array.from(parent.children).filter((child): child is HTMLLIElement => child.tagName.toLowerCase() === "li")
    : [item];
  const index = Math.max(0, siblings.indexOf(item));
  const number = value ?? start + index;
  const listStyle = parent ? getComputedStyle(parent).listStyleType : "decimal";
  return `${formatListCounter(number, listStyle)}.`;
}

function getUnorderedListMarkerText(item: HTMLLIElement): string | null {
  const parent = item.parentElement;
  const listStyle = parent ? getComputedStyle(parent).listStyleType : "";
  if (listStyle === "circle") return "o";
  if (listStyle === "square") return "▪";
  if (listStyle && listStyle !== "disc") return null;

  const depth = getListDepth(item);
  if (depth % 3 === 1) return "o";
  if (depth % 3 === 2) return "▪";
  return null;
}

function getListDepth(item: HTMLLIElement): number {
  let depth = 0;
  let current: Element | null = item.parentElement;
  while (current) {
    if (current.tagName.toLowerCase() === "ul" || current.tagName.toLowerCase() === "ol") depth += 1;
    current = current.parentElement;
  }
  return Math.max(0, depth - 1);
}

function formatListCounter(value: number, listStyle: string): string {
  if (listStyle === "lower-alpha" || listStyle === "lower-latin") return toAlphaCounter(value).toLowerCase();
  if (listStyle === "upper-alpha" || listStyle === "upper-latin") return toAlphaCounter(value).toUpperCase();
  if (listStyle === "lower-roman") return toRomanCounter(value).toLowerCase();
  if (listStyle === "upper-roman") return toRomanCounter(value).toUpperCase();
  return String(value);
}

function toAlphaCounter(value: number): string {
  let number = Math.max(1, Math.floor(value));
  let result = "";
  while (number > 0) {
    number -= 1;
    result = String.fromCharCode(65 + (number % 26)) + result;
    number = Math.floor(number / 26);
  }
  return result;
}

function toRomanCounter(value: number): string {
  let number = Math.max(1, Math.min(3999, Math.floor(value)));
  const parts: Array<[number, string]> = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"]
  ];
  let result = "";
  for (const [amount, marker] of parts) {
    while (number >= amount) {
      result += marker;
      number -= amount;
    }
  }
  return result;
}

function getTaskStatusText(checkbox: HTMLInputElement): string | undefined {
  const item = checkbox.closest<HTMLElement>("li");
  const status = getTaskStatusFromElement(checkbox);
  return getTaskStatusTextFromStatus(status, item);
}

function getTaskStatusFromElement(element: HTMLElement | null): string {
  const item = element?.closest<HTMLElement>("li") ?? null;
  return (
    element?.getAttribute("data-task") ??
    element?.getAttribute("data-task-state") ??
    element?.getAttribute("data-task-status") ??
    item?.getAttribute("data-task") ??
    item?.getAttribute("data-task-state") ??
    item?.getAttribute("data-task-status") ??
    ""
  );
}

function getTaskStatusTextFromStatus(status: string, item: HTMLElement | null): string | undefined {
  const clean = status.trim();
  if (!clean || clean === " " || clean.toLowerCase() === "x") return undefined;
  if (clean.length <= 2) return clean;

  if (item?.classList.contains("is-cancelled") || item?.classList.contains("task-list-item-cancelled")) return "-";
  if (item?.classList.contains("is-important") || item?.classList.contains("task-list-item-important")) return "!";
  if (item?.classList.contains("is-in-progress") || item?.classList.contains("task-list-item-in-progress")) return "/";
  return undefined;
}

function isTaskChecked(item: HTMLElement, checkbox: HTMLInputElement | null, status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return Boolean(
    checkbox?.checked ||
    normalized === "x" ||
    item.classList.contains("is-checked") ||
    item.classList.contains("is-done") ||
    item.classList.contains("task-list-item-checked")
  );
}

function capturePseudoTextDecorations(pageEl: HTMLElement, pageRect: DOMRect): DecorationFragment[] {
  const selectors = [
    ".callout-title",
    ".callout-icon",
    ".list-bullet",
    ".task-list-item",
    ".metadata-property-icon",
    ".nav-file-tag",
    ".tag"
  ].join(",");
  const decorations: DecorationFragment[] = [];

  for (const element of Array.from(pageEl.querySelectorAll<HTMLElement>(selectors))) {
    if (!isExportableElement(element)) continue;
    for (const pseudo of ["::before", "::after"] as const) {
      const style = getComputedStyle(element, pseudo);
      const text = parsePseudoContent(style.content);
      if (!text) continue;

      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const fontSizePx = parseFloat(style.fontSize) || parseFloat(getComputedStyle(element).fontSize) || 16;
      const color = parseCssColor(style.color) ?? parseCssColor(getComputedStyle(element).color) ?? rgb(0.12, 0.12, 0.12);
      const width = Math.max(fontSizePx * 0.9, text.length * fontSizePx * 0.62);
      const leftOffset = pseudo === "::before" ? 0 : Math.max(0, rect.width - width);
      const topOffset = Math.max(0, (rect.height - fontSizePx) * 0.5);

      decorations.push({
        kind: "text",
        left: rect.left - pageRect.left + leftOffset,
        top: rect.top - pageRect.top + topOffset,
        right: rect.left - pageRect.left + leftOffset + width,
        bottom: rect.top - pageRect.top + topOffset + fontSizePx * 1.15,
        color,
        border: null,
        text,
        fontSizePx
      });
    }
  }

  return decorations;
}

function parsePseudoContent(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed === "none" || trimmed === "normal") return null;
  const strings = Array.from(trimmed.matchAll(/"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'/gu));
  const text = strings.length > 0
    ? strings.map((match) => match[1] ?? match[2] ?? "").join("")
    : trimmed;
  const clean = text
    .replace(/\\([0-9a-f]{1,6})\s?/giu, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/\\([\\'"])/gu, "$1")
    .trim();
  if (!clean || clean.length > 8) return null;
  return clean;
}

function getKeepBlockPriority(element: HTMLElement): number {
  const tag = element.tagName.toLowerCase();
  if (tag === "svg" && isLargeOrExcalidrawSvg(element as unknown as SVGSVGElement)) return 6;
  if (tag === "img" || tag === "picture" || tag === "figure" || element.matches(".image-embed")) return 6;
  if (tag === "pre" || tag === "table") return 4;
  if (tag === "tr") return 4;
  if (tag === "blockquote" || element.matches(".callout, .markdown-embed, .internal-embed")) return 4;
  if (tag === "li") return 3;
  if (/^h[1-6]$/u.test(tag)) return 3;
  return 2;
}

function withExportableElementCache<T>(callback: () => T): T {
  const previousCache = exportableElementCache;
  exportableElementCache = new WeakMap();
  try {
    return callback();
  } finally {
    exportableElementCache = previousCache;
  }
}

async function buildSemanticHtml(file: TFile, model: PreviewPdfModel): Promise<Blob> {
  const pageWidthCssPx = model.pageWidthPt / 72 * 96;
  const pageHeightCssPx = model.pageHeightPt / 72 * 96;
  const pageCount = Math.max(0, model.pageBreaks.length - 1);
  const pageMarkup = (await Promise.all(Array.from({ length: pageCount }, async (_, pageIndex) => {
    const pageTop = model.pageBreaks[pageIndex];
    const pageBottom = model.pageBreaks[pageIndex + 1];
    const toCssPx = (value: number): number => value * model.pxToPt / 72 * 96;
    const boxes = model.boxFragments.filter((box) => box.bottom > pageTop && box.top < pageBottom).map((box) => {
      const top = Math.max(box.top, pageTop) - pageTop + model.bodyTopInsetPx;
      const bottom = Math.min(box.bottom, pageBottom) - pageTop + model.bodyTopInsetPx;
      const left = Math.max(0, box.left);
      const right = Math.min(model.sourceWidthPx, box.right);
      if (bottom <= top || right <= left) return "";
      const border = (side: CssBorderFragment | null): string => side
        ? `${side.widthPx}px solid ${escapeHtml(side.color)}`
        : "none";
      return `<div class="page-box" style="left:${toCssPx(left)}px;top:${toCssPx(top)}px;width:${toCssPx(right - left)}px;height:${toCssPx(bottom - top)}px;background:${escapeHtml(box.background ?? "transparent")};border-top:${border(box.borderTop)};border-right:${border(box.borderRight)};border-bottom:${border(box.borderBottom)};border-left:${border(box.borderLeft)};border-radius:${toCssPx(box.borderRadiusPx)}px"></div>`;
    }).join("");
    const media = (await getOfficeMediaFragments(model, pageIndex, {
      colorMode: "color",
      rasterScale: 1
    })).map((fragment) => (
      `<img class="page-media" alt="" draggable="false" src="${bytesToDataUrl(fragment.data)}" style="left:${toCssPx(fragment.leftPx)}px;top:${toCssPx(fragment.topPx)}px;width:${toCssPx(fragment.widthPx)}px;height:${toCssPx(fragment.heightPx)}px">`
    )).join("");
    const text = getPageTextFragments(model, pageIndex).map((fragment) => {
      const style = `left:${toCssPx(fragment.left)}px;top:${toCssPx(fragment.top - pageTop + model.bodyTopInsetPx)}px;width:${Math.max(1, toCssPx(fragment.right - fragment.left))}px;min-height:${Math.max(1, toCssPx(fragment.bottom - fragment.top))}px;font-family:${escapeHtml(fragment.fontFamily)};font-size:${Math.max(4, toCssPx(fragment.fontSizePx))}px;font-weight:${escapeHtml(fragment.fontWeight)};font-style:${escapeHtml(fragment.fontStyle)};line-height:${Math.max(1, toCssPx(fragment.bottom - fragment.top))}px;color:#${colorToHex(fragment.color)};text-decoration:${fragment.underline ? "underline" : fragment.lineThrough ? "line-through" : "none"};`;
      const content = escapeHtml(fragment.text);
      return fragment.href
        ? `<a class="page-text" contenteditable="true" href="${escapeHtml(fragment.href)}" target="_blank" rel="noopener" style="${style}">${content}</a>`
        : `<span class="page-text" contenteditable="true" style="${style}">${content}</span>`;
    }).join("");
    return `<section class="page" aria-label="Page ${pageIndex + 1}"><div class="page-content">${boxes}${media}${text}</div></section>`;
  }))).join("");
  const background = colorToCss(model.background, "color");
  const html = `<!doctype html><html lang="zh-CN" data-mpe-format="semantic-layout"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(file.basename)}</title><style>*{box-sizing:border-box}html{background:#e9edf2}body{margin:0;padding:24px;background:#e9edf2;font-family:system-ui,sans-serif;color:#1f2937}.page{position:relative;width:min(100%,${pageWidthCssPx}px);height:${pageHeightCssPx}px;margin:0 auto 24px;background:${escapeHtml(background)};box-shadow:0 8px 28px #0002;overflow:hidden}.page-content{position:absolute;inset:0;overflow:hidden}.page-box{position:absolute;z-index:0;pointer-events:none}.page-media{position:absolute;z-index:1;display:block;max-width:none;object-fit:fill;user-select:none}.page-text{position:absolute;z-index:2;display:block;overflow:visible;white-space:pre-wrap;word-break:normal;overflow-wrap:normal;outline:none;text-decoration-thickness:from-font}.page-text:focus{z-index:4;background:#fff;box-shadow:0 0 0 2px #2f6feb;border-radius:2px}.page-text[href]{cursor:pointer}@media print{html,body{padding:0;background:#fff}.page{width:100%;height:auto;min-height:${pageHeightCssPx}px;margin:0;box-shadow:none;break-after:page}.page-content{position:relative;min-height:${pageHeightCssPx}px}}</style></head><body>${pageMarkup}</body></html>`;
  return new Blob([html], { type: "text/html;charset=utf-8" });
}

function isLivePreviewMarkdownSyntaxElement(element: Element): boolean {
  const formatting = element.closest('[class*="cm-formatting"]');
  return Boolean(formatting && !formatting.classList.contains("cm-formatting-hashtag"));
}

function isExportableElement(element: Element): boolean {
  const cached = exportableElementCache?.get(element);
  if (cached !== undefined) return cached;

  if (
    isLivePreviewMarkdownSyntaxElement(element) ||
    element.closest(
      ".mobile-pdf-exporter-skip, .collapse-indicator, .heading-collapse-indicator, .markdown-embed-link, .copy-code-button, .notedraw-toolbar, .notedraw-palette-panel, .notedraw-text-panel, .notedraw-format-toolbar, .notedraw-selection-menu, .notedraw-fallback-button, .notedraw-header-button, style, script"
    )
  ) {
    exportableElementCache?.set(element, false);
    return false;
  }

  if (element.matches("pre.language-compressed-json, code.language-compressed-json")) {
    exportableElementCache?.set(element, false);
    return false;
  }
  if (isExcalidrawSourceText(element.textContent ?? "")) {
    exportableElementCache?.set(element, false);
    return false;
  }

  let current: Element | null = element;
  while (current) {
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      exportableElementCache?.set(element, false);
      return false;
    }
    current = current.parentElement;
  }

  exportableElementCache?.set(element, true);
  return true;
}

function measureTextNode(
  textNode: Text,
  parent: HTMLElement,
  pageRect: DOMRect,
  linkContext?: PdfLinkContext
): TextFragment[] {
  const style = getComputedStyle(parent);
  const mergeScope = getTextMergeScope(parent);
  const headingLevel = getTextHeadingLevel(parent);
  const fontSizePx = parseFloat(style.fontSize) || 16;
  const linkElement = parent.closest("a, .internal-link, .external-link");
  const href = resolveLinkHref(linkElement, linkContext);
  const color = parseCssColor(style.color) ??
    (linkElement ? rgb(0.08, 0.36, 0.72) : rgb(0.08, 0.08, 0.08));
  const underline = Boolean(
    linkElement ||
    style.textDecorationLine.includes("underline") ||
    style.textDecoration.includes("underline")
  );
  const lineThrough = Boolean(
    style.textDecorationLine.includes("line-through") ||
    style.textDecoration.includes("line-through")
  );
  const text = textNode.nodeValue ?? "";
  const direction = getTextDirection(style.direction, text);
  const range = textNode.ownerDocument.createRange();
  const fragments: TextFragment[] = [];
  let current: TextLineDraft | null = null;
  let offset = 0;

  const pushCurrent = (): void => {
    if (!current) return;
    const cleanText = normalizeLineText(current.text);
    if (cleanText) {
      fragments.push({
        text: cleanText,
        left: current.left,
        top: current.top,
        right: current.right,
        bottom: current.bottom,
        fontSizePx: current.fontSizePx,
        fontFamily: current.fontFamily,
        fontWeight: current.fontWeight,
        fontStyle: current.fontStyle,
        direction: current.direction,
        color: current.color,
        underline: current.underline,
        lineThrough: current.lineThrough,
        href: current.href,
        headingLevel: current.headingLevel,
        mergeScope: current.mergeScope
      });
    }
    current = null;
  };

  for (const char of Array.from(text)) {
    const start = offset;
    offset += char.length;

    if (char === "\n" || char === "\r") {
      pushCurrent();
      continue;
    }

    range.setStart(textNode, start);
    range.setEnd(textNode, offset);
    const rect = firstUsefulRect(range);

    if (!rect) {
      if (/\s/u.test(char) && current) current.text += " ";
      continue;
    }

    const isWhitespace = /\s/u.test(char);
    if (isWhitespace) {
      if (current) current.text += " ";
      continue;
    }

    const left = rect.left - pageRect.left;
    const top = rect.top - pageRect.top;
    const right = rect.right - pageRect.left;
    const bottom = rect.bottom - pageRect.top;
    const sameLine =
      current &&
      Math.abs(top - current.top) <= Math.max(2.5, fontSizePx * 0.35);

    if (!sameLine) pushCurrent();

    if (!current) {
      current = {
        text: "",
        left,
        top,
        right,
        bottom,
        fontSizePx,
        fontFamily: style.fontFamily || "",
        fontWeight: style.fontWeight || "400",
        fontStyle: style.fontStyle || "normal",
        direction,
        color,
        underline,
        lineThrough,
        href,
        headingLevel,
        mergeScope
      };
    }

    current.text += char;
    current.left = Math.min(current.left, left);
    current.top = Math.min(current.top, top);
    current.right = Math.max(current.right, right);
    current.bottom = Math.max(current.bottom, bottom);
  }

  pushCurrent();
  range.detach();
  return fragments;
}

function getTextHeadingLevel(parent: HTMLElement): number | undefined {
  const semanticHeading = parent.closest<HTMLElement>("h1, h2, h3, h4, h5, h6");
  const semanticMatch = semanticHeading?.tagName.match(/^H([1-6])$/u);
  if (semanticMatch) return Number(semanticMatch[1]);

  const livePreviewHeading = parent.closest<HTMLElement>(
    '.HyperMD-header, [class*="HyperMD-header-"], .cm-header, [class*="cm-header-"]'
  );
  const classMatch = livePreviewHeading?.className.match(/(?:HyperMD-header|cm-header)-([1-6])/u);
  return classMatch ? Number(classMatch[1]) : undefined;
}

function getTextMergeScope(parent: HTMLElement): Element {
  return parent.closest(
    "th, td, p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, figcaption, .callout, .markdown-embed, .internal-embed"
  ) ?? parent;
}

function firstUsefulRect(range: Range): DOMRect | null {
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width > 0.1 && rect.height > 0.1) return rect;
  }
  return null;
}

function normalizeLineText(text: string): string {
  return text.replace(/[ \t\u00A0]+/gu, " ").trim();
}

function compactSeparatorSpacing(text: string): string {
  const clean = normalizeLineText(text);
  if (!clean || isPdfJumpHref(clean)) return clean;

  const hasCjk = /[\u3400-\u9FFF\uF900-\uFAFF]/u.test(clean);
  const separatorCount = (clean.match(/[·•・|｜/、，,;；<>#()[\]（）【】]/gu) ?? []).length;
  if (!hasCjk && separatorCount < 2) return clean;

  return clean
    .replace(/\s*([·•・|｜/、，,;；<>#()[\]（）【】])\s*/gu, "$1")
    .replace(/[ \t\u00A0]{2,}/gu, " ")
    .trim();
}

function sortTextFragmentsForDrawing(fragments: TextFragment[]): TextFragment[] {
  return [...fragments].sort((left, right) => {
    const lineTolerance = Math.max(3, Math.min(left.fontSizePx, right.fontSizePx) * 0.45);
    return Math.abs(left.top - right.top) <= lineTolerance
      ? left.left - right.left
      : left.top - right.top;
  });
}

function createPdfLinkContext(app: App, file: TFile): PdfLinkContext {
  return {
    app,
    sourcePath: file.path,
    vaultName: app.vault.getName()
  };
}

function resolveLinkHref(linkElement: Element | null, context?: PdfLinkContext): string | null {
  if (!linkElement) return null;
  const hrefValue = linkElement.getAttribute("href") ?? "";
  const dataHrefValue = linkElement.getAttribute("data-href") ?? "";
  const rawValues = [
    hrefValue,
    dataHrefValue,
    linkElement.getAttribute("aria-label") ??
      "",
    linkElement.getAttribute("title") ??
      "",
    linkElement.textContent ??
      ""
  ];

  for (const raw of rawValues) {
    const href = normalizePdfHref(raw);
    if (href) return href;
  }

  if (context && (linkElement.classList.contains("internal-link") || dataHrefValue)) {
    return resolveInternalPdfHref(dataHrefValue || hrefValue || linkElement.textContent || "", context);
  }

  return null;
}

function resolveInternalPdfHref(raw: string, context: PdfLinkContext): string | null {
  let clean = raw.trim();
  if (!clean) return null;
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // Keep the original text when it is not URI-encoded.
  }

  clean = clean.replace(/^app:\/\/obsidian\.md\//iu, "").replace(/^\.\//u, "");
  const hashIndex = clean.indexOf("#");
  const linkPath = (hashIndex >= 0 ? clean.slice(0, hashIndex) : clean).trim();
  const subpath = hashIndex >= 0 ? clean.slice(hashIndex) : "";
  const relativePath = linkPath ? resolveRelativeMarkdownLinkPath(linkPath, context.sourcePath) : context.sourcePath;
  const relativeFile = relativePath ? context.app.vault.getAbstractFileByPath(relativePath) : null;
  const resolvedFile = linkPath && !relativeFile
    ? context.app.metadataCache.getFirstLinkpathDest(linkPath, context.sourcePath)
    : relativeFile;
  const targetPath = resolvedFile instanceof TFile ? resolvedFile.path : (relativePath || linkPath || context.sourcePath);
  if (!targetPath) return null;

  const vault = encodeURIComponent(context.vaultName);
  const file = encodeURIComponent(`${targetPath}${subpath}`);
  return `obsidian://open?vault=${vault}&file=${file}`;
}

function resolveRelativeMarkdownLinkPath(linkPath: string, sourcePath: string): string | null {
  const cleanPath = linkPath.trim().replace(/\\/gu, "/");
  if (!cleanPath) return null;
  if (!isPathLikeMarkdownLink(cleanPath)) return null;

  const sourceDir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  const rootedPath = cleanPath.startsWith("/")
    ? cleanPath.slice(1)
    : sourceDir
      ? `${sourceDir}/${cleanPath}`
      : cleanPath;
  return collapseVaultPathSegments(normalizePath(rootedPath));
}

function isPathLikeMarkdownLink(linkPath: string): boolean {
  return (
    linkPath.startsWith("/") ||
    linkPath.startsWith("./") ||
    linkPath.startsWith("../") ||
    linkPath.includes("/") ||
    /\.md$/iu.test(linkPath)
  );
}

function collapseVaultPathSegments(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function normalizePdfHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isPdfJumpHref(trimmed)) return trimmed;

  const match = trimmed.match(/\b(?:https?:\/\/|mailto:|tel:|obsidian:)[^\s"'<>）)]+/iu);
  return match ? match[0] : null;
}

function isPdfJumpHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|tel:|obsidian:)/iu.test(href.trim());
}

function measureExportContentHeight(
  pageEl: HTMLElement,
  textFragments: TextFragment[],
  imageFragments: ImageFragment[],
  videoFragments: VideoFragment[],
  canvasFragments: CanvasFragment[],
  boxFragments: BoxFragment[],
  svgFragments: SvgFragment[],
  decorationFragments: DecorationFragment[],
  keepBlocks: KeepBlockFragment[]
): number {
  const maxTextBottom = Math.max(0, ...textFragments.map((fragment) => fragment.bottom));
  const maxImageBottom = Math.max(0, ...imageFragments.map((fragment) => fragment.bottom));
  const maxVideoBottom = Math.max(0, ...videoFragments.map((fragment) => fragment.bottom));
  const maxCanvasBottom = Math.max(0, ...canvasFragments.map((fragment) => fragment.bottom));
  const maxSvgBottom = Math.max(0, ...svgFragments.map((fragment) => fragment.bottom));
  const maxDecorationBottom = Math.max(0, ...decorationFragments.map((fragment) => fragment.bottom));
  const visibleBottom = Math.max(
    maxTextBottom,
    maxImageBottom,
    maxVideoBottom,
    maxCanvasBottom,
    maxSvgBottom,
    maxDecorationBottom
  );
  if (visibleBottom > 0) return Math.ceil(visibleBottom);

  const rect = pageEl.getBoundingClientRect();
  return Math.ceil(Math.max(rect.height, 1));
}

function computePageBreaks(
  contentHeightPx: number,
  pageHeightPx: number,
  keepBlocks: KeepBlockFragment[]
): number[] {
  const breaks = [0];
  let pageTop = 0;
  const sortedBlocks = [...keepBlocks].sort((a, b) => a.top - b.top || b.priority - a.priority);

  while (pageTop + pageHeightPx < contentHeightPx - 1) {
    let nextBreak = pageTop + pageHeightPx;
    const nearbyGapBreak = findNearbyGapBreak(pageTop, nextBreak, pageHeightPx, sortedBlocks);
    if (nearbyGapBreak) nextBreak = nearbyGapBreak;

    const mediaBreak = sortedBlocks
      .filter((fragment) => {
        if (fragment.priority < 6) return false;
        const height = fragment.bottom - fragment.top;
        const startsOnThisPage = fragment.top > pageTop + PAGE_BREAK_MIN_ADVANCE_PX;
        const crossesBreak = fragment.bottom > nextBreak - PAGE_BREAK_PADDING_PX;
        const remainingHeight = Math.max(0, nextBreak - fragment.top);
        const fitsOnOnePage = height <= pageHeightPx * 0.94;
        if (fitsOnOnePage) return startsOnThisPage && crossesBreak;
        return startsOnThisPage && crossesBreak && remainingHeight < pageHeightPx * 0.28;
      })
      .sort((a, b) => a.top - b.top)[0];

    if (mediaBreak) {
      const candidate = mediaBreak.top - PAGE_BREAK_PADDING_PX;
      if (candidate > pageTop + pageHeightPx * 0.15) nextBreak = candidate;
    }

    const crossing = sortedBlocks
      .filter((fragment) => {
        const height = fragment.bottom - fragment.top;
        const startsOnThisPage = fragment.top > pageTop + PAGE_BREAK_MIN_ADVANCE_PX;
        const maxKeepRatio = fragment.priority >= 6 ? 0.94 : fragment.priority >= 4 ? 0.62 : 0.44;
        const fitsOnOnePage = height < pageHeightPx * maxKeepRatio;
        const crossesBreak = fragment.top < nextBreak - 2 && fragment.bottom > nextBreak + 2;
        return startsOnThisPage && fitsOnOnePage && crossesBreak;
      })
      .sort((a, b) => b.priority - a.priority || a.top - b.top)[0];

    if (crossing) {
      const candidate = crossing.top - PAGE_BREAK_PADDING_PX;
      const minimumFilledRatio = crossing.priority >= 6 ? 0.18 : crossing.priority >= 4 ? 0.48 : 0.62;
      if (candidate > pageTop + pageHeightPx * minimumFilledRatio) nextBreak = candidate;
    }

    nextBreak = moveBreakOutsideTextLines(pageTop, nextBreak, pageHeightPx, sortedBlocks);

    if (nextBreak <= pageTop + PAGE_BREAK_MIN_ADVANCE_PX) nextBreak = pageTop + pageHeightPx;
    breaks.push(Math.min(nextBreak, contentHeightPx));
    pageTop = nextBreak;
  }

  if (breaks[breaks.length - 1] < contentHeightPx) breaks.push(contentHeightPx);
  return enforceMaximumPageSpan(breaks, contentHeightPx, pageHeightPx, sortedBlocks);
}

function removeEmptyTrailingPageBreaks(model: PreviewPdfModel): number[] {
  const breaks = [...model.pageBreaks];
  const overlaps = (fragment: { top: number; bottom: number }, top: number, bottom: number): boolean =>
    fragment.bottom > top + 0.5 && fragment.top < bottom - 0.5;
  const hasContent = (top: number, bottom: number): boolean => (
    model.textFragments.some((fragment) => overlaps(fragment, top, bottom)) ||
    model.imageFragments.some((fragment) => overlaps(fragment, top, bottom)) ||
    model.videoFragments.some((fragment) => overlaps(fragment, top, bottom)) ||
    model.canvasFragments.some((fragment) => overlaps(fragment, top, bottom)) ||
    model.svgFragments.some((fragment) => overlaps(fragment, top, bottom)) ||
    model.decorationFragments.some((fragment) => overlaps(fragment, top, bottom)) ||
    (model.noteDrawElements ?? []).some((fragment) => overlaps(fragment, top, bottom)) ||
    (model.noteDrawInkStrokes ?? []).some((stroke) => stroke.points.some((point) => (
      point.y + stroke.widthPx > top + 0.5 && point.y - stroke.widthPx < bottom - 0.5
    )))
  );

  while (breaks.length > 2) {
    const top = breaks[breaks.length - 2];
    const bottom = breaks[breaks.length - 1];
    if (hasContent(top, bottom)) break;
    breaks.splice(breaks.length - 2, 1);
  }
  return breaks;
}

function enforceMaximumPageSpan(
  pageBreaks: number[],
  contentHeightPx: number,
  pageHeightPx: number,
  sortedBlocks: KeepBlockFragment[]
): number[] {
  const maximumSpan = Math.max(24, pageHeightPx);
  const normalized = [0];

  for (const rawTarget of pageBreaks.slice(1)) {
    const target = clampNumber(rawTarget, 0, contentHeightPx, contentHeightPx);
    let current = normalized[normalized.length - 1];

    while (target - current > maximumSpan + 0.5) {
      const idealBreak = current + maximumSpan;
      const textSafeBreak = moveBreakOutsideTextLines(current, idealBreak, maximumSpan, sortedBlocks);
      let nextBreak = Math.min(idealBreak, textSafeBreak);
      if (nextBreak <= current + PAGE_BREAK_MIN_ADVANCE_PX) nextBreak = idealBreak;
      normalized.push(nextBreak);
      current = nextBreak;
    }

    const isContentEnd = target >= contentHeightPx - 0.5;
    if (
      target > current + 0.5 &&
      (isContentEnd || target - current > PAGE_BREAK_MIN_ADVANCE_PX)
    ) normalized.push(target);
  }

  if (normalized[normalized.length - 1] < contentHeightPx - 0.5) normalized.push(contentHeightPx);
  return normalized;
}

function moveBreakOutsideTextLines(
  pageTop: number,
  nextBreak: number,
  pageHeightPx: number,
  sortedBlocks: KeepBlockFragment[]
): number {
  let adjustedBreak = nextBreak;
  const pageBottom = pageTop + pageHeightPx;
  for (let guard = 0; guard < 48; guard += 1) {
    const crossingTextLine = sortedBlocks
      .filter((fragment) => (
        fragment.priority === 1 &&
        fragment.top < adjustedBreak - 0.5 &&
        fragment.bottom > adjustedBreak + 0.5
      ))
      .sort((a, b) => Math.abs(adjustedBreak - a.top) - Math.abs(adjustedBreak - b.top))[0];
    if (!crossingTextLine) return adjustedBreak;

    const beforeLine = crossingTextLine.top;
    const afterLine = crossingTextLine.bottom;
    if (beforeLine > pageTop + PAGE_BREAK_MIN_ADVANCE_PX) {
      adjustedBreak = beforeLine;
    } else if (afterLine < pageBottom - 0.5) {
      adjustedBreak = afterLine;
    } else {
      return nextBreak;
    }
  }
  return adjustedBreak;
}

function findNearbyGapBreak(
  pageTop: number,
  idealBreak: number,
  pageHeightPx: number,
  keepBlocks: KeepBlockFragment[]
): number | null {
  const minBreak = pageTop + pageHeightPx * 0.58;
  const maxBreak = pageTop + pageHeightPx * 0.98;
  const candidateBlocks = keepBlocks
    .filter((block) => block.priority >= 2 && block.bottom > pageTop && block.top < idealBreak + pageHeightPx * 0.2)
    .sort((a, b) => a.top - b.top);
  let best: { y: number; score: number } | null = null;

  for (let index = 0; index < candidateBlocks.length - 1; index += 1) {
    const current = candidateBlocks[index];
    const next = candidateBlocks[index + 1];
    const gapTop = current.bottom + PAGE_BREAK_PADDING_PX;
    const gapBottom = next.top - PAGE_BREAK_PADDING_PX;
    if (gapBottom <= gapTop) continue;
    if (gapTop < minBreak || gapTop > maxBreak) continue;

    const y = Math.min(Math.max(gapTop, minBreak), maxBreak);
    const score = Math.abs(idealBreak - y) - Math.min(64, gapBottom - gapTop) * 0.4;
    if (!best || score < best.score) best = { y, score };
  }

  return best?.y ?? null;
}

function drawTextLayer(
  page: PDFPage,
  fragments: TextFragment[],
  options: {
    fonts: ExportFontSet;
    pageTopPx: number;
    pageBottomPx: number;
    pageWidthPt: number;
    pageHeightPt: number;
    pxToPt: number;
    contentTopInsetPx?: number;
    colorMode: PdfColorMode;
    opacity?: number;
    drawUnderlines?: boolean;
    hiddenVisualTextFragments?: ReadonlySet<TextFragment>;
  }
): void {
  const { fonts, pageTopPx, pageBottomPx, pageWidthPt, pageHeightPt, pxToPt } = options;
  const contentTopInsetPx = options.contentTopInsetPx ?? 0;
  const opacity = options.opacity ?? 1;
  const drawUnderlines = options.drawUnderlines ?? true;

  for (const fragment of fragments) {
    if (fragment.bottom <= pageTopPx + 0.5 || fragment.top >= pageBottomPx - 0.5) continue;

    const localTop = fragment.top - pageTopPx;
    const fontSize = Math.max(3.5, fragment.fontSizePx * pxToPt);
    const x = clampNumber(fragment.left * pxToPt, 0, pageWidthPt - 4, 0);
    const baselineY = pageHeightPt - (contentTopInsetPx + localTop + fragment.fontSizePx * 0.86) * pxToPt;
    const measuredWidth = Math.max(1, (fragment.right - fragment.left) * pxToPt);
    const maxWidth = Math.max(8, Math.min(pageWidthPt - x - 2, measuredWidth + 2));
    const font = selectPdfFont(fonts, fragment.text);
    const hiddenInVisualLayer = options.hiddenVisualTextFragments?.has(fragment) ?? false;

    const drawn = drawSafeText(page, fragment.text, {
      x,
      y: baselineY,
      size: fontSize,
      font,
      color: outputColor(fragment.color, options.colorMode),
      maxWidth,
      opacity: hiddenInVisualLayer ? 0 : opacity
    });

    const inkWidth = Math.min(maxWidth, Math.max(1, drawn.width));
    if (drawUnderlines && !hiddenInVisualLayer && fragment.underline && inkWidth > 1) {
      const underlineY = baselineY - Math.max(0.55, drawn.size * 0.12);
      page.drawLine({
        start: { x, y: underlineY },
        end: { x: x + inkWidth, y: underlineY },
        thickness: Math.max(0.35, drawn.size * 0.055),
        color: outputColor(fragment.color, options.colorMode)
      });
    }
  }
}

function drawSafeText(
  page: PDFPage,
  text: string,
  options: {
    x: number;
    y: number;
    size: number;
    font: PDFFont;
    color: Color;
    maxWidth: number;
    opacity?: number;
  }
): { text: string; size: number; width: number } {
  const clean = getEncodablePdfText(options.font, stripProblematicPdfChars(compactSeparatorSpacing(text)));
  if (!clean) return { text: "", size: options.size, width: 0 };
  const width = options.font.widthOfTextAtSize(clean, options.size);
  const fitSize = width > options.maxWidth
    ? Math.max(3.5, options.size * (options.maxWidth / width))
    : options.size;
  const fitWidth = options.font.widthOfTextAtSize(clean, fitSize);
  const drawOptions = {
    x: options.x,
    y: options.y,
    size: fitSize,
    font: options.font,
    color: options.color,
    opacity: options.opacity
  };

  try {
    page.drawText(clean, drawOptions);
    return { text: clean, size: fitSize, width: fitWidth };
  } catch {
    const fallback = getEncodablePdfText(
      options.font,
      clean.replace(/[^\u0020-\u007E\u3400-\u9FFF\uF900-\uFAFF，。！？、；：“”‘’（）《》【】￥…—]/gu, "")
    );
    if (!fallback) return { text: "", size: fitSize, width: 0 };
    try {
      const fallbackWidth = options.font.widthOfTextAtSize(fallback, options.size);
      const fallbackSize = fallbackWidth > options.maxWidth
        ? Math.max(3.5, options.size * (options.maxWidth / fallbackWidth))
        : options.size;
      page.drawText(fallback, { ...drawOptions, size: fallbackSize });
      return {
        text: fallback,
        size: fallbackSize,
        width: options.font.widthOfTextAtSize(fallback, fallbackSize)
      };
    } catch {
      // One unsupported line should not make the whole export fail.
      return { text: "", size: fitSize, width: 0 };
    }
  }
}

function drawPdfHeaderFooter(
  page: PDFPage,
  font: PDFFont,
  settings: Pick<MobilePdfExporterSettings, "marginMm" | "headerText" | "footerText" | "colorMode">,
  context: { title: string; pageNumber: number; pageCount: number; exportDate: string }
): void {
  const header = formatHeaderFooterText(
    settings.headerText,
    context.title,
    context.pageNumber,
    context.pageCount,
    context.exportDate
  );
  const footer = formatHeaderFooterText(
    settings.footerText,
    context.title,
    context.pageNumber,
    context.pageCount,
    context.exportDate
  );
  if (!header && !footer) return;

  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const insetX = Math.max(5, mmToPt(settings.marginMm));
  const maxWidth = Math.max(16, pageWidth - insetX * 2);
  const { topMm, bottomMm } = getPageBodyInsetsMm(settings);
  const color = outputColor(rgb(0.22, 0.22, 0.22), settings.colorMode);

  if (header) {
    drawAlignedSafePdfText(page, header, {
      x: insetX,
      y: pageHeight - mmToPt(topMm) + mmToPt(2.2),
      size: 8,
      font,
      color,
      maxWidth,
      align: "left"
    });
  }
  if (footer) {
    drawAlignedSafePdfText(page, footer, {
      x: pageWidth - insetX,
      y: Math.max(3, mmToPt(bottomMm) - mmToPt(4.5)),
      size: 8,
      font,
      color,
      maxWidth,
      align: "right"
    });
  }
}

function drawAlignedSafePdfText(
  page: PDFPage,
  text: string,
  options: {
    x: number;
    y: number;
    size: number;
    font: PDFFont;
    color: Color;
    maxWidth: number;
    align: "left" | "right";
  }
): void {
  const clean = getEncodablePdfText(options.font, stripProblematicPdfChars(text));
  if (!clean) return;
  const naturalWidth = options.font.widthOfTextAtSize(clean, options.size);
  const size = naturalWidth > options.maxWidth
    ? Math.max(4, options.size * (options.maxWidth / naturalWidth))
    : options.size;
  const width = Math.min(options.maxWidth, options.font.widthOfTextAtSize(clean, size));
  const x = options.align === "right" ? options.x - width : options.x;
  drawSafeText(page, clean, {
    x,
    y: options.y,
    size,
    font: options.font,
    color: options.color,
    maxWidth: options.maxWidth
  });
}

function getEncodablePdfText(font: PDFFont, text: string): string {
  if (!text) return "";
  if (canEncodePdfText(font, text)) return text;

  const cjkFallback = text.replace(/[^\u0020-\u007E\u3400-\u9FFF\uF900-\uFAFF，。！？、；：“”‘’（）《》【】￥…—]/gu, "");
  if (cjkFallback && canEncodePdfText(font, cjkFallback)) return cjkFallback;

  const asciiFallback = text.replace(/[^\u0020-\u007E]/gu, "");
  if (asciiFallback && canEncodePdfText(font, asciiFallback)) return asciiFallback;

  return filterEncodablePdfChars(font, text);
}

function canEncodePdfText(font: PDFFont, text: string): boolean {
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

function filterEncodablePdfChars(font: PDFFont, text: string): string {
  let filtered = "";
  for (const char of text) {
    if (canEncodePdfChar(font, char)) filtered += char;
  }
  return filtered.trim();
}

function canEncodePdfChar(font: PDFFont, char: string): boolean {
  let cache = pdfCharEncodingCache.get(font);
  if (!cache) {
    cache = new Map<string, boolean>();
    pdfCharEncodingCache.set(font, cache);
  }

  const cached = cache.get(char);
  if (cached !== undefined) return cached;
  const encodable = canEncodePdfText(font, char);
  cache.set(char, encodable);
  return encodable;
}

function drawLinkAnnotationLayer(
  page: PDFPage,
  links: LinkFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    pageWidthPt: number;
    pageHeightPt: number;
    pxToPt: number;
    contentTopInsetPx?: number;
  }
): void {
  const contentTopInsetPx = options.contentTopInsetPx ?? 0;
  for (const link of links) {
    if (link.bottom <= options.pageTopPx || link.top >= options.pageBottomPx) continue;

    const localTop = link.top - options.pageTopPx;
    const localBottom = link.bottom - options.pageTopPx;
    const x = clampNumber(link.left * options.pxToPt, 0, options.pageWidthPt - 1, 0);
    const right = clampNumber(link.right * options.pxToPt, x + 1, options.pageWidthPt, x + 1);
    const yTop = options.pageHeightPt - (contentTopInsetPx + localTop) * options.pxToPt;
    const yBottom = options.pageHeightPt - (contentTopInsetPx + localBottom) * options.pxToPt;
    const y = clampNumber(yBottom - 1, 0, options.pageHeightPt - 1, 0);
    const height = Math.max(4, Math.min(options.pageHeightPt - y, yTop - yBottom + 2));
    const width = Math.max(4, right - x);

    addLinkAnnotation(page, link.href, x, y, width, height);
  }
}

function addLinkAnnotation(page: PDFPage, href: string, x: number, y: number, width: number, height: number): void {
  const target = normalizePdfHref(href);
  if (!target || width <= 0 || height <= 0) return;

  try {
    const pageWidth = page.getWidth();
    const pageHeight = page.getHeight();
    const left = clampNumber(x, 0, pageWidth - 1, 0);
    const bottom = clampNumber(y, 0, pageHeight - 1, 0);
    const right = clampNumber(x + width, left + 1, pageWidth, left + 1);
    const top = clampNumber(y + height, bottom + 1, pageHeight, bottom + 1);
    const context = page.doc.context;
    const annotation = context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [left, bottom, right, top],
      Border: [0, 0, 0],
      A: {
        Type: "Action",
        S: "URI",
        URI: getPdfStringRuntime().of(target)
      }
    });
    const annotationRef = context.register(annotation);
    page.node.addAnnot(annotationRef);
  } catch (error) {
    console.warn("Mobile PDF Exporter link annotation failed", error);
  }
}

function drawNoteDrawInkAnnotationLayer(
  page: PDFPage,
  strokes: PdfInkStroke[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    pageHeightPt: number;
    pxToPt: number;
    contentTopInsetPx: number;
  }
): void {
  for (const stroke of strokes) {
    const offsets = stroke.brush === "watercolor"
      ? [{ x: 0, y: 0 }]
      : getNoteDoodlePenOffsets(stroke.count, stroke.widthPx);
    const pagePaths = offsets.flatMap((offset) => splitInkPathForPage(
      stroke.points.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y })),
      options.pageTopPx,
      options.pageBottomPx
    ));
    if (!pagePaths.length) continue;

    const pdfPaths = pagePaths.map((path) => path.map((point) => ({
      x: point.x * options.pxToPt,
      y: options.pageHeightPt - (
        options.contentTopInsetPx + point.y - options.pageTopPx
      ) * options.pxToPt
    })));
    const allPoints = pdfPaths.flat();
    const widthPt = Math.max(
      0.5,
      stroke.widthPx * options.pxToPt * (stroke.brush === "watercolor" ? 2.15 : 1)
    );
    const padding = widthPt / 2 + 1;
    const left = Math.max(0, Math.min(...allPoints.map((point) => point.x)) - padding);
    const right = Math.min(page.getWidth(), Math.max(...allPoints.map((point) => point.x)) + padding);
    const bottom = Math.max(0, Math.min(...allPoints.map((point) => point.y)) - padding);
    const top = Math.min(page.getHeight(), Math.max(...allPoints.map((point) => point.y)) + padding);
    if (right <= left || top <= bottom) continue;

    const color = parseCssColor(stroke.color) ?? rgb(0.9, 0.12, 0.12);
    const components = color as unknown as { red?: number; green?: number; blue?: number };
    const opacity = clampNumber(stroke.opacity, 0.08, 1, 0.54);

    try {
      const context = page.doc.context;
      const appearanceRef = createInkAnnotationAppearance(page, pdfPaths, {
        left,
        bottom,
        right,
        top,
        widthPt,
        opacity,
        red: clampNumber(components.red, 0, 1, 0.9),
        green: clampNumber(components.green, 0, 1, 0.12),
        blue: clampNumber(components.blue, 0, 1, 0.12)
      });
      const now = new Date();
      pdfInkAnnotationSerial += 1;
      const annotation = context.obj({
        Type: "Annot",
        Subtype: "Ink",
        Rect: [left, bottom, right, top],
        InkList: pdfPaths.map((path) => path.flatMap((point) => [point.x, point.y])),
        C: [
          clampNumber(components.red, 0, 1, 0.9),
          clampNumber(components.green, 0, 1, 0.12),
          clampNumber(components.blue, 0, 1, 0.12)
        ],
        CA: opacity,
        Border: [0, 0, widthPt],
        BS: { W: widthPt, S: "S" },
        F: 4,
        IT: "Ink",
        P: page.ref,
        NM: getPdfStringRuntime().of(`notedraw-ink-${now.getTime()}-${pdfInkAnnotationSerial}`),
        M: getPdfStringRuntime().of(formatPdfAnnotationDate(now)),
        Contents: getPdfStringRuntime().of("NoteDraw ink"),
        AP: { N: appearanceRef }
      });
      page.node.addAnnot(context.register(annotation));
    } catch (error) {
      console.warn("Mobile PDF Exporter NoteDraw ink annotation failed", error);
    }
  }
}

function splitInkPathForPage(
  points: Array<{ x: number; y: number }>,
  pageTopPx: number,
  pageBottomPx: number
): Array<Array<{ x: number; y: number }>> {
  const paths: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  const finish = (): void => {
    if (current.length === 1) current.push({ ...current[0], x: current[0].x + 0.01 });
    if (current.length >= 2) paths.push(current);
    current = [];
  };

  for (const point of points) {
    if (point.y >= pageTopPx && point.y <= pageBottomPx) current.push(point);
    else finish();
  }
  finish();
  return paths;
}

function stripProblematicPdfChars(text: string): string {
  let stripped = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x08 || codePoint === 0x0B || codePoint === 0x0C) continue;
    if ((codePoint >= 0x0E && codePoint <= 0x1F) || codePoint === 0x7F) continue;
    if (codePoint >= 0x1F000 && codePoint <= 0x1FAFF) continue;
    stripped += char;
  }
  return stripped.trim();
}

function shouldDrawMediaOnPage(
  fragment: { top: number; bottom: number },
  pageTopPx: number,
  pageBottomPx: number
): boolean {
  return fragment.bottom > pageTopPx && fragment.top < pageBottomPx;
}

function shouldDrawSvgOnPage(fragment: SvgFragment, pageTopPx: number, pageBottomPx: number): boolean {
  return shouldDrawMediaOnPage(fragment, pageTopPx, pageBottomPx);
}

function isLargeOrExcalidrawSvg(svg: SVGSVGElement): boolean {
  const rect = svg.getBoundingClientRect();
  const width = rect.width || svg.clientWidth || 0;
  const height = rect.height || svg.clientHeight || 0;
  return (
    width > 96 ||
    height > 96 ||
    svg.classList.contains("mobile-pdf-exporter-excalidraw-svg") ||
    Boolean(svg.closest(".mobile-pdf-exporter-excalidraw-preview, .excalidraw, .excalidraw-svg"))
  );
}

async function renderPreviewPageToPngBytes(
  model: PreviewPdfModel,
  pageIndex: number,
  options: {
    colorMode: PdfColorMode;
    rasterScale: number;
    includeText?: boolean;
    includeDecorations?: boolean;
    includeNoteDraw?: boolean;
  }
): Promise<Uint8Array> {
  const pageTopPx = model.pageBreaks[pageIndex];
  const pageBottomPx = model.pageBreaks[pageIndex + 1];
  const scale = getSafePreviewImageScale(model.sourceWidthPx, model.pageHeightPx, options.rasterScale);
  const canvas = createCanvas(model.ownerDocument);
  const context = canvas.getContext("2d");
  if (!context) throw new Error(translate(runtimeUiLanguage, "imagePdfCanvasError"));

  canvas.width = Math.max(1, Math.ceil(model.sourceWidthPx * scale));
  canvas.height = Math.max(1, Math.ceil(model.pageHeightPx * scale));
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.fillStyle = colorToCss(model.background, "color");
  context.fillRect(0, 0, model.sourceWidthPx, model.pageHeightPx);

  context.save();
  context.beginPath();
  context.rect(0, model.bodyTopInsetPx, model.sourceWidthPx, model.bodyHeightPx);
  context.clip();
  context.translate(0, model.bodyTopInsetPx);

  drawCanvasBoxLayer(context, model.boxFragments, {
    pageTopPx,
    pageBottomPx,
    colorMode: "color"
  });
  await drawCanvasImageLayer(context, model.imageFragments, {
    pageTopPx,
    pageBottomPx,
    sourceWidthPx: model.sourceWidthPx,
    pageHeightPx: model.bodyHeightPx
  });
  await drawCanvasVideoLayer(context, model.videoFragments, {
    pageTopPx,
    pageBottomPx,
    sourceWidthPx: model.sourceWidthPx,
    pageHeightPx: model.bodyHeightPx
  });
  await drawCanvasSvgLayer(context, model.svgFragments, {
    pageTopPx,
    pageBottomPx,
    sourceWidthPx: model.sourceWidthPx,
    pageHeightPx: model.bodyHeightPx,
    rasterScale: scale
  });
  if (options.includeDecorations !== false) {
    drawCanvasDecorationLayer(context, model.decorationFragments, {
      pageTopPx,
      pageBottomPx,
      sourceWidthPx: model.sourceWidthPx,
      pageHeightPx: model.bodyHeightPx,
      colorMode: "color"
    });
  }
  if (options.includeText !== false) {
    drawCanvasTextLayer(context, model.textFragments, {
      pageTopPx,
      pageBottomPx,
      sourceWidthPx: model.sourceWidthPx,
      colorMode: "color"
    });
  }
  drawCanvasBitmapLayer(context, model.canvasFragments, {
    pageTopPx,
    pageBottomPx,
    sourceWidthPx: model.sourceWidthPx,
    pageHeightPx: model.bodyHeightPx
  });
  drawCanvasNoteDrawElementLayer(context, model.noteDrawElements ?? [], {
    pageTopPx,
    pageBottomPx,
    sourceWidthPx: model.sourceWidthPx
  });
  if (options.includeNoteDraw === true) {
    drawCanvasNoteDrawInkLayer(context, model.noteDrawInkStrokes ?? [], {
      pageTopPx,
      pageBottomPx
    });
  }

  context.restore();
  drawCanvasHeaderFooter(context, model, pageIndex);

  if (options.colorMode === "grayscale") {
    context.setTransform(1, 0, 0, 1, 0, 0);
    applyCanvasGrayscale(context, canvas.width, canvas.height);
  }

  return dataUrlToUint8Array(canvas.toDataURL("image/png"));
}

function drawCanvasNoteDrawInkLayer(
  context: CanvasRenderingContext2D,
  strokes: PdfInkStroke[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
  }
): void {
  for (const stroke of strokes) {
    const strokeWidth = Math.max(0.5, stroke.widthPx);
    const offsets = stroke.brush === "watercolor"
      ? getNoteDoodlePenOffsets(Math.max(2, stroke.count + 1), strokeWidth * 0.85)
      : getNoteDoodlePenOffsets(stroke.count, strokeWidth);
    const paths = offsets.flatMap((offset) => splitInkPathForPage(
      stroke.points.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y })),
      options.pageTopPx,
      options.pageBottomPx
    ));
    if (!paths.length) continue;

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = stroke.color;
    for (const [pathIndex, path] of paths.entries()) {
      context.globalAlpha = stroke.brush === "watercolor"
        ? clampNumber(stroke.opacity, 0.08, 1, 0.34) * (pathIndex === 0 ? 0.46 : 0.22)
        : clampNumber(stroke.opacity, 0.08, 1, 0.54);
      context.lineWidth = stroke.brush === "watercolor"
        ? strokeWidth * (pathIndex === 0 ? 2.15 : 1.55)
        : strokeWidth;
      context.beginPath();
      context.moveTo(path[0].x, path[0].y - options.pageTopPx);
      for (const point of path.slice(1)) {
        context.lineTo(point.x, point.y - options.pageTopPx);
      }
      context.stroke();
    }
    context.restore();
  }
}

function drawCanvasHeaderFooter(
  context: CanvasRenderingContext2D,
  model: PreviewPdfModel,
  pageIndex: number
): void {
  const pageNumber = pageIndex + 1;
  const pageCount = Math.max(1, model.pageBreaks.length - 1);
  const header = formatHeaderFooterText(model.headerText, model.title, pageNumber, pageCount, model.exportDate);
  const footer = formatHeaderFooterText(model.footerText, model.title, pageNumber, pageCount, model.exportDate);
  if (!header && !footer) return;

  const insetX = Math.max(4, model.horizontalInsetPx);
  const maxWidth = Math.max(16, model.sourceWidthPx - insetX * 2);
  const headerY = Math.max(HEADER_FOOTER_FONT_SIZE_PX + 2, model.bodyTopInsetPx - 5);
  const footerY = Math.min(
    model.pageHeightPx - 3,
    model.pageHeightPx - model.bodyBottomInsetPx + HEADER_FOOTER_FONT_SIZE_PX + 5
  );

  if (header) {
    drawFittedCanvasPageText(context, header, insetX, headerY, maxWidth, "left", model.foreground);
  }
  if (footer) {
    drawFittedCanvasPageText(context, footer, model.sourceWidthPx - insetX, footerY, maxWidth, "right", model.foreground);
  }
}

function drawFittedCanvasPageText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  align: CanvasTextAlign,
  color: Color
): void {
  context.save();
  let fontSize = HEADER_FOOTER_FONT_SIZE_PX;
  context.font = `400 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const width = context.measureText(text).width;
  if (width > maxWidth) {
    fontSize = Math.max(7, fontSize * (maxWidth / width));
    context.font = `400 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  }
  context.fillStyle = colorToCss(color, "color");
  context.textAlign = align;
  context.textBaseline = "alphabetic";
  context.fillText(text, x, y, maxWidth);
  context.restore();
}

function formatHeaderFooterText(
  template: string,
  title: string,
  pageNumber: number,
  pageCount: number,
  exportDate: string
): string {
  return normalizeHeaderFooterTemplate(template)
    .replace(/\{title\}/giu, title)
    .replace(/\{page\}/giu, String(pageNumber))
    .replace(/\{pages\}/giu, String(pageCount))
    .replace(/\{date\}/giu, exportDate);
}

function getSafePreviewImageScale(widthPx: number, heightPx: number, requestedScale: number): number {
  const safeRequested = clampNumber(requestedScale, 1, 3, DEFAULT_SETTINGS.imageRasterScale);
  const maxPixelScale = Math.sqrt(PREVIEW_IMAGE_MAX_CANVAS_PIXELS / Math.max(1, widthPx * heightPx));
  return Math.max(0.75, Math.min(safeRequested, maxPixelScale));
}

function drawCanvasBoxLayer(
  context: CanvasRenderingContext2D,
  boxes: BoxFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    colorMode: PdfColorMode;
  }
): void {
  for (const box of boxes) {
    if (box.bottom < options.pageTopPx || box.top > options.pageBottomPx) continue;
    if (!box.background && !box.borderTop && !box.borderRight && !box.borderBottom && !box.borderLeft) continue;

    const x = Math.max(0, box.left);
    const y = box.top - options.pageTopPx;
    const width = Math.max(1, box.right - box.left);
    const height = Math.max(1, box.bottom - box.top);
    const radius = Math.min(box.borderRadiusPx, width / 2, height / 2);

    context.save();
    if (box.background) {
      context.fillStyle = box.background;
      if (radius > 0.5) {
        roundedRectPath(context, x, y, width, height, radius);
        context.fill();
      } else {
        context.fillRect(x, y, width, height);
      }
    }

    const uniformBorder = getUniformCssBorder(box);
    if (uniformBorder) {
      const inset = uniformBorder.widthPx / 2;
      context.strokeStyle = uniformBorder.color;
      context.lineWidth = uniformBorder.widthPx;
      roundedRectPath(
        context,
        x + inset,
        y + inset,
        Math.max(0.5, width - uniformBorder.widthPx),
        Math.max(0.5, height - uniformBorder.widthPx),
        Math.max(0, radius - inset)
      );
      context.stroke();
    } else {
      drawCanvasBorderSide(context, box.borderTop, x, y, x + width, y);
      drawCanvasBorderSide(context, box.borderRight, x + width, y, x + width, y + height);
      drawCanvasBorderSide(context, box.borderBottom, x + width, y + height, x, y + height);
      drawCanvasBorderSide(context, box.borderLeft, x, y + height, x, y);
    }
    context.restore();
  }
}

function getUniformCssBorder(box: BoxFragment): CssBorderFragment | null {
  const borders = [box.borderTop, box.borderRight, box.borderBottom, box.borderLeft];
  if (borders.some((border) => !border)) return null;
  const first = borders[0] as CssBorderFragment;
  return borders.every((border) => border?.color === first.color && Math.abs(border.widthPx - first.widthPx) < 0.01)
    ? first
    : null;
}

function drawCanvasBorderSide(
  context: CanvasRenderingContext2D,
  border: CssBorderFragment | null,
  startX: number,
  startY: number,
  endX: number,
  endY: number
): void {
  if (!border) return;
  context.strokeStyle = border.color;
  context.lineWidth = border.widthPx;
  context.lineCap = "butt";
  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.stroke();
}

async function drawCanvasImageLayer(
  context: CanvasRenderingContext2D,
  images: ImageFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    pageHeightPx: number;
  }
): Promise<void> {
  for (const imageFragment of images) {
    if (!shouldDrawMediaOnPage(imageFragment, options.pageTopPx, options.pageBottomPx)) continue;

    try {
      const slice = getMediaPageSlice(imageFragment, options);
      if (!slice) continue;

      const sliceBytes = await imageFragmentSliceToPngBytes(
        imageFragment.element,
        slice.offsetTopPx,
        slice.height,
        slice.fragmentHeightPx,
        "color"
      );
      const sliceImage = await imageBytesToHtmlImage(sliceBytes);
      context.drawImage(sliceImage, slice.x, slice.y, slice.width, slice.height);
    } catch (error) {
      console.warn("Mobile PDF Exporter canvas image draw failed", error);
    }
  }
}

function createInkAnnotationAppearance(
  page: PDFPage,
  paths: Array<Array<{ x: number; y: number }>>,
  options: {
    left: number;
    bottom: number;
    right: number;
    top: number;
    widthPt: number;
    opacity: number;
    red: number;
    green: number;
    blue: number;
  }
) {
  const commands = [
    "q",
    "/GS0 gs",
    `${formatPdfNumber(options.red)} ${formatPdfNumber(options.green)} ${formatPdfNumber(options.blue)} RG`,
    `${formatPdfNumber(options.widthPt)} w`,
    "1 J",
    "1 j"
  ];
  for (const path of paths) {
    if (path.length < 2) continue;
    commands.push(
      `${formatPdfNumber(path[0].x - options.left)} ${formatPdfNumber(path[0].y - options.bottom)} m`
    );
    for (const point of path.slice(1)) {
      commands.push(`${formatPdfNumber(point.x - options.left)} ${formatPdfNumber(point.y - options.bottom)} l`);
    }
    commands.push("S");
  }
  commands.push("Q");
  const context = page.doc.context;
  const stream = context.flateStream(commands.join("\n"), {
    Type: "XObject",
    Subtype: "Form",
    BBox: [0, 0, options.right - options.left, options.top - options.bottom],
    Resources: {
      ExtGState: {
        GS0: {
          Type: "ExtGState",
          CA: options.opacity,
          ca: options.opacity
        }
      }
    }
  });
  return context.register(stream);
}

function formatPdfNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4).replace(/\.?0+$/u, "") || "0" : "0";
}

function formatPdfAnnotationDate(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `D:${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`;
}

function drawCanvasNoteDrawElementLayer(
  context: CanvasRenderingContext2D,
  elements: PdfNoteDrawElement[],
  options: { pageTopPx: number; pageBottomPx: number; sourceWidthPx: number }
): void {
  for (const element of elements) {
    if (element.bottom < options.pageTopPx || element.top > options.pageBottomPx) continue;
    if (element.kind === "connector") {
      drawCanvasNoteDrawConnector(context, element, options.pageTopPx);
      continue;
    }
    const left = clampNumber(element.left, 0, options.sourceWidthPx - 1, 0);
    const top = element.top - options.pageTopPx;
    const width = Math.max(1, Math.min(element.right - element.left, options.sourceWidthPx - left));
    const height = Math.max(1, element.bottom - element.top);
    context.save();
    context.globalAlpha = element.opacity;

    if ((element.kind === "image" || element.kind === "video") && element.media) {
      const mediaWidth = element.media.instanceOf(HTMLImageElement)
        ? element.media.naturalWidth
        : element.media.width;
      const mediaHeight = element.media.instanceOf(HTMLImageElement)
        ? element.media.naturalHeight
        : element.media.height;
      const fit = containMediaRect(mediaWidth, mediaHeight, left, top, width, height);
      context.drawImage(element.media, fit.x, fit.y, fit.width, fit.height);
      if (element.kind === "video") drawCanvasVideoPlayGlyph(context, left, top, width, height);
      context.restore();
      continue;
    }

    if (element.kind === "image" || element.kind === "video" || element.kind === "file") {
      drawCanvasNoteDrawFileCard(context, element, left, top, width, height);
      if (element.kind === "video") drawCanvasVideoPlayGlyph(context, left, top, width, height);
      context.restore();
      continue;
    }

    drawCanvasNoteDrawTextElement(context, element, left, top, width, height);
    context.restore();
  }
}

function containMediaRect(
  mediaWidth: number,
  mediaHeight: number,
  left: number,
  top: number,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } {
  const ratio = Math.min(width / Math.max(1, mediaWidth), height / Math.max(1, mediaHeight));
  const drawWidth = Math.max(1, mediaWidth * ratio);
  const drawHeight = Math.max(1, mediaHeight * ratio);
  return {
    x: left + (width - drawWidth) / 2,
    y: top + (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight
  };
}

function drawCanvasNoteDrawConnector(
  context: CanvasRenderingContext2D,
  element: PdfNoteDrawElement,
  pageTopPx: number
): void {
  if (element.points.length < 2) return;
  const points = element.points.map((point) => ({ x: point.x, y: point.y - pageTopPx }));
  context.save();
  context.globalAlpha = element.opacity;
  context.strokeStyle = element.color;
  context.fillStyle = element.color;
  context.lineWidth = Math.max(1, element.width);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  if (points.length === 3) {
    context.quadraticCurveTo(points[1].x, points[1].y, points[2].x, points[2].y);
  } else {
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  }
  context.stroke();
  const last = points[points.length - 1];
  const previous = points[Math.max(0, points.length - 2)];
  const angle = Math.atan2(last.y - previous.y, last.x - previous.x);
  const size = Math.max(6, element.width * 3.4);
  context.beginPath();
  context.moveTo(last.x, last.y);
  context.lineTo(last.x - Math.cos(angle - Math.PI / 6) * size, last.y - Math.sin(angle - Math.PI / 6) * size);
  context.lineTo(last.x - Math.cos(angle + Math.PI / 6) * size, last.y - Math.sin(angle + Math.PI / 6) * size);
  context.closePath();
  context.fill();
  context.restore();
}

function drawCanvasNoteDrawTextElement(
  context: CanvasRenderingContext2D,
  element: PdfNoteDrawElement,
  left: number,
  top: number,
  width: number,
  height: number
): void {
  const style = element.buttonStyle;
  const shouldDrawBox = element.boxed || Boolean(style) || element.render !== "plain";
  if (shouldDrawBox) {
    context.lineWidth = 1.25;
    context.strokeStyle = element.color;
    context.fillStyle = style === "solid" ? element.color : "rgba(255,255,255,0.88)";
    if (style === "circle") {
      context.beginPath();
      context.arc(left + width / 2, top + height / 2, Math.min(width, height) / 2, 0, Math.PI * 2);
    } else {
      roundedRectPath(context, left, top, width, height, style === "pill" ? height / 2 : 6);
    }
    context.fill();
    context.stroke();
  }

  const text = getNoteDrawElementVisibleText(element);
  if (!text) return;
  const fontSize = Math.max(8, Math.min(element.fontSize, height * 0.78));
  context.font = `${element.bold ? "700" : "400"} ${fontSize}px ${element.code ? "monospace" : "sans-serif"}`;
  context.fillStyle = style === "solid" ? "#ffffff" : element.color;
  context.textBaseline = "top";
  const padding = shouldDrawBox ? Math.max(5, fontSize * 0.35) : 0;
  const lines = wrapCanvasText(context, text, Math.max(8, width - padding * 2));
  const lineHeight = fontSize * 1.25;
  for (let index = 0; index < lines.length; index += 1) {
    const y = top + padding + index * lineHeight;
    if (y + fontSize > top + height + 0.5) break;
    context.fillText(lines[index], left + padding, y, Math.max(8, width - padding * 2));
  }
}

function getNoteDrawElementVisibleText(element: PdfNoteDrawElement): string {
  const source = element.text || element.assetName;
  if (element.render === "html") {
    try {
      return new DOMParser().parseFromString(source, "text/html").body.textContent?.trim() ?? "";
    } catch {
      return source;
    }
  }
  if (element.render === "markdown" || element.render === "note") {
    return source
      .replace(/!?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/gu, "$1")
      .replace(/[*_~`>#-]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }
  return source.trim();
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/u)) {
    let current = "";
    for (const character of Array.from(paragraph)) {
      const next = current + character;
      if (current && context.measureText(next).width > maxWidth) {
        lines.push(current);
        current = character;
      } else {
        current = next;
      }
    }
    lines.push(current);
  }
  return lines.filter((line, index) => line || index === 0);
}

function drawCanvasNoteDrawFileCard(
  context: CanvasRenderingContext2D,
  element: PdfNoteDrawElement,
  left: number,
  top: number,
  width: number,
  height: number
): void {
  context.fillStyle = "rgba(255,255,255,0.92)";
  context.strokeStyle = element.color || "#64748b";
  context.lineWidth = 1.25;
  roundedRectPath(context, left, top, width, height, 6);
  context.fill();
  context.stroke();
  const label = element.assetName || element.text || (element.kind === "video" ? "Video" : "Attachment");
  const fontSize = Math.max(9, Math.min(16, height * 0.22));
  context.fillStyle = "#1f2937";
  context.font = `600 ${fontSize}px sans-serif`;
  context.textBaseline = "middle";
  context.fillText(label, left + 12, top + height / 2, Math.max(8, width - 24));
}

function getTextDirection(cssDirection: string, text: string): "ltr" | "rtl" {
  if (cssDirection === "rtl") return "rtl";
  if (cssDirection === "ltr") return "ltr";
  return containsCodePointInRanges(text, [
    [0x0590, 0x08ff],
    [0xfb1d, 0xfdff],
    [0xfe70, 0xfeff]
  ]) ? "rtl" : "ltr";
}

function captureVideoLinkFragments(
  videos: VideoFragment[],
  linkContext?: PdfLinkContext
): LinkFragment[] {
  return videos.flatMap((video) => {
    const directHref = normalizePdfHref(video.sourcePath ?? video.element.currentSrc ?? video.element.src);
    const href = directHref ?? (
      linkContext && video.sourcePath
        ? resolveInternalPdfHref(video.sourcePath, linkContext)
        : null
    );
    return href ? [{
      href,
      left: video.left,
      top: video.top,
      right: video.right,
      bottom: video.bottom
    }] : [];
  });
}

async function drawCanvasVideoLayer(
  context: CanvasRenderingContext2D,
  videos: VideoFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    pageHeightPx: number;
  }
): Promise<void> {
  for (const videoFragment of videos) {
    if (!shouldDrawMediaOnPage(videoFragment, options.pageTopPx, options.pageBottomPx)) continue;
    const slice = getMediaPageSlice(videoFragment, options);
    if (!slice) continue;

    try {
      const source = await getVideoExportFrame(videoFragment.element);
      if (!source) {
        drawCanvasVideoPlaceholder(context, videoFragment, slice);
        continue;
      }
      const sourceWidth = source.instanceOf(HTMLVideoElement)
        ? source.videoWidth
        : source.naturalWidth;
      const sourceHeight = source.instanceOf(HTMLVideoElement)
        ? source.videoHeight
        : source.naturalHeight;
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        drawCanvasVideoPlaceholder(context, videoFragment, slice);
        continue;
      }
      const sourceY = (slice.offsetTopPx / slice.fragmentHeightPx) * sourceHeight;
      const sourceSliceHeight = Math.max(1, (slice.height / slice.fragmentHeightPx) * sourceHeight);
      context.drawImage(
        source,
        0,
        sourceY,
        sourceWidth,
        Math.min(sourceSliceHeight, sourceHeight - sourceY),
        slice.x,
        slice.y,
        slice.width,
        slice.height
      );
      drawCanvasVideoPlayGlyph(context, slice.x, slice.y, slice.width, slice.height);
    } catch (error) {
      console.warn("Mobile PDF Exporter canvas video draw failed", error);
      drawCanvasVideoPlaceholder(context, videoFragment, slice);
    }
  }
}

async function getVideoExportFrame(video: HTMLVideoElement): Promise<HTMLVideoElement | HTMLImageElement | null> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
    return video;
  }
  if (video.poster) {
    try {
      return await loadImage(video.poster, 1800);
    } catch {
      // Continue to the video frame fallback.
    }
  }
  if (!video.currentSrc && !video.src) return null;
  await waitForVideoFrame(video, 1800);
  return video.videoWidth > 0 && video.videoHeight > 0 ? video : null;
}

function waitForVideoFrame(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("loadeddata", finish);
      video.removeEventListener("error", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    video.addEventListener("loadeddata", finish, { once: true });
    video.addEventListener("error", finish, { once: true });
    try {
      video.load();
    } catch {
      finish();
    }
  });
}

function drawCanvasVideoPlaceholder(
  context: CanvasRenderingContext2D,
  fragment: VideoFragment,
  slice: MediaPageSlice
): void {
  context.save();
  context.fillStyle = "#17191d";
  context.fillRect(slice.x, slice.y, slice.width, slice.height);
  const label = fragment.sourcePath?.split(/[\\/]/u).pop() || "Video";
  const fontSize = Math.max(9, Math.min(16, slice.height * 0.12));
  context.fillStyle = "rgba(255,255,255,0.9)";
  context.font = `500 ${fontSize}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "bottom";
  context.fillText(label, slice.x + slice.width / 2, slice.y + slice.height - Math.max(8, fontSize * 0.6), slice.width * 0.88);
  context.restore();
  drawCanvasVideoPlayGlyph(context, slice.x, slice.y, slice.width, slice.height);
}

function drawCanvasVideoPlayGlyph(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const radius = Math.max(12, Math.min(30, Math.min(width, height) * 0.16));
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  context.save();
  context.fillStyle = "rgba(0,0,0,0.58)";
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.moveTo(centerX - radius * 0.28, centerY - radius * 0.46);
  context.lineTo(centerX + radius * 0.5, centerY);
  context.lineTo(centerX - radius * 0.28, centerY + radius * 0.46);
  context.closePath();
  context.fill();
  context.restore();
}

async function drawCanvasSvgLayer(
  context: CanvasRenderingContext2D,
  svgs: SvgFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    pageHeightPx: number;
    rasterScale: number;
  }
): Promise<void> {
  const visibleSvgs = svgs
    .filter((svgFragment) => shouldDrawSvgOnPage(svgFragment, options.pageTopPx, options.pageBottomPx))
    .filter((svgFragment) => svgFragment.right > svgFragment.left && svgFragment.bottom > svgFragment.top)
    .sort((a, b) => Number(isLargeOrExcalidrawSvg(b.element)) - Number(isLargeOrExcalidrawSvg(a.element)))
    .slice(0, MAX_SVG_FRAGMENTS_PER_PAGE);

  for (const svgFragment of visibleSvgs) {
    try {
      const imageBytes = await svgElementToPngBytes(svgFragment.element, options.rasterScale, SVG_IMAGE_LOAD_TIMEOUT_MS, "color");
      if (!imageBytes) continue;
      const image = await imageBytesToHtmlImage(imageBytes);
      const slice = getMediaPageSlice(svgFragment, options);
      if (!slice) continue;

      const rasterHeight = Math.max(1, image.naturalHeight || image.height);
      const rasterWidth = Math.max(1, image.naturalWidth || image.width);
      const sourceY = (slice.offsetTopPx / slice.fragmentHeightPx) * rasterHeight;
      const sourceHeight = Math.max(1, (slice.height / slice.fragmentHeightPx) * rasterHeight);
      context.drawImage(
        image,
        0,
        sourceY,
        rasterWidth,
        Math.min(sourceHeight, rasterHeight - sourceY),
        slice.x,
        slice.y,
        slice.width,
        slice.height
      );
    } catch (error) {
      console.warn("Mobile PDF Exporter canvas SVG draw failed", error);
    }
  }
}

interface MediaPageSlice {
  x: number;
  y: number;
  width: number;
  height: number;
  offsetTopPx: number;
  fragmentHeightPx: number;
}

interface RemoteCanvasImageCacheEntry {
  source: string;
  image: Promise<HTMLImageElement | null>;
}

const remoteCanvasImageCache = new WeakMap<HTMLImageElement, RemoteCanvasImageCacheEntry>();

function getMediaPageSlice(
  fragment: { left: number; top: number; right: number; bottom: number },
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    pageHeightPx: number;
  }
): MediaPageSlice | null {
  const visibleTop = Math.max(fragment.top, options.pageTopPx);
  const visibleBottom = Math.min(fragment.bottom, options.pageBottomPx);
  if (visibleBottom <= visibleTop) return null;

  const fragmentWidthPx = Math.max(1, fragment.right - fragment.left);
  const fragmentHeightPx = Math.max(1, fragment.bottom - fragment.top);
  const x = clampNumber(fragment.left, 0, options.sourceWidthPx - 1, 0);
  const y = Math.max(0, visibleTop - options.pageTopPx);
  const width = Math.max(1, Math.min(fragmentWidthPx, options.sourceWidthPx - x));
  const height = Math.max(1, Math.min(visibleBottom - visibleTop, options.pageHeightPx - y));

  return {
    x,
    y,
    width,
    height,
    offsetTopPx: visibleTop - fragment.top,
    fragmentHeightPx
  };
}

function drawCanvasBitmapLayer(
  context: CanvasRenderingContext2D,
  canvases: CanvasFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    pageHeightPx: number;
  }
): void {
  for (const canvasFragment of canvases) {
    const visibleTop = Math.max(canvasFragment.top, options.pageTopPx);
    const visibleBottom = Math.min(canvasFragment.bottom, options.pageBottomPx);
    if (visibleBottom <= visibleTop) continue;

    const cssWidth = Math.max(1, canvasFragment.right - canvasFragment.left);
    const cssHeight = Math.max(1, canvasFragment.bottom - canvasFragment.top);
    const sourceFragmentWidth = Math.max(1, canvasFragment.sourceRightPx - canvasFragment.sourceLeftPx);
    const sourceFragmentHeight = Math.max(1, canvasFragment.sourceBottomPx - canvasFragment.sourceTopPx);
    const ratioX = sourceFragmentWidth / cssWidth;
    const ratioY = sourceFragmentHeight / cssHeight;
    const cssSliceTop = visibleTop - canvasFragment.top;
    const cssSliceHeight = visibleBottom - visibleTop;
    const sourceX = canvasFragment.sourceLeftPx;
    const sourceY = Math.max(canvasFragment.sourceTopPx, Math.floor(canvasFragment.sourceTopPx + cssSliceTop * ratioY));
    const sourceWidth = Math.max(1, Math.min(sourceFragmentWidth, Math.ceil(cssWidth * ratioX)));
    const sourceHeight = Math.max(
      1,
      Math.min(canvasFragment.sourceBottomPx - sourceY, Math.ceil(cssSliceHeight * ratioY))
    );
    const x = clampNumber(canvasFragment.left, 0, options.sourceWidthPx - 4, 0);
    const y = Math.max(0, visibleTop - options.pageTopPx);
    const width = Math.max(1, Math.min(cssWidth, options.sourceWidthPx - x));
    const height = Math.max(1, Math.min(cssSliceHeight, options.pageHeightPx - y));

    try {
      context.drawImage(
        canvasFragment.element,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        x,
        y,
        width,
        height
      );
    } catch (error) {
      console.warn("Mobile PDF Exporter canvas bitmap draw failed", error);
    }
  }
}

function isNoteDrawCanvasFragment(fragment: CanvasFragment): boolean {
  const canvas = fragment.element;
  return canvas.matches(
    ".mobile-pdf-exporter-note-doodle-canvas, .notedraw-canvas, .notedraw-static-canvas, .note-doodle-canvas, .notedraw-export-image-canvas"
  ) || Boolean(canvas.closest(
    ".notedraw-shell, .note-doodle-shell, .notedraw-export-image-canvas-layer"
  ));
}

function drawCanvasDecorationLayer(
  context: CanvasRenderingContext2D,
  decorations: DecorationFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    pageHeightPx: number;
    colorMode: PdfColorMode;
  }
): void {
  for (const decoration of decorations) {
    if (decoration.bottom < options.pageTopPx || decoration.top > options.pageBottomPx) continue;

    const x = clampNumber(decoration.left, 0, options.sourceWidthPx - 4, 0);
    const y = decoration.top - options.pageTopPx;
    const width = Math.max(1, Math.min(decoration.right - decoration.left, options.sourceWidthPx - x));
    const height = Math.max(1, Math.min(decoration.bottom - decoration.top, options.pageHeightPx - y));

    if (decoration.kind === "checkbox") {
      drawCanvasCheckbox(context, { x, y, width, height, decoration, colorMode: options.colorMode });
      continue;
    }

    if (decoration.kind === "bullet") {
      const size = Math.max(2.4, Math.min(width, height));
      context.fillStyle = colorToCss(decoration.color, options.colorMode);
      context.beginPath();
      context.arc(x + width / 2, y + height / 2, size / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }

    if ((decoration.kind === "marker" || decoration.kind === "text") && decoration.text) {
      const fontSize = Math.max(5, decoration.fontSizePx * (decoration.kind === "text" ? 0.95 : 0.88));
      drawCanvasText(context, decoration.text, {
        x,
        y: y + Math.max(0, height - fontSize) * 0.45 + fontSize * 0.86,
        size: fontSize,
        color: decoration.color,
        maxWidth: width,
        colorMode: options.colorMode
      });
    }
  }
}

function drawCanvasCheckbox(
  context: CanvasRenderingContext2D,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    decoration: DecorationFragment;
    colorMode: PdfColorMode;
  }
): void {
  const { x, y, width, height, decoration, colorMode } = options;
  const size = Math.max(5, Math.min(width, height));
  const offsetX = x + (width - size) / 2;
  const offsetY = y + (height - size) / 2;
  const border = colorToCss(decoration.border ?? decoration.color, colorMode);
  const fill = colorToCss(decoration.color, colorMode);
  const background = decoration.background ? colorToCss(decoration.background, colorMode) : null;
  const radius = Math.max(0, Math.min(size / 2, decoration.borderRadiusPx ?? size * 0.18));

  context.save();
  context.lineWidth = Math.max(0.75, decoration.borderWidthPx ?? size * 0.065);
  context.strokeStyle = border;
  roundedRectPath(context, offsetX, offsetY, size, size, radius);
  if (decoration.checked) {
    context.fillStyle = fill;
    context.fill();
  } else if (background) {
    context.fillStyle = background;
    context.fill();
  }
  context.stroke();

  if (!decoration.checked) {
    context.restore();
    return;
  }

  context.strokeStyle = "#fff";
  context.lineWidth = Math.max(1, size * 0.11);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(offsetX + size * 0.22, offsetY + size * 0.48);
  context.lineTo(offsetX + size * 0.43, offsetY + size * 0.7);
  context.lineTo(offsetX + size * 0.78, offsetY + size * 0.28);
  context.stroke();
  context.restore();
}

function drawCanvasTextLayer(
  context: CanvasRenderingContext2D,
  fragments: TextFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    colorMode: PdfColorMode;
  }
): void {
  for (const fragment of fragments) {
    if (fragment.bottom <= options.pageTopPx + 0.5 || fragment.top >= options.pageBottomPx - 0.5) continue;

    const fontSize = Math.max(5, fragment.fontSizePx);
    const left = clampNumber(fragment.left, 0, options.sourceWidthPx - 4, 0);
    const right = clampNumber(fragment.right, left + 1, options.sourceWidthPx - 1, left + 1);
    const x = fragment.direction === "rtl" ? right : left;
    const y = fragment.top - options.pageTopPx + fragment.fontSizePx * 0.86;
    const measuredWidth = Math.max(1, fragment.right - fragment.left);
    const availableWidth = fragment.direction === "rtl" ? right : options.sourceWidthPx - left;
    const maxWidth = Math.max(1, Math.min(availableWidth, measuredWidth));
    context.save();
    context.beginPath();
    context.rect(
      left,
      fragment.top - options.pageTopPx - fragment.fontSizePx * 0.2,
      measuredWidth,
      Math.max(1, fragment.bottom - fragment.top + fragment.fontSizePx * 0.4)
    );
    context.clip();
    const drawn = drawCanvasText(context, fragment.text, {
      x,
      y,
      size: fontSize,
      fontFamily: fragment.fontFamily,
      fontWeight: fragment.fontWeight,
      fontStyle: fragment.fontStyle,
      direction: fragment.direction,
      color: fragment.color,
      maxWidth,
      colorMode: options.colorMode
    });

    const decorationWidth = Math.min(maxWidth, measuredWidth + 2, drawn.width);
    if (fragment.underline && decorationWidth > 1) {
      const underlineY = y + Math.max(0.75, drawn.size * 0.12);
      context.strokeStyle = colorToCss(fragment.color, options.colorMode);
      context.lineWidth = Math.max(0.65, drawn.size * 0.055);
      context.beginPath();
      context.moveTo(fragment.direction === "rtl" ? x - decorationWidth : x, underlineY);
      context.lineTo(fragment.direction === "rtl" ? x : x + decorationWidth, underlineY);
      context.stroke();
    }

    if (fragment.lineThrough && decorationWidth > 1) {
      const strikeY = y - drawn.size * 0.31;
      context.strokeStyle = colorToCss(fragment.color, options.colorMode);
      context.lineWidth = Math.max(0.75, drawn.size * 0.06);
      context.beginPath();
      context.moveTo(fragment.direction === "rtl" ? x - decorationWidth : x, strikeY);
      context.lineTo(fragment.direction === "rtl" ? x : x + decorationWidth, strikeY);
      context.stroke();
    }
    context.restore();
  }
}

function drawCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  options: {
    x: number;
    y: number;
    size: number;
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
    direction?: "ltr" | "rtl";
    color: Color;
    maxWidth: number;
    colorMode: PdfColorMode;
  }
): { text: string; size: number; width: number } {
  const clean = normalizeCanvasVisibleText(text);
  if (!clean) return { text: "", size: options.size, width: 0 };

  let size = options.size;
  let runs = splitCanvasTextRuns(clean);
  let width = measureCanvasTextRuns(context, runs, size, options);
  if (width > options.maxWidth) {
    size = Math.max(5, size * (options.maxWidth / width));
    runs = splitCanvasTextRuns(clean);
    width = measureCanvasTextRuns(context, runs, size, options);
  }

  context.fillStyle = colorToCss(options.color, options.colorMode);
  context.textBaseline = "alphabetic";
  if (options.direction === "rtl") {
    context.save();
    context.direction = "rtl";
    context.textAlign = "right";
    context.font = getCanvasTextFont(size, false, options);
    context.fillText(clean, options.x, options.y, options.maxWidth);
    context.restore();
  } else {
    drawCanvasTextRuns(context, runs, options.x, options.y, size, options);
  }
  return { text: clean, size, width };
}

let canvasGraphemeSegmenter: { segment(input: string): Iterable<{ segment: string }> } | null | undefined;

function getCanvasGraphemeSegments(text: string): string[] {
  if (canvasGraphemeSegmenter === undefined) {
    const Segmenter = (Intl as unknown as {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity: "grapheme" }
      ) => { segment(input: string): Iterable<{ segment: string }> };
    }).Segmenter;
    canvasGraphemeSegmenter = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null;
  }
  return canvasGraphemeSegmenter
    ? Array.from(canvasGraphemeSegmenter.segment(text), (entry) => entry.segment)
    : Array.from(text);
}

function splitCanvasTextRuns(text: string): Array<{ text: string; emoji: boolean }> {
  const runs: Array<{ text: string; emoji: boolean }> = [];
  const segments = getCanvasGraphemeSegments(text);
  for (const segment of segments) {
    const emoji = isEmojiLikeText(segment);
    const previous = runs[runs.length - 1];
    if (previous && previous.emoji === emoji) {
      previous.text += segment;
    } else {
      runs.push({ text: segment, emoji });
    }
  }
  return runs;
}

function measureCanvasTextRuns(
  context: CanvasRenderingContext2D,
  runs: Array<{ text: string; emoji: boolean }>,
  size: number,
  fontOptions: {
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
  } = {}
): number {
  let width = 0;
  for (const run of runs) {
    if (run.emoji) {
      width += measureEmojiCanvasText(context, run.text, size, fontOptions);
      continue;
    }
    context.font = getCanvasTextFont(size, run.emoji, fontOptions);
    width += context.measureText(run.text).width;
  }
  return width;
}

function drawCanvasTextRuns(
  context: CanvasRenderingContext2D,
  runs: Array<{ text: string; emoji: boolean }>,
  x: number,
  y: number,
  size: number,
  fontOptions: {
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
  } = {}
): void {
  let cursorX = x;
  for (const run of runs) {
    if (run.emoji) {
      cursorX += drawEmojiCanvasText(context, run.text, cursorX, y, size, fontOptions);
      continue;
    }
    context.font = getCanvasTextFont(size, run.emoji, fontOptions);
    context.fillText(run.text, cursorX, y);
    cursorX += context.measureText(run.text).width;
  }
}

function getCanvasTextFont(
  size: number,
  emoji: boolean,
  fontOptions: {
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
  } = {}
): string {
  const textFonts = getCanvasFontFamily(fontOptions.fontFamily);
  const emojiFonts = `"Segoe UI Emoji", "Segoe UI Symbol", "Apple Color Emoji", "Noto Color Emoji"`;
  const weight = normalizeCanvasFontPart(fontOptions.fontWeight, "400");
  const style = normalizeCanvasFontPart(fontOptions.fontStyle, "normal");
  return emoji
    ? `normal 400 ${size}px ${emojiFonts}, ${textFonts}`
    : `${style} ${weight} ${size}px ${textFonts}, ${emojiFonts}`;
}

function getCanvasFontFamily(fontFamily?: string): string {
  const fallback = `"Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif`;
  const clean = (fontFamily ?? "").trim();
  if (!clean) return fallback;
  return `${clean}, ${fallback}`;
}

function normalizeCanvasFontPart(value: string | undefined, fallback: string): string {
  const clean = (value ?? "").trim();
  if (!clean) return fallback;
  return /^[\w -]+$/u.test(clean) ? clean : fallback;
}

function normalizeCanvasVisibleText(text: string): string {
  const singleLine = text.replace(/[\r\n\t\u00A0]+/gu, " ").replace(/ {2,}/gu, " ");
  return singleLine.trim();
}

function isEmojiLikeText(text: string): boolean {
  return /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0F|\u20E3)/u.test(text);
}

function measureEmojiCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  size: number,
  fontOptions: { fontFamily?: string; fontWeight?: string; fontStyle?: string } = {}
): number {
  return getEmojiSegments(text).reduce(
    (width, segment) => width + getEmojiIconAdvance(context, segment, size, fontOptions),
    0
  );
}

function drawEmojiCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  baselineY: number,
  size: number,
  fontOptions: { fontFamily?: string; fontWeight?: string; fontStyle?: string } = {}
): number {
  let cursorX = x;
  for (const segment of getEmojiSegments(text)) {
    const advance = getEmojiIconAdvance(context, segment, size, fontOptions);
    drawEmojiIcon(context, segment, cursorX, baselineY, size, fontOptions);
    cursorX += advance;
  }
  return cursorX - x;
}

function getEmojiSegments(text: string): string[] {
  return getCanvasGraphemeSegments(text).filter(Boolean);
}

function getEmojiIconAdvance(
  context: CanvasRenderingContext2D,
  segment: string,
  size: number,
  fontOptions: { fontFamily?: string; fontWeight?: string; fontStyle?: string } = {}
): number {
  context.save();
  context.font = getCanvasTextFont(size, isEmojiLikeText(segment), fontOptions);
  const measured = context.measureText(segment).width;
  context.restore();
  if (measured > 0.1) return measured;
  return isEmojiLikeText(segment) ? size * 1.08 : size * 0.55;
}

function drawEmojiIcon(
  context: CanvasRenderingContext2D,
  emoji: string,
  x: number,
  baselineY: number,
  size: number,
  fontOptions: { fontFamily?: string; fontWeight?: string; fontStyle?: string } = {}
): void {
  context.save();
  context.font = getCanvasTextFont(size, isEmojiLikeText(emoji), fontOptions);
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  if (context.measureText(emoji).width > 0.1) {
    context.fillText(emoji, x, baselineY);
    context.restore();
    return;
  }
  context.restore();

  if (!isEmojiLikeText(emoji)) {
    context.fillText(emoji, x, baselineY);
    return;
  }

  const iconSize = Math.max(7, size * 0.92);
  const top = baselineY - iconSize * 0.84;
  const left = x + Math.max(0, (size * 1.08 - iconSize) / 2);
  const centerX = left + iconSize / 2;
  const centerY = top + iconSize / 2;

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = Math.max(1.1, iconSize * 0.12);

  switch (emoji) {
    case "📎":
      context.strokeStyle = "#6b7280";
      context.lineWidth = Math.max(1.2, iconSize * 0.13);
      context.beginPath();
      context.moveTo(left + iconSize * 0.36, top + iconSize * 0.25);
      context.lineTo(left + iconSize * 0.64, top + iconSize * 0.12);
      context.quadraticCurveTo(left + iconSize * 0.86, top + iconSize * 0.26, left + iconSize * 0.72, top + iconSize * 0.48);
      context.lineTo(left + iconSize * 0.38, top + iconSize * 0.82);
      context.quadraticCurveTo(left + iconSize * 0.18, top + iconSize * 0.66, left + iconSize * 0.34, top + iconSize * 0.45);
      context.lineTo(left + iconSize * 0.58, top + iconSize * 0.22);
      context.stroke();
      break;
    case "💬":
      context.fillStyle = "#8b5cf6";
      roundedRectPath(context, left + iconSize * 0.08, top + iconSize * 0.18, iconSize * 0.78, iconSize * 0.58, iconSize * 0.18);
      context.fill();
      context.beginPath();
      context.moveTo(left + iconSize * 0.36, top + iconSize * 0.72);
      context.lineTo(left + iconSize * 0.28, top + iconSize * 0.92);
      context.lineTo(left + iconSize * 0.52, top + iconSize * 0.75);
      context.fill();
      break;
    case "💡":
      context.fillStyle = "#facc15";
      context.beginPath();
      context.arc(centerX, top + iconSize * 0.42, iconSize * 0.28, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#9ca3af";
      roundedRectPath(context, left + iconSize * 0.36, top + iconSize * 0.68, iconSize * 0.28, iconSize * 0.18, iconSize * 0.04);
      context.fill();
      break;
    case "💼":
      context.fillStyle = "#8b5a2b";
      roundedRectPath(context, left + iconSize * 0.12, top + iconSize * 0.34, iconSize * 0.76, iconSize * 0.48, iconSize * 0.08);
      context.fill();
      context.strokeStyle = "#5b3a1c";
      context.strokeRect(left + iconSize * 0.39, top + iconSize * 0.22, iconSize * 0.22, iconSize * 0.14);
      break;
    case "📋":
    case "📅":
      context.fillStyle = "#bfdbfe";
      roundedRectPath(context, left + iconSize * 0.18, top + iconSize * 0.12, iconSize * 0.64, iconSize * 0.78, iconSize * 0.08);
      context.fill();
      context.strokeStyle = "#2563eb";
      context.stroke();
      context.fillStyle = "#64748b";
      context.fillRect(left + iconSize * 0.32, top + iconSize * 0.32, iconSize * 0.36, iconSize * 0.06);
      context.fillRect(left + iconSize * 0.32, top + iconSize * 0.48, iconSize * 0.32, iconSize * 0.06);
      break;
    case "📚":
      drawBook(context, left + iconSize * 0.1, top + iconSize * 0.2, iconSize * 0.2, iconSize * 0.62, "#ef4444");
      drawBook(context, left + iconSize * 0.34, top + iconSize * 0.16, iconSize * 0.2, iconSize * 0.66, "#22c55e");
      drawBook(context, left + iconSize * 0.58, top + iconSize * 0.24, iconSize * 0.2, iconSize * 0.58, "#3b82f6");
      break;
    case "🎬":
      context.fillStyle = "#111827";
      roundedRectPath(context, left + iconSize * 0.12, top + iconSize * 0.28, iconSize * 0.76, iconSize * 0.52, iconSize * 0.07);
      context.fill();
      context.strokeStyle = "#fff";
      context.lineWidth = Math.max(0.8, iconSize * 0.08);
      context.beginPath();
      context.moveTo(left + iconSize * 0.2, top + iconSize * 0.42);
      context.lineTo(left + iconSize * 0.32, top + iconSize * 0.3);
      context.moveTo(left + iconSize * 0.45, top + iconSize * 0.42);
      context.lineTo(left + iconSize * 0.57, top + iconSize * 0.3);
      context.moveTo(left + iconSize * 0.7, top + iconSize * 0.42);
      context.lineTo(left + iconSize * 0.82, top + iconSize * 0.3);
      context.stroke();
      break;
    case "✅":
    case "☑":
      context.fillStyle = "#22c55e";
      roundedRectPath(context, left + iconSize * 0.16, top + iconSize * 0.16, iconSize * 0.68, iconSize * 0.68, iconSize * 0.12);
      context.fill();
      context.strokeStyle = "#fff";
      context.beginPath();
      context.moveTo(left + iconSize * 0.32, top + iconSize * 0.52);
      context.lineTo(left + iconSize * 0.46, top + iconSize * 0.66);
      context.lineTo(left + iconSize * 0.72, top + iconSize * 0.34);
      context.stroke();
      break;
    case "🎯":
      context.fillStyle = "#ef4444";
      context.beginPath();
      context.arc(centerX, centerY, iconSize * 0.38, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#fff";
      context.beginPath();
      context.arc(centerX, centerY, iconSize * 0.24, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#ef4444";
      context.beginPath();
      context.arc(centerX, centerY, iconSize * 0.1, 0, Math.PI * 2);
      context.fill();
      break;
    case "🔤":
      context.fillStyle = "#3b82f6";
      roundedRectPath(context, left, top + iconSize * 0.18, iconSize * 1.15, iconSize * 0.64, iconSize * 0.08);
      context.fill();
      context.fillStyle = "#fff";
      context.font = `600 ${Math.max(6, iconSize * 0.42)}px sans-serif`;
      context.fillText("abc", left + iconSize * 0.16, baselineY - iconSize * 0.16);
      break;
    case "🏠":
      context.fillStyle = "#f97316";
      context.beginPath();
      context.moveTo(centerX, top + iconSize * 0.16);
      context.lineTo(left + iconSize * 0.88, top + iconSize * 0.46);
      context.lineTo(left + iconSize * 0.76, top + iconSize * 0.46);
      context.lineTo(left + iconSize * 0.76, top + iconSize * 0.84);
      context.lineTo(left + iconSize * 0.24, top + iconSize * 0.84);
      context.lineTo(left + iconSize * 0.24, top + iconSize * 0.46);
      context.lineTo(left + iconSize * 0.12, top + iconSize * 0.46);
      context.closePath();
      context.fill();
      break;
    default:
      context.fillStyle = getGenericEmojiColor(emoji);
      context.beginPath();
      context.arc(centerX, centerY, iconSize * 0.34, 0, Math.PI * 2);
      context.fill();
      break;
  }

  context.restore();
}

function drawBook(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, color: string): void {
  context.fillStyle = color;
  roundedRectPath(context, x, y, width, height, Math.max(1, width * 0.15));
  context.fill();
  context.fillStyle = "rgba(255,255,255,0.85)";
  context.fillRect(x + width * 0.16, y + height * 0.18, width * 0.12, height * 0.64);
}

function roundedRectPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function getGenericEmojiColor(emoji: string): string {
  switch (emoji) {
    case "🌈":
      return "#22c55e";
    case "🎮":
      return "#8b5cf6";
    case "🧠":
      return "#ec4899";
    case "💻":
    case "🖥":
      return "#3b82f6";
    case "🤝":
      return "#f59e0b";
    default:
      return "#64748b";
  }
}

async function imageElementToPngBytes(image: HTMLImageElement, colorMode: PdfColorMode = "color"): Promise<Uint8Array | null> {
  try {
    const canvas = createCanvas(image);
    const context = canvas.getContext("2d");
    if (!context) return null;

    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (colorMode === "grayscale") applyCanvasGrayscale(context, canvas.width, canvas.height);
    return dataUrlToUint8Array(canvas.toDataURL("image/png"));
  } catch (error) {
    console.warn("Mobile PDF Exporter image embed failed", error);
    return null;
  }
}

async function svgElementToPngBytes(
  svg: SVGSVGElement,
  preferredScale?: number,
  timeoutMs = SVG_IMAGE_LOAD_TIMEOUT_MS,
  colorMode: PdfColorMode = "color"
): Promise<Uint8Array | null> {
  try {
    const { width, height } = getSvgRasterSize(svg);
    const canvas = createCanvas(svg);
    const context = canvas.getContext("2d");
    if (!context) return null;

    const requestedScale = preferredScale ?? Math.min(2, Math.max(1, activeWindow.devicePixelRatio || 1));
    const scale = getSvgSafeRasterScale(svg, requestedScale);
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);

    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
    clone.setCssStyles({ color: getComputedStyle(svg).color });

    // Fix text ghosting on Apple/WebKit: Excalidraw SVGs include both <text> and
    // <foreignObject> elements for the same text content. WebKit renders both,
    // causing visible ghosting/double-vision. Remove <foreignObject> duplicates
    // so only the crisp <text> elements are rasterized.
    clone.querySelectorAll("foreignObject").forEach((node) => node.remove());

    // Set text-rendering to geometricPrecision for consistent cross-platform rendering.
    clone.querySelectorAll("text").forEach((textEl) => {
      textEl.setAttribute("text-rendering", "geometricPrecision");
    });

    const xml = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const image = await loadImage(url, timeoutMs);
      context.drawImage(image, 0, 0, width, height);
      if (colorMode === "grayscale") applyCanvasGrayscale(context, canvas.width, canvas.height);
      return dataUrlToUint8Array(canvas.toDataURL("image/png"));
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    console.warn("Mobile PDF Exporter SVG embed failed", error);
    return null;
  }
}

async function imageBytesToHtmlImage(imageBytes: Uint8Array): Promise<HTMLImageElement> {
  const bytes = new Uint8Array(imageBytes.byteLength);
  bytes.set(imageBytes);
  const blob = new Blob([bytes.buffer], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url, EXCALIDRAW_IMAGE_LOAD_TIMEOUT_MS);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function imageSliceToPngBytes(
  image: HTMLImageElement,
  sourceY: number,
  sourceSliceHeight: number,
  colorMode: PdfColorMode = "color"
): Promise<Uint8Array> {
  const sourceWidth = Math.max(1, image.naturalWidth || image.width);
  const sourceHeight = Math.max(1, image.naturalHeight || image.height);
  const cropY = Math.max(0, Math.min(Math.floor(sourceY), sourceHeight - 1));
  const cropHeight = Math.max(1, Math.min(Math.ceil(sourceSliceHeight), sourceHeight - cropY));
  const scale = Math.min(
    1,
    EXCALIDRAW_MAX_SLICE_WIDTH_PX / sourceWidth,
    EXCALIDRAW_MAX_SLICE_HEIGHT_PX / cropHeight,
    Math.sqrt(EXCALIDRAW_MAX_SLICE_PIXELS / Math.max(1, sourceWidth * cropHeight))
  );
  const targetWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.floor(cropHeight * scale));
  const canvas = createCanvas(image);
  const context = canvas.getContext("2d");
  if (!context) throw new Error(translate(runtimeUiLanguage, "imageSliceError"));

  canvas.width = targetWidth;
  canvas.height = targetHeight;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = scale < 1 ? "high" : "medium";
  context.drawImage(image, 0, cropY, sourceWidth, cropHeight, 0, 0, targetWidth, targetHeight);
  if (colorMode === "grayscale") applyCanvasGrayscale(context, canvas.width, canvas.height);
  return dataUrlToUint8Array(canvas.toDataURL("image/png"));
}

async function imageFragmentSliceToPngBytes(
  image: HTMLImageElement,
  offsetTopPx: number,
  sliceHeightPx: number,
  fragmentHeightPx: number,
  colorMode: PdfColorMode = "color",
  fallback?: ImageExportFallback
): Promise<Uint8Array> {
  const sliceSource = (source: HTMLImageElement) => {
    const sourceHeight = Math.max(1, source.naturalHeight || source.height);
    const sourceY = (offsetTopPx / Math.max(1, fragmentHeightPx)) * sourceHeight;
    const sourceHeightPx = (sliceHeightPx / Math.max(1, fragmentHeightPx)) * sourceHeight;
    return imageSliceToPngBytes(source, sourceY, sourceHeightPx, colorMode);
  };

  try {
    return await sliceSource(image);
  } catch (directError) {
    const vaultImage = await loadVaultImageForCanvas(fallback);
    if (vaultImage) return sliceSource(vaultImage);
    const remoteImage = await loadRemoteImageForCanvas(image);
    if (!remoteImage) throw directError;
    return sliceSource(remoteImage);
  }
}

interface ImageExportFallback {
  app: App;
  sourcePath: string;
  linkPath?: string | null;
}

async function loadVaultImageForCanvas(fallback?: ImageExportFallback): Promise<HTMLImageElement | null> {
  const linkPath = fallback?.linkPath?.trim();
  if (!fallback || !linkPath || /^(?:app|https?|data|blob):/iu.test(linkPath)) return null;
  try {
    const file = fallback.app.metadataCache.getFirstLinkpathDest(linkPath, fallback.sourcePath) ??
      fallback.app.vault.getAbstractFileByPath(normalizePath(linkPath));
    if (!(file instanceof TFile)) return null;
    const bytes = await fallback.app.vault.readBinary(file);
    const url = URL.createObjectURL(new Blob([bytes], { type: getImageMimeType(file.extension) }));
    try {
      return await loadImage(url, IMAGE_WAIT_TIMEOUT_MS);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    console.warn("Mobile PDF Exporter vault image fallback failed", error);
    return null;
  }
}

function getImageMimeType(extension: string): string {
  switch (extension.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}

async function loadRemoteImageForCanvas(image: HTMLImageElement): Promise<HTMLImageElement | null> {
  const source = String(image.currentSrc || image.src || "").trim();
  if (!/^https?:\/\//iu.test(source)) return null;

  const cached = remoteCanvasImageCache.get(image);
  if (cached?.source === source) return cached.image;

  const imagePromise = (async () => {
    try {
      try {
        return await loadImage(source, REMOTE_IMAGE_CORS_TIMEOUT_MS, "anonymous");
      } catch {
        // Some hosts omit CORS headers even though Obsidian can request the image directly.
      }

      const response = await waitForPromiseOrTimeout(
        requestUrl({ url: source, method: "GET" }),
        REMOTE_IMAGE_REQUEST_TIMEOUT_MS
      );
      if (!response) throw new Error("Remote image download timed out.");
      if (response.status < 200 || response.status >= 300 || response.arrayBuffer.byteLength < 1) {
        throw new Error(`Remote image download failed with HTTP ${response.status}.`);
      }
      const contentType = response.headers?.["content-type"] || response.headers?.["Content-Type"] || "application/octet-stream";
      const bytes = new Uint8Array(response.arrayBuffer.byteLength);
      bytes.set(new Uint8Array(response.arrayBuffer));
      const blob = new Blob([bytes.buffer], { type: contentType.split(";", 1)[0] });
      const url = URL.createObjectURL(blob);
      try {
        return await loadImage(url, EXCALIDRAW_IMAGE_LOAD_TIMEOUT_MS);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.warn("Mobile PDF Exporter remote image fallback failed", error);
      return null;
    }
  })();

  remoteCanvasImageCache.set(image, { source, image: imagePromise });
  return imagePromise;
}

function drawLiveDrawingCanvas(
  context: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  sourceSurface: HTMLElement,
  targetSurface: HTMLElement,
  width: number,
  height: number
): boolean {
  if (sourceCanvas.width < 1 || sourceCanvas.height < 1) return false;

  try {
    const sourceRect = sourceCanvas.getBoundingClientRect();
    const surfaceRect = sourceSurface.getBoundingClientRect();
    const targetRect = targetSurface.getBoundingClientRect();
    const sourceCssWidth = Math.max(1, sourceRect.width || sourceCanvas.clientWidth || sourceCanvas.width);
    const sourceCssHeight = Math.max(1, sourceRect.height || sourceCanvas.clientHeight || sourceCanvas.height);
    const scaleX = sourceCanvas.width / sourceCssWidth;
    const scaleY = sourceCanvas.height / sourceCssHeight;
    const offsetLeftCss = Math.max(0, sourceRect.left - surfaceRect.left);
    const offsetTopCss = Math.max(0, sourceRect.top - surfaceRect.top);
    const copyWidthCss = Math.max(1, Math.min(sourceCssWidth, surfaceRect.width || sourceCssWidth));
    const copyHeightCss = Math.max(1, Math.min(sourceCssHeight, surfaceRect.height || sourceCssHeight));
    const cropX = Math.max(0, Math.min(Math.floor(offsetLeftCss * scaleX), sourceCanvas.width - 1));
    const cropY = Math.max(0, Math.min(Math.floor(offsetTopCss * scaleY), sourceCanvas.height - 1));
    const cropWidth = Math.max(1, Math.min(Math.ceil(copyWidthCss * scaleX), sourceCanvas.width - cropX));
    const cropHeight = Math.max(1, Math.min(Math.ceil(copyHeightCss * scaleY), sourceCanvas.height - cropY));
    const targetWidth = Math.max(1, width);
    const targetHeight = Math.max(1, height);
    const surfaceAspect = copyWidthCss / copyHeightCss;
    const targetAspect = targetRect.width > 0 && targetRect.height > 0
      ? targetRect.width / targetRect.height
      : targetWidth / targetHeight;

    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    if (Math.abs(surfaceAspect - targetAspect) > 0.18) {
      context.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, 0, 0, targetWidth, targetHeight);
    } else {
      context.drawImage(sourceCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);
    }
    context.restore();
    return true;
  } catch (error) {
    context.restore();
    console.warn("Mobile PDF Exporter live drawing canvas draw failed", error);
    return false;
  }
}

function drawNoteDoodleStrokes(
  context: CanvasRenderingContext2D,
  strokes: NoteDoodleStroke[],
  width: number,
  height: number,
  contentFrame?: NoteDrawContentFrame
): void {
  for (const stroke of strokes) {
    if (stroke.brush === NOTE_DOODLE_WATERCOLOR) {
      drawNoteDoodleWatercolorStroke(context, stroke, width, height, contentFrame);
    } else {
      drawNoteDoodlePenStroke(context, stroke, width, height, contentFrame);
    }
  }
}

function drawNoteDoodlePenStroke(
  context: CanvasRenderingContext2D,
  stroke: NoteDoodleStroke,
  width: number,
  height: number,
  contentFrame?: NoteDrawContentFrame
): void {
  if (!stroke.points.length) return;
  const offsets = getNoteDoodlePenOffsets(stroke.count, stroke.width);

  context.save();
  context.globalAlpha = stroke.opacity;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width;

  for (const offset of offsets) {
    context.beginPath();
    const first = noteDoodlePointToCanvas(stroke.points[0], width, height, contentFrame);
    context.moveTo(first.x + offset.x, first.y + offset.y);

    for (const point of stroke.points.slice(1)) {
      const next = noteDoodlePointToCanvas(point, width, height, contentFrame);
      context.lineTo(next.x + offset.x, next.y + offset.y);
    }

    context.stroke();
  }

  context.restore();
}

function drawNoteDoodleWatercolorStroke(
  context: CanvasRenderingContext2D,
  stroke: NoteDoodleStroke,
  width: number,
  height: number,
  contentFrame?: NoteDrawContentFrame
): void {
  if (!stroke.points.length) return;
  const strokeWidth = Math.max(2, stroke.width);
  const opacity = clampNumber(stroke.opacity || 0.34, 0.08, 1, 0.34);
  const offsets = getNoteDoodlePenOffsets(Math.max(2, stroke.count + 1), strokeWidth * 0.85);

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = stroke.color;

  for (const [layerIndex, offset] of offsets.entries()) {
    context.globalAlpha = opacity * (layerIndex === 0 ? 0.46 : 0.22);
    context.lineWidth = strokeWidth * (layerIndex === 0 ? 2.15 : 1.55);
    context.beginPath();
    const first = noteDoodlePointToCanvas(stroke.points[0], width, height, contentFrame);
    context.moveTo(first.x + offset.x, first.y + offset.y);

    for (const point of stroke.points.slice(1)) {
      const next = noteDoodlePointToCanvas(point, width, height, contentFrame);
      context.lineTo(next.x + offset.x, next.y + offset.y);
    }

    context.stroke();
  }

  context.restore();
}

function noteDoodlePointToCanvas(
  point: NoteDoodlePoint,
  width: number,
  height: number,
  contentFrame?: NoteDrawContentFrame
): { x: number; y: number } {
  const x = contentFrame && point.anchor?.basis === "note-content-v1"
    ? contentFrame.left + point.anchor.x * contentFrame.width
    : point.x * width;
  return {
    x,
    y: point.y * height
  };
}

function getNoteDoodlePenOffsets(count: number, width: number): Array<{ x: number; y: number }> {
  const safeCount = Math.round(clampNumber(count, 1, NOTE_DOODLE_MAX_PEN_COUNT, 1));
  if (safeCount <= 1) return [{ x: 0, y: 0 }];

  const radius = Math.max(2, Number(width || 3) * 1.15);
  const offsets = [{ x: 0, y: 0 }];

  for (let index = 1; index < safeCount; index += 1) {
    const angle = ((index - 1) / Math.max(1, safeCount - 1)) * Math.PI * 2;
    offsets.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    });
  }

  return offsets;
}

function getExcalidrawExportScaleCandidates(preferredScale: number): number[] {
  const candidates = [
    preferredScale,
    1.5,
    1.25,
    1,
    0.7,
    EXCALIDRAW_MIN_EXPORT_SCALE
  ];
  return Array.from(
    new Set(
      candidates
        .filter((scale) => Number.isFinite(scale))
        .map((scale) => Math.max(EXCALIDRAW_MIN_EXPORT_SCALE, Math.min(preferredScale, scale)))
        .map((scale) => Math.round(scale * 100) / 100)
    )
  ).sort((a, b) => b - a);
}

function getExcalidrawPngFallbackScaleCandidates(hasSvgApi: boolean): number[] {
  const candidates = hasSvgApi
    ? [0.7, EXCALIDRAW_MIN_EXPORT_SCALE]
    : [1, 0.7, EXCALIDRAW_MIN_EXPORT_SCALE];
  return Array.from(
    new Set(
      candidates
        .filter((scale) => Number.isFinite(scale))
        .map((scale) => Math.max(EXCALIDRAW_MIN_EXPORT_SCALE, Math.min(1, scale)))
        .map((scale) => Math.round(scale * 100) / 100)
    )
  ).sort((a, b) => b - a);
}

function getSvgSafeRasterScale(svg: SVGSVGElement, requestedScale: number): number {
  const { width, height } = getSvgRasterSize(svg);
  const maxSafeScale = Math.min(
    requestedScale,
    EXCALIDRAW_MAX_SLICE_WIDTH_PX / width,
    EXCALIDRAW_MAX_SLICE_HEIGHT_PX / height,
    Math.sqrt(EXCALIDRAW_MAX_SLICE_PIXELS / Math.max(1, width * height))
  );
  return Math.max(Number.EPSILON, Math.min(requestedScale, maxSafeScale));
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getSvgRasterSize(svg: SVGSVGElement): { width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  const width = Math.max(
    1,
    Math.ceil(
      rect.width ||
        svg.clientWidth ||
        parseSvgLength(svg.getAttribute("width")) ||
        viewBox.width ||
        16
    )
  );
  const height = Math.max(
    1,
    Math.ceil(
      rect.height ||
        svg.clientHeight ||
        parseSvgLength(svg.getAttribute("height")) ||
        viewBox.height ||
        16
    )
  );
  return { width, height };
}

function parseSvgLength(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadImage(
  url: string,
  timeoutMs = SVG_IMAGE_LOAD_TIMEOUT_MS,
  crossOrigin: "anonymous" | "use-credentials" | null = null
): Promise<HTMLImageElement> {
  const image = activeDocument.createElement("img");
  if (crossOrigin) image.crossOrigin = crossOrigin;
  let timeout = 0;
  await new Promise<void>((resolve, reject) => {
    timeout = activeWindow.setTimeout(() => reject(new Error("Image load timed out.")), timeoutMs);
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Image load failed."));
    image.src = url;
  }).finally(() => {
    activeWindow.clearTimeout(timeout);
  });
  return image;
}

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parseCssColor(value: string): Color | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "transparent") return null;

  const rgbMatch = trimmed.match(/^rgba?\(([^)]+)\)$/iu);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((part) => part.trim());
    const r = parseCssColorChannel(parts[0]);
    const g = parseCssColorChannel(parts[1]);
    const b = parseCssColorChannel(parts[2]);
    const a = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
    if ([r, g, b, a].every((part) => Number.isFinite(part)) && a > 0) {
      return rgb(r / 255, g / 255, b / 255);
    }
  }

  const hexMatch = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu);
  if (hexMatch) {
    const hex = hexMatch[1].length === 3
      ? Array.from(hexMatch[1]).map((char) => char + char).join("")
      : hexMatch[1];
    return rgb(
      Number.parseInt(hex.slice(0, 2), 16) / 255,
      Number.parseInt(hex.slice(2, 4), 16) / 255,
      Number.parseInt(hex.slice(4, 6), 16) / 255
    );
  }

  return null;
}

function parseCssColorChannel(value: string | undefined): number {
  if (!value) return Number.NaN;
  if (value.endsWith("%")) return (Number.parseFloat(value) / 100) * 255;
  return Number.parseFloat(value);
}

function outputColor(color: Color, colorMode: PdfColorMode): Color {
  if (colorMode !== "grayscale") return color;
  const channels = getPdfRgbChannels(color);
  if (!channels) return color;
  const gray = toGrayChannel(channels.red, channels.green, channels.blue);
  return rgb(gray, gray, gray);
}

function colorToCss(color: Color, colorMode: PdfColorMode): string {
  const channels = getPdfRgbChannels(outputColor(color, colorMode));
  if (!channels) return colorMode === "grayscale" ? "rgb(128, 128, 128)" : "rgb(0, 0, 0)";
  return `rgb(${Math.round(channels.red * 255)}, ${Math.round(channels.green * 255)}, ${Math.round(channels.blue * 255)})`;
}

function getPdfRgbChannels(color: Color): { red: number; green: number; blue: number } | null {
  const candidate = color as Partial<{ red: number; green: number; blue: number }>;
  if (
    typeof candidate.red === "number" &&
    typeof candidate.green === "number" &&
    typeof candidate.blue === "number"
  ) {
    return {
      red: clampNumber(candidate.red, 0, 1, 0),
      green: clampNumber(candidate.green, 0, 1, 0),
      blue: clampNumber(candidate.blue, 0, 1, 0)
    };
  }
  return null;
}

function toGrayChannel(red: number, green: number, blue: number): number {
  return clampNumber(red * 0.2126 + green * 0.7152 + blue * 0.0722, 0, 1, 0);
}

function applyCanvasGrayscale(context: CanvasRenderingContext2D, width: number, height: number): void {
  try {
    const imageData = context.getImageData(0, 0, width, height);
    const data = imageData.data;
    for (let index = 0; index < data.length; index += 4) {
      const gray = Math.round(data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722);
      data[index] = gray;
      data[index + 1] = gray;
      data[index + 2] = gray;
    }
    context.putImageData(imageData, 0, 0);
  } catch (error) {
    console.warn("Mobile PDF Exporter grayscale conversion failed", error);
  }
}

function cleanupRenderRoots(): void {
  for (const root of Array.from(activeDocument.querySelectorAll(".mobile-pdf-exporter-render-root"))) {
    root.remove();
  }
}

function createCanvas(owner: Node | Document): HTMLCanvasElement {
  const ownerDocument = owner.ownerDocument ?? owner as Document;
  return ownerDocument.createElement("canvas");
}

async function waitForPromiseOrTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeout = 0;
  type PromiseRaceResult =
    | { kind: "resolved"; value: T }
    | { kind: "rejected"; error: unknown }
    | { kind: "timeout" };
  const guardedPromise: Promise<PromiseRaceResult> = promise.then(
    (value) => ({ kind: "resolved" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error })
  );
  const timeoutPromise = new Promise<PromiseRaceResult>((resolve) => {
    timeout = activeWindow.setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });

  const result = await Promise.race([guardedPromise, timeoutPromise]).finally(() => {
    activeWindow.clearTimeout(timeout);
  });

  if (result.kind === "timeout") {
    console.warn(`Mobile PDF Exporter preview render timed out after ${timeoutMs}ms; using rendered DOM so far.`);
    return null;
  }
  if (result.kind === "rejected") throw result.error;
  return result.value;
}

async function waitForRenderedContent(container: HTMLElement, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (hasRenderedContent(container)) return;
    await nextAnimationFrame();
  }
  console.warn(`Mobile PDF Exporter rendered content wait timed out after ${timeoutMs}ms.`);
}

function getPreviewWaitProfile(container: HTMLElement): {
  renderedContentMs: number;
  initialStableMs: number;
  finalStableMs: number;
} {
  const imageCount = container.querySelectorAll("img").length;
  const svgCount = container.querySelectorAll("svg").length;
  const heavyBlockCount = container.querySelectorAll("table, pre, blockquote, .callout, .markdown-embed, .internal-embed").length;
  const textLength = container.textContent?.length ?? 0;
  const complexity = imageCount * 3 + svgCount * 3 + heavyBlockCount * 2 + Math.min(8, Math.floor(textLength / 2500));

  return {
    renderedContentMs: complexity > 8 ? 1200 : 520,
    initialStableMs: complexity > 14 ? 5200 : complexity > 6 ? 2600 : 1100,
    finalStableMs: complexity > 10 ? 1100 : 420
  };
}

async function waitForPreviewDomStable(container: HTMLElement, timeoutMs: number): Promise<void> {
  const started = Date.now();
  const minWaitMs = Math.min(420, Math.max(120, timeoutMs * 0.08));
  const stableForMs = Math.min(520, Math.max(180, timeoutMs * 0.16));
  let lastSignature = getPreviewDomSignature(container);
  let lastChangedAt = Date.now();

  const observer = new MutationObserver(() => {
    const signature = getPreviewDomSignature(container);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastChangedAt = Date.now();
    }
  });

  observer.observe(container, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true
  });

  try {
    while (Date.now() - started < timeoutMs) {
      await nextAnimationFrame(Math.min(180, FRAME_WAIT_TIMEOUT_MS));
      const signature = getPreviewDomSignature(container);
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastChangedAt = Date.now();
      }

      const waitedLongEnough = Date.now() - started >= minWaitMs;
      const stableLongEnough = Date.now() - lastChangedAt >= stableForMs;
      if (waitedLongEnough && stableLongEnough && hasRenderedContent(container)) return;
    }
  } finally {
    observer.disconnect();
  }

  console.warn(`Mobile PDF Exporter preview DOM stability wait timed out after ${timeoutMs}ms.`);
}

function getPreviewDomSignature(container: HTMLElement): string {
  return [
    container.textContent?.length ?? 0,
    container.querySelectorAll("img").length,
    container.querySelectorAll("svg").length,
    container.querySelectorAll("li, table, pre, blockquote, .callout, .markdown-embed, .internal-embed, .block-language-tasks").length,
    Math.round(container.scrollHeight),
    Math.round(container.getBoundingClientRect().height)
  ].join("|");
}

function hasRenderedContent(container: HTMLElement): boolean {
  if (container.textContent?.trim()) return true;
  return !!container.querySelector("img, svg, canvas, table, li, pre, blockquote, .callout, .markdown-embed, .internal-embed");
}

function hasExportableContent(container: HTMLElement): boolean {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (!isExportableElement(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  if (walker.nextNode()) return true;
  return Boolean(
    Array.from(container.querySelectorAll<HTMLElement | SVGSVGElement>("img, svg, canvas, table, li, blockquote, .callout, .markdown-embed, .internal-embed"))
      .some((element) => isExportableElement(element))
  );
}

async function waitForImages(container: HTMLElement, timeoutMs: number): Promise<void> {
  await waitForImagesInElements([container], timeoutMs);
}

async function waitForImagesInElements(elements: Iterable<Element>, timeoutMs: number): Promise<boolean> {
  const images = Array.from(new Set(
    Array.from(elements).flatMap((element) => Array.from(element.querySelectorAll("img")))
  )).filter((image) => !image.complete);
  if (!images.length) return false;
  const adaptiveTimeout = Math.min(timeoutMs, Math.max(360, images.length * 260));
  const imagePromise = Promise.all(
    images.map(async (image) => {
      await new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      });
    })
  );

  await waitForPromiseOrTimeout(imagePromise, adaptiveTimeout);
  return true;
}

async function nextAnimationFrame(timeoutMs = FRAME_WAIT_TIMEOUT_MS): Promise<void> {
  if (activeDocument.hidden) return;
  let frame = 0;
  let timeout = 0;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      if (frame) activeWindow.cancelAnimationFrame(frame);
      activeWindow.clearTimeout(timeout);
      resolve();
    };
    frame = activeWindow.requestAnimationFrame(finish);
    timeout = activeWindow.setTimeout(finish, timeoutMs);
  });
}

async function delay(ms: number): Promise<void> {
  if (activeDocument.hidden) return;
  await new Promise<void>((resolve) => activeWindow.setTimeout(resolve, ms));
}
