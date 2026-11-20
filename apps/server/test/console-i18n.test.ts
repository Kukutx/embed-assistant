import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The admin console is written in English; i18n/<lang>.json maps English UI texts to translations.
const dir = join(import.meta.dirname, "..", "static", "admin");
const source = readFileSync(join(dir, "admin.js"), "utf8");
const keys = new Set([...source.matchAll(/\btx\(("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]!) as string));
/** Texts that read the same in every language (examples of values to type). */
const SAME = new Set(["company.com, subsidiary.com", "public, users, staff"]);
const placeholders = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
const catalogs = readdirSync(join(dir, "i18n")).filter((f) => f.endsWith(".json"));

describe("admin console translations", () => {
  it("finds the console texts", () => {
    expect(keys.size).toBeGreaterThan(500);
    expect(catalogs.length).toBeGreaterThan(0);
  });

  for (const file of catalogs) {
    it(`${file} is complete and current`, () => {
      const catalog = JSON.parse(readFileSync(join(dir, "i18n", file), "utf8")) as Record<string, string>;
      expect(Object.keys(catalog).filter((k) => !keys.has(k)), "translations of texts the console no longer has").toEqual([]);
      expect([...keys].filter((k) => !(k in catalog) && !SAME.has(k)), "texts without a translation").toEqual([]);
      for (const [k, v] of Object.entries(catalog)) expect(placeholders(v), `placeholders of "${k}"`).toEqual(placeholders(k));
    });
  }

  it("lists every catalog in the language picker", () => {
    const langs = /const LANGS = \{([^}]*)\}/.exec(source)![1]!;
    for (const file of catalogs) expect(langs).toContain(`${file.replace(".json", "")}:`);
  });
});
