// Pure parse5 render sanitizer and protocol validation. No page HTML enters the application DOM.
import { z } from "../../shared/deps.ts";
import type { P5Document, P5Element, P5Node } from "../../core/html/parse.ts";
import { HTML_NS, SVG_NS, textContent, walkTree } from "../../core/html/parse.ts";
import { buildRenderCopy } from "../../core/html/renderCopy.ts";
import { utf8ByteLength } from "../../core/limits.ts";
export const IFRAME_SANDBOX = "allow-scripts";
export const MESSAGE_MAX_BYTES = 2 * 1024 * 1024;
export function csp(nonce: string): string {
  if (!/^[a-f0-9]{48}$/.test(nonce)) throw new Error("invalid_nonce");
  return `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; object-src 'none'`;
}
function decodeCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\\\r?\n/g, "").replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\r\f ])?|\\([^\n\r\f])/gi,
    (_whole, hex: string | undefined, char: string | undefined) => hex === undefined ? char ?? "" : String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(hex, 16)) || 0xfffd));
}
/** Fail closed on resource-bearing or legacy executable CSS; gradients/plain inline colours remain measurable. */
export function unsafeCss(css: string): boolean {
  const decoded = decodeCss(css);
  return /@\s*import\b|\b(?:url|(?:-webkit-)?image-set|image|cross-fade|paint|src|expression)\s*\(|\b(?:behavior|-moz-binding)\s*:|(?:https?|ftp|file|blob|javascript)\s*:|\/\/|[<>]/i.test(decoded);
}
const REMOVE = new Set(["script", "base", "link", "object", "embed", "applet", "portal", "fencedframe", "webview", "noscript", "xmp", "plaintext"]);
const SVG_MUTATORS = new Set(["animate", "set", "animatemotion", "animatetransform", "discard", "mpath"]);
const RESOURCES = new Set(["src", "srcdoc", "srcset", "imagesrcset", "imagesizes", "href", "xlink:href", "action", "formaction", "poster", "data", "ping", "background", "codebase", "archive", "manifest"]);
function rasterData(value: string): boolean { return /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,[a-z0-9+/=\r\n]+$/i.test(value.trim()); }
function detach(node: P5Element): void {
  const parent = node.parentNode;
  if (parent?.childNodes !== undefined) parent.childNodes = parent.childNodes.filter((child) => child !== node);
}
/** Uses the canonical walk, including template content and foreign-object HTML. */
export function sanitizeTree(tree: P5Document): void {
  for (const entry of walkTree(tree)) {
    const node = entry.node; const tag = node.tagName.toLowerCase();
    if (REMOVE.has(tag) || (node.namespaceURI === SVG_NS && SVG_MUTATORS.has(tag)) ||
      (tag === "meta" && node.attrs.some((a) => a.name.toLowerCase() === "http-equiv"))) { detach(node); continue; }
    node.attrs = node.attrs.flatMap((attr) => {
      const name = `${attr.prefix ? `${attr.prefix}:` : ""}${attr.name}`.toLowerCase();
      if (/^on/i.test(name) || ["autofocus", "target", "download", "nonce", "integrity"].includes(name)) return [];
      if (name === "style" && unsafeCss(attr.value)) return [];
      if (!RESOURCES.has(name)) return [attr];
      // Preserve native link/focus/name semantics without navigation to untrusted URLs.
      if (name === "href" && node.namespaceURI === HTML_NS && (tag === "a" || tag === "area")) return [{ ...attr, value: "#" }];
      if (name === "src" && node.namespaceURI === HTML_NS && tag === "img" && rasterData(attr.value)) return [{ ...attr, value: attr.value.trim() }];
      return [];
    });
    if (tag === "style" && unsafeCss(textContent(node))) node.childNodes = [];
  }
}
function element(tagName: string, attrs: { name: string; value: string }[], parent: P5Node, text?: string): P5Element {
  const node: P5Element = { nodeName: tagName, tagName, namespaceURI: HTML_NS, attrs, childNodes: [], parentNode: parent };
  if (text !== undefined) node.childNodes.push({ nodeName: "#text", value: text, parentNode: node } as P5Node);
  return node;
}
/** Complete exact srcdoc builder; host passes only trusted runner JavaScript, never page-generated code. */
export function preparedSrcdoc(source: string, options: { nonce: string; runner: string; insertedTitleStart: number | null }): string {
  return buildRenderCopy(source, { insertedTitleStart: options.insertedTitleStart, transform(tree) {
    sanitizeTree(tree);
    const head = walkTree(tree).find((entry) => entry.namespace === HTML_NS && entry.tagName === "head")?.node;
    if (head === undefined) throw new Error("render_head_missing");
    head.childNodes.unshift(element("meta", [{ name: "http-equiv", value: "Content-Security-Policy" }, { name: "content", value: csp(options.nonce) }], head));
    head.childNodes.push(element("script", [{ name: "nonce", value: options.nonce }], head, options.runner));
  } }).html;
}
const MarkerSchema = z.object({ ordinal: z.string().max(12).nullable(), unanchored: z.enum(["implied_element", "no_source_anchor"]).nullable() }).strict();
const ContrastSchema = z.object({ fgColor: z.string().max(80).nullable(), bgColor: z.string().max(80).nullable(), contrastRatio: z.number().finite().nullable(), expectedContrastRatio: z.string().max(40).nullable(), fontSize: z.string().max(40).nullable(), fontWeight: z.string().max(40).nullable() }).strict();
const ImpactSchema = z.enum(["minor", "moderate", "serious", "critical"]).nullable();
const NodeSchema = z.object({ key: z.string().regex(/^n\d+$/), markers: MarkerSchema.nullable(), impact: ImpactSchema, summary: z.string().max(4000).nullable(), contrast: ContrastSchema.nullable(), executionError: z.boolean() }).strict();
const RuleSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), impact: ImpactSchema, nodes: z.array(NodeSchema).max(10000), executionError: z.boolean() }).strict();
export const RunnerMessageSchema = z.object({ runToken: z.string().regex(/^[a-f0-9]{48}$/), engine: z.literal("iframe"), status: z.enum(["complete", "partial", "error", "timeout"]),
  profile: z.string().min(1).max(200), axeVersion: z.string().min(1).max(100), notMeasured: z.array(z.string().max(100)).max(1000),
  violations: z.array(RuleSchema).max(1000), incomplete: z.array(RuleSchema).max(1000), errors: z.array(z.object({ code: z.string().max(100), message: z.string().max(300) }).strict()).max(1000),
}).strict().superRefine((message, ctx) => {
  const keys = [...message.violations, ...message.incomplete].flatMap((rule) => rule.nodes.map((node) => node.key));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "duplicate_node_key" });
});
export type RunnerMessage = z.infer<typeof RunnerMessageSchema>;
export function parseRunnerMessage(event: { source: unknown; data: unknown }, expected: { source: unknown; token: string; profile: string; axeVersion: string; notMeasured: readonly string[] }):
  { kind: "ignore" } | { kind: "error"; reason: string } | { kind: "result"; message: RunnerMessage } {
  if (event.source !== expected.source || typeof event.data !== "object" || event.data === null || (event.data as { runToken?: unknown }).runToken !== expected.token) return { kind: "ignore" };
  try { const serialized = JSON.stringify(event.data); if (typeof serialized !== "string") return { kind: "error", reason: "iframe_message_invalid" }; if (utf8ByteLength(serialized) > MESSAGE_MAX_BYTES) return { kind: "error", reason: "iframe_message_too_large" }; }
  catch { return { kind: "error", reason: "iframe_message_invalid" }; }
  const parsed = RunnerMessageSchema.safeParse(event.data);
  if (!parsed.success) return { kind: "error", reason: "iframe_message_invalid" };
  if (parsed.data.profile !== expected.profile || parsed.data.axeVersion !== expected.axeVersion ||
    JSON.stringify([...parsed.data.notMeasured].sort()) !== JSON.stringify([...expected.notMeasured].sort())) return { kind: "error", reason: "iframe_profile_mismatch" };
  return { kind: "result", message: parsed.data };
}
