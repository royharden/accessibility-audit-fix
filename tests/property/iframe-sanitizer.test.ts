// what_bug_this_catches: active/resource HTML surviving the stripped profile, escaped CSS fetches, template/SVG
// mutation bypasses or lost native link semantics. Parse5/source properties only; never a browser security claim.
// Written in Dirty Mode, not run.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { getAttr, parsePage, textContent } from "../../src/core/html/parse.ts";
import { csp, IFRAME_SANDBOX, preparedSrcdoc, unsafeCss } from "../../src/engines/iframe/csp.ts";

const nonce = "a".repeat(48);
const render = (source: string) => preparedSrcdoc(source, { nonce, runner: ";void 0;/*trusted unit runner*/", insertedTitleStart: null });
const fragments = [
  '<script src="https://example.test/x.js">bad()</script>', '<template><script>bad()</script><img src="https://example.test/x" onerror="bad()"></template>',
  '<iframe src="https://example.test" srcdoc="<script>bad()</script>" title="Map"></iframe>',
  '<base href="https://example.test/"><link rel="stylesheet" href="https://example.test/x.css"><meta http-equiv="refresh" content="0;url=https://example.test">',
  '<object data="https://example.test"><embed src="https://example.test"></object><applet></applet>',
  '<svg><script>bad()</script><use href="https://example.test/a.svg"><set attributeName="data-a11y-ord" to="999"></set><animate attributeName="href" values="https://example.test"></animate></use><foreignObject><button onclick="bad()">Safe text</button></foreignObject></svg>',
  '<a href="javascript:bad()" onclick="bad()">Details</a><form action="https://example.test"><input autofocus formaction="https://example.test"></form>',
  '<p style="background:url(https://example.test/x)">Words</p><style>@import "https://example.test/x.css";</style>',
  '<video poster="https://example.test/x"><source src="https://example.test/x"></video><img srcset="https://example.test/x 2x">',
];
function assertStripped(source: string): void {
  const page = parsePage(render(source));
  const scripts = page.entries.filter((entry) => entry.tagName.toLowerCase() === "script");
  expect(scripts).toHaveLength(1); expect(scripts[0] === undefined ? null : getAttr(scripts[0], "nonce")).toBe(nonce);
  expect(scripts[0] === undefined ? "" : textContent(scripts[0].node)).toContain("trusted unit runner");
  for (const entry of page.entries) {
    const tag = entry.tagName.toLowerCase();
    expect(["base", "link", "object", "embed", "applet", "animate", "set", "animatemotion", "animatetransform"]).not.toContain(tag);
    for (const attr of entry.node.attrs) {
      const name = `${attr.prefix ? `${attr.prefix}:` : ""}${attr.name}`.toLowerCase();
      expect(name).not.toMatch(/^on/); expect(name).not.toBe("srcdoc"); expect(name).not.toBe("autofocus");
      if (["src", "srcset", "href", "xlink:href", "action", "formaction", "poster", "data", "ping", "background"].includes(name)) {
        expect((tag === "a" || tag === "area") && name === "href" && attr.value === "#" || tag === "img" && name === "src" && /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,/i.test(attr.value)).toBe(true);
      }
      if (name === "style") expect(unsafeCss(attr.value)).toBe(false);
    }
    if (tag === "style") expect(unsafeCss(textContent(entry.node))).toBe(false);
    if (tag === "iframe" || tag === "frame") { expect(getAttr(entry, "src")).toBeNull(); expect(getAttr(entry, "srcdoc")).toBeNull(); }
  }
}
describe("iframe stripped render properties", () => {
  it("removes active/resource constructs across arbitrary combinations including templates", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...fragments), { minLength: 0, maxLength: 20 }), (parts) => {
      assertStripped(`<html><head></head><body>${parts.join("")}</body></html>`);
    }), { numRuns: 100 });
  });
  it.each([String.raw`background:u\72l(https://example.test/a)`, String.raw`@\69mport "relative.css";`, String.raw`background:u\000072l(data:image/svg+xml,a)`, 'background:u/**/rl("relative.png")', 'background:image-set("relative.png" 1x)', String.raw`background:i\6d age-set("relative.png" 1x)`])("clears resource CSS including escapes: %s", (css) => {
    expect(unsafeCss(css)).toBe(true); const page = parsePage(render(`<p style='${css}'>Text</p><style>${css}</style>`));
    const p = page.entries.find((entry) => entry.tagName === "p"); expect(p === undefined ? "" : getAttr(p, "style")).toBeNull();
    expect(page.entries.filter((entry) => entry.tagName === "style").every((entry) => textContent(entry.node) === "")).toBe(true);
  });
  it("retains gradients, inert frames, raster data images and native link detection", () => {
    const source = '<html><head></head><body><p style="background:linear-gradient(red,blue)">Text</p><iframe title="Map" src="https://example.test"></iframe><a href="https://example.test">Explore trails</a><img src="data:image/png;base64,AAAA"><img src="data:image/svg+xml;base64,AAAA"></body></html>';
    assertStripped(source); const page = parsePage(render(source));
    const p = page.entries.find((entry) => entry.tagName === "p"); expect(p === undefined ? null : getAttr(p, "style")).toContain("linear-gradient");
    expect(page.entries.filter((entry) => entry.tagName === "iframe")).toHaveLength(1);
    expect(page.entries.find((entry) => entry.tagName === "a")?.node.attrs).toContainEqual({ name: "href", value: "#" });
    expect(page.entries.filter((entry) => entry.tagName === "img").map((entry) => getAttr(entry, "src"))).toEqual(["data:image/png;base64,AAAA", null]);
  });
  it("strips forged source markers and inserts CSP before the trusted runner", () => {
    const source = '<html><head></head><body><p id="target" data-a11y-ord="999">Text</p></body></html>';
    const ordinal = parsePage(source).elements.find((entry) => entry.attrs.some((attr) => attr.name === "id" && attr.value === "target"))?.ordinal;
    const page = parsePage(render(source)); const target = page.entries.find((entry) => getAttr(entry, "id") === "target");
    expect(target === undefined ? null : getAttr(target, "data-a11y-ord")).toBe(String(ordinal));
    const head = page.entries.find((entry) => entry.tagName === "head")?.node;
    expect(head?.childNodes[0]?.nodeName).toBe("meta"); expect(csp(nonce)).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp(nonce)).not.toContain("unsafe-eval"); expect(IFRAME_SANDBOX).toBe("allow-scripts");
  });
});
