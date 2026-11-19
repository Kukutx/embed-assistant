// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { plainText, renderMarkdown, safeUrl } from "../src/markdown.js";

const html = (md: string, citation?: (n: number) => Node | null) => {
  const div = document.createElement("div");
  div.appendChild(renderMarkdown(md, { citation }));
  return div;
};

describe("renderMarkdown", () => {
  it("never interprets HTML", () => {
    const d = html('<img src=x onerror="alert(1)"> <script>alert(2)</script> **bold**');
    expect(d.querySelector("img")).toBeNull();
    expect(d.querySelector("script")).toBeNull();
    expect(d.textContent).toContain("<img src=x");
    expect(d.querySelector("strong")?.textContent).toBe("bold");
  });

  it("only links safe protocols", () => {
    const d = html("[a](javascript:alert(1)) [b](https://example.com/x) [c](data:text/html,hi) see https://example.org/page.");
    const links = [...d.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://example.com/x", "https://example.org/page"]);
    expect(d.querySelector("a")?.getAttribute("rel")).toContain("noopener");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("/relative")).toBeNull();
  });

  it("renders blocks", () => {
    const d = html("# Title\n\nPara one\nline two\n\n- a\n- b `code`\n\n1. first\n2. second\n\n```js\nconst x = 1 < 2;\n```\n\n> quote");
    expect(d.querySelector("h3")?.textContent).toBe("Title");
    expect(d.querySelector("p")?.innerHTML).toContain("<br>");
    expect(d.querySelectorAll("ul li")).toHaveLength(2);
    expect(d.querySelectorAll("ol li")).toHaveLength(2);
    expect(d.querySelector("pre code")?.textContent).toBe("const x = 1 < 2;");
    expect(d.querySelector("blockquote")?.textContent).toContain("quote");
  });

  it("renders tables", () => {
    const d = html("| Plan | Price |\n|---|---:|\n| Free | 0 |\n| Pro | 10 |");
    expect(d.querySelectorAll("th")).toHaveLength(2);
    expect(d.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("tolerates an unterminated code fence while streaming", () => {
    const d = html("Try:\n\n```bash\nnpm i");
    expect(d.querySelector("pre code")?.textContent).toBe("npm i");
  });

  it("turns [n] into citation nodes but keeps [text](url) links", () => {
    const seen: number[] = [];
    const d = html("Do this [1][2]. See [docs](https://e.com).", (n) => {
      seen.push(n);
      const s = document.createElement("sup");
      s.textContent = String(n);
      return s;
    });
    expect(seen).toEqual([1, 2]);
    expect(d.querySelectorAll("sup")).toHaveLength(2);
    expect(d.querySelector("a")?.textContent).toBe("docs");
  });

  it("strips citation markers for copy", () => {
    expect(plainText("Hello [1] world [2][3].")).toBe("Hello world.");
  });
});
