// Self-contained browser function. Its compiled JavaScript source is embedded into a trusted nonce bootstrap.
export interface RunnerConfig { token: string; nonce: string; profile: string; axeVersion: string; axeSource: string; notMeasured: readonly string[]; excludedRules: readonly string[]; enabledExtraRules: readonly string[]; parentOrigin: string }
export function iframeRunner(config: RunnerConfig): void {
  const bootstrap = document.currentScript;
  const start = async (): Promise<void> => {
    let library: HTMLScriptElement | null = null;
    const send = (value: unknown) => parent.postMessage(value, config.parentOrigin === "null" ? "*" : config.parentOrigin);
    const error = (code: string) => send({ runToken: config.token, engine: "iframe", status: "error", profile: config.profile, axeVersion: config.axeVersion,
      notMeasured: config.notMeasured, violations: [], incomplete: [], errors: [{ code, message: code }] });
    try {
      library = document.createElement("script"); library.nonce = config.nonce; library.textContent = config.axeSource; document.head.append(library);
      const engine = (window as unknown as { axe?: { version: string; run(context: Document, options: unknown): Promise<{ violations: unknown[]; incomplete: unknown[] }> } }).axe;
      library.remove(); bootstrap?.remove();
      if (engine === undefined || engine.version !== config.axeVersion) { error("iframe_axe_unavailable"); return; }
      const rules: Record<string, { enabled: boolean }> = {};
      config.enabledExtraRules.forEach((id) => { rules[id] = { enabled: true }; }); config.excludedRules.forEach((id) => { rules[id] = { enabled: false }; });
      const raw = await engine.run(document, { resultTypes: ["violations", "incomplete"], rules });
      const object = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
      const impact = (value: unknown): string | null => ["minor", "moderate", "serious", "critical"].includes(String(value)) ? String(value) : null;
      const string = (value: unknown, max: number): string | null => typeof value === "string" ? value.slice(0, max) : null;
      let key = 0; let partial = false;
      const mapRules = (values: unknown[]) => values.map((value) => {
        const rule = object(value); if (rule === null || typeof rule["id"] !== "string" || !Array.isArray(rule["nodes"])) throw new Error("invalid_axe_result");
        const ruleError = rule["error"] != null; partial ||= ruleError;
        const nodes = rule["nodes"].map((value: unknown) => {
          const node = object(value); if (node === null) throw new Error("invalid_axe_node");
          const target = node["target"]; let element: Element | null = null;
          if (Array.isArray(target) && target.length === 1 && typeof target[0] === "string") { try { const found = document.querySelectorAll(target[0]); if (found.length === 1) element = found.item(0); } catch { /* unmapped */ } }
          const checks = ["any", "all", "none"].flatMap((name) => Array.isArray(node[name]) ? node[name] as unknown[] : []);
          const executionError = checks.some((check) => object(check)?.["error"] != null || object(object(check)?.["data"])?.["error"] != null); partial ||= executionError;
          const data = checks.map((check) => object(object(check)?.["data"])).find((data) => data !== null && ("contrastRatio" in data || "fgColor" in data));
          return { key: `n${key++}`, markers: element === null ? null : { ordinal: element.getAttribute("data-a11y-ord"), unanchored: element.getAttribute("data-a11y-unanchored") },
            impact: impact(node["impact"] ?? rule["impact"]), summary: string(node["failureSummary"], 4000), executionError,
            contrast: data === undefined || data === null ? null : { fgColor: string(data["fgColor"], 80), bgColor: string(data["bgColor"], 80),
              contrastRatio: typeof data["contrastRatio"] === "number" && Number.isFinite(data["contrastRatio"]) ? data["contrastRatio"] : null,
              expectedContrastRatio: string(data["expectedContrastRatio"], 40), fontSize: string(data["fontSize"], 40), fontWeight: string(data["fontWeight"], 40) } };
        });
        return { id: rule["id"], impact: impact(rule["impact"]), nodes, executionError: ruleError };
      });
      const violations = mapRules(raw.violations); const incomplete = mapRules(raw.incomplete);
      send({ runToken: config.token, engine: "iframe", status: partial ? "partial" : "complete", profile: config.profile, axeVersion: engine.version,
        notMeasured: config.notMeasured, violations, incomplete, errors: partial ? [{ code: "iframe_check_error", message: "An axe check did not complete." }] : [] });
    } catch { library?.remove(); bootstrap?.remove(); error("iframe_audit_error"); }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { void start(); }, { once: true }); else void start();
}
export function runnerSource(config: RunnerConfig): string {
  const json = JSON.stringify(config).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `;(${iframeRunner.toString()})(${json});`;
}
