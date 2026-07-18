import type { AegisPlan } from '../plan';
import type { JobDb, JobRow, SectionRow } from '../job-store';

/**
 * In-memory JobDb stub implementing exactly the query shapes the store issues.
 * Guarded `updateMany` semantics (count reflects the WHERE match) are the part
 * under test — they carry the concurrency story.
 */
export function makeStubDb(): JobDb & {
  jobs: JobRow[];
  sections: SectionRow[];
  conversations: Array<{ id: string; sessionId: string; userId: string | null; mode: string; language: string }>;
  messages: Array<{ conversationId: string; role: string; seq: number; content: string }>;
} {
  const state = {
    jobs: [] as JobRow[],
    sections: [] as SectionRow[],
    conversations: [] as Array<{
      id: string;
      sessionId: string;
      userId: string | null;
      mode: string;
      language: string;
    }>,
    messages: [] as Array<{ conversationId: string; role: string; seq: number; content: string }>,
  };

  const matchJob = (row: JobRow, where: Record<string, unknown>): boolean => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.resumeCount !== undefined) {
      const cond = where.resumeCount as { lt: number };
      if (!(row.resumeCount < cond.lt)) return false;
    }
    return true;
  };
  const matchSection = (row: SectionRow, where: Record<string, unknown>): boolean => {
    if (where.jobId !== undefined && row.jobId !== where.jobId) return false;
    if (where.index !== undefined && row.index !== where.index) return false;
    if (where.status !== undefined) {
      const cond = where.status;
      if (typeof cond === 'string') {
        if (row.status !== cond) return false;
      } else {
        const list = (cond as { in: string[] }).in;
        if (!list.includes(row.status)) return false;
      }
    }
    return true;
  };

  const dbApi: JobDb = {
    aegisJob: {
      async create(args) {
        const { data } = args as { data: Omit<JobRow, 'id'> };
        const row: JobRow = { id: `job-${state.jobs.length + 1}`, ...data } as JobRow;
        state.jobs.push(row);
        return row;
      },
      async findFirst(args) {
        const { where } = args as { where: Record<string, unknown> };
        return state.jobs.find((j) => matchJob(j, where)) ?? null;
      },
      async updateMany(args) {
        const { where, data } = args as {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        };
        let count = 0;
        for (const row of state.jobs) {
          if (!matchJob(row, where)) continue;
          count++;
          if (data.status !== undefined) row.status = data.status as string;
          if (data.cursor !== undefined) row.cursor = data.cursor as number;
          if (data.resumeCount !== undefined) {
            const inc = data.resumeCount as { increment: number };
            row.resumeCount += inc.increment;
          }
        }
        return { count };
      },
    },
    aegisJobSection: {
      async createMany(args) {
        const { data } = args as { data: Array<Partial<SectionRow>> };
        for (const d of data) {
          state.sections.push({
            contentMd: null,
            digestJson: null,
            citationsJson: null,
            verifyJson: null,
            firstPassOk: null,
            ...d,
            id: `sec-${state.sections.length + 1}`,
          } as SectionRow);
        }
        return { count: data.length };
      },
      async findMany(args) {
        const { where } = args as { where: Record<string, unknown> };
        return state.sections
          .filter((s) => matchSection(s, where))
          .sort((a, b) => a.index - b.index);
      },
      async updateMany(args) {
        const { where, data } = args as {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        };
        let count = 0;
        for (const row of state.sections) {
          if (!matchSection(row, where)) continue;
          count++;
          Object.assign(row, data);
        }
        return { count };
      },
    },
    aegisConversation: {
      async findFirst(args) {
        const { where } = args as {
          where: { id: string; OR: Array<Record<string, string>> };
        };
        const row = state.conversations.find(
          (c) =>
            c.id === where.id &&
            where.OR.some(
              (cond) =>
                (cond.sessionId !== undefined && c.sessionId === cond.sessionId) ||
                (cond.userId !== undefined && c.userId === cond.userId),
            ),
        );
        return row ? { id: row.id, mode: row.mode, language: row.language } : null;
      },
    },
    aegisMessage: {
      async findFirst(args) {
        const { where } = args as { where: { conversationId: string; role: string } };
        const rows = state.messages
          .filter((m) => m.conversationId === where.conversationId && m.role === where.role)
          .sort((a, b) => a.seq - b.seq);
        return rows[0] ? { content: rows[0].content } : null;
      },
    },
    async $transaction(fn) {
      return fn(dbApi);
    },
  };

  return Object.assign(dbApi, state);
}

export const PLAN: AegisPlan = {
  sections: [
    {
      title: 'Einleitung',
      covers: ['einleitung'],
      coversNot: [],
      kbDomains: ['DORA'],
      grounded: true,
      outputShape: 'prose',
      estTokens: 800,
    },
    {
      title: 'Kontrollkatalog',
      covers: ['katalog'],
      coversNot: [],
      kbDomains: [],
      grounded: false,
      outputShape: 'table',
      estTokens: 1200,
    },
  ],
  vocab: {
    entities: ['Muster GmbH'],
    jurisdictions: ['EU'],
    terminology: [],
    citationStyle: '[R-...] inline',
  },
};
