// Honest weak deterministic baseline. Names and alt come from text/stems, never image pixels or semantic truth.
import type { Op } from "../../shared/opsSchema.ts";
import { checkTextValue, parseCssColor } from "../../shared/valueGates.ts";
import type { FixProposer } from "./types.ts";
import type { ProposalContext } from "./context.ts";

type RGB = readonly [number, number, number];
function rgb(value: string | null): RGB | null {
  if (value === null) return null;
  const parsed = parseCssColor(value);
  if (parsed === null) return null;
  if (parsed.kind === "named") return parsed.name === "black" ? [0, 0, 0] : parsed.name === "white" ? [255, 255, 255] : null;
  return parsed.rgba.a === 1 ? [parsed.rgba.r, parsed.rgba.g, parsed.rgba.b] : null;
}
function luminance(color: RGB): number {
  const channels = color.map((channel) => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}
export function contrastRatio(a: RGB, b: RGB): number {
  const x = luminance(a); const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function hex(color: RGB): string { return `#${color.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`; }
function contrastOps(context: ProposalContext, fingerprint: string): Op[] | null {
  const data = context.contrast;
  if (data === null) return null;
  const foreground = rgb(data.fgColor); const background = rgb(data.bgColor);
  if (foreground === null || background === null) return null;
  const stated = Number.parseFloat(data.expectedContrastRatio ?? "");
  const fontSize = Number.parseFloat(data.fontSize ?? "");
  const fontWeight = Number.parseFloat(data.fontWeight ?? "");
  const large = fontSize >= 24 || (fontSize >= 18.6667 && (fontWeight >= 700 || data.fontWeight === "bold"));
  const required = Number.isFinite(stated) && stated >= 3 && stated <= 21 ? stated : large ? 3 : 4.5;
  // Choose the first quantized sRGB step toward either endpoint that really reaches the target ratio.
  for (let step = 1; step <= 255; step++) for (const endpoint of [0, 255]) {
    const mix = (channel: number): number => Math.round(channel + (endpoint - channel) * step / 255);
    const candidate: RGB = [mix(foreground[0]), mix(foreground[1]), mix(foreground[2])];
    if (contrastRatio(candidate, background) >= required) return [{ op: "set_style_color", fingerprint, property: "color", value: hex(candidate) }];
  }
  return [{ op: "set_style_color", fingerprint, property: "color", value: "#000000" },
    { op: "set_style_color", fingerprint, property: "background-color", value: "#ffffff" }];
}
function acceptable(value: string): boolean {
  return !value.includes("[screened]") && checkTextValue(value, {}, { checkAdjacent: false }).length === 0;
}
export const rulesProposer: FixProposer = {
  id: "rules", mode: "mock", requiresSafeContext: true,
  async propose(finding, context) {
    const fingerprint = finding.fingerprint;
    if (fingerprint === null) return { kind: "abstain", reason: finding.unmappedReason ?? "unmapped" };
    let ops: Op[] | null = null;
    switch (finding.rule) {
      case "html-has-lang": ops = [{ op: "set_attr", fingerprint, name: "lang", value: "en" }]; break;
      case "document-title": {
        const text = [context.firstH1, context.fileTitle].find(acceptable);
        if (text !== undefined) ops = [{ op: "set_document_title", fingerprint, text }];
        break;
      }
      case "image-alt": {
        const text = context.candidates.find((c) => c.source === "image-stem" && acceptable(c.value));
        if (text !== undefined) ops = [{ op: "set_attr", fingerprint, name: "alt", value: text.value }];
        break;
      }
      case "button-name": case "link-name": case "label": case "frame-title": {
        const candidate = context.candidates.find((c) => acceptable(c.value));
        if (candidate !== undefined) ops = [{ op: "set_attr", fingerprint, name: finding.rule === "frame-title" ? "title" : "aria-label", value: candidate.value }];
        break;
      }
      case "heading-order": {
        const previous = context.previousHeadingLevel;
        if (previous !== null && previous < 6 && context.tagName !== `h${previous + 1}`) ops = [{ op: "retag_heading", fingerprint, level: previous + 1 }];
        break;
      }
      case "tabindex":
        if (context.focusability === "focusable") ops = [{ op: "remove_attr", fingerprint, name: "tabindex" }];
        else if (context.focusability === "not_focusable") ops = [{ op: "set_attr", fingerprint, name: "tabindex", value: "0" }];
        break;
      case "color-contrast": ops = contrastOps(context, fingerprint); break;
    }
    return ops === null ? { kind: "abstain", reason: context.screened ? "screened" : "no_safe_candidate" } : { kind: "proposal", value: { ops } };
  },
};
