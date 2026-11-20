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

// Type declarations for sites written in TypeScript: served as /widget/embed-assistant.d.ts.
// Built from the public types in shared.ts so they cannot drift from the code.
const shared = await readFile(new URL("./src/shared.ts", import.meta.url), "utf8");
const sharedLines = shared.split("\n");
const pick = (name) => {
  const at = sharedLines.findIndex((l) => new RegExp(`^export (interface|type) ${name}\\b`).test(l));
  if (at < 0) throw new Error(`build: type ${name} not found in shared.ts`);
  let from = at;
  while (from > 0 && /^\s*(\/\*\*|\*)/.test(sharedLines[from - 1])) from--; // its doc comment
  let to = at;
  if (sharedLines[at].startsWith("export interface")) while (sharedLines[to] !== "}") to++;
  else while (!sharedLines[to].trimEnd().endsWith(";")) to++;
  return sharedLines.slice(from, to + 1).join("\n").replace(/^export /m, "");
};
const PUBLIC = ["PageContextInput", "UserTokenProvider", "EventName", "ToolRegistration", "Listener", "SearchResult", "EmbedAssistantApi"];
await writeFile(
  "dist/embed-assistant.d.ts",
  `// embed-assistant widget ${pkg.version}: types of window.EmbedAssistant and window.EmbedAssistantConfig.
// Add this file to your project (or reference it) to type the global API.
export {};
declare global {
${PUBLIC.map(pick).join("\n").replace(/^(?=.)/gm, "  ")}
  /** Options for loading the widget without data-* attributes (set before loader.js runs). */
  interface EmbedAssistantConfig {
    widgetId: string;
    apiBase?: string;
    locale?: string;
    position?: "bottom-right" | "bottom-left";
    accentColor?: string;
    mode?: "light" | "dark" | "auto";
    launcher?: boolean;
    open?: boolean;
    pageContext?: boolean;
    zIndex?: number;
    target?: string;
  }
  interface Window {
    EmbedAssistant?: EmbedAssistantApi;
    EmbedAssistantConfig?: EmbedAssistantConfig;
  }
}
`,
);

const kb = (b) => `${(b.length / 1024).toFixed(1)} KB`;
console.log(`widget ${pkg.version}: loader.js ${kb(loader.outputFiles[0].contents)}, ${appFile} ${kb(appCode)}`);

// Size budget: catches a runtime import that drags a library (e.g. zod from the protocol package) into the bundle.
const BUDGET = { loader: 12 * 1024, app: 150 * 1024 };
if (loader.outputFiles[0].contents.length > BUDGET.loader || appCode.length > BUDGET.app) {
  console.error(`widget bundle over budget (loader ${kb(loader.outputFiles[0].contents)} / 12 KB, app ${kb(appCode)} / 150 KB)`);
  process.exit(1);
}
