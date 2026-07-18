/**
 * Pure helpers for KB validation (scripts/validate-kb.ts).
 *
 * Article validation strategy: the free-text `article` field of a KB entry
 * is parsed into atomic references (articles, paragraphs, Randziffern,
 * Textziffern, sections, clauses). For each atomic reference we generate a
 * set of regex probes; the reference counts as located when ANY probe
 * matches the primary source text. Range references (Art. 34-35) are
 * checked at their endpoints. Standard designators (e.g. "ISO/IEC
 * 23894:2023") identify a whole document, not a location inside it — they
 * are reported as `skipped`, not as failures.
 */

export type ArticleRef = {
  kind: 'article' | 'paragraph' | 'at' | 'rz' | 'tz' | 'section' | 'clause' | 'annex' | 'designator';
  /** Human-readable form for error messages, e.g. "Art. 34". */
  label: string;
  /** Regex probes; the ref is located when any probe matches the source. */
  probes: RegExp[];
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Expand "12" / "12-14" into endpoint tokens (range endpoints only). */
function endpoints(from: string, to?: string): string[] {
  return to ? [from, to] : [from];
}

export function extractArticleRefs(article: string): ArticleRef[] {
  const refs: ArticleRef[] = [];

  // Standard designators: the whole field names a standard, not a location.
  if (/^ISO\/IEC\s/.test(article.trim())) {
    return [{ kind: 'designator', label: article.trim(), probes: [] }];
  }

  // Art. 12, Art. 34-35, Art. 4 + Art. 7, Artikel 22
  for (const m of article.matchAll(/Art(?:\.|ikel)\s*(\d+[a-z]?)(?:\s*[-–]\s*(\d+[a-z]?))?/gi)) {
    for (const n of endpoints(m[1], m[2])) {
      refs.push({
        kind: 'article',
        label: `Art. ${n}`,
        probes: [new RegExp(`Artikel\\s+${esc(n)}\\b`, 'i'), new RegExp(`Art\\.\\s*${esc(n)}\\b`, 'i')],
      });
    }
  }

  // § 22, § 22 + § 27
  for (const m of article.matchAll(/§\s*(\d+[a-z]?)/g)) {
    refs.push({
      kind: 'paragraph',
      label: `§ ${m[1]}`,
      probes: [new RegExp(`§\\s*${esc(m[1])}\\b`)],
    });
  }

  // MaRisk modules: AT 4.3.4, BT 3.1
  for (const m of article.matchAll(/\b(AT|BT)\s+(\d+(?:\.\d+)*)/g)) {
    refs.push({
      kind: 'at',
      label: `${m[1]} ${m[2]}`,
      probes: [new RegExp(`${m[1]}\\s*${esc(m[2])}\\b`)],
    });
  }

  // FINMA Randziffern: Rz 32-35, (Rz 1-114)
  for (const m of article.matchAll(/\bRz\.?\s*(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?/g)) {
    // PDF-extracted circulars often keep ranges verbatim ("Rz 22-46" in the
    // table of contents, or bare "32–35" with en-dash) while losing the
    // per-paragraph margin numbers — accept the verbatim range for both
    // endpoints, with hyphen and en-dash variants.
    const rangeProbe = m[2]
      ? [new RegExp(`\\b${esc(m[1])}\\s*[-–]\\s*${esc(m[2])}\\b`)]
      : [];
    for (const n of endpoints(m[1], m[2])) {
      refs.push({
        kind: 'rz',
        label: `Rz ${n}`,
        probes: [
          ...rangeProbe,
          new RegExp(`Rz\\.?\\s*${esc(n)}\\b`),
          new RegExp(`^\\s*${esc(n)}\\b`, 'm'),
        ],
      });
    }
  }

  // BAIT Textziffern: Tz. 3.1-3.11
  for (const m of article.matchAll(/\bTz\.?\s*(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?/g)) {
    for (const n of endpoints(m[1], m[2])) {
      refs.push({
        kind: 'tz',
        label: `Tz. ${n}`,
        probes: [new RegExp(`Tz\\.?\\s*${esc(n)}\\b`), new RegExp(`(?<!\\d\\.)\\b${esc(n)}\\b`)],
      });
    }
  }

  // Section 5.1 (NIST), (Section 2.2) (FINMA guidance)
  for (const m of article.matchAll(/\bSection\s+(\d+(?:\.\d+)*)/gi)) {
    refs.push({
      kind: 'section',
      label: `Section ${m[1]}`,
      probes: [
        new RegExp(`(Section|Abschnitt|Kapitel)\\s*${esc(m[1])}\\b`, 'i'),
        new RegExp(`^\\s*${esc(m[1])}[.\\s]`, 'm'),
      ],
    });
  }

  // ISO clauses: Clause 8, Clauses 4-10
  for (const m of article.matchAll(/\bClauses?\s+(\d+)(?:\s*[-–]\s*(\d+))?/gi)) {
    for (const n of endpoints(m[1], m[2])) {
      refs.push({
        kind: 'clause',
        label: `Clause ${n}`,
        probes: [
          new RegExp(`(Clause|Kapitel|Abschnitt)\\s*${esc(n)}\\b`, 'i'),
          new RegExp(`^\\s*${esc(n)}[.\\s]`, 'm'),
        ],
      });
    }
  }

  // Annex A / Anhang A / Anhang III (Roman numerals)
  for (const m of article.matchAll(/\b(?:Annex|Anhang)\s+([IVXLC]+|[A-Z])\b/g)) {
    refs.push({
      kind: 'annex',
      label: `Annex ${m[1]}`,
      probes: [new RegExp(`(Annex|Anhang)\\s+${esc(m[1])}\\b`, 'i')],
    });
  }

  return refs;
}

export type ArticleCheckResult = {
  located: ArticleRef[];
  missing: ArticleRef[];
  skipped: ArticleRef[];
};

export function checkArticleRefs(article: string, sourceText: string): ArticleCheckResult {
  const result: ArticleCheckResult = { located: [], missing: [], skipped: [] };
  for (const ref of extractArticleRefs(article)) {
    if (ref.kind === 'designator') result.skipped.push(ref);
    else if (ref.probes.some(p => p.test(sourceText))) result.located.push(ref);
    else result.missing.push(ref);
  }
  return result;
}

/** Fingerprint used to decide whether two controls sharing an ID are the
 *  same control (allowed) or divergent content under one ID (defect). */
export function controlFingerprint(c: {
  action: string; description: string; priority: string; complexity: string;
  standard?: string; standardClause?: string;
}): string {
  return JSON.stringify([c.action, c.description, c.priority, c.complexity, c.standard ?? null, c.standardClause ?? null]);
}
