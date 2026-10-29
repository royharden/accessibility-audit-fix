// Engine render copy (PLAN.md 2.2; CL 2.4): the ONLY place the tree is serialized, and its output goes to an audit
// engine, never to source output. Steps:
//   1. parse with the shared walk (parsePage; a patched copy passes insertedTitleStart so its title is ordinal n);
//   2. strip every input `data-a11y-ord` / `data-a11y-unanchored` attribute from every element (anti-spoofing);
//   3. run the optional tree transform (seam for the M7 iframe strip list; not implemented here), then strip
//      markers again in case the transform introduced any;
//   4. inject trusted markers: `data-a11y-ord="<ordinal>"` on ordinal-bearing elements and
//      `data-a11y-unanchored="implied_element|no_source_anchor"` on the rest, so M3 normalisation can tell an
//      implied or clone element from an unmapped axe node;
//   5. serialize with parse5.
// Source patches are spliced from the original text (ops/apply.ts), so markers can never reach source output.
import { serialize as parse5Serialize } from "parse5";
import type { P5Document, P5Element, ParsedPage } from "./parse.ts";
import { parsePage, walkTree } from "./parse.ts";

export const ORDINAL_MARKER_ATTR = "data-a11y-ord";
export const UNANCHORED_MARKER_ATTR = "data-a11y-unanchored";
export const MARKER_ATTRS: readonly string[] = Object.freeze([ORDINAL_MARKER_ATTR, UNANCHORED_MARKER_ATTR]);

export interface RenderCopyContext {
  /** The parse whose tree is being transformed (records and ranges stay valid; the tree is the render tree). */
  readonly page: ParsedPage;
}

/**
 * Engine-specific tree transform, run after input markers are stripped and before trusted markers are injected.
 * The iframe engine (M7) supplies its strip list here (scripts, on*, URLs, <base>, refresh, <link>, plugins, CSS
 * url()/@import, inert frames, CSP meta, runner). It may remove or add nodes; added elements get no marker.
 */
export type RenderTreeTransform = (tree: P5Document, context: RenderCopyContext) => void;

export interface RenderCopyOptions {
  readonly insertedTitleStart?: number | null;
  readonly transform?: RenderTreeTransform;
}

export interface RenderCopy {
  readonly html: string;
  /** Number of ordinal-bearing elements (markers 0..n-1, plus n for an inserted title). */
  readonly ordinalCount: number;
  /** Input marker attributes removed (a non-zero count is worth surfacing: the page tried to spoof markers). */
  readonly strippedInputMarkers: number;
  /** The parse used (its tree is the mutated render tree; do not use it for source edits). */
  readonly page: ParsedPage;
}

function isMarkerAttrName(name: string): boolean {
  const lower = name.toLowerCase();
  return MARKER_ATTRS.includes(lower);
}

function stripMarkers(el: P5Element): number {
  const before = el.attrs.length;
  if (!el.attrs.some((a) => isMarkerAttrName(a.name))) return 0;
  el.attrs = el.attrs.filter((a) => !isMarkerAttrName(a.name));
  return before - el.attrs.length;
}

function stripTree(tree: P5Document): number {
  let n = 0;
  for (const entry of walkTree(tree)) n += stripMarkers(entry.node);
  return n;
}

export function buildRenderCopy(source: string, options: RenderCopyOptions = {}): RenderCopy {
  const page = parsePage(source, { insertedTitleStart: options.insertedTitleStart ?? null });
  let strippedInputMarkers = 0;
  for (const entry of page.entries) strippedInputMarkers += stripMarkers(entry.node);

  if (options.transform !== undefined) {
    options.transform(page.tree, { page });
    stripTree(page.tree);
  }

  let ordinalCount = 0;
  for (let i = 0; i < page.entries.length; i++) {
    const entry = page.entries[i];
    if (entry === undefined) continue;
    const ordinal = page.entryOrdinals[i] ?? null;
    if (ordinal !== null) {
      entry.node.attrs.push({ name: ORDINAL_MARKER_ATTR, value: String(ordinal) });
      ordinalCount++;
    } else {
      entry.node.attrs.push({ name: UNANCHORED_MARKER_ATTR, value: page.entryReasons[i] ?? "no_source_anchor" });
    }
  }

  const html = parse5Serialize(page.tree as unknown as Parameters<typeof parse5Serialize>[0]);
  return { html, ordinalCount, strippedInputMarkers, page };
}

/** Read a trusted ordinal marker value back (M3 normalisation): a canonical non-negative integer, else null. */
export function parseOrdinalMarker(value: string | null): number | null {
  if (value === null || !/^(?:0|[1-9][0-9]{0,8})$/.test(value)) return null;
  return Number(value);
}

/** True when text contains a marker attribute name (used to assert markers never reach source output). */
export function containsMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return MARKER_ATTRS.some((m) => lower.includes(m));
}
