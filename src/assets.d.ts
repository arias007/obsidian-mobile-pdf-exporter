declare module "*.jpg" {
  const content: string;
  export default content;
}

declare module "*.gz" {
  const content: string;
  export default content;
}

declare module "*.otf" {
  const content: string;
  export default content;
}

declare module "*.png" {
  const content: string;
  export default content;
}

declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  const worker: Record<string, unknown>;
  export = worker;
}
