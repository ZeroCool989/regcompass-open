import type { LegislationNode, LegislationFormat } from './types';
import { KB } from '@/lib/kb';

let nodeCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++nodeCounter}`;
}

function resetCounter() {
  nodeCounter = 0;
}

function matchKbEntries(regulationId: string, text: string): string[] {
  return KB.requirements
    .filter((r) => {
      if (r.regulation !== regulationId) return false;
      const article = r.article;
      if (!article || article.length < 2) return false;
      return text.includes(article);
    })
    .map((r) => r.id);
}

export function parseToTree(
  text: string,
  regulationId: string,
  format: LegislationFormat,
): LegislationNode {
  resetCounter();
  const cleaned = normalizeSourceText(text);
  switch (format) {
    case 'eu_regulation':
    case 'eu_directive':
      return parseEuRegulation(cleaned, regulationId);
    case 'ch_law':
      return parseChLaw(cleaned, regulationId);
    case 'ch_circular':
      return parseChCircular(cleaned, regulationId);
    case 'ch_guidance':
      return parseChGuidance(cleaned, regulationId);
    case 'de_law':
      return parseDeLaw(cleaned, regulationId);
    case 'de_circular':
      return parseDeCircular(cleaned, regulationId);
    case 'iso_standard':
      return parseIsoStandard(cleaned, regulationId);
    case 'nist_framework':
      return parseNistFramework(cleaned, regulationId);
    default:
      return parseFallback(cleaned, regulationId);
  }
}

// ─────────────────────────── Source text normalization ───────────────────────────

// Strip PDF-extraction artifacts and table-of-contents debris that pollutes
// the parsed tree. Applied before any format-specific parser runs.
function normalizeSourceText(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isExtractionArtifact(line))
    .join('\n');
}

function isExtractionArtifact(line: string): boolean {
  const t = line.trim();
  if (!t) return false; // keep blank lines (they separate blocks)

  // Bracketed extractor annotations like "[SOURCE_FILE: ...]", "[PAGE: 3]",
  // "[TRANSLATED_FROM: ...]", "[WARNING: ...]", "[PAGE_METHOD: ocr]" etc.
  // These come from the pymupdf + DeepL pipeline and never appear in real law text.
  if (/^\[[A-Z][A-Z0-9_]*:[^\]]*\]\s*$/.test(t)) return true;

  // Table-of-contents lines with 6+ dot leaders ("..............3").
  if (/\.{6,}/.test(t)) return true;

  // Standalone page-number lines (just digits, nothing else).
  if (/^\d+\s*$/.test(t)) return true;
  // Standalone section-number lines orphaned by the TOC ("0.1", "4.2.3").
  if (/^\d+(?:\.\d+)+\s*$/.test(t)) return true;

  // Beuth/DIN-specific page footer watermark.
  if (/^Normen-Download-Beuth/i.test(t)) return true;
  // Recurring DIN/ISO page header like "DIN ISO/IEC 27001:2015-03".
  if (/^DIN ISO\/IEC\s+\d+(?::\d{4}-\d{2})?\s*$/i.test(t)) return true;

  return false;
}

// ─────────────────────────── EU Regulation / Directive ───────────────────────────

const EU_CHAPTER_RE = /^(KAPITEL|TITEL|CHAPTER)\s+([IVXLCDM]+)\s*$/m;
const EU_ARTICLE_RE = /^Artikel\s+(\d+)\s*$/m;
const EU_ANNEX_RE = /^(Anhang|ANHANG)\s+([IVXLCDM]+[a-z]?)\s*$/m;

// TOC lines that appear at the top of EUR-Lex exports and pollute the preamble.
const EU_TOC_LINE_RES: RegExp[] = [
  /^VERORDNUNG \(EU\) …\s*$/i,
  /^RICHTLINIE \(EU\) …\s*$/i,
  /^Präambel$/i,
  /^verfügender Teil$/i,
  /^Schluss$/i,
  /^Anhang [IVXLCDM]+[a-z]?$/,
  /^ANHANG [IVXLCDM]+[a-z]?$/,
  /^European flag\s*$/i,
  /^Amtsblatt$/i,
  /^Amtsblatt der Europäischen Union$/i,
  /^der Europäischen Union$/i,
  /^Reihe [A-Z]$/,
  /^DE$/,
  /^L \d+\/\d+$/,                 // OJ reference like "L 119/1"
  /^\d{4}\/\d+$/,                 // CELEX-style "2024/1689"
  /^\d{1,2}\.\d{1,2}\.\d{4}\s*$/, // dates "27.12.2022"
];

const EU_PREAMBLE_PLACEHOLDER =
  'Präambel — die Erwägungsgründe des Gesetzgebers. Wählen Sie einen Artikel in der Navigation, um den verfügenden Teil zu lesen.';

function isEuTocLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return EU_TOC_LINE_RES.some((re) => re.test(t));
}

// Walk forward from idx through blank/TOC lines and return the first index whose
// line carries real content (or lines.length when none remains).
function nextContentIndex(lines: string[], idx: number): number {
  let j = idx;
  while (j < lines.length) {
    const t = lines[j].trim();
    if (t && !isEuTocLine(lines[j])) return j;
    j++;
  }
  return j;
}

function parseEuRegulation(text: string, regId: string): LegislationNode {
  const root: LegislationNode = {
    id: 'root', type: 'root', label: '', shortLabel: '', content: '', children: [], kbEntryIds: [],
  };

  const lines = text.split('\n');

  // ── Locate the real preamble start ──
  // EUR-Lex exports start with a TOC block ("VERORDNUNG (EU) …", "Präambel",
  // "verfügender Teil", "Schluss", "Anhang I-XIII", "European flag", "Amtsblatt"...)
  // The real text begins at the first line matching the act header
  // ("VERORDNUNG (EU) 2024/1689 DES EUROPÄISCHEN PARLAMENTS UND DES RATES").
  let preambleStartIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(VERORDNUNG|RICHTLINIE)\s+\(EU\)\s+\d+\/\d+\s+DES\s+EUROPÄISCHEN\s+PARLAMENTS/i.test(t)) {
      preambleStartIdx = i;
      break;
    }
  }

  // Find the main-body start (first KAPITEL/Artikel).
  let mainStartIdx = lines.length;
  for (let i = preambleStartIdx; i < lines.length; i++) {
    if (EU_CHAPTER_RE.test(lines[i].trim()) || EU_ARTICLE_RE.test(lines[i].trim())) {
      mainStartIdx = i;
      break;
    }
  }

  // Collect preamble, dropping any TOC lines that snuck through.
  const preambleLines: string[] = [];
  for (let i = preambleStartIdx; i < mainStartIdx; i++) {
    if (!isEuTocLine(lines[i])) preambleLines.push(lines[i]);
  }
  const preambleContent = preambleLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  root.children.push({
    id: nextId('preamble'),
    type: 'section',
    label: 'Präambel',
    shortLabel: 'Präambel',
    content: preambleContent.length > 200 ? preambleContent : EU_PREAMBLE_PLACEHOLDER,
    children: [],
    kbEntryIds: [],
  });

  let currentChapter: LegislationNode | null = null;
  let currentArticle: LegislationNode | null = null;
  let buffer: string[] = [];

  function flushArticle() {
    if (currentArticle) {
      currentArticle.content = buffer.join('\n').trim();
      currentArticle.kbEntryIds = matchKbEntries(regId, currentArticle.label + ' ' + currentArticle.content);
      buffer = [];
    }
  }

  for (let i = mainStartIdx; i < lines.length; i++) {
    const line = lines[i].trim();

    const annexMatch = line.match(/^(Anhang|ANHANG)\s+([IVXLCDM]+[a-z]?)\s*$/);
    if (annexMatch) {
      flushArticle();
      currentChapter = null;
      currentArticle = null;
      const annexLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i].trim();
        if (/^(Anhang|ANHANG)\s+[IVXLCDM]/.test(nextLine)) { i--; break; }
        annexLines.push(lines[i]);
        i++;
      }
      root.children.push({
        id: nextId('annex'),
        type: 'annex',
        label: `Anhang ${annexMatch[2]}`,
        shortLabel: `Anhang ${annexMatch[2]}`,
        content: annexLines.join('\n').trim(),
        children: [],
        kbEntryIds: [],
      });
      continue;
    }

    const chapterMatch = line.match(/^(KAPITEL|TITEL|CHAPTER)\s+([IVXLCDM]+)\s*$/);
    if (chapterMatch) {
      flushArticle();
      // Walk past blank lines to find the chapter title.
      const titleIdx = nextContentIndex(lines, i + 1);
      let title = '';
      if (titleIdx < lines.length) {
        const t = lines[titleIdx].trim();
        if (!EU_ARTICLE_RE.test(t) && !EU_CHAPTER_RE.test(t) && !/^\(\d+\)/.test(t) && t.length < 200) {
          title = t;
          i = titleIdx;
        }
      }
      const label = title ? `${chapterMatch[1]} ${chapterMatch[2]} — ${title}` : `${chapterMatch[1]} ${chapterMatch[2]}`;
      currentChapter = {
        id: nextId('chap'),
        type: 'chapter',
        label,
        shortLabel: `${chapterMatch[1]} ${chapterMatch[2]}`,
        content: '',
        children: [],
        kbEntryIds: [],
      };
      root.children.push(currentChapter);
      currentArticle = null;
      buffer = [];
      continue;
    }

    const articleMatch = line.match(/^Artikel\s+(\d+)\s*$/);
    if (articleMatch) {
      flushArticle();
      // Walk past blank lines to find the article title.
      const titleIdx = nextContentIndex(lines, i + 1);
      let title = '';
      if (titleIdx < lines.length) {
        const t = lines[titleIdx].trim();
        if (!EU_ARTICLE_RE.test(t) && !EU_CHAPTER_RE.test(t) && !/^\(\d+\)/.test(t) && t.length < 200) {
          title = t;
          i = titleIdx;
        }
      }
      const label = title ? `Artikel ${articleMatch[1]} — ${title}` : `Artikel ${articleMatch[1]}`;
      currentArticle = {
        id: nextId('art'),
        type: 'article',
        label,
        shortLabel: `Art. ${articleMatch[1]}`,
        content: '',
        children: [],
        kbEntryIds: [],
      };
      if (currentChapter) {
        currentChapter.children.push(currentArticle);
      } else {
        root.children.push(currentArticle);
      }
      buffer = [];
      continue;
    }

    buffer.push(lines[i]);
  }
  flushArticle();

  return root;
}

// ─────────────────────────── CH Law (revDSG) ───────────────────────────

function parseChLaw(text: string, regId: string): LegislationNode {
  const root: LegislationNode = { id: 'root', type: 'root', label: '', shortLabel: '', content: '', children: [], kbEntryIds: [] };
  const lines = text.split('\n');
  let currentChapter: LegislationNode | null = null;
  let currentArticle: LegislationNode | null = null;
  let buffer: string[] = [];
  let preambleDone = false;
  const preambleLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const chapMatch = line.match(/^(\d+)\.\s*Kapitel:?\s*(.*)$/);
    const artMatch = line.match(/^Art\.\s*(\d+[a-z]?)\s*(.*)$/);

    if (!preambleDone && !chapMatch && !artMatch) {
      preambleLines.push(lines[i]);
      continue;
    }

    if (!preambleDone) {
      preambleDone = true;
      if (preambleLines.length > 0) {
        root.children.push({ id: nextId('pre'), type: 'section', label: 'Einleitung', shortLabel: 'Einleitung', content: preambleLines.join('\n').trim(), children: [], kbEntryIds: [] });
      }
    }

    if (chapMatch) {
      flushNode();
      const label = chapMatch[2] ? `${chapMatch[1]}. Kapitel — ${chapMatch[2]}` : `${chapMatch[1]}. Kapitel`;
      currentChapter = { id: nextId('chap'), type: 'chapter', label, shortLabel: `Kap. ${chapMatch[1]}`, content: '', children: [], kbEntryIds: [] };
      root.children.push(currentChapter);
      currentArticle = null;
      buffer = [];
      continue;
    }

    if (artMatch) {
      flushNode();
      const label = artMatch[2] ? `Art. ${artMatch[1]} ${artMatch[2]}` : `Art. ${artMatch[1]}`;
      currentArticle = { id: nextId('art'), type: 'article', label, shortLabel: `Art. ${artMatch[1]}`, content: '', children: [], kbEntryIds: [] };
      if (currentChapter) currentChapter.children.push(currentArticle);
      else root.children.push(currentArticle);
      buffer = [];
      continue;
    }

    buffer.push(lines[i]);
  }
  flushNode();

  function flushNode() {
    if (currentArticle) {
      currentArticle.content = buffer.join('\n').trim();
      currentArticle.kbEntryIds = matchKbEntries(regId, currentArticle.label + ' ' + currentArticle.content);
      buffer = [];
    }
  }

  return root;
}

// ─────────────────────────── CH Circular (FINMA RS) ───────────────────────────

function parseChCircular(text: string, regId: string): LegislationNode {
  return parseSectionBased(text, regId, /^([IVXLCDM]+)\.\s+(.+)$/m, /^(?:Rz|Randziffer)\s+(\d+(?:[–-]\d+)?)\s*(.*)$/m);
}

// ─────────────────────────── CH Guidance (FINMA 08/2024) ───────────────────────────

function parseChGuidance(text: string, regId: string): LegislationNode {
  return parseSectionBased(text, regId, /^(\d+(?:\.\d+)?)\s+([A-ZÄÖÜ].{3,})$/m, /^(\d+\.\d+\.\d+)\s+(.+)$/m);
}

// ─────────────────────────── DE Law (BDSG, BSIG) ───────────────────────────

function parseDeLaw(text: string, regId: string): LegislationNode {
  const root: LegislationNode = { id: 'root', type: 'root', label: '', shortLabel: '', content: '', children: [], kbEntryIds: [] };
  const lines = text.split('\n');
  let currentSection: LegislationNode | null = null;
  let currentParagraph: LegislationNode | null = null;
  let buffer: string[] = [];
  const preambleLines: string[] = [];
  let preambleDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const teilMatch = line.match(/^Teil\s+(\d+)\s*(.*)$/);
    const kapMatch = line.match(/^(?:Kapitel|Abschnitt|Unterabschnitt)\s+(\d+)\s*(.*)$/);
    const paraMatch = line.match(/^§\s*(\d+[a-z]?)\s+(.+)$/);

    if (!preambleDone && !teilMatch && !kapMatch && !paraMatch) {
      preambleLines.push(lines[i]);
      continue;
    }
    if (!preambleDone) {
      preambleDone = true;
      if (preambleLines.length > 0) {
        root.children.push({ id: nextId('pre'), type: 'section', label: 'Einleitung', shortLabel: 'Einleitung', content: preambleLines.join('\n').trim(), children: [], kbEntryIds: [] });
      }
    }

    if (teilMatch || kapMatch) {
      flush();
      const m = teilMatch ?? kapMatch!;
      const prefix = teilMatch ? 'Teil' : 'Abschnitt';
      const label = m[2] ? `${prefix} ${m[1]} — ${m[2]}` : `${prefix} ${m[1]}`;
      currentSection = { id: nextId('sec'), type: 'chapter', label, shortLabel: `${prefix} ${m[1]}`, content: '', children: [], kbEntryIds: [] };
      root.children.push(currentSection);
      currentParagraph = null;
      buffer = [];
      continue;
    }

    if (paraMatch) {
      flush();
      const label = `§ ${paraMatch[1]} ${paraMatch[2]}`;
      currentParagraph = { id: nextId('para'), type: 'article', label, shortLabel: `§ ${paraMatch[1]}`, content: '', children: [], kbEntryIds: [] };
      if (currentSection) currentSection.children.push(currentParagraph);
      else root.children.push(currentParagraph);
      buffer = [];
      continue;
    }

    buffer.push(lines[i]);
  }
  flush();

  function flush() {
    if (currentParagraph) {
      currentParagraph.content = buffer.join('\n').trim();
      currentParagraph.kbEntryIds = matchKbEntries(regId, currentParagraph.label + ' ' + currentParagraph.content);
      buffer = [];
    }
  }

  return root;
}

// ─────────────────────────── DE Circular (MaRisk, BAIT) ───────────────────────────

function parseDeCircular(text: string, regId: string): LegislationNode {
  const root: LegislationNode = { id: 'root', type: 'root', label: '', shortLabel: '', content: '', children: [], kbEntryIds: [] };
  const lines = text.split('\n');
  let currentSection: LegislationNode | null = null;
  let buffer: string[] = [];
  const preambleLines: string[] = [];
  let preambleDone = false;

  const sectionRe = /^(AT|BT)\s+(\d+(?:\.\d+)*)\s+(.+)$/;
  const itSectionRe = /^(IT-\w+)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const secMatch = line.match(sectionRe);
    const itMatch = line.match(itSectionRe);

    if (!preambleDone && !secMatch && !itMatch) {
      preambleLines.push(lines[i]);
      continue;
    }
    if (!preambleDone) {
      preambleDone = true;
      if (preambleLines.length > 0) {
        root.children.push({ id: nextId('pre'), type: 'section', label: 'Vorbemerkung', shortLabel: 'Vorbemerkung', content: preambleLines.join('\n').trim(), children: [], kbEntryIds: [] });
      }
    }

    if (secMatch || itMatch) {
      if (currentSection) {
        currentSection.content = buffer.join('\n').trim();
        currentSection.kbEntryIds = matchKbEntries(regId, currentSection.label + ' ' + currentSection.content);
      }
      buffer = [];
      const label = secMatch ? `${secMatch[1]} ${secMatch[2]} ${secMatch[3]}` : itMatch![1];
      const short = secMatch ? `${secMatch[1]} ${secMatch[2]}` : itMatch![1];
      currentSection = { id: nextId('sec'), type: 'section', label, shortLabel: short, content: '', children: [], kbEntryIds: [] };
      root.children.push(currentSection);
      continue;
    }

    buffer.push(lines[i]);
  }
  if (currentSection) {
    currentSection.content = buffer.join('\n').trim();
    currentSection.kbEntryIds = matchKbEntries(regId, currentSection.label + ' ' + currentSection.content);
  }

  return root;
}

// ─────────────────────────── ISO Standard ───────────────────────────

function parseIsoStandard(text: string, regId: string): LegislationNode {
  const root: LegislationNode = { id: 'root', type: 'root', label: '', shortLabel: '', content: '', children: [], kbEntryIds: [] };
  const lines = text.split('\n');
  let currentSection: LegislationNode | null = null;
  let currentSub: LegislationNode | null = null;
  let buffer: string[] = [];
  const preambleLines: string[] = [];
  let preambleDone = false;

  const mainSecRe = /^(\d+)\s+([A-ZÄÖÜ].{2,})$/;
  const subSecRe = /^(\d+\.\d+(?:\.\d+)?)\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const mainMatch = line.match(mainSecRe);
    const subMatch = line.match(subSecRe);

    if (!preambleDone && !mainMatch && !subMatch) {
      preambleLines.push(lines[i]);
      continue;
    }
    if (!preambleDone) {
      preambleDone = true;
      if (preambleLines.length > 0) {
        root.children.push({ id: nextId('pre'), type: 'section', label: 'Vorwort', shortLabel: 'Vorwort', content: preambleLines.join('\n').trim(), children: [], kbEntryIds: [] });
      }
    }

    if (mainMatch && !subMatch) {
      flushSub();
      flushSec();
      currentSection = { id: nextId('sec'), type: 'chapter', label: `${mainMatch[1]} ${mainMatch[2]}`, shortLabel: mainMatch[1], content: '', children: [], kbEntryIds: [] };
      root.children.push(currentSection);
      currentSub = null;
      buffer = [];
      continue;
    }

    if (subMatch) {
      flushSub();
      currentSub = { id: nextId('sub'), type: 'subsection', label: `${subMatch[1]} ${subMatch[2]}`, shortLabel: subMatch[1], content: '', children: [], kbEntryIds: [] };
      if (currentSection) currentSection.children.push(currentSub);
      else root.children.push(currentSub);
      buffer = [];
      continue;
    }

    buffer.push(lines[i]);
  }
  flushSub();
  flushSec();

  function flushSub() {
    if (currentSub) {
      currentSub.content = buffer.join('\n').trim();
      currentSub.kbEntryIds = matchKbEntries(regId, currentSub.label + ' ' + currentSub.content);
      buffer = [];
    }
  }
  function flushSec() {
    if (currentSection && !currentSub) {
      currentSection.content = buffer.join('\n').trim();
      buffer = [];
    }
  }

  return root;
}

// ─────────────────────────── NIST Framework ───────────────────────────

function parseNistFramework(text: string, regId: string): LegislationNode {
  return parseSectionBased(text, regId, /^(?:Teil|Part)\s+(\d+):?\s*(.*)$/m, /^(\d+(?:\.\d+)+)\s+(.+)$/m);
}

// ─────────────────────────── Generic section-based ───────────────────────────

function parseSectionBased(
  text: string,
  regId: string,
  sectionRe: RegExp,
  subRe: RegExp,
): LegislationNode {
  const root: LegislationNode = { id: 'root', type: 'root', label: '', shortLabel: '', content: '', children: [], kbEntryIds: [] };
  const lines = text.split('\n');
  let currentSection: LegislationNode | null = null;
  let currentSub: LegislationNode | null = null;
  let buffer: string[] = [];
  const preambleLines: string[] = [];
  let preambleDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const secMatch = line.match(sectionRe);
    const subMatch = line.match(subRe);

    if (!preambleDone && !secMatch && !subMatch) {
      preambleLines.push(lines[i]);
      continue;
    }
    if (!preambleDone) {
      preambleDone = true;
      if (preambleLines.length > 0) {
        root.children.push({ id: nextId('pre'), type: 'section', label: 'Einleitung', shortLabel: 'Einleitung', content: preambleLines.join('\n').trim(), children: [], kbEntryIds: [] });
      }
    }

    if (secMatch) {
      flushSub();
      if (currentSection) { currentSection.content += buffer.join('\n').trim(); buffer = []; }
      const label = secMatch[2] ? `${secMatch[1]} ${secMatch[2]}`.trim() : secMatch[1];
      currentSection = { id: nextId('sec'), type: 'chapter', label, shortLabel: secMatch[1], content: '', children: [], kbEntryIds: [] };
      root.children.push(currentSection);
      currentSub = null;
      buffer = [];
      continue;
    }

    if (subMatch) {
      flushSub();
      const label = `${subMatch[1]} ${subMatch[2]}`.trim();
      currentSub = { id: nextId('sub'), type: 'subsection', label, shortLabel: subMatch[1], content: '', children: [], kbEntryIds: [] };
      if (currentSection) currentSection.children.push(currentSub);
      else root.children.push(currentSub);
      buffer = [];
      continue;
    }

    buffer.push(lines[i]);
  }
  flushSub();
  if (currentSection) currentSection.content += buffer.join('\n').trim();

  function flushSub() {
    if (currentSub) {
      currentSub.content = buffer.join('\n').trim();
      currentSub.kbEntryIds = matchKbEntries(regId, currentSub.label + ' ' + currentSub.content);
      buffer = [];
    }
  }

  return root;
}

// ─────────────────────────── Fallback ───────────────────────────

function parseFallback(text: string, regId: string): LegislationNode {
  const root: LegislationNode = { id: 'root', type: 'root', label: '', shortLabel: '', content: '', children: [], kbEntryIds: [] };
  const sections = text.split(/\n\s*\n/).filter((s) => s.trim().length > 0);
  for (const sec of sections) {
    const firstLine = sec.trim().split('\n')[0].slice(0, 80);
    root.children.push({
      id: nextId('sec'),
      type: 'paragraph',
      label: firstLine,
      shortLabel: firstLine.slice(0, 40),
      content: sec.trim(),
      children: [],
      kbEntryIds: matchKbEntries(regId, sec),
    });
  }
  return root;
}
