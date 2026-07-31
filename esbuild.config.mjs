import { readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import process from "node:process";
import esbuild from "esbuild";

const prod = process.argv[2] === "production";
const builtins = Array.from(new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]));
const pptxGenBrowserRuntime = {
  name: "pptxgen-browser-runtime",
  setup(build) {
    build.onLoad({ filter: /pptxgen\.es\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      let replacements = 0;
      const contents = source.replace(
        /const isNode = typeof process !== 'undefined'[^\r\n]*;/gu,
        () => {
          replacements += 1;
          return "const isNode = false;";
        }
      );
      if (replacements !== 2) {
        throw new Error(`Expected two PptxGenJS runtime checks, found ${replacements}.`);
      }
      return { contents, loader: "js" };
    });
  }
};

const context = await esbuild.context({
  banner: {
    js: "/* Mobile PDF Exporter for Obsidian */"
  },
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  loader: {
    ".gz": "base64",
    ".jpg": "base64",
    ".png": "base64",
    ".otf": "base64"
  },
  logLevel: "info",
  minify: prod,
  outfile: "main.js",
  platform: "browser",
  plugins: [pptxGenBrowserRuntime],
  sourcemap: prod ? false : "inline",
  target: "es2021",
  treeShaking: true
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  const output = await readFile("main.js", "utf8");
  await writeFile("main.js", output.replace(/[ \t]+$/gm, ""), "utf8");
} else {
  await context.watch();
}
