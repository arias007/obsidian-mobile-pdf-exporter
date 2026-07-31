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

function replaceExactly(source, pattern, replacement, expected, label) {
  let replacements = 0;
  const contents = source.replace(pattern, (...args) => {
    replacements += 1;
    return replacement(...args);
  });
  if (replacements !== expected) {
    throw new Error(`Expected ${expected} ${label} replacement(s), found ${replacements}.`);
  }
  return contents;
}

function sanitizeLegacyZipSchedulers(source, dependencyName) {
  const dynamicFunctionCount = (source.match(/new\s+Function\s*\(/gu) ?? []).length;
  const dynamicScriptCount = (source.match(/createElement\(\s*["']script["']\s*\)/gu) ?? []).length;
  if (dynamicFunctionCount !== 1 || dynamicScriptCount !== 4) {
    throw new Error(
      `Unexpected ${dependencyName} scheduler source: found ${dynamicFunctionCount} dynamic function and ${dynamicScriptCount} dynamic script creation(s).`
    );
  }

  let contents = replaceExactly(
    source,
    /"document"\s*in\s+t\s*&&\s*"onreadystatechange"\s*in\s+t\.document\.createElement\("script"\)\s*\?\s*function\(\)\s*\{\s*var\s+e\s*=\s*t\.document\.createElement\("script"\);[\s\S]*?t\.document\.documentElement\.appendChild\(e\);?\s*\}\s*:\s*function\(\)\s*\{\s*setTimeout\(u,\s*0\);?\s*\}/gu,
    () => "function() { setTimeout(u, 0); }",
    1,
    `${dependencyName} Promise scheduler`
  );
  contents = replaceExactly(
    contents,
    /l\s*&&\s*"onreadystatechange"\s*in\s+l\.createElement\("script"\)\s*\?\s*\(\s*s\s*=\s*l\.documentElement,\s*function\(e\)\s*\{\s*var\s+t\s*=\s*l\.createElement\("script"\);[\s\S]*?s\.appendChild\(t\);?\s*\}\s*\)\s*:\s*function\(e\)\s*\{\s*setTimeout\(c,\s*0,\s*e\);?\s*\}/gu,
    () => "function(e) { setTimeout(c, 0, e); }",
    1,
    `${dependencyName} setImmediate scheduler`
  );
  contents = replaceExactly(
    contents,
    /"function"\s*!=\s*typeof\s+e\s*&&\s*\(\s*e\s*=\s*new\s+Function\(\s*""\s*\+\s*e\s*\)\s*\)/gu,
    () => '"function" != typeof e && (() => { throw new TypeError("setImmediate callback must be a function"); })()',
    1,
    `${dependencyName} string callback`
  );

  if (/\beval\s*\(|new\s+Function\s*\(|createElement\(\s*["']script["']\s*\)/u.test(contents)) {
    throw new Error(`${dependencyName} still contains dynamic code execution after sanitization.`);
  }
  return contents;
}

const safeZipSchedulers = {
  name: "safe-zip-schedulers",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]node_modules[\\/](?:docx[\\/]dist[\\/]index\.mjs|jszip[\\/]dist[\\/]jszip\.min\.js)$/ },
      async (args) => {
        const source = await readFile(args.path, "utf8");
        const dependencyName = args.path.includes(`${process.platform === "win32" ? "\\" : "/"}docx${process.platform === "win32" ? "\\" : "/"}`)
          ? "docx"
          : "jszip";
        return {
          contents: sanitizeLegacyZipSchedulers(source, dependencyName),
          loader: "js"
        };
      }
    );
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
  plugins: [pptxGenBrowserRuntime, safeZipSchedulers],
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
