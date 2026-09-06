import type Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../types';
import {
  extractRegulationTags,
  loadActiveFactsForUser,
  markSuperseded,
  createMemoryFact,
} from '../cross-memory';
import { similarity } from '../soul-health';
import { MemoryConfig } from '../memory-config';

export const SAVE_FACT_SCHEMA: Anthropic.Tool = {
  name: 'save_fact',
  description:
    'Speichert eine wichtige regulatorische Erkenntnis, Entscheidung oder offene Aufgabe ' +
    'als dauerhaftes Faktum im Gedächtnis des Nutzers. Verwende dieses Tool, wenn der ' +
    'Nutzer eine klare Entscheidung trifft, ein wichtiger Schluss gezogen wird oder eine ' +
    'Aufgabe identifiziert wird, die über diese Unterhaltung hinaus relevant ist. ' +
    'NICHT verwenden für: Stilpräferenzen (dafür existiert das Soul-System), triviale ' +
    'oder kurzlebige Informationen, oder Fakten die bereits gespeichert sind.',
  input_schema: {
    type: 'object',
    properties: {
      fact: {
        type: 'string',
        description: 'Der zu speichernde Fakt — präzise, in einem Satz.',
      },
      category: {
        type: 'string',
        enum: ['decision', 'conclusion', 'open_task', 'general'],
        description: 'Art des Faktums.',
      },
      importance: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: '1 = nice-to-know, 3 = standard, 5 = geschäftskritisch. Standard: 3.',
      },
      regulations: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Betroffene Regulierungen, z.B. ["DORA", "MaRisk"]. Wird auch automatisch aus dem Text extrahiert.',
      },
    },
    required: ['fact', 'category'],
  },
};

type SaveFactInput = {
  fact: string;
  category: 'decision' | 'conclusion' | 'open_task' | 'general';
  importance?: number;
  regulations?: string[];
};

type SaveFactResult =
  | { status: 'saved'; factId: string; tags: string[] }
  | { status: 'duplicate'; existingFact: string }
  | { status: 'error'; message: string };

export async function executeSaveFact(
  input: unknown,
  ctx: ToolContext,
): Promise<SaveFactResult> {
  const { fact, category, importance, regulations } = input as SaveFactInput;

  if (!ctx.userId) {
    return { status: 'error', message: 'Faktenspeicherung erfordert eine Anmeldung.' };
  }
  if (!fact || typeof fact !== 'string' || fact.trim().length === 0) {
    return { status: 'error', message: 'Kein Fakt angegeben.' };
  }

  // Extract tags from text + merge with explicitly provided regulations.
  const autoTags = extractRegulationTags(fact);
  const explicitTags = (regulations ?? []).map((r) => r.toUpperCase());
  const tags = [...new Set([...autoTags, ...explicitTags])].sort();

  // Load existing active facts for dedup + supersession.
  const existing = await loadActiveFactsForUser(ctx.userId);

  // Dedup: skip if too similar to an existing active fact.
  const dup = existing.find(
    (f) => similarity(f.content, fact) >= MemoryConfig.memoryDuplicateThreshold,
  );
  if (dup) {
    return { status: 'duplicate', existingFact: dup.content };
  }

  // Supersession: same category + overlapping tags → mark old as superseded.
  const toSupersede = existing.filter(
    (f) => f.category === category && f.tags.some((t) => tags.includes(t)),
  );
  for (const old of toSupersede) {
    await markSuperseded(old.id);
  }

  const result = await createMemoryFact({
    userId: ctx.userId,
    content: fact.trim(),
    tags,
    category,
    importance: importance ?? 3,
    sourceConversationId: ctx.conversationId ?? null,
  });

  return { status: 'saved', factId: result.id, tags };
}
