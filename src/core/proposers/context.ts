// Code-selected evidence only. Provider context is bounded independently from full-page local validation facts.
import type { ContrastData, Finding } from "../audit/types.ts";
import type { P5Node, ParsedPage, Focusability } from "../html/parse.ts";
import { childrenOf, getAttr, isElementNode, isTextNode, nativeFocusability } from "../html/parse.ts";
import { CONTEXT_MAX_BYTES, CONTEXT_PARENT_CHUNK_MAX_CHARS, CONTEXT_TARGET_TAG_MAX_CHARS, utf8ByteLength } from "../limits.ts";
import type { ValueGateContext } from "../../shared/valueGates.ts";
import { screenText } from "../../shared/screen.ts";

export interface NameCandidate { readonly source: "inner" | "title" | "placeholder" | "value" | "image-stem" | "label"; readonly value: string }
export interface ProposalContext {
  readonly rule: string;
  readonly ordinal: number | null;
  readonly tagName: string | null;
  readonly targetTag: string;
  readonly parentChunk: string;
  readonly precedingHeading: string;
  readonly previousHeadingLevel: number | null;
  readonly firstH1: string;
  readonly fileTitle: string;
  readonly summary: string;
  readonly candidates: readonly NameCandidate[];
  readonly contrast: ContrastData | null;
  readonly tabindex: string | null;
  readonly focusability: Focusability;
  readonly screened: boolean;
}
export interface ContextBundle {
  readonly context: ProposalContext;
  readonly validation: ValueGateContext;
  readonly blockedByScreen: boolean;
}
const INVISIBLE = new Set(["script", "style", "template", "noscript"]);
export function localVisibleText(node: P5Node): string {
  let out = "";
  const stack: P5Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (isTextNode(current)) { out += current.value; continue; }
    if (isElementNode(current) && INVISIBLE.has(current.tagName)) continue;
    const children = childrenOf(current);
    for (let i = children.length - 1; i >= 0; i--) { const child = children[i]; if (child !== undefined) stack.push(child); }
  }
  return out.replace(/\s+/gu, " ").trim();
}
/** No fetching or image interpretation: this intentionally weak baseline humanises meaningful source stems. */
export function humanizeFileStem(path: string): string | null {
  let name = (path.split(/[?#]/, 1)[0] ?? "").replace(/\\/g, "/").split("/").at(-1) ?? "";
  try { name = decodeURIComponent(name); } catch { return null; }
  name = name.replace(/\.[a-z0-9]{1,8}$/i, "");
  if (name === "" || /^(?:img|dscn?|dscf|dcim|pxl|mvimg|screenshot|scan)[\s_-]*\d/i.test(name) ||
    /^[\da-f-]{8,}$/i.test(name) || /^\d+$/.test(name) || /^(?:image|photo|picture|pic|icon|logo|banner|spacer|blank|untitled)(?:[\s_-]*\d+)?$/i.test(name)) return null;
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words === "" ? null : words.charAt(0).toUpperCase() + words.slice(1);
}
function contextWire(context: ProposalContext): string {
  return `<page_data>${JSON.stringify(context).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</page_data>`;
}
/** The actual remote wire excerpt. Fail closed even if a caller bypasses buildContext's bounds. */
export function serializeContext(context: ProposalContext): string {
  const wire = contextWire(context);
  if (utf8ByteLength(wire) > CONTEXT_MAX_BYTES) throw new Error("context_exceeds_4096_utf8_bytes");
  return wire;
}
function pageScreenedSpans(page: ParsedPage): string[] {
  const inputs = [page.original];
  const stack: P5Node[] = [page.tree];
  while (stack.length > 0) {
    const n = stack.pop(); if (n === undefined) continue;
    if (isTextNode(n)) inputs.push(n.value);
    else if (n.nodeName === "#comment") inputs.push(String((n as P5Node & { data?: string }).data ?? ""));
    if (isElementNode(n)) inputs.push(...n.attrs.map((a) => a.value));
    for (const child of childrenOf(n)) stack.push(child);
  }
  return [...new Set(inputs.flatMap((value) => screenText(value).spans.map((span) => span.text)))];
}
export function buildContext(page: ParsedPage, finding: Finding, file = "page.html"): ContextBundle {
  const target = finding.ordinal === null ? undefined : page.elements[finding.ordinal];
  const entry = target === undefined ? undefined : page.entries[target.entry];
  const parent = entry?.parentIndex === null || entry?.parentIndex === undefined ? undefined : page.entries[entry.parentIndex];
  // Keep individual sibling chunks as well as the useful aggregate. A separate credit line must not mask
  // an exact repeated caption. These local validation facts are never truncated to the provider wire cap.
  const adjacent = parent === undefined ? [] : [...new Set([
    ...childrenOf(parent.node).filter((node) => node !== entry?.node).map(localVisibleText),
    localVisibleText(parent.node),
  ].filter((text) => text !== ""))];
  const labels = page.entries.filter((e) => !e.inTemplate && e.tagName === "label" && entry !== undefined &&
    ((getAttr(entry, "id") !== null && getAttr(e, "for") === getAttr(entry, "id")) || e.index === entry.parentIndex)).map((e) => localVisibleText(e.node));
  const candidates: NameCandidate[] = [];
  let screened = false;
  const safe = (value: string, cap: number): string => { const result = screenText(value); screened ||= result.flagged; return result.text.slice(0, cap); };
  const candidate = (source: NameCandidate["source"], value: string | null): void => {
    if (value === null || value.trim() === "" || candidates.length >= 8) return;
    const result = screenText(value); screened ||= result.flagged;
    if (!result.flagged && !candidates.some((c) => c.value === value.trim())) candidates.push({ source, value: value.trim().slice(0, 125) });
  };
  if (entry !== undefined) {
    candidate("inner", localVisibleText(entry.node));
    candidate("title", getAttr(entry, "title")); candidate("placeholder", getAttr(entry, "placeholder")); candidate("value", getAttr(entry, "value"));
    if (entry.tagName === "img") candidate("image-stem", humanizeFileStem(getAttr(entry, "src") ?? ""));
    labels.forEach((label) => candidate("label", label));
  }
  const previous = page.entries.filter((e) => !e.inTemplate && /^h[1-6]$/.test(e.tagName) && e.index < (entry?.index ?? 0)).at(-1);
  const h1 = page.entries.find((e) => !e.inTemplate && e.tagName === "h1");
  const parentRecord = parent === undefined ? undefined : page.elements[page.entryOrdinals[parent.index] ?? -1];
  const parentEnd = parentRecord?.endTag?.end ?? parentRecord?.startTag.end ?? 0;
  const nullable = (value: string | null, cap: number): string | null => value === null ? null : safe(value, cap);
  const contrast = finding.contrast;
  let context: ProposalContext = {
    rule: safe(finding.rule, 100), ordinal: finding.ordinal, tagName: nullable(target?.tagName ?? null, 100),
    targetTag: safe(target === undefined ? "" : page.original.slice(target.startTag.start, target.startTag.end), CONTEXT_TARGET_TAG_MAX_CHARS),
    parentChunk: safe(parentRecord === undefined ? "" : page.original.slice(parentRecord.startTag.start, Math.min(parentEnd, parentRecord.startTag.start + CONTEXT_PARENT_CHUNK_MAX_CHARS)), CONTEXT_PARENT_CHUNK_MAX_CHARS),
    precedingHeading: safe(previous === undefined ? "" : localVisibleText(previous.node), 200),
    previousHeadingLevel: previous === undefined ? null : Number(previous.tagName.slice(1)),
    firstH1: safe(h1 === undefined ? "" : localVisibleText(h1.node), 125), fileTitle: safe(humanizeFileStem(file) ?? "", 125),
    summary: safe(finding.summary ?? "", 300), candidates,
    contrast: contrast === null ? null : {
      fgColor: nullable(contrast.fgColor, 80), bgColor: nullable(contrast.bgColor, 80),
      contrastRatio: Number.isFinite(contrast.contrastRatio) ? contrast.contrastRatio : null,
      expectedContrastRatio: nullable(contrast.expectedContrastRatio, 40),
      fontSize: nullable(contrast.fontSize, 40), fontWeight: nullable(contrast.fontWeight, 40),
    },
    tabindex: entry === undefined ? null : safe(getAttr(entry, "tabindex") ?? "", 40),
    focusability: entry === undefined ? "undecidable" : nativeFocusability(entry), screened: false,
  };
  context = { ...context, screened };
  // Escaping and UTF-8 may expand a short field. Shrink optional evidence until the entire wire excerpt fits.
  while (utf8ByteLength(contextWire(context)) > CONTEXT_MAX_BYTES) {
    if (context.parentChunk !== "") context = { ...context, parentChunk: context.parentChunk.slice(0, Math.floor(context.parentChunk.length / 2)) };
    else if (context.summary !== "") context = { ...context, summary: context.summary.slice(0, Math.floor(context.summary.length / 2)) };
    else if (context.candidates.length > 0) context = { ...context, candidates: context.candidates.slice(0, -1) };
    else if (context.targetTag !== "") context = { ...context, targetTag: context.targetTag.slice(0, Math.floor(context.targetTag.length / 2)) };
    else if (context.precedingHeading !== "") context = { ...context, precedingHeading: "" };
    else if (context.firstH1 !== "") context = { ...context, firstH1: "" };
    else if (context.fileTitle !== "") context = { ...context, fileTitle: "" };
    else if (context.contrast !== null) context = { ...context, contrast: null };
    else throw new Error("context_exceeds_4096_utf8_bytes");
  }
  serializeContext(context); // Final aggregate check: no path may return an oversized provider context.
  return { context, blockedByScreen: screened && context.candidates.length === 0,
    validation: { adjacentText: adjacent, screenedSpans: pageScreenedSpans(page), idCounts: page.idCounts,
      targetId: entry === undefined ? null : getAttr(entry, "id") } };
}
