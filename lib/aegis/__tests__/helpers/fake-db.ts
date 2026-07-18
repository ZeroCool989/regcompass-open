/**
 * In-memory stand-in for the Prisma client used by lib/aegis/document-store
 * and lib/aegis/memory. Implements just the query shapes those modules issue,
 * so unit tests run without a database. Honors vi.useFakeTimers via
 * `new Date()`.
 *
 * Fidelity notes:
 *  - `aegisMessage.create` enforces the (conversationId, seq) @@unique and
 *    throws `{ code: 'P2002' }` like Prisma — required by the seq-retry tests.
 *  - deleting a conversation cascades to its messages (DB-level
 *    `onDelete: Cascade` in the real schema).
 *  - `$transaction(fn)` just runs `fn(this)` with NO isolation — exactly what
 *    lets tests reproduce the concurrent-seq race deterministically.
 *
 * Usage in a test file:
 *   vi.mock('@/lib/db', async () => {
 *     const { fakeDb } = await import('./helpers/fake-db');
 *     return { db: fakeDb };
 *   });
 *   import { fakeDb } from './helpers/fake-db';
 *   afterEach(() => fakeDb.reset());
 */

type DocRow = {
  id: string;
  sessionId: string;
  filename: string;
  type: string;
  textContent: string;
  excelData: unknown;
  excelBuffer: Uint8Array | null;
  createdAt: Date;
  expiresAt: Date;
};

export type ConversationRow = {
  id: string;
  sessionId: string;
  userId: string | null;
  mode: string;
  language: string;
  title: string | null;
  createdAt: Date;
  lastTurnAt: Date;
  expiresAt: Date;
};

export type MessageRow = {
  id: string;
  conversationId: string;
  seq: number;
  role: string;
  content: string;
  citedIds: string[];
  status: string;
  exitReason: string | null;
  model: string | null;
  mode: string | null;
  toolCalls: unknown;
  traceId: string | null;
  createdAt: Date;
};

export type UsageRow = { id: string; conversationId: string } & Record<string, unknown>;

type DateFilter = Date | { gt?: Date; lt?: Date };

function dateMatches(value: Date, filter: DateFilter): boolean {
  if (filter instanceof Date) return value.getTime() === filter.getTime();
  if (filter.gt !== undefined && !(value > filter.gt)) return false;
  if (filter.lt !== undefined && !(value < filter.lt)) return false;
  return true;
}

function rowMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const value = row[key];
    if (value instanceof Date) {
      if (!dateMatches(value, cond as DateFilter)) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function applySelect<T extends Record<string, unknown>>(
  row: T,
  select?: Record<string, boolean>,
): T {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (select[key]) out[key] = row[key];
  }
  return out as T;
}

function sortBy<T extends Record<string, unknown>>(
  rows: T[],
  orderBy?: Record<string, 'asc' | 'desc'>,
): T[] {
  if (!orderBy) return rows;
  const [field, dir] = Object.entries(orderBy)[0];
  return [...rows].sort((a, b) => {
    const av = a[field] as number | Date;
    const bv = b[field] as number | Date;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === 'desc' ? -cmp : cmp;
  });
}

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++idCounter}`;
}

function createFakeDb() {
  const docRows: DocRow[] = [];
  const conversationRows: ConversationRow[] = [];
  const messageRows: MessageRow[] = [];
  const usageRows: UsageRow[] = [];

  function cascadeDeleteConversations(ids: string[]): void {
    for (let i = messageRows.length - 1; i >= 0; i--) {
      if (ids.includes(messageRows[i].conversationId)) messageRows.splice(i, 1);
    }
  }

  const base = {
    // Direct access for assertions / fixture setup.
    docRows,
    conversationRows,
    messageRows,
    usageRows,

    reset(): void {
      docRows.length = 0;
      conversationRows.length = 0;
      messageRows.length = 0;
      usageRows.length = 0;
    },

    aegisDocument: {
      async create({ data }: { data: Partial<DocRow> & { id: string } }): Promise<DocRow> {
        const row = {
          excelData: null,
          excelBuffer: null,
          createdAt: new Date(),
          ...data,
        } as DocRow;
        docRows.push(row);
        return row;
      },
      async findFirst({ where }: { where: Record<string, unknown> }): Promise<DocRow | null> {
        return docRows.find((r) => rowMatches(r, where)) ?? null;
      },
      async deleteMany({ where }: { where: Record<string, unknown> }): Promise<{ count: number }> {
        const before = docRows.length;
        for (let i = docRows.length - 1; i >= 0; i--) {
          if (rowMatches(docRows[i], where)) docRows.splice(i, 1);
        }
        return { count: before - docRows.length };
      },
    },

    aegisConversation: {
      async create({ data }: { data: Partial<ConversationRow> }): Promise<ConversationRow> {
        const row = {
          id: nextId('conv'),
          userId: null,
          title: null,
          createdAt: new Date(),
          lastTurnAt: new Date(),
          ...data,
        } as ConversationRow;
        conversationRows.push(row);
        return row;
      },
      async findFirst({ where }: { where: Record<string, unknown> }): Promise<ConversationRow | null> {
        return conversationRows.find((r) => rowMatches(r, where)) ?? null;
      },
      async findMany(args: {
        where?: Record<string, unknown>;
        orderBy?: Record<string, 'asc' | 'desc'>;
        select?: Record<string, boolean>;
      }): Promise<ConversationRow[]> {
        const rows = conversationRows.filter((r) => rowMatches(r, args.where ?? {}));
        return sortBy(rows, args.orderBy).map((r) =>
          applySelect(r as unknown as Record<string, unknown>, args.select),
        ) as ConversationRow[];
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<ConversationRow>;
      }): Promise<ConversationRow> {
        const row = conversationRows.find((r) => r.id === where.id);
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        Object.assign(row, data);
        return row;
      },
      async deleteMany({ where }: { where: Record<string, unknown> }): Promise<{ count: number }> {
        const doomed = conversationRows.filter((r) => rowMatches(r, where));
        for (const row of doomed) {
          conversationRows.splice(conversationRows.indexOf(row), 1);
        }
        cascadeDeleteConversations(doomed.map((r) => r.id));
        return { count: doomed.length };
      },
    },

    aegisMessage: {
      async create({ data }: { data: Partial<MessageRow> }): Promise<MessageRow> {
        const exists = messageRows.some(
          (r) => r.conversationId === data.conversationId && r.seq === data.seq,
        );
        if (exists) {
          throw Object.assign(
            new Error('Unique constraint failed on (conversationId, seq)'),
            { code: 'P2002' },
          );
        }
        const row = {
          id: nextId('msg'),
          citedIds: [],
          status: 'complete',
          exitReason: null,
          model: null,
          mode: null,
          toolCalls: null,
          traceId: null,
          createdAt: new Date(),
          ...data,
        } as MessageRow;
        messageRows.push(row);
        return row;
      },
      async findFirst(args: {
        where: Record<string, unknown>;
        orderBy?: Record<string, 'asc' | 'desc'>;
        select?: Record<string, boolean>;
      }): Promise<MessageRow | null> {
        const rows = sortBy(
          messageRows.filter((r) => rowMatches(r, args.where)),
          args.orderBy,
        );
        if (rows.length === 0) return null;
        return applySelect(
          rows[0] as unknown as Record<string, unknown>,
          args.select,
        ) as MessageRow;
      },
      async findMany(args: {
        where?: Record<string, unknown>;
        orderBy?: Record<string, 'asc' | 'desc'>;
        select?: Record<string, boolean>;
      }): Promise<MessageRow[]> {
        const rows = messageRows.filter((r) => rowMatches(r, args.where ?? {}));
        return sortBy(rows, args.orderBy).map((r) =>
          applySelect(r as unknown as Record<string, unknown>, args.select),
        ) as MessageRow[];
      },
      async deleteMany({ where }: { where: Record<string, unknown> }): Promise<{ count: number }> {
        const before = messageRows.length;
        for (let i = messageRows.length - 1; i >= 0; i--) {
          if (rowMatches(messageRows[i], where)) messageRows.splice(i, 1);
        }
        return { count: before - messageRows.length };
      },
    },

    aegisUsageLog: {
      async create({ data }: { data: Partial<UsageRow> }): Promise<UsageRow> {
        const row = { id: nextId('usage'), ...data } as UsageRow;
        usageRows.push(row);
        return row;
      },
    },
  };

  // `$transaction` runs the callback against the same (non-isolated) store —
  // defined outside `base` so the self-reference doesn't trip TS7022.
  return {
    ...base,
    async $transaction<T>(fn: (tx: typeof base) => Promise<T>): Promise<T> {
      return fn(base);
    },
  };
}

export const fakeDb = createFakeDb();
