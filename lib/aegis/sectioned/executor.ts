import type Anthropic from '@anthropic-ai/sdk';
import { CostAccumulator } from '../context/cost';
import { intEnv } from '../env';
import { runInnerLoopStreaming, runToolFreeRepair, trimForRetry, type LoopState } from '../loop';
import { timeLeftMs } from '../degrade';
import type { ModeSpec } from '../modes';
import { MODEL_IDS } from '../types';
import type { ToolAuditEntry, VerifyResult } from '../types';
import { generateSectionDigest } from './section-digest';
import { verifySection, type SectionVerifyOutcome } from './section-verify';
import {
  checkRepairFeedback,
  hasBlockingFindings,
  runSectionChecks,
  type SectionCheckFindings,
} from './section-checks';
import { EXTERNAL_STANDARDS_FOOTNOTE_DE } from '../statusLabels';
import type { SectionedStreamEvent } from './events';
import {
  persistSectionResult,
  planSections,
  planVocab,
  resetStaleWriting,
  transitionJob,
  transitionSection,
  type JobDb,
  type JobWithSections,
} from './job-store';
import type { PlanSection, PlanVocab } from './plan';
import type { SectionDigest } from './section-digest';

/**
 * Sectioned executor (epic Station 2, decisions F9/P3). Generates sections
 * strictly in plan order, one at a time:
 *
 *   time gate → pending→writing → inner tool loop (Sonnet, ≤4 tool iterations,
 *   section token cap) → section verify → ≤2 tool-free repair passes →
 *   done | degraded → digest → persist (single transaction, cursor advance)
 *
 * P3: before EVERY section the remaining wall-clock is checked; below the
 * resume floor the job pauses cleanly (no error event — the iron rule). A
 * half-finished section is never persisted: a crash mid-section leaves the row
 * 'writing', which `resetStaleWriting` returns to 'pending' on the next resume
 * — retries therefore never duplicate completed work.
 *
 * F9: repair uses the tool-free repair pass; a section that still fails verify
 * is persisted as 'degraded' and the job CONTINUES — never a full-job
 * regeneration.
 */

export const sectionRepairMax = (): number => intEnv('AEGIS_SECTION_REPAIR_MAX', 2);
export const resumeTimeFloorMs = (): number => intEnv('AEGIS_RESUME_TIME_FLOOR_MS', 90_000);
export const sectionMaxTokens = (): number => intEnv('AEGIS_SECTION_MAX_TOKENS', 4096);

/** 4 tool iterations + the forced-answer reserve slot (inner-loop semantics). */
const SECTION_MAX_ITERATIONS = 5;

export type ExecutorOutcome =
  | { status: 'done' }
  | { status: 'paused'; cursor: number }
  | { status: 'failed'; code: string };

export type ExecutorDeps = {
  client?: JobDb;
  innerLoop?: typeof runInnerLoopStreaming;
  repair?: typeof runToolFreeRepair;
  digestFn?: typeof generateSectionDigest;
  verifyFn?: typeof verifySection;
  now?: () => number;
};

export type ExecutorContext = {
  /** Base spec of the triaged mode — section overrides applied on top. */
  baseSpec: ModeSpec;
  language: 'de' | 'en';
  /** Original user request — every section call sees the full deliverable ask. */
  userMessage: string;
  /** Absolute wall-clock deadline of the CURRENT invocation (route deadline). */
  deadlineAt: number;
  cost: CostAccumulator;
  toolContext: LoopState['toolContext'];
  /** Collects per-section tool audit entries into the run's audit trail. */
  toolAudit?: ToolAuditEntry[];
};

function sectionContextBlock(
  sections: PlanSection[],
  vocab: PlanVocab,
  section: PlanSection,
  index: number,
  digests: Array<{ title: string; digest: SectionDigest }>,
  language: 'de' | 'en',
): string {
  const outline = sections
    .map((s, i) => `${i + 1}. ${s.title}${i === index ? '  ← DIESER ABSCHNITT' : ''}`)
    .join('\n');
  const digestLines = digests
    .map(
      (d) =>
        `- ${d.title}: ${[...d.digest.claims, ...d.digest.definedTerms].slice(0, 10).join(' | ') || '(kein Digest)'}`,
    )
    .join('\n');
  const vocabLines = [
    vocab.entities.length ? `Entitäten (verbatim verwenden): ${vocab.entities.join(', ')}` : '',
    vocab.jurisdictions.length ? `Jurisdiktionen: ${vocab.jurisdictions.join(', ')}` : '',
    vocab.terminology.length ? `Terminologie: ${vocab.terminology.join('; ')}` : '',
    `Zitierstil: ${vocab.citationStyle}`,
  ]
    .filter(Boolean)
    .join('\n');
  const langNote = language === 'de' ? 'Schreibe auf DEUTSCH.' : 'Write in ENGLISH.';
  return (
    `Du schreibst genau EINEN Abschnitt eines mehrteiligen Reports.\n\n` +
    `Gesamtgliederung:\n${outline}\n\n` +
    `Dein Abschnitt: "${section.title}"\n` +
    `- Behandelt AUSSCHLIESSLICH: ${section.covers.join(', ')}\n` +
    (section.coversNot.length
      ? `- NICHT behandeln (gehört anderen Abschnitten): ${section.coversNot.join(', ')}\n`
      : '') +
    `- Format: ${section.outputShape === 'table' ? 'Markdown-Tabelle(n) mit knapper Einleitung' : 'Fließtext mit Zwischenüberschriften'}\n` +
    `- Zielumfang: ~${section.estTokens} Tokens\n` +
    (section.grounded
      ? `- KB-Domänen: ${section.kbDomains.join(', ')} — nutze die Tools und zitiere jede gestützte Aussage mit [R-...].\n`
      : `- Beratungsinhalt ohne KB-Anker: KEINE [R-...]-Zitate erfinden; als Empfehlung formulieren.\n`) +
    `\nGeteiltes Vokabular:\n${vocabLines}\n` +
    (digestLines ? `\nBereits geschriebene Abschnitte (Digest):\n${digestLines}\n` : '') +
    `\nGib NUR den Abschnittsinhalt aus — keine Gesamt-Einleitung, kein Fazit des Reports. ${langNote}`
  );
}

function sectionSpec(base: ModeSpec, contextBlock: string): ModeSpec {
  return {
    ...base,
    systemBlocks: [...base.systemBlocks, { text: contextBlock, cached: false }],
    maxTokens: sectionMaxTokens(),
    maxIterations: SECTION_MAX_ITERATIONS,
  };
}

/**
 * Execute all remaining sections of a job. Yields SECTIONED events; returns
 * the outcome. The caller owns job-level status transitions BEFORE this runs
 * (job must be 'running') and event transport; this generator owns section
 * lifecycles, the P3 pause, and the terminal done/failed transition.
 */
export async function* executeJobSections(
  loaded: JobWithSections,
  ctx: ExecutorContext,
  deps: ExecutorDeps = {},
): AsyncGenerator<SectionedStreamEvent, ExecutorOutcome, void> {
  const client = deps.client;
  const innerLoop = deps.innerLoop ?? runInnerLoopStreaming;
  const repair = deps.repair ?? runToolFreeRepair;
  const digestFn = deps.digestFn ?? generateSectionDigest;
  const verifyFn = deps.verifyFn ?? verifySection;
  const now = deps.now ?? Date.now;

  const { job } = loaded;
  const sections = planSections(job);
  const vocab = planVocab(job);

  // Digests of already-finished sections (resume case) seed the context chain.
  const digests: Array<{ title: string; digest: SectionDigest }> = loaded.sections
    .filter((s) => (s.status === 'done' || s.status === 'degraded') && s.digestJson)
    .sort((a, b) => a.index - b.index)
    .map((s) => ({ title: s.title, digest: s.digestJson as SectionDigest }));

  // Full texts of sections completed IN THIS RUN — the PR-2 checks compare the
  // current section against every finished sibling (persisted + in-run).
  const completedTexts: Array<{ index: number; title: string; text: string }> = [];

  for (let index = job.cursor; index < sections.length; index++) {
    // ── P3 time gate: pause BEFORE starting a section that can't finish. ──
    if (timeLeftMs({ deadlineAt: ctx.deadlineAt, now }) < resumeTimeFloorMs()) {
      await transitionJob(job.id, 'running', 'paused', client);
      yield { type: 'job_paused', jobId: job.id, cursor: index };
      return { status: 'paused', cursor: index };
    }

    const section = sections[index];
    await transitionSection(job.id, index, 'pending', 'writing', client);
    yield { type: 'section_start', index, title: section.title };

    const contextBlock = sectionContextBlock(sections, vocab, section, index, digests, ctx.language);
    const spec = sectionSpec(ctx.baseSpec, contextBlock);

    // Fresh section-local state (F8: section-local allowedIds scope). Cost is
    // the SHARED accumulator so the job's spend is capped and billed as one run.
    const state: LoopState = {
      messages: [{ role: 'user', content: ctx.userMessage } satisfies Anthropic.MessageParam],
      iteration: 0,
      cost: ctx.cost,
      toolCalls: [],
      toolsCalled: 0,
      allowedIds: new Set<string>(),
      servedModels: new Set<string>(),
      guardrailsTriggered: [],
      toolContext: ctx.toolContext,
      toolAudit: ctx.toolAudit ?? [],
      deadlineAt: ctx.deadlineAt,
    };

    let text: string;
    try {
      const gen = innerLoop(spec, state, MODEL_IDS.sonnet);
      let sectionText = '';
      while (true) {
        const r = await gen.next();
        if (r.done) {
          sectionText = r.value;
          break;
        }
        // Forward only text tokens; tool-phase noise stays internal (iron rule).
        if (r.value.type === 'token') {
          yield { type: 'section_token', index, text: r.value.text };
        }
      }
      text = sectionText;
    } catch (err) {
      // Unrecoverable upstream/guard error → job fails closed with audit; the
      // completed sections stay persisted (partial-result persistence).
      await transitionJob(job.id, 'running', 'failed', client);
      const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'internal_error';
      console.error(
        JSON.stringify({
          event: 'aegis_job_failed',
          level: 'error',
          jobId: job.id,
          sectionIndex: index,
          code,
        }),
      );
      yield {
        type: 'job_failed',
        jobId: job.id,
        code,
        message: 'Der Report konnte nicht fortgesetzt werden. Bereits fertige Abschnitte sind gespeichert.',
      };
      return { status: 'failed', code };
    }

    // ── Verify → ≤2 tool-free repair passes → done | degraded (F9). ──
    const runVerify = (t: string): SectionVerifyOutcome =>
      verifyFn({
        text: t,
        grounded: section.grounded,
        allowedIds: state.allowedIds,
        toolsCalled: state.toolsCalled,
        toolsCalledNames: state.toolCalls.map((c) => c.name),
        language: ctx.language,
      });
    // PR 2: deterministic per-section checks against everything already
    // written. Blocking findings (duplication/scope) count as a verify failure
    // for the SHARED F9 repair budget; contradictions are audit-only.
    const priorTexts = loaded.sections
      .filter((s) => (s.status === 'done' || s.status === 'degraded') && s.contentMd)
      .map((s) => ({ index: s.index, title: s.title, text: s.contentMd as string }))
      .concat(completedTexts);
    const runChecks = (t: string): SectionCheckFindings =>
      runSectionChecks({
        text: t,
        section,
        sectionIndex: index,
        priors: priorTexts,
        vocab,
      });

    let outcome = runVerify(text);
    let verify: VerifyResult = outcome.verify;
    let checks = runChecks(text);
    const firstPassOk = verify.ok && !hasBlockingFindings(checks);
    let sectionStatus: 'writing' | 'revising' = 'writing';
    let repairs = 0;
    while ((!verify.ok || hasBlockingFindings(checks)) && repairs < sectionRepairMax()) {
      repairs++;
      if (sectionStatus !== 'revising') {
        await transitionSection(job.id, index, sectionStatus, 'revising', client);
        sectionStatus = 'revising';
      }
      try {
        const feedback = !verify.ok ? verify.reason : checkRepairFeedback(checks);
        const repaired = await repair(
          spec,
          MODEL_IDS.sonnet,
          trimForRetry(
            [{ role: 'user', content: ctx.userMessage }],
            state.messages,
            state.allowedIds,
            text,
            feedback,
          ),
          state,
        );
        if (typeof repaired !== 'string' || repaired.length === 0) break; // keep last good text
        text = repaired;
      } catch {
        break; // repair transport failure → degrade below, job continues
      }
      outcome = runVerify(text);
      verify = outcome.verify;
      checks = runChecks(text);
    }

    // Unrepaired check findings never fail the section (the assembler dedupes
    // deterministically); they are recorded for the audit trail below.
    const finalStatus: 'done' | 'degraded' = verify.ok ? 'done' : 'degraded';

    // F8: allowlisted external standards are NEVER a silent pass — footnote in
    // the section content plus a structured audit event.
    if (outcome.externalRefs.length > 0) {
      text = `${text.trimEnd()}\n\n${EXTERNAL_STANDARDS_FOOTNOTE_DE(outcome.externalRefs)}`;
    }
    if (
      outcome.externalRefs.length > 0 ||
      checks.contradiction.length > 0 ||
      hasBlockingFindings(checks)
    ) {
      console.warn(
        JSON.stringify({
          event: 'aegis_section_checks',
          level: 'warn',
          jobId: job.id,
          sectionIndex: index,
          externalRefs: outcome.externalRefs,
          duplication: checks.duplication,
          scope: checks.scope,
          contradiction: checks.contradiction.map((c) => ({
            term: c.term,
            withIndex: c.withIndex,
          })),
          repairs,
        }),
      );
    }
    const digest = await digestFn(text, {
      onUsage: (model, usage) => ctx.cost.add(model, usage),
    });
    const citations = [...new Set(text.match(/\[R-[A-Z0-9]+-[A-Z0-9-]+\]/g) ?? [])];
    await persistSectionResult(
      job.id,
      index,
      sectionStatus,
      {
        status: finalStatus,
        contentMd: text,
        digestJson: digest,
        citationsJson: citations,
        // Verify verdict plus the PR-2 audit trail: deterministic check
        // findings and F8 external-standard references, queryable per section.
        verifyJson: {
          ...verify,
          sectionChecks: checks,
          externalRefs: outcome.externalRefs,
        },
        firstPassOk,
      },
      client,
    );
    digests.push({ title: section.title, digest });
    completedTexts.push({ index, title: section.title, text });
    yield { type: 'section_done', index, status: finalStatus, firstPassOk };
  }

  await transitionJob(job.id, 'running', 'done', client);
  yield { type: 'job_done', jobId: job.id, cursor: sections.length };
  return { status: 'done' };
}

export { resetStaleWriting };
