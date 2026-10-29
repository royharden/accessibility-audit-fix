// Hidden semantic judge: Node evaluation only. Never imported by proposers, gates or the app.
import type { GoldDefect } from "../../gold/oracle/schema.ts";
import type { FixAttempt } from "../core/ledger/types.ts";
import type { ParsedPage, WalkEntry } from "../core/html/parse.ts";
import { entryOf, getAttr, nativeFocusability, parsePage } from "../core/html/parse.ts";
import { handlerPrints, scriptPrints, visibleBodyText } from "../core/html/invariants.ts";
import { localVisibleText } from "../core/proposers/context.ts";
import { normalizeText } from "../shared/valueGates.ts";

export interface OracleVerdict { readonly correct: boolean | null; readonly reasons: readonly string[] }
function words(value: string): string { return ` ${normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `; }
function keywordMatch(value: string | null, keywords: readonly string[] | undefined): boolean | null {
  if (keywords === undefined || keywords.length === 0) return null;
  return value !== null && keywords.every((keyword) => words(value).includes(words(keyword)));
}
function accessibleName(page: ParsedPage, entry: WalkEntry): string | null {
  const refs = getAttr(entry, "aria-labelledby");
  if (refs !== null) {
    const text: string[] = [];
    for (const id of refs.trim().split(/\s+/u)) {
      const matches = page.entries.filter((e) => !e.inTemplate && getAttr(e, "id") === id);
      if (matches.length !== 1 || matches[0] === undefined) return null;
      text.push(localVisibleText(matches[0].node));
    }
    return text.join(" ");
  }
  const aria = getAttr(entry, "aria-label"); if (aria !== null && aria.trim() !== "") return aria;
  const id = getAttr(entry, "id");
  const labels = page.entries.filter((e) => !e.inTemplate && e.tagName === "label" &&
    ((id !== null && getAttr(e, "for") === id) || e.index === entry.parentIndex));
  if (labels.length > 0) return labels.map((e) => localVisibleText(e.node)).join(" ");
  const text = localVisibleText(entry.node);
  return text !== "" ? text : getAttr(entry, "title");
}
export function judgeGoldDefect(original: ParsedPage, defect: GoldDefect, attempt: FixAttempt): OracleVerdict {
  if (attempt.applied === undefined) return { correct: null, reasons: ["no_applied_candidate"] };
  const after = parsePage(attempt.applied.text, { insertedTitleStart: attempt.applied.insertedTitleStart });
  const reasons: string[] = [];
  if (visibleBodyText(after) !== defect.mustPreserve.visibleBodyText) reasons.push("oracle_visible_text_changed");
  if (handlerPrints(after).length !== defect.mustPreserve.handlerCount || JSON.stringify(handlerPrints(original)) !== JSON.stringify(handlerPrints(after))) reasons.push("oracle_handlers_changed");
  if (JSON.stringify(scriptPrints(original)) !== JSON.stringify(scriptPrints(after))) reasons.push("oracle_scripts_changed");
  if (attempt.invariants?.ok !== true) reasons.push("oracle_structure_not_preserved");
  const target = entryOf(after, defect.ordinal);
  const before = entryOf(original, defect.ordinal);
  let correct: boolean | null = null;
  if (target === undefined) reasons.push("oracle_target_missing");
  else switch (defect.rule) {
    case "html-has-lang": correct = defect.truth.language === undefined ? null : getAttr(target, "lang")?.toLowerCase() === defect.truth.language.toLowerCase(); break;
    case "document-title": correct = keywordMatch(after.titles.length === 1 ? after.titles[0]?.text ?? null : null, defect.truth.keywords); break;
    case "image-alt": correct = defect.truth.decorative === true ? getAttr(target, "alt") === "" : keywordMatch(getAttr(target, "alt"), defect.truth.keywords); break;
    case "button-name": case "link-name": case "label": case "frame-title": correct = keywordMatch(accessibleName(after, target), defect.truth.keywords); break;
    case "heading-order": correct = defect.truth.headingLevel === undefined ? null : target.tagName === `h${defect.truth.headingLevel}`; break;
    case "tabindex":
      correct = defect.truth.tabindex === undefined ? null : defect.truth.tabindex === null ?
        getAttr(target, "tabindex") === null && before !== undefined && nativeFocusability(before) === "focusable" :
        getAttr(target, "tabindex") === defect.truth.tabindex;
      break;
    case "color-contrast": correct = null; break; // No semantic/visual contrast truth is declared in this GoldDefect format.
  }
  if (reasons.length > 0) return { correct: false, reasons };
  return correct === null ? { correct: null, reasons: ["oracle_truth_unavailable"] } : { correct, reasons: correct ? [] : ["oracle_semantic_mismatch"] };
}
