import {
  App,
  Component,
  MarkdownRenderer,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath
} from "obsidian";
import { PDFDocument, PDFFont, PDFPage, PDFString, rgb } from "pdf-lib";
import type { Color } from "pdf-lib";
import * as fontkitModule from "@pdf-lib/fontkit";
import notoSansScRegularBase64 from "../fonts/NotoSansSC-Regular.otf";

interface MobilePdfExporterSettings {
  outputFolder: string;
  marginMm: number;
  includeTitle: boolean;
  shareAfterExport: boolean;
  openAfterExport: boolean;
}

interface RenderedPreview {
  rootEl: HTMLElement;
  pageEl: HTMLElement;
  renderComponent: Component;
}

interface TextFragment {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  fontSizePx: number;
  color: Color;
  underline: boolean;
  href: string | null;
}

interface TextLineDraft {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  fontSizePx: number;
  color: Color;
  underline: boolean;
  href: string | null;
}

interface ImageFragment {
  element: HTMLImageElement;
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

interface BoxFragment {
  left: number;
  top: number;
  right: number;
  bottom: number;
  background: Color | null;
  border: Color | null;
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

const DEFAULT_SETTINGS: MobilePdfExporterSettings = {
  outputFolder: "PDF Exports",
  marginMm: 7,
  includeTitle: true,
  shareAfterExport: true,
  openAfterExport: false
};

const MOBILE_PAGE_MM = { width: 104, height: 225 };
const PDF_SUBJECT = "Selectable preview PDF exported from Obsidian";
const EXCALIDRAW_IMAGE_PDF_SUBJECT = "Image PDF exported from Obsidian Excalidraw";
const MAX_SVG_FRAGMENTS_PER_PAGE = 24;
const SVG_IMAGE_LOAD_TIMEOUT_MS = 1800;
const IMAGE_WAIT_TIMEOUT_MS = 2500;
const PREVIEW_RENDER_TIMEOUT_MS = 12000;
const EXCALIDRAW_IMAGE_RENDER_TIMEOUT_MS = 60000;
const EXCALIDRAW_IMAGE_LOAD_TIMEOUT_MS = 30000;
const EXCALIDRAW_MIN_EXPORT_SCALE = 0.5;
const EXCALIDRAW_PREFERRED_MAX_PNG_BYTES = 24 * 1024 * 1024;
const EXCALIDRAW_MAX_SLICE_WIDTH_PX = 4096;
const EXCALIDRAW_MAX_SLICE_HEIGHT_PX = 8192;
const EXCALIDRAW_MAX_SLICE_PIXELS = 16_000_000;
const FRAME_WAIT_TIMEOUT_MS = 120;
const PAGE_BREAK_PADDING_PX = 8;
const PAGE_BREAK_MIN_ADVANCE_PX = 72;
type RegisteredFontkit = Parameters<PDFDocument["registerFontkit"]>[0];
type FontkitModuleShape = Partial<RegisteredFontkit> & { default?: Partial<RegisteredFontkit> };

export default class MobilePdfExporterPlugin extends Plugin {
  settings: MobilePdfExporterSettings = DEFAULT_SETTINGS;
  private fontBytesPromise: Promise<ArrayBuffer> | null = null;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    cleanupRenderRoots();

    this.addRibbonIcon("file-output", "导出预览版 PDF", () => {
      void this.exportCurrentFile();
    });

    this.addCommand({
      id: "export-current-note-preview-pdf",
      name: "导出当前笔记为预览版 PDF",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.exportFile(file);
        return true;
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;
        menu.addItem((item) => {
          item
            .setTitle("导出预览版 PDF")
            .setIcon("file-output")
            .onClick(() => void this.exportFile(file));
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return;
        menu.addItem((item) => {
          item
            .setTitle("导出预览版 PDF")
            .setIcon("file-output")
            .onClick(() => void this.exportFile(file));
        });
      })
    );

    this.addSettingTab(new MobilePdfExporterSettingTab(this.app, this));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async exportCurrentFile(): Promise<void> {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("先打开一个 Markdown 笔记。");
      return;
    }

    await this.exportFile(file);
  }

  async exportFile(file: TFile): Promise<void> {
    const notice = new Notice("正在导出预览版 PDF...", 0);
    let rendered: RenderedPreview | null = null;

    try {
      cleanupRenderRoots();
      const markdown = await this.app.vault.cachedRead(file);
      const pdfBlob = isExcalidrawMarkdownFile(file, markdown)
        ? await this.renderExcalidrawToImagePdf(file)
        : await (async () => {
            rendered = await this.renderMarkdownPreview(file, markdown);
            return this.renderPreviewToSelectablePdf(file, rendered.pageEl);
          })();

      await this.ensureFolderExists(this.settings.outputFolder);
      const outputPath = await this.getAvailableOutputPath(file, this.settings.outputFolder);
      await this.app.vault.adapter.writeBinary(outputPath, await pdfBlob.arrayBuffer());

      notice.hide();
      new Notice(`PDF 已导出：${outputPath}`, 6000);

      if (this.settings.openAfterExport) {
        await this.app.workspace.openLinkText(outputPath, file.path, true);
      }

      if (this.settings.shareAfterExport) {
        await this.sharePdfIfAvailable(pdfBlob, outputPath);
      }
    } catch (error) {
      notice.hide();
      const message = error instanceof Error ? error.message : String(error);
      console.error("Mobile PDF Exporter failed", error);
      new Notice(`PDF 导出失败：${message}`, 8000);
    } finally {
      rendered?.renderComponent.unload();
      rendered?.rootEl.remove();
    }
  }

  private async renderExcalidrawToImagePdf(file: TFile): Promise<Blob> {
    const lease = this.getExcalidrawAutomateLease();
    if (!lease) {
      throw new Error("没有找到 Excalidraw 导出接口，请确认 Excalidraw 插件已启用。");
    }

    const errors: string[] = [];

    try {
      const exportSettings = lease.api.getExportSettings?.(true, true, false);
      const loader = lease.api.getEmbeddedFilesLoader?.(false);
      const preferredScale = Math.min(3, Math.max(2, window.devicePixelRatio || 2));
      const scales = getExcalidrawExportScaleCandidates(preferredScale);

      // Prefer SVG so Excalidraw's own createPNG path does not show "PNG too large" notices.
      if (lease.api.createSVG) {
        try {
          lease.api.reset?.();
          const svg = await waitForPromiseOrTimeout(
            lease.api.createSVG(file.path, false, exportSettings, loader, "light", 12, true, true),
            EXCALIDRAW_IMAGE_RENDER_TIMEOUT_MS
          );
          if (svg instanceof SVGSVGElement) {
            for (const scale of scales) {
              const pngBytes = await svgElementToPngBytes(svg, scale, EXCALIDRAW_IMAGE_LOAD_TIMEOUT_MS);
              if (!pngBytes || pngBytes.byteLength <= 0) continue;
              if (pngBytes.byteLength > EXCALIDRAW_PREFERRED_MAX_PNG_BYTES && scale > EXCALIDRAW_MIN_EXPORT_SCALE) continue;

              const pdfBlob = await this.tryBuildExcalidrawImagePdf(file, pngBytes, `SVG ${scale}x`);
              if (pdfBlob) return pdfBlob;
            }
          }
        } catch (error) {
          errors.push(formatErrorMessage(error));
          console.warn("Mobile PDF Exporter Excalidraw SVG fallback failed", error);
        }
      }

      if (lease.api.createPNG) {
        for (const scale of getExcalidrawPngFallbackScaleCandidates(Boolean(lease.api.createSVG))) {
          try {
            lease.api.reset?.();
            const pngBlob = await waitForPromiseOrTimeout(
              lease.api.createPNG(file.path, scale, exportSettings, loader, "light", 12),
              EXCALIDRAW_IMAGE_RENDER_TIMEOUT_MS
            );
            if (!pngBlob || pngBlob.size <= 0) {
              errors.push(`PNG ${scale}x 没有返回图片。`);
              continue;
            }

            const pdfBlob = await this.tryBuildExcalidrawImagePdf(file, await blobToUint8Array(pngBlob), `PNG ${scale}x`);
            if (pdfBlob) return pdfBlob;
          } catch (error) {
            errors.push(formatErrorMessage(error));
            console.warn(`Mobile PDF Exporter Excalidraw PNG ${scale}x failed`, error);
          }
        }
      }

      const suffix = errors.length > 0 ? `最后错误：${errors[errors.length - 1]}` : "未能取得可用图片。";
      throw new Error(`Excalidraw 图片过大或导出失败，已尝试降低分辨率和分页切片。${suffix}`);
    } finally {
      if (lease.destroyAfterUse) lease.api.destroy?.();
    }
  }

  private async tryBuildExcalidrawImagePdf(file: TFile, imageBytes: Uint8Array, label: string): Promise<Blob | null> {
    try {
      return await this.imageBytesToSlicedExcalidrawPdf(file, imageBytes);
    } catch (error) {
      console.warn(`Mobile PDF Exporter Excalidraw PDF build failed for ${label}`, error);
      return null;
    }
  }

  private async imageBytesToSlicedExcalidrawPdf(file: TFile, imageBytes: Uint8Array): Promise<Blob> {
    const sourceImage = await imageBytesToHtmlImage(imageBytes);
    const sourceWidthPx = Math.max(1, sourceImage.naturalWidth || sourceImage.width);
    const sourceHeightPx = Math.max(1, sourceImage.naturalHeight || sourceImage.height);
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(file.basename);
    pdfDoc.setSubject(EXCALIDRAW_IMAGE_PDF_SUBJECT);

    const pageWidthPt = mmToPt(MOBILE_PAGE_MM.width);
    const fixedPageHeightPt = mmToPt(MOBILE_PAGE_MM.height);
    const pageMarginPt = mmToPt(2);
    const usableWidthPt = Math.max(24, pageWidthPt - pageMarginPt * 2);
    const usableHeightPt = Math.max(24, fixedPageHeightPt - pageMarginPt * 2);
    const pxToPt = usableWidthPt / sourceWidthPx;
    const fullPageSourceHeightPx = Math.max(1, Math.floor(usableHeightPt / pxToPt));
    const singlePage = sourceHeightPx <= fullPageSourceHeightPx;
    let sourceY = 0;

    while (sourceY < sourceHeightPx) {
      const sourceSliceHeightPx = Math.min(fullPageSourceHeightPx, sourceHeightPx - sourceY);
      const sliceBytes = await imageSliceToPngBytes(sourceImage, sourceY, sourceSliceHeightPx);
      const sliceImage = await pdfDoc.embedPng(sliceBytes);
      const drawHeightPt = Math.min(usableHeightPt, sourceSliceHeightPx * pxToPt);
      const pageHeightPt = singlePage
        ? Math.max(mmToPt(20), drawHeightPt + pageMarginPt * 2)
        : fixedPageHeightPt;
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
        y: pageHeightPt - pageMarginPt - drawHeightPt,
        width: usableWidthPt,
        height: drawHeightPt
      });

      sourceY += sourceSliceHeightPx;
      await nextAnimationFrame();
    }

    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(pdfBuffer).set(pdfBytes);
    return new Blob([pdfBuffer], { type: "application/pdf" });
  }

  private getActiveMarkdownFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension.toLowerCase() !== "md") return null;
    return file;
  }

  private async renderMarkdownPreview(file: TFile, markdown: string): Promise<RenderedPreview> {
    const renderWidthPx = mmToPx(MOBILE_PAGE_MM.width);
    const paddingPx = mmToPx(this.settings.marginMm);
    const isExcalidrawFile = isExcalidrawMarkdownFile(file, markdown);
    const markdownToRender = isExcalidrawFile
      ? sanitizeExcalidrawMarkdownForPreview(markdown)
      : markdown;

    cleanupRenderRoots();
    const renderComponent = new Component();
    renderComponent.load();
    const rootEl = appendElement(document.body, "div", {
      cls: "mobile-pdf-exporter-render-root"
    });

    try {
      rootEl.style.setProperty("--mobile-pdf-exporter-width", `${renderWidthPx}px`);
      rootEl.style.setProperty("--mobile-pdf-exporter-padding", `${paddingPx}px`);
      rootEl.style.setProperty("--mobile-pdf-exporter-page-height", `${mmToPx(MOBILE_PAGE_MM.height)}px`);

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
            text: "Excalidraw 预览暂不可用，已跳过源码数据。"
          });
        }
      }

      if (!rendered) {
        await waitForRenderedContent(markdownEl, 1000);
      }

      await waitForRenderedContent(markdownEl, 1500);
      await waitForPreviewDomStable(pageEl, 8000);
      await waitForImages(pageEl, IMAGE_WAIT_TIMEOUT_MS);
      await waitForPreviewDomStable(pageEl, 1800);
      tightenSeparatorTextNodes(pageEl);
      await nextAnimationFrame(FRAME_WAIT_TIMEOUT_MS);
      await nextAnimationFrame(FRAME_WAIT_TIMEOUT_MS);

      const rect = pageEl.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || pageEl.scrollHeight < 1 || !hasExportableContent(markdownEl)) {
        throw new Error("预览层没有可导出的尺寸。");
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
      svg.style.display = "block";
      svg.style.width = "100%";
      svg.style.maxWidth = "100%";
      svg.style.height = "auto";
      const viewBox = svg.viewBox.baseVal;
      if (viewBox.width > 0 && viewBox.height > 0) {
        svg.style.aspectRatio = `${viewBox.width} / ${viewBox.height}`;
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
    const globalApi = (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomateRuntime }).ExcalidrawAutomate;
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

  private async renderPreviewToSelectablePdf(file: TFile, pageEl: HTMLElement): Promise<Blob> {
    const pageWidthPt = mmToPt(MOBILE_PAGE_MM.width);
    const pageHeightPt = mmToPt(MOBILE_PAGE_MM.height);
    const sourceWidthPx = Math.max(pageEl.getBoundingClientRect().width, 1);
    const pxToPt = pageWidthPt / sourceWidthPx;
    const pageHeightPx = pageHeightPt / pxToPt;
    const boxFragments = captureBoxFragments(pageEl);
    const textFragments = captureTextFragments(pageEl);
    const imageFragments = captureImageFragments(pageEl);
    const linkFragments = captureLinkFragments(pageEl);
    const svgFragments = captureSvgFragments(pageEl);
    const decorationFragments = captureDecorationFragments(pageEl);
    const keepBlocks = captureKeepBlockFragments(
      pageEl,
      textFragments,
      imageFragments,
      boxFragments,
      svgFragments,
      decorationFragments
    );
    const contentHeightPx = measureExportContentHeight(
      pageEl,
      textFragments,
      imageFragments,
      boxFragments,
      svgFragments,
      decorationFragments,
      keepBlocks
    );

    if (textFragments.length === 0 && imageFragments.length === 0 && svgFragments.length === 0) {
      throw new Error("预览没有可导出的内容。");
    }

    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(file.basename);
    pdfDoc.setSubject(PDF_SUBJECT);
    pdfDoc.registerFontkit(resolvePdfFontkit(fontkitModule));
    const font = await pdfDoc.embedFont(await this.loadFontBytes(), { subset: true });
    const background = parseCssColor(getComputedStyle(pageEl).backgroundColor) ?? rgb(1, 1, 1);
    const pageBreaks = computePageBreaks(contentHeightPx, pageHeightPx, keepBlocks);

    for (let index = 0; index < pageBreaks.length - 1; index += 1) {
      const pageTopPx = pageBreaks[index];
      const pageBottomPx = pageBreaks[index + 1];
      const pdfPage = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

      pdfPage.drawRectangle({
        x: 0,
        y: 0,
        width: pageWidthPt,
        height: pageHeightPt,
        color: background
      });

      drawBoxLayer(pdfPage, boxFragments, {
        pageTopPx,
        pageBottomPx,
        pageWidthPt,
        pageHeightPt,
        pxToPt
      });

      await drawImageLayer(pdfDoc, pdfPage, imageFragments, {
        pageTopPx,
        pageBottomPx,
        pageWidthPt,
        pageHeightPt,
        pxToPt
      });

      await drawSvgLayer(pdfDoc, pdfPage, svgFragments, {
        pageTopPx,
        pageBottomPx,
        pageWidthPt,
        pageHeightPt,
        pxToPt
      });

      drawDecorationLayer(pdfPage, decorationFragments, {
        font,
        pageTopPx,
        pageBottomPx,
        pageWidthPt,
        pageHeightPt,
        pxToPt
      });

      drawTextLayer(pdfPage, textFragments, {
        font,
        pageTopPx,
        pageBottomPx,
        pageWidthPt,
        pageHeightPt,
        pxToPt
      });

      drawLinkAnnotationLayer(pdfPage, linkFragments, {
        pageTopPx,
        pageBottomPx,
        pageWidthPt,
        pageHeightPt,
        pxToPt
      });
    }

    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(pdfBuffer).set(pdfBytes);
    return new Blob([pdfBuffer], { type: "application/pdf" });
  }

  private async loadFontBytes(): Promise<ArrayBuffer> {
    if (!this.fontBytesPromise) {
      this.fontBytesPromise = this.app.vault.adapter
        .readBinary(this.getPluginAssetPath("fonts/SimHei.ttf"))
        .catch(() => this.app.vault.adapter.readBinary(this.getPluginAssetPath("fonts/NotoSansSC-Regular.otf")))
        .catch(() => base64ToArrayBuffer(notoSansScRegularBase64));
    }
    return this.fontBytesPromise;
  }

  private getPluginAssetPath(relativePath: string): string {
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return normalizePath(`${pluginDir}/${relativePath}`);
  }

  private async getAvailableOutputPath(file: TFile, outputFolder: string): Promise<string> {
    const folder = normalizeOutputFolder(outputFolder);
    const date = new Date();
    const stamp = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
    const baseName = sanitizeFileName(`${file.basename}-preview-${stamp}`);

    for (let index = 0; index < 1000; index += 1) {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      const path = normalizePath(`${folder}/${baseName}${suffix}.pdf`);
      if (!(await this.app.vault.adapter.exists(path))) return path;
    }

    throw new Error("无法生成唯一 PDF 文件名。");
  }

  private async ensureFolderExists(outputFolder: string): Promise<void> {
    const folder = normalizeOutputFolder(outputFolder);
    const parts = folder.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = await this.app.vault.adapter.exists(current);
      if (!exists) await this.app.vault.createFolder(current);
    }
  }

  private async sharePdfIfAvailable(pdfBlob: Blob, outputPath: string): Promise<void> {
    const share = navigator.share?.bind(navigator);
    const canShare = navigator.canShare?.bind(navigator);
    if (!share || !canShare || typeof File === "undefined") return;

    const fileName = outputPath.split("/").pop() ?? "export.pdf";
    const file = new File([pdfBlob], fileName, { type: "application/pdf" });
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
      new Notice("PDF 已保存，但系统分享面板没有打开。", 5000);
    }
  }
}

class MobilePdfExporterSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MobilePdfExporterPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.replaceChildren();
    appendElement(containerEl, "h2", { text: "Mobile PDF Exporter" });
    appendElement(containerEl, "p", {
      text: "菜单和按钮会直接导出预览版 PDF；文字层可复制，页面固定为手机阅读尺寸。"
    });

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("PDF 保存到库里的这个文件夹。")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.outputFolder)
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Open PDF after export")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.openAfterExport)
          .onChange(async (value) => {
            this.plugin.settings.openAfterExport = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show mobile share sheet")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.shareAfterExport)
          .onChange(async (value) => {
            this.plugin.settings.shareAfterExport = value;
            await this.plugin.saveSettings();
          });
      });
  }
}

function normalizeSettings(raw: unknown): MobilePdfExporterSettings {
  const saved = (raw && typeof raw === "object" ? raw : {}) as Partial<MobilePdfExporterSettings>;
  return {
    outputFolder: typeof saved.outputFolder === "string" && saved.outputFolder.trim()
      ? saved.outputFolder.trim()
      : DEFAULT_SETTINGS.outputFolder,
    marginMm: clampNumber(saved.marginMm, 0, 18, DEFAULT_SETTINGS.marginMm),
    includeTitle: typeof saved.includeTitle === "boolean" ? saved.includeTitle : DEFAULT_SETTINGS.includeTitle,
    shareAfterExport: typeof saved.shareAfterExport === "boolean"
      ? saved.shareAfterExport
      : DEFAULT_SETTINGS.shareAfterExport,
    openAfterExport: typeof saved.openAfterExport === "boolean"
      ? saved.openAfterExport
      : DEFAULT_SETTINGS.openAfterExport
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function resolvePdfFontkit(moduleValue: unknown): RegisteredFontkit {
  const moduleShape = moduleValue as FontkitModuleShape;
  const candidate = typeof moduleShape.create === "function" ? moduleShape : moduleShape.default;
  if (!candidate || typeof candidate.create !== "function") {
    throw new Error("PDF 字体组件初始化失败：fontkit.create 不存在。");
  }
  return candidate as RegisteredFontkit;
}

function appendElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tagName: K,
  options: { cls?: string; text?: string } = {}
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (options.cls) element.className = options.cls;
  if (options.text !== undefined) element.textContent = options.text;
  parent.appendChild(element);
  return element;
}

function normalizeOutputFolder(folder: string): string {
  return normalizePath((folder.trim() || DEFAULT_SETTINGS.outputFolder).replace(/^\/+|\/+$/g, ""));
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim() || "export";
}

function mmToPx(mm: number): number {
  return Math.round((mm / 25.4) * 96);
}

function mmToPt(mm: number): number {
  return (mm / 25.4) * 72;
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
  element.style.display = "none";
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

function tightenSeparatorTextNodes(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (!isExportableElement(parent)) return NodeFilter.FILTER_REJECT;
      if (parent.closest("pre, code, kbd, samp, textarea")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const original = textNode.nodeValue ?? "";
    const tightened = tightenSeparatorText(original);
    if (tightened !== original) textNode.nodeValue = tightened;
  }
}

function tightenSeparatorText(text: string): string {
  if (!text.trim() || isPdfJumpHref(text.trim())) return text;

  const hasCjk = /[\u3400-\u9FFF\uF900-\uFAFF]/u.test(text);
  const separatorCount = (text.match(/[·•・|｜/、，,;；:：#]/gu) ?? []).length;
  const isOnlyPunctuation = /^[\s·•・|｜/、，,;；:：#()[\]（）【】<>-]+$/u.test(text);
  const withoutUnsupportedEmoji = text.replace(/[\u{1F000}-\u{1FAFF}]\uFE0F?/gu, "");
  if (!hasCjk && separatorCount < 1 && !isOnlyPunctuation && withoutUnsupportedEmoji === text) return text;

  return withoutUnsupportedEmoji
    .replace(/\s*([·•・|｜/、，,;；:：#])\s*/gu, "$1")
    .replace(/\s*([()（）【】<>])\s*/gu, "$1")
    .replace(/[ \t\u00A0]{2,}/gu, " ");
}

function captureTextFragments(pageEl: HTMLElement): TextFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const fragments: TextFragment[] = [];
  const walker = document.createTreeWalker(pageEl, NodeFilter.SHOW_TEXT, {
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
    if (parent) fragments.push(...measureTextNode(textNode, parent, pageRect));
    node = walker.nextNode();
  }

  return mergeAdjacentFragments(fragments);
}

function captureImageFragments(pageEl: HTMLElement): ImageFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  return Array.from(pageEl.querySelectorAll("img"))
    .filter((image) => isExportableElement(image) && image.naturalWidth > 0 && image.naturalHeight > 0)
    .map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        element: image,
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top
      };
    })
    .filter((fragment) => fragment.right > fragment.left && fragment.bottom > fragment.top);
}

function captureLinkFragments(pageEl: HTMLElement): LinkFragment[] {
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
    const href = resolveLinkHref(element);
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
  const selectors = [
    "pre",
    "blockquote",
    "table",
    ".callout",
    ".markdown-embed",
    ".internal-embed",
    ".HyperMD-codeblock",
    "hr"
  ].join(",");

  return Array.from(pageEl.querySelectorAll<HTMLElement>(selectors))
    .filter((element) => isExportableElement(element))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const background = parseCssColor(style.backgroundColor);
      const border = parseCssColor(style.borderColor);
      return {
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top,
        background,
        border
      };
    })
    .filter((fragment) => fragment.right > fragment.left && fragment.bottom > fragment.top);
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

    decorations.push({
      kind: "checkbox",
      left: rect.left - pageRect.left,
      top: rect.top - pageRect.top,
      right: rect.right - pageRect.left,
      bottom: rect.bottom - pageRect.top,
      color: parseCssColor(style.accentColor) ?? parseCssColor(style.color) ?? rgb(0.12, 0.12, 0.12),
      border: parseCssColor(style.borderColor) ?? parseCssColor(style.color) ?? rgb(0.35, 0.35, 0.35),
      checked: checkbox.checked,
      text: getTaskStatusText(checkbox),
      fontSizePx: parseFloat(style.fontSize) || 16
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
    const top = firstRect.top - pageRect.top + Math.max(0, (firstRect.height - size) * 0.5);
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
  boxFragments: BoxFragment[],
  svgFragments: SvgFragment[],
  decorationFragments: DecorationFragment[]
): KeepBlockFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const selectors = [
    "img",
    "picture",
    "figure",
    ".image-embed",
    "pre",
    "blockquote",
    "table",
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
  for (const box of boxFragments) blocks.push({ ...box, priority: 3 });
  for (const svg of svgFragments) blocks.push({ ...svg, priority: isLargeOrExcalidrawSvg(svg.element) ? 6 : 3 });
  for (const decoration of decorationFragments) blocks.push({ ...decoration, priority: 2 });
  for (const text of textFragments) blocks.push({ ...text, priority: 1 });

  return blocks;
}

function firstTextRectInside(element: HTMLElement): DOMRect | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (!isExportableElement(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const range = document.createRange();
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
  if (tag === "blockquote" || element.matches(".callout, .markdown-embed, .internal-embed")) return 4;
  if (tag === "li") return 3;
  if (/^h[1-6]$/u.test(tag)) return 3;
  return 2;
}

function isExportableElement(element: Element): boolean {
  if (
    element.closest(
      ".mobile-pdf-exporter-skip, .collapse-indicator, .heading-collapse-indicator, .markdown-embed-link, .copy-code-button, style, script"
    )
  ) {
    return false;
  }

  if (element.matches("pre.language-compressed-json, code.language-compressed-json")) return false;
  if (isExcalidrawSourceText(element.textContent ?? "")) return false;

  let current: Element | null = element;
  while (current) {
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    current = current.parentElement;
  }

  return true;
}

function measureTextNode(textNode: Text, parent: HTMLElement, pageRect: DOMRect): TextFragment[] {
  const style = getComputedStyle(parent);
  const fontSizePx = parseFloat(style.fontSize) || 16;
  const linkElement = parent.closest("a, .internal-link, .external-link");
  const href = resolveLinkHref(linkElement);
  const color = parseCssColor(style.color) ??
    (linkElement ? rgb(0.08, 0.36, 0.72) : rgb(0.08, 0.08, 0.08));
  const underline = Boolean(
    linkElement ||
    style.textDecorationLine.includes("underline") ||
    style.textDecoration.includes("underline")
  );
  const text = textNode.nodeValue ?? "";
  const range = document.createRange();
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
        color: current.color,
        underline: current.underline,
        href: current.href
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

    const left = rect.left - pageRect.left;
    const top = rect.top - pageRect.top;
    const right = rect.right - pageRect.left;
    const bottom = rect.bottom - pageRect.top;
    const sameLine =
      current &&
      Math.abs(top - current.top) <= Math.max(2.5, fontSizePx * 0.35) &&
      left >= current.right - fontSizePx * 0.75;

    if (!sameLine) pushCurrent();

    if (!current) {
      current = {
        text: "",
        left,
        top,
        right,
        bottom,
        fontSizePx,
        color,
        underline,
        href
      };
    }

    current.text += /\s/u.test(char) ? " " : char;
    current.left = Math.min(current.left, left);
    current.top = Math.min(current.top, top);
    current.right = Math.max(current.right, right);
    current.bottom = Math.max(current.bottom, bottom);
  }

  pushCurrent();
  range.detach();
  return fragments;
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
  const separatorCount = (clean.match(/[·•・|｜/、，,;；:：<>#()[\]（）【】]/gu) ?? []).length;
  if (!hasCjk && separatorCount < 2) return clean;

  return clean
    .replace(/\s*([·•・|｜/、，,;；:：<>#()[\]（）【】])\s*/gu, "$1")
    .replace(/([A-Za-z0-9])([:：])(?=[A-Za-z0-9])/gu, "$1$2 ")
    .replace(/[ \t\u00A0]{2,}/gu, " ")
    .trim();
}

function mergeAdjacentFragments(fragments: TextFragment[]): TextFragment[] {
  const sorted = [...fragments].sort((a, b) => (Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left));
  const merged: TextFragment[] = [];

  for (const fragment of sorted) {
    const previous = merged[merged.length - 1];
    const sameLine =
      previous &&
      Math.abs(previous.top - fragment.top) <= Math.max(2.5, fragment.fontSizePx * 0.35) &&
      fragment.left >= previous.right - fragment.fontSizePx * 0.5 &&
      previous.underline === fragment.underline &&
      previous.href === fragment.href &&
      colorsEqual(previous.color, fragment.color);

    if (!sameLine) {
      merged.push({ ...fragment });
      continue;
    }

    const gap = fragment.left - previous.right;
    const separator =
      gap > fragment.fontSizePx * 0.3 && !previous.text.endsWith(" ") && !fragment.text.startsWith(" ")
        ? " "
        : "";
    previous.text = normalizeLineText(`${previous.text}${separator}${fragment.text}`);
    previous.right = Math.max(previous.right, fragment.right);
    previous.bottom = Math.max(previous.bottom, fragment.bottom);
  }

  return merged;
}

function colorsEqual(left: Color, right: Color): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveLinkHref(linkElement: Element | null): string | null {
  if (!linkElement) return null;
  const rawValues = [
    linkElement.getAttribute("href") ??
      "",
    linkElement.getAttribute("data-href") ??
      "",
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

  return null;
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
  boxFragments: BoxFragment[],
  svgFragments: SvgFragment[],
  decorationFragments: DecorationFragment[],
  keepBlocks: KeepBlockFragment[]
): number {
  const maxTextBottom = Math.max(0, ...textFragments.map((fragment) => fragment.bottom));
  const maxImageBottom = Math.max(0, ...imageFragments.map((fragment) => fragment.bottom));
  const maxBoxBottom = Math.max(0, ...boxFragments.map((fragment) => fragment.bottom));
  const maxSvgBottom = Math.max(0, ...svgFragments.map((fragment) => fragment.bottom));
  const maxDecorationBottom = Math.max(0, ...decorationFragments.map((fragment) => fragment.bottom));
  const maxKeepBottom = Math.max(0, ...keepBlocks.map((fragment) => fragment.bottom));
  const visibleBottom = Math.max(
    maxTextBottom,
    maxImageBottom,
    maxBoxBottom,
    maxSvgBottom,
    maxDecorationBottom,
    maxKeepBottom
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
        const preferredHeight = Math.min(height, pageHeightPx * 0.92);
        return startsOnThisPage && crossesBreak && remainingHeight < preferredHeight * 0.88;
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
        const fitsOnOnePage = height < pageHeightPx * 0.96;
        const crossesBreak = fragment.top < nextBreak - 2 && fragment.bottom > nextBreak + 2;
        return startsOnThisPage && fitsOnOnePage && crossesBreak;
      })
      .sort((a, b) => b.priority - a.priority || a.top - b.top)[0];

    if (crossing) {
      const candidate = crossing.top - PAGE_BREAK_PADDING_PX;
      if (candidate > pageTop + pageHeightPx * 0.22) nextBreak = candidate;
    }

    if (nextBreak <= pageTop + PAGE_BREAK_MIN_ADVANCE_PX) nextBreak = pageTop + pageHeightPx;
    breaks.push(Math.min(nextBreak, contentHeightPx));
    pageTop = nextBreak;
  }

  if (breaks[breaks.length - 1] < contentHeightPx) breaks.push(contentHeightPx);
  return breaks;
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

function drawBoxLayer(
  page: PDFPage,
  boxes: BoxFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    pageWidthPt: number;
    pageHeightPt: number;
    pxToPt: number;
  }
): void {
  for (const box of boxes) {
    if (box.bottom < options.pageTopPx || box.top > options.pageBottomPx) continue;
    if (!box.background && !box.border) continue;

    const x = clampNumber(box.left * options.pxToPt, 0, options.pageWidthPt - 4, 0);
    const localTop = box.top - options.pageTopPx;
    const width = Math.min((box.right - box.left) * options.pxToPt, options.pageWidthPt - x);
    const height = (box.bottom - box.top) * options.pxToPt;
    const y = options.pageHeightPt - (localTop * options.pxToPt) - height;

    page.drawRectangle({
      x,
      y,
      width,
      height,
      color: box.background ?? undefined,
      borderColor: box.border ?? undefined,
      borderWidth: box.border ? 0.5 : 0
    });
  }
}

function drawTextLayer(
  page: PDFPage,
  fragments: TextFragment[],
  options: {
    font: PDFFont;
    pageTopPx: number;
    pageBottomPx: number;
    pageWidthPt: number;
    pageHeightPt: number;
    pxToPt: number;
  }
): void {
  const { font, pageTopPx, pageBottomPx, pageWidthPt, pageHeightPt, pxToPt } = options;

  for (const fragment of fragments) {
    if (fragment.bottom < pageTopPx || fragment.top > pageBottomPx) continue;

    const localTop = fragment.top - pageTopPx;
    const fontSize = Math.max(3.5, fragment.fontSizePx * pxToPt);
    const x = clampNumber(fragment.left * pxToPt, 0, pageWidthPt - 4, 0);
    const baselineY = pageHeightPt - (localTop + fragment.fontSizePx * 0.86) * pxToPt;
    const measuredWidth = Math.max(1, (fragment.right - fragment.left) * pxToPt);
    const maxWidth = Math.max(8, Math.min(pageWidthPt - x - 2, measuredWidth + 2));

    const drawn = drawSafeText(page, fragment.text, {
      x,
      y: baselineY,
      size: fontSize,
      font,
      color: fragment.color,
      maxWidth
    });

    const inkWidth = Math.min(maxWidth, Math.max(1, drawn.width));
    if (fragment.underline && inkWidth > 1) {
      const underlineY = baselineY - Math.max(0.55, drawn.size * 0.12);
      page.drawLine({
        start: { x, y: underlineY },
        end: { x: x + inkWidth, y: underlineY },
        thickness: Math.max(0.35, drawn.size * 0.055),
        color: fragment.color
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
  }
): { text: string; size: number; width: number } {
  const clean = stripProblematicPdfChars(compactSeparatorSpacing(text));
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
    color: options.color
  };

  try {
    page.drawText(clean, drawOptions);
    return { text: clean, size: fitSize, width: fitWidth };
  } catch {
    const fallback = clean.replace(/[^\u0020-\u007E\u3400-\u9FFF\uF900-\uFAFF，。！？、；：“”‘’（）《》【】￥…—]/gu, "");
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

function drawLinkAnnotationLayer(
  page: PDFPage,
  links: LinkFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    pageWidthPt: number;
    pageHeightPt: number;
    pxToPt: number;
  }
): void {
  for (const link of links) {
    if (link.bottom <= options.pageTopPx || link.top >= options.pageBottomPx) continue;

    const localTop = link.top - options.pageTopPx;
    const localBottom = link.bottom - options.pageTopPx;
    const x = clampNumber(link.left * options.pxToPt, 0, options.pageWidthPt - 1, 0);
    const right = clampNumber(link.right * options.pxToPt, x + 1, options.pageWidthPt, x + 1);
    const yTop = options.pageHeightPt - localTop * options.pxToPt;
    const yBottom = options.pageHeightPt - localBottom * options.pxToPt;
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
        URI: PDFString.of(target)
      }
    });
    const annotationRef = context.register(annotation);
    page.node.addAnnot(annotationRef);
  } catch (error) {
    console.warn("Mobile PDF Exporter link annotation failed", error);
  }
}

function stripProblematicPdfChars(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, "")
    .trim();
}

async function drawImageLayer(
  pdfDoc: PDFDocument,
  page: PDFPage,
  images: ImageFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    pageWidthPt: number;
    pageHeightPt: number;
    pxToPt: number;
  }
): Promise<void> {
  for (const imageFragment of images) {
    if (!shouldDrawMediaOnPage(imageFragment, options.pageTopPx, options.pageBottomPx)) continue;

    const imageBytes = await imageElementToPngBytes(imageFragment.element);
    if (!imageBytes) continue;

    const embeddedImage = await pdfDoc.embedPng(imageBytes);
    const sourceX = clampNumber(imageFragment.left * options.pxToPt, 0, options.pageWidthPt - 4, 0);
    const localTop = imageFragment.top - options.pageTopPx;
    const localTopPt = Math.max(0, localTop * options.pxToPt);
    const sourceWidth = Math.max(1, (imageFragment.right - imageFragment.left) * options.pxToPt);
    const sourceHeight = Math.max(1, (imageFragment.bottom - imageFragment.top) * options.pxToPt);
    const maxWidth = Math.max(8, options.pageWidthPt - sourceX);
    const maxHeight = Math.max(8, options.pageHeightPt - localTopPt - 4);
    const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    const x = sourceX + Math.max(0, Math.min(sourceWidth - width, (sourceWidth - width) / 2));
    const y = options.pageHeightPt - localTopPt - height;

    page.drawImage(embeddedImage, { x, y, width, height });
  }
}

function shouldDrawMediaOnPage(
  fragment: { top: number; bottom: number },
  pageTopPx: number,
  pageBottomPx: number
): boolean {
  if (fragment.bottom <= pageTopPx || fragment.top >= pageBottomPx) return false;
  if (fragment.top < pageTopPx - 1) return false;
  return fragment.top < pageBottomPx - PAGE_BREAK_PADDING_PX;
}

async function drawSvgLayer(
  pdfDoc: PDFDocument,
  page: PDFPage,
  svgs: SvgFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    pageWidthPt: number;
    pageHeightPt: number;
    pxToPt: number;
  }
): Promise<void> {
  const svgCache = new Map<string, Promise<Uint8Array | null>>();
  const visibleSvgs = svgs
    .filter((svgFragment) => shouldDrawSvgOnPage(svgFragment, options.pageTopPx, options.pageBottomPx))
    .filter((svgFragment) => {
      const width = svgFragment.right - svgFragment.left;
      const height = svgFragment.bottom - svgFragment.top;
      return width > 0 && height > 0;
    })
    .sort((a, b) => Number(isLargeOrExcalidrawSvg(b.element)) - Number(isLargeOrExcalidrawSvg(a.element)))
    .slice(0, MAX_SVG_FRAGMENTS_PER_PAGE);

  const prepared = visibleSvgs.map((svgFragment) => {
    const sourceX = clampNumber(svgFragment.left * options.pxToPt, 0, options.pageWidthPt - 4, 0);
    const localTop = svgFragment.top - options.pageTopPx;
    const localTopPt = Math.max(0, localTop * options.pxToPt);
    const sourceWidth = Math.max(1, (svgFragment.right - svgFragment.left) * options.pxToPt);
    const sourceHeight = Math.max(1, (svgFragment.bottom - svgFragment.top) * options.pxToPt);
    const maxWidth = Math.max(8, options.pageWidthPt - sourceX);
    const maxHeight = Math.max(8, options.pageHeightPt - localTopPt - 4);
    const scale = isLargeOrExcalidrawSvg(svgFragment.element)
      ? Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight)
      : 1;
    const width = Math.min(sourceWidth * scale, maxWidth);
    const height = Math.min(sourceHeight * scale, maxHeight);
    const x = sourceX + Math.max(0, Math.min(sourceWidth - width, (sourceWidth - width) / 2));
    const y = options.pageHeightPt - localTopPt - height;

    const style = getComputedStyle(svgFragment.element);
    const cacheKey = [
      Math.round(svgFragment.right - svgFragment.left),
      Math.round(svgFragment.bottom - svgFragment.top),
      style.color,
      svgFragment.element.outerHTML
    ].join("|");
    let imagePromise = svgCache.get(cacheKey);
    if (!imagePromise) {
      imagePromise = svgElementToPngBytes(svgFragment.element);
      svgCache.set(cacheKey, imagePromise);
    }
    return { x, y, width, height, imagePromise };
  });

  const loaded = await Promise.all(
    prepared.map(async (item) => ({
      ...item,
      imageBytes: await item.imagePromise.catch(() => null)
    }))
  );

  for (const item of loaded) {
    if (!item.imageBytes) continue;

    try {
      const embeddedImage = await pdfDoc.embedPng(item.imageBytes);
      page.drawImage(embeddedImage, { x: item.x, y: item.y, width: item.width, height: item.height });
    } catch (error) {
      console.warn("Mobile PDF Exporter SVG draw failed", error);
    }
  }
}

function shouldDrawSvgOnPage(fragment: SvgFragment, pageTopPx: number, pageBottomPx: number): boolean {
  if (isLargeOrExcalidrawSvg(fragment.element)) {
    return shouldDrawMediaOnPage(fragment, pageTopPx, pageBottomPx);
  }
  return fragment.bottom >= pageTopPx && fragment.top <= pageBottomPx;
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

function drawDecorationLayer(
  page: PDFPage,
  decorations: DecorationFragment[],
  options: {
    font: PDFFont;
    pageTopPx: number;
    pageBottomPx: number;
    pageWidthPt: number;
    pageHeightPt: number;
    pxToPt: number;
  }
): void {
  for (const decoration of decorations) {
    if (decoration.bottom < options.pageTopPx || decoration.top > options.pageBottomPx) continue;

    const x = clampNumber(decoration.left * options.pxToPt, 0, options.pageWidthPt - 4, 0);
    const localTop = decoration.top - options.pageTopPx;
    const width = Math.max(1, Math.min((decoration.right - decoration.left) * options.pxToPt, options.pageWidthPt - x));
    const height = Math.max(1, (decoration.bottom - decoration.top) * options.pxToPt);
    const y = options.pageHeightPt - (localTop * options.pxToPt) - height;

    if (decoration.kind === "checkbox") {
      drawCheckbox(page, { x, y, width, height, decoration });
      continue;
    }

    if (decoration.kind === "bullet") {
      const size = Math.max(1.8, Math.min(width, height));
      page.drawCircle({
        x: x + width / 2,
        y: y + height / 2,
        size: size / 2,
        color: decoration.color
      });
      continue;
    }

    if ((decoration.kind === "marker" || decoration.kind === "text") && decoration.text) {
      const fontSize = Math.max(3.5, decoration.fontSizePx * options.pxToPt * (decoration.kind === "text" ? 0.95 : 0.88));
      drawSafeText(page, decoration.text, {
        x,
        y: y + Math.max(0, height - fontSize) * 0.45,
        size: fontSize,
        font: options.font,
        color: decoration.color,
        maxWidth: width
      });
    }
  }
}

function drawCheckbox(
  page: PDFPage,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    decoration: DecorationFragment;
  }
): void {
  const { x, y, width, height, decoration } = options;
  const size = Math.max(4, Math.min(width, height));
  const offsetX = x + (width - size) / 2;
  const offsetY = y + (height - size) / 2;
  const border = decoration.border ?? decoration.color;

  page.drawRectangle({
    x: offsetX,
    y: offsetY,
    width: size,
    height: size,
    borderColor: border,
    borderWidth: Math.max(0.35, size * 0.08),
    color: decoration.checked ? decoration.color : undefined
  });

  if (!decoration.checked) return;

  const checkColor = rgb(1, 1, 1);
  const thickness = Math.max(0.45, size * 0.11);
  page.drawLine({
    start: { x: offsetX + size * 0.22, y: offsetY + size * 0.52 },
    end: { x: offsetX + size * 0.43, y: offsetY + size * 0.3 },
    thickness,
    color: checkColor
  });
  page.drawLine({
    start: { x: offsetX + size * 0.42, y: offsetY + size * 0.3 },
    end: { x: offsetX + size * 0.78, y: offsetY + size * 0.72 },
    thickness,
    color: checkColor
  });
}

async function imageElementToPngBytes(image: HTMLImageElement): Promise<Uint8Array | null> {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return null;

    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return dataUrlToUint8Array(canvas.toDataURL("image/png"));
  } catch (error) {
    console.warn("Mobile PDF Exporter image embed failed", error);
    return null;
  }
}

async function svgElementToPngBytes(
  svg: SVGSVGElement,
  preferredScale?: number,
  timeoutMs = SVG_IMAGE_LOAD_TIMEOUT_MS
): Promise<Uint8Array | null> {
  try {
    const { width, height } = getSvgRasterSize(svg);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return null;

    const requestedScale = preferredScale ?? Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const maxSafeScale = Math.min(
      requestedScale,
      EXCALIDRAW_MAX_SLICE_WIDTH_PX / width,
      EXCALIDRAW_MAX_SLICE_HEIGHT_PX / height,
      Math.sqrt(EXCALIDRAW_MAX_SLICE_PIXELS / Math.max(1, width * height))
    );
    const scale = Math.max(Number.EPSILON, Math.min(requestedScale, maxSafeScale));
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);

    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
    clone.style.color = getComputedStyle(svg).color;

    const xml = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const image = await loadImage(url, timeoutMs);
      context.drawImage(image, 0, 0, width, height);
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
  sourceSliceHeight: number
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
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("图片切片失败：canvas 不可用。");

  canvas.width = targetWidth;
  canvas.height = targetHeight;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = scale < 1 ? "high" : "medium";
  context.drawImage(image, 0, cropY, sourceWidth, cropHeight, 0, 0, targetWidth, targetHeight);
  return dataUrlToUint8Array(canvas.toDataURL("image/png"));
}

function getExcalidrawExportScaleCandidates(preferredScale: number): number[] {
  const candidates = [
    preferredScale,
    3,
    2.5,
    2,
    1.5,
    1,
    0.75,
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
    ? [0.75, EXCALIDRAW_MIN_EXPORT_SCALE]
    : [1, 0.75, EXCALIDRAW_MIN_EXPORT_SCALE];
  return Array.from(
    new Set(
      candidates
        .filter((scale) => Number.isFinite(scale))
        .map((scale) => Math.max(EXCALIDRAW_MIN_EXPORT_SCALE, Math.min(1, scale)))
        .map((scale) => Math.round(scale * 100) / 100)
    )
  ).sort((a, b) => b - a);
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

async function loadImage(url: string, timeoutMs = SVG_IMAGE_LOAD_TIMEOUT_MS): Promise<HTMLImageElement> {
  const image = new Image();
  let timeout = 0;
  await new Promise<void>((resolve, reject) => {
    timeout = window.setTimeout(() => reject(new Error("Image load timed out.")), timeoutMs);
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Image load failed."));
    image.src = url;
  }).finally(() => {
    window.clearTimeout(timeout);
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

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
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

function cleanupRenderRoots(): void {
  for (const root of Array.from(document.querySelectorAll(".mobile-pdf-exporter-render-root"))) {
    root.remove();
  }
}

async function waitForPromiseOrTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeout = 0;
  const guardedPromise = promise.then(
    (value) => ({ kind: "resolved" as const, value }),
    (error) => ({ kind: "rejected" as const, error })
  );
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timeout = window.setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });

  const result = await Promise.race([guardedPromise, timeoutPromise]).finally(() => {
    window.clearTimeout(timeout);
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

async function waitForPreviewDomStable(container: HTMLElement, timeoutMs: number): Promise<void> {
  const started = Date.now();
  const minWaitMs = Math.min(700, Math.max(250, timeoutMs * 0.12));
  const stableForMs = Math.min(900, Math.max(320, timeoutMs * 0.2));
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
    Math.round(container.getBoundingClientRect().height),
    container.innerHTML.length
  ].join("|");
}

function hasRenderedContent(container: HTMLElement): boolean {
  if (container.textContent?.trim()) return true;
  return !!container.querySelector("img, svg, canvas, table, li, pre, blockquote, .callout, .markdown-embed, .internal-embed");
}

function hasExportableContent(container: HTMLElement): boolean {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
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
  const images = Array.from(container.querySelectorAll("img"));
  const imagePromise = Promise.all(
    images.map(async (image) => {
      if (image.complete) return;
      await new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      });
    })
  );

  await waitForPromiseOrTimeout(imagePromise, timeoutMs);
}

async function nextAnimationFrame(timeoutMs = FRAME_WAIT_TIMEOUT_MS): Promise<void> {
  let frame = 0;
  let timeout = 0;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      resolve();
    };
    frame = requestAnimationFrame(finish);
    timeout = window.setTimeout(finish, timeoutMs);
  });
}
