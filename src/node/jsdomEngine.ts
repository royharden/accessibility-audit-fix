// Node-only boundary. Input must be the trusted buildRenderCopy result for the original source bound below.
import { JSDOM } from "jsdom";
import axe from "axe-core";
import declaration from "../../engine-profile.json" with { type: "json" };
import type { AuditEngine, AuditResult } from "../core/audit/types.ts";
import type { ParsedPage } from "../core/html/parse.ts";
import type { AxeResultsLike } from "../core/findings/normalize.ts";
import { normalizeAudit } from "../core/findings/normalize.ts";
import { ORDINAL_MARKER_ATTR, UNANCHORED_MARKER_ATTR } from "../core/html/renderCopy.ts";

export interface JsdomProfile {
  readonly profileId: string;
  readonly enabledExtraRules: readonly string[];
  readonly excludedRules: readonly string[];
  readonly notMeasuredRules: readonly string[];
  readonly timeoutMs: number;
}
export interface JsdomEngineOptions { readonly source: ParsedPage; readonly file?: string; readonly profile?: JsdomProfile }
type AxeWindow = { axe: { run(context: unknown, options: unknown): Promise<AxeResultsLike> } };

export function createJsdomEngine(options: JsdomEngineOptions): AuditEngine {
  const profile = options.profile ?? declaration.engines.jsdom;
  if (!Number.isFinite(profile.timeoutMs) || profile.timeoutMs <= 0 || profile.timeoutMs > 10000) throw new RangeError("jsdom timeout must be 1..10000ms");
  return {
    id: "jsdom",
    async audit(renderCopy): Promise<AuditResult> {
      let dom: JSDOM | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const failure = (status: "error" | "timeout", code: string): AuditResult => ({ status, findings: [], incomplete: [], engine: "jsdom",
        axeVersion: axe.version, profile: profile.profileId, notMeasured: [...profile.notMeasuredRules], errors: [{ code, message: code }] });
      try {
        // No resources option: no resource loader, no external fetches. Page scripts cannot run outside-only.
        dom = new JSDOM(renderCopy, { runScripts: "outside-only" });
        const window = dom.window;
        window.eval(axe.source);
        const rules: Record<string, { enabled: boolean }> = {};
        for (const id of profile.enabledExtraRules) rules[id] = { enabled: true };
        for (const id of profile.excludedRules) rules[id] = { enabled: false };
        const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), profile.timeoutMs); });
        // Promise.race installs rejection handling even if an axe run finishes after the deadline.
        const raw = await Promise.race([(window as unknown as AxeWindow).axe.run(window.document,
          { resultTypes: ["violations", "incomplete"], rules }), timeout]);
        if (raw === null) return failure("timeout", "audit_timeout");
        return normalizeAudit(raw, { source: options.source, file: options.file ?? "page.html", engine: "jsdom",
          axeVersion: axe.version, profile: profile.profileId, notMeasured: profile.notMeasuredRules,
          resolveTarget(target) {
            // Nested target arrays imply shadow/frame boundaries; jsdom does not guess across them.
            if (target.length !== 1 || typeof target[0] !== "string") return null;
            try {
              const elements = window.document.querySelectorAll(target[0]);
              const element = elements.length === 1 ? elements.item(0) : null;
              return element === null ? null : { ordinal: element.getAttribute(ORDINAL_MARKER_ATTR), unanchored: element.getAttribute(UNANCHORED_MARKER_ATTR) };
            } catch { return null; }
          } });
      } catch { return failure("error", "audit_error"); }
      finally {
        if (timer !== undefined) clearTimeout(timer);
        dom?.window.close();
      }
    },
  };
}
