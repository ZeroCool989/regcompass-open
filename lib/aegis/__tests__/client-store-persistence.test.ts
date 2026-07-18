import { describe, it, expect, beforeEach, afterAll } from 'vitest';

// Polyfill a minimal localStorage on the node global so the client-store's
// browser-guarded persistence helpers run in the node test environment.
const store = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => store.clear(),
};
(globalThis as unknown as { window: unknown }).window = { localStorage: fakeLocalStorage };

import {
  storeUploadedDocuments,
  readStoredUploadedDocuments,
  storeLastAttachment,
  readStoredLastAttachment,
  type UploadedDocument,
} from '../client-store';

beforeEach(() => store.clear());
afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('uploaded-document persistence survives a refresh (localStorage)', () => {
  const docs: UploadedDocument[] = [
    { id: 'd1', filename: 'policy.pdf', type: 'policy' },
    { id: 'd2', filename: 'template.xlsx', type: 'template' },
  ];

  it('round-trips uploaded documents (names + type)', () => {
    storeUploadedDocuments(docs);
    expect(readStoredUploadedDocuments()).toEqual(docs);
  });

  it('clears persisted docs when set to empty (reset/new session)', () => {
    storeUploadedDocuments(docs);
    storeUploadedDocuments([]);
    expect(readStoredUploadedDocuments()).toEqual([]);
    expect(fakeLocalStorage.getItem('aegis-uploaded-documents')).toBeNull();
  });

  it('ignores corrupt or invalid stored data (never throws on load)', () => {
    fakeLocalStorage.setItem('aegis-uploaded-documents', 'not json');
    expect(readStoredUploadedDocuments()).toEqual([]);
    fakeLocalStorage.setItem('aegis-uploaded-documents', JSON.stringify([{ id: 1, type: 'bad' }]));
    expect(readStoredUploadedDocuments()).toEqual([]);
  });
});

describe('generated-download attachment persistence', () => {
  it('round-trips the last download + clears on null', () => {
    storeLastAttachment({ downloadId: 'x1', filename: 'Gap.xlsx', conversationId: 'c1' });
    expect(readStoredLastAttachment()).toEqual({
      downloadId: 'x1',
      filename: 'Gap.xlsx',
      conversationId: 'c1',
    });
    storeLastAttachment(null);
    expect(readStoredLastAttachment()).toBeNull();
  });
});
