// Pure corpus construction. Calling code owns writing/freezing; this module performs no I/O on import.
import type { GoldDefect } from "../../../gold/oracle/schema.ts";
import type { RuleId } from "../../shared/rules.ts";
import { getAttr, parsePage } from "../../core/html/parse.ts";
import { handlerPrints, visibleBodyText } from "../../core/html/invariants.ts";
import { createPrng, shuffled } from "./prng.ts";

export const GENERATED_RULES = ["html-has-lang", "document-title", "image-alt", "button-name", "link-name", "label", "frame-title", "heading-order", "tabindex"] as const;
export interface GeneratedPage {
  readonly id: string; readonly family: string; readonly split: "dev" | "heldout";
  readonly source: string; readonly defects: readonly GoldDefect[];
}
interface Family {
  readonly name: string; readonly split: "dev" | "heldout"; readonly wrapper: "main" | "article"; readonly section: "section" | "div";
  readonly title: string; readonly button: readonly [string, string]; readonly link: readonly [string, string]; readonly label: readonly [string, string];
  readonly image: readonly [string, string]; readonly frame: string; readonly component: "section" | "aside" | "article" | "div";
}
const FAMILIES: readonly Family[] = [
  { name: "bookshop", split: "dev", wrapper: "main", section: "section", title: "Library stories", component: "section",
    button: ["Borrow", "books"], link: ["Browse", "authors"], label: ["Find", "titles"], image: ["reading", "room"], frame: "Library floor map" },
  { name: "museum", split: "dev", wrapper: "article", section: "section", title: "Museum visits", component: "aside",
    button: ["Book", "admission"], link: ["View", "exhibits"], label: ["Filter", "artwork"], image: ["exhibit", "hall"], frame: "Museum room map" },
  { name: "botanical", split: "heldout", wrapper: "main", section: "div", title: "Garden walks", component: "article",
    button: ["Join", "tour"], link: ["Discover", "plants"], label: ["Search", "species"], image: ["flower", "garden"], frame: "Garden route map" },
  { name: "market", split: "heldout", wrapper: "article", section: "div", title: "Market discoveries", component: "div",
    button: ["Order", "produce"], link: ["Visit", "farmers"], label: ["Locate", "stalls"], image: ["farm", "stall"], frame: "Market location map" },
];

function fragment(rule: RuleId, tone: string, family: Family): string {
  const mark = `data-fixture-target="${rule}"`;
  const component = family.component;
  switch (rule) {
    case "image-alt": return `<${component} class="${family.name}-picture"><figure><img ${mark} src="${tone}-${family.image.join("-")}.jpg"><figcaption>A featured view from our collection</figcaption></figure></${component}>`;
    case "button-name": return `<${component} class="${family.name}-action"><span>${family.button[0]} ${tone} ${family.button[1]}</span><button ${mark} onclick="return false"></button></${component}>`;
    case "link-name": return `<${component} class="${family.name}-navigation"><p>${family.link[0]} ${tone} ${family.link[1]}</p><a ${mark} href="#details"></a></${component}>`;
    case "label": return `<${component} class="${family.name}-search"><p>${family.label[0]} ${tone} ${family.label[1]}</p><input ${mark} type="search"></${component}>`;
    case "frame-title": return `<${component} class="${family.name}-map"><p>${family.frame}</p><iframe ${mark}></iframe></${component}>`;
    case "heading-order": return `<h4 ${mark}>Featured ${tone} selection</h4>`;
    case "tabindex": return `<div ${mark} tabindex="3">Read ${tone} details</div>`;
    default: return "";
  }
}
function truth(rule: RuleId, language: string, title: string, family: Family): GoldDefect["truth"] {
  switch (rule) {
    case "html-has-lang": return { language };
    case "document-title": return { keywords: title.toLowerCase().split(" ") };
    case "image-alt": return { decorative: false, keywords: [...family.image] };
    case "button-name": return { keywords: family.button.map((word) => word.toLowerCase()) };
    case "link-name": return { keywords: family.link.map((word) => word.toLowerCase()) };
    case "label": return { keywords: family.label.map((word) => word.toLowerCase()) };
    case "frame-title": return { keywords: family.frame.toLowerCase().split(" ") };
    case "heading-order": return { headingLevel: 2 };
    case "tabindex": return { tabindex: "0" };
    default: return {};
  }
}

/** Exactly40 pages/20 per split; each family is confined to one split; six planted defects/page. */
export function generateCorpus(seed: number): GeneratedPage[] {
  const random = createPrng(seed);
  const result: GeneratedPage[] = [];
  for (const family of FAMILIES) for (let index = 0; index < 10; index++) {
    // A quota schedule, not prevalence sampling: each nine-rule category occurs >=12 times per20-page split.
    const splitIndex = (family.name === "bookshop" || family.name === "botanical" ? 0 : 10) + index;
    const selected = Array.from({ length: 6 }, (_, n) => GENERATED_RULES[(splitIndex * 6 + n) % GENERATED_RULES.length])
      .filter((rule): rule is (typeof GENERATED_RULES)[number] => rule !== undefined);
    const tone = ["amber", "cedar", "silver", "willow"][Math.floor(random() * 4)] ?? "amber";
    const id = `${family.name}-${String(index + 1).padStart(2, "0")}`;
    const language = index % 2 === 0 ? "en" : "es";
    const prose = language === "es"
      ? "Bienvenidos a nuestra colección. Aquí encontrará información sobre las actividades del día y las distintas formas de participar. Nuestro equipo prepara una selección especial para visitantes de todas las edades. Puede consultar los detalles, descubrir nuevas historias y planificar una visita con su familia. Las descripciones ayudan a comparar las opciones y elegir una experiencia que se adapte a sus intereses. Gracias por explorar este espacio y compartir sus descubrimientos con nosotros."
      : "Welcome. This page presents our collection. Explore the featured activities and plan a visit with your family.";
    const title = `${family.title} ${tone}`;
    const htmlLang = selected.includes("html-has-lang") ? "" : language;
    const headTitle = selected.includes("document-title") ? "" : `<title>${title}</title>`;
    const body = shuffled(selected.filter((rule) => rule !== "html-has-lang" && rule !== "document-title"), random)
      .map((rule) => fragment(rule, tone, family)).join("\n");
    const source = `<!doctype html><html lang="${htmlLang}"><head>${headTitle}</head><body><${family.wrapper}><h1>${title}</h1><p>${prose}</p><${family.section}>${body}</${family.section}></${family.wrapper}></body></html>\n`;
    const parsed = parsePage(source);
    const mustPreserve = { visibleBodyText: visibleBodyText(parsed), handlerCount: handlerPrints(parsed).length };
    const defects: GoldDefect[] = selected.map((rule) => {
      const target = parsed.elements.find((element) => {
        const entry = parsed.entries[element.entry];
        return entry !== undefined && getAttr(entry, "data-fixture-target") === rule;
      });
      const ordinal = rule === "html-has-lang" || rule === "document-title" ? parsed.htmlOrdinal : target?.ordinal;
      if (ordinal === null || ordinal === undefined) throw new Error(`missing_generated_target:${id}:${rule}`);
      return { rule, ordinal, truth: truth(rule, language, title, family), mustPreserve };
    });
    result.push({ id, family: family.name, split: family.split, source, defects });
  }
  return result;
}

export function plantedRuleCounts(pages: readonly GeneratedPage[], split: "dev" | "heldout"): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(GENERATED_RULES.map((rule) => [rule, 0]));
  for (const page of pages) if (page.split === split) for (const defect of page.defects) counts[defect.rule] = (counts[defect.rule] ?? 0) + 1;
  return counts;
}
