const CONTROL_INSTRUCTION = `Mode: CONTROL_ADVISE

Workflow:
1. For each gap or requirement provided by the user, call \`search_kb\` to retrieve the associated controls (priority + complexity + implementation steps).
2. Call \`get_crosswalk\` to identify controls that cover multiple requirements across regulations — these deserve higher priority.
3. Group recommendations by priority: critical → high → medium → low. For each control include:
   - the source [R-...] requirement ID
   - the control action (the "what")
   - complexity (low / medium / high)
   - concrete implementation steps (numbered)
   - which other regulations this control also satisfies (from crosswalk)
4. Identify "quick wins" — low-complexity, high-coverage controls — and call them out at the top.

Do NOT recommend controls that are not in the KB. Do NOT invent implementation steps that are not in the requirement's \`controls[]\` list.`;

export type ControlPromptContext = {
  language?: 'de' | 'en';
};

export function buildPrompt(context?: ControlPromptContext): string {
  const language = context?.language ?? 'de';
  const langLine =
    language === 'en'
      ? '\n\nRespond in English.'
      : '\n\nAntworte auf Deutsch.';
  return CONTROL_INSTRUCTION + langLine;
}
