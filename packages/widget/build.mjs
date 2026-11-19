// Builds dist/loader.js (tiny, embed this) and dist/assistant.<hash>.js (lazy-loaded UI).
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const common = { bundle: true, minify: true, format: "iife", target: ["es2020", "chrome90", "firefox90", "safari15"], legalComments: "none", write: false };

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const app = await build({ ...common, entryPoints: ["src/app.ts"], define: { __VERSION__: JSON.stringify(pkg.version) } });
const appCode = app.outputFiles[0].contents;
const hash = createHash("sha256").update(appCode).digest("hex").slice(0, 10);
const appFile = `assistant.${hash}.js`;
await writeFile(`dist/${appFile}`, appCode);
await writeFile("dist/assistant.js", appCode);

const loader = await build({
  ...common,
  entryPoints: ["src/loader.ts"],
  define: { __VERSION__: JSON.stringify(pkg.version), __APP_FILE__: JSON.stringify(appFile) },
});
await writeFile("dist/loader.js", loader.outputFiles[0].contents);
await writeFile("dist/manifest.json", JSON.stringify({ version: pkg.version, loader: "loader.js", app: appFile }, null, 2));

const kb = (b) => `${(b.length / 1024).toFixed(1)} KB`;
console.log(`widget ${pkg.version}: loader.js ${kb(loader.outputFiles[0].contents)}, ${appFile} ${kb(appCode)}`);
