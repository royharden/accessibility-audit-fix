import axe from "axe-core";
import declaration from "../../../engine-profile.json" with { type: "json" };
import type { AuditEngine, AuditResult } from "../../core/audit/types.ts";
import type { ParsedPage } from "../../core/html/parse.ts";
import { normalizeAudit } from "../../core/findings/normalize.ts";
import type { AxeRuleLike, TrustedMarkers } from "../../core/findings/normalize.ts";
import { IFRAME_SANDBOX, parseRunnerMessage, preparedSrcdoc } from "./csp.ts";
import { runnerSource } from "./runner.ts";

function randomHex(): string { return [...crypto.getRandomValues(new Uint8Array(24))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
export function createIframeEngine(options: { source: ParsedPage; file?: string }): AuditEngine & { render(source: string, insertedTitleStart: number | null): string; close(): void } {
  const profile = declaration.engines.iframe; const prepared = new Map<string, string>();
  const active = new Set<() => void>(); let closed = false;
  const failure = (code: string, status: "error" | "timeout" = "error"): AuditResult => ({ status, findings: [], incomplete: [], engine: "iframe", profile: profile.profileId,
    axeVersion: axe.version, notMeasured: profile.notMeasuredRules, errors: [{ code, message: code }] });
  return { id: "iframe",
    render(source, insertedTitleStart) {
      if (closed) throw new Error("iframe_engine_closed");
      const nonce = randomHex(); const token = randomHex();
      const html = preparedSrcdoc(source, { nonce, insertedTitleStart, runner: runnerSource({ nonce, token, axeSource: axe.source, axeVersion: axe.version,
        profile: profile.profileId, notMeasured: profile.notMeasuredRules, excludedRules: profile.excludedRules, enabledExtraRules: profile.enabledExtraRules, parentOrigin: location.origin }) });
      prepared.set(html, token); if (prepared.size > 8) { const oldest = prepared.keys().next().value; if (oldest !== undefined) prepared.delete(oldest); }
      return html; // Exact complete srcdoc; audit must never modify these hashed bytes.
    },
    async audit(renderCopy) {
      if (closed) return failure("iframe_engine_closed"); const token = prepared.get(renderCopy);
      if (token === undefined) return failure("iframe_render_not_prepared");
      return new Promise<AuditResult>((resolve) => {
        const frame = document.createElement("iframe"); frame.setAttribute("sandbox", IFRAME_SANDBOX); frame.setAttribute("aria-hidden", "true");
        frame.title = "Isolated accessibility audit"; frame.tabIndex = -1;
        frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${profile.viewport.width}px;height:${profile.viewport.height}px;border:0;`;
        let done = false;
        const finish = (result: AuditResult): void => { if (done) return; done = true; clearTimeout(timer); window.removeEventListener("message", onMessage); frame.remove(); active.delete(cancel); resolve(result); };
        const cancel = () => finish(failure("iframe_engine_closed"));
        const onMessage = (event: MessageEvent<unknown>): void => {
          const parsed = parseRunnerMessage(event, { source: frame.contentWindow, token, profile: profile.profileId, axeVersion: axe.version, notMeasured: profile.notMeasuredRules });
          if (parsed.kind === "ignore") return; if (parsed.kind === "error") { finish(failure(parsed.reason)); return; }
          const message = parsed.message; const markers = new Map<string, TrustedMarkers | null>();
          const rules = (values: typeof message.violations): AxeRuleLike[] => values.map((rule) => ({ id: rule.id, impact: rule.impact,
            ...(rule.executionError ? { error: "axe_check_error" } : {}), nodes: rule.nodes.map((node) => { markers.set(node.key, node.markers); return { target: [node.key], impact: node.impact,
              ...(node.summary === null ? {} : { failureSummary: node.summary }), any: [...(node.contrast === null ? [] : [{ data: node.contrast }]), ...(node.executionError ? [{ error: "axe_check_error" }] : [])] }; }) }));
          try { finish(normalizeAudit({ violations: rules(message.violations), incomplete: rules(message.incomplete) }, { source: options.source, file: options.file ?? "page.html", engine: "iframe", profile: message.profile,
            axeVersion: message.axeVersion, notMeasured: message.notMeasured, status: message.status, errors: message.errors,
            resolveTarget: (target) => target.length === 1 && typeof target[0] === "string" ? markers.get(target[0]) ?? null : null })); }
          catch { finish(failure("iframe_normalization_error")); }
        };
        const timer = setTimeout(() => finish(failure("iframe_audit_timeout", "timeout")), Math.min(15000, profile.timeoutMs));
        active.add(cancel); window.addEventListener("message", onMessage); frame.srcdoc = renderCopy;
        try { document.body.append(frame); } catch { finish(failure("iframe_mount_failed")); }
      });
    },
    close() { closed = true; for (const cancel of [...active]) cancel(); prepared.clear(); },
  };
}
