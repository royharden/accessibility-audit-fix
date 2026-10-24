import type { ParsedPage } from "../core/html/parse.ts";
import { getAttr } from "../core/html/parse.ts";
import { createMockProposer } from "../core/proposers/mock.ts";
import type { ReplayScript } from "../core/proposers/mock.ts";
import { formatFingerprint } from "../core/findings/fingerprint.ts";

export const SAMPLE_HTML = `<!doctype html>
<html lang="en">
<head><title>Field Notes — nature books</title><style>body{font:18px Georgia,serif;color:#243d34;background:#fff;padding:32px}img{width:240px}button,a{margin:12px}</style></head>
<body><main>
<h1>Field Notes</h1><p>Books for curious people and quiet weekends.</p>
<div data-demo="tab" tabindex="3">Explore the collection</div>
<figure><img data-demo="image" src="mountain-lake.jpg"><figcaption>A view from our latest travel collection.</figcaption></figure>
<section><h2>Plan your next chapter</h2><p>Reserve a reading-room visit.</p><button data-demo="reject"></button></section>
<p>Browse the nature collection: <a data-demo="timeout" href="#nature"></a></p>
<p>Our reading-room location:</p><iframe data-demo="human"></iframe>
</main></body></html>`;

/** Sample-specific scripted proposals. All still cross the production schema, value and code gates. */
export function sampleMockProposer(page: ParsedPage) {
  const scripts: ReplayScript[] = [];
  for (const element of page.elements) {
    const entry = page.entries[element.entry]; if (entry === undefined) continue;
    const name = getAttr(entry, "data-demo");
    if (name === "tab") {
      const fingerprint = formatFingerprint("tabindex", element.ordinal);
      scripts.push({ fingerprint, attempts: [{ kind: "ops", ops: [{ op: "set_attr", fingerprint, name: "tabindex", value: "0" }] }] });
    } else if (name === "image") {
      const fingerprint = formatFingerprint("image-alt", element.ordinal);
      scripts.push({ fingerprint, attempts: [{ kind: "ops", ops: [{ op: "set_attr", fingerprint, name: "alt", value: "Sunrise over a mountain lake" }] }] });
    } else if (name === "reject") {
      const fingerprint = formatFingerprint("button-name", element.ordinal);
      scripts.push({ fingerprint, attempts: [{ kind: "ops", ops: [{ op: "set_attr", fingerprint, name: "aria-label", value: "button" }] }] });
    } else if (name === "timeout") {
      scripts.push({ fingerprint: formatFingerprint("link-name", element.ordinal), attempts: [{ kind: "timeout" }] });
    } else if (name === "human") {
      scripts.push({ fingerprint: formatFingerprint("frame-title", element.ordinal), attempts: [{ kind: "abstain", reason: "frame_context_needs_human" }] });
    }
  }
  return createMockProposer(scripts);
}
