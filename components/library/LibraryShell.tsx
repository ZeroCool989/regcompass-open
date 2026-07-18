'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { SourceFile } from '@/lib/library/types';
import type { LegislationNode } from '@/lib/library/types';
import { GLOSSARY, GLOSSARY_TERMS } from '@/lib/glossary';
import { TranslatePanel } from '@/components/TranslatePanel';

const TRANSLATE_TARGETS = new Set(['DE', 'EN']);

// ─────────────────────────── Constants ───────────────────────────

const JUR_CLS: Record<string, string> = {
  EU: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
  CH: 'bg-red-500/20 text-red-300 border-red-500/40',
  DE: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40',
  INTL: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
};
const JUR_ORDER = ['EU', 'CH', 'DE', 'INTL'];
const JUR_LABEL: Record<string, string> = {
  EU: 'Europa',
  CH: 'Schweiz',
  DE: 'Deutschland',
  INTL: 'International',
};

// ─────────────────────────── Main Shell ───────────────────────────

export function LibraryShell({
  laws,
  defaultLaw,
  isAdmin = false,
}: {
  laws: SourceFile[];
  defaultLaw: string;
  isAdmin?: boolean;
}) {
  const [activeLaw, setActiveLaw] = useState(defaultLaw);
  const [tree, setTree] = useState<LegislationNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [showTranslate, setShowTranslate] = useState(false);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [fontSize, setFontSize] = useState(18);
  const [progress, setProgress] = useState(0);
  // Source returned by the API — used as a fallback for docs not in the SSR
  // `laws` list (e.g. a translation just created this session).
  const [fetchedSource, setFetchedSource] = useState<SourceFile | null>(null);
  const readerRef = useRef<HTMLDivElement>(null);

  const source = useMemo(
    () => laws.find((l) => l.regulationId === activeLaw) ?? (fetchedSource?.regulationId === activeLaw ? fetchedSource : undefined),
    [laws, activeLaw, fetchedSource],
  );

  const loadLaw = useCallback(async (regId: string) => {
    setActiveLaw(regId);
    setTree(null);
    setError(null);
    setLoading(true);
    setSearchQuery('');
    setActiveNodeId(null);
    setShowTranslate(false);
    try {
      const res = await fetch(`/api/library/${regId}`);
      if (!res.ok) {
        const j = (await res.json()) as { message?: string };
        throw new Error(j.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { tree: LegislationNode; source?: SourceFile };
      setTree(data.tree);
      if (data.source) setFetchedSource(data.source);
      readerRef.current?.scrollTo(0, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLaw(defaultLaw);
  }, [defaultLaw, loadLaw]);

  const scrollToNode = useCallback((nodeId: string) => {
    const el = document.getElementById(nodeId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveNodeId(nodeId);
    }
  }, []);

  // Intersection observer — tracks which section is in view
  useEffect(() => {
    if (!tree) return;
    const allIds = collectIds(tree);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveNodeId(entry.target.id);
          }
        }
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );
    for (const id of allIds) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [tree]);

  // Search highlighting
  useEffect(() => {
    if (!searchQuery || !readerRef.current) {
      setSearchMatchCount(0);
      return;
    }
    const text = readerRef.current.textContent ?? '';
    const re = new RegExp(escapeRegex(searchQuery), 'gi');
    setSearchMatchCount((text.match(re) ?? []).length);
  }, [searchQuery, tree]);

  // Reading-progress (% scrolled through the reader pane).
  useEffect(() => {
    const el = readerRef.current;
    if (!el) return;
    const recompute = () => {
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) { setProgress(0); return; }
      setProgress(Math.min(100, Math.max(0, (el.scrollTop / max) * 100)));
    };
    recompute();
    el.addEventListener('scroll', recompute, { passive: true });
    const obs = new ResizeObserver(recompute);
    obs.observe(el);
    return () => {
      el.removeEventListener('scroll', recompute);
      obs.disconnect();
    };
  }, [tree]);

  // Focus mode: F to toggle, Escape to exit. Ignore when typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        setFocusMode((f) => !f);
      } else if (e.key === 'Escape') {
        setFocusMode((f) => (f ? false : f));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const grouped = useMemo(() => {
    const m = new Map<string, SourceFile[]>();
    for (const j of JUR_ORDER) m.set(j, []);
    for (const l of laws) if (!l.ingested) m.get(l.jurisdiction)!.push(l);
    return m;
  }, [laws]);

  // Runtime documents are shown in their own groups, separate from the curated,
  // bundled legislation: radar-ingested originals vs. machine translations.
  const radarLaws = useMemo(() => laws.filter((l) => l.ingested && !l.isTranslation), [laws]);
  const translationLaws = useMemo(() => laws.filter((l) => l.ingested && l.isTranslation), [laws]);

  const showSidebar = sidebarOpen && !focusMode;

  return (
    <div className="flex h-full">
      {/* ── Column 1: Laws list ── */}
      <aside
        className={`${showSidebar ? 'w-48 lg:w-56' : 'w-0'} transition-all duration-200 border-r border-border-brand bg-surface/40 flex flex-col shrink-0 overflow-hidden`}
      >
        <div className="px-3 py-2.5 border-b border-border-brand shrink-0 flex items-center gap-2">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-secondary">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-text-secondary">Gesetze</span>
        </div>
        <nav className="library-nav flex-1 overflow-y-auto py-1.5">
          {JUR_ORDER.map((jur) => {
            const group = grouped.get(jur)!;
            if (group.length === 0) return null;
            return (
              <div key={jur} className="py-1.5">
                <div className="px-3 mb-0.5 flex items-center gap-1.5">
                  <span className={`shrink-0 px-1 py-0 text-[0.55rem] font-mono rounded border ${JUR_CLS[jur] ?? ''}`}>{jur}</span>
                  <span className="text-[0.6rem] uppercase tracking-wider font-bold text-text-secondary/70">{JUR_LABEL[jur]}</span>
                </div>
                {group.map((law) => {
                  const active = law.regulationId === activeLaw;
                  return (
                    <button
                      key={law.regulationId}
                      onClick={() => void loadLaw(law.regulationId)}
                      title={law.fullTitle}
                      className={`w-full text-left px-3 py-1 text-[0.78rem] transition-colors border-l-2 truncate ${
                        active
                          ? 'border-l-brand-primary bg-brand-primary/15 text-brand-primary font-semibold'
                          : 'border-l-transparent text-foreground/75 hover:bg-brand-primary/5 hover:text-foreground'
                      }`}
                    >
                      {law.title}
                    </button>
                  );
                })}
              </div>
            );
          })}

          {[
            { key: 'radar', label: 'Aus Radar', badge: 'NEU', badgeCls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40', list: radarLaws },
            { key: 'translations', label: 'Übersetzungen', badge: '🌐', badgeCls: 'bg-sky-500/20 text-sky-300 border-sky-500/40', list: translationLaws },
          ].map((g) =>
            g.list.length === 0 ? null : (
              <div key={g.key} className="py-1.5 border-t border-border-brand mt-1.5">
                <div className="px-3 mb-0.5 flex items-center gap-1.5">
                  <span className={`shrink-0 px-1 py-0 text-[0.55rem] font-mono rounded border ${g.badgeCls}`}>{g.badge}</span>
                  <span className="text-[0.6rem] uppercase tracking-wider font-bold text-text-secondary/70">{g.label}</span>
                </div>
                {g.list.map((law) => {
                  const active = law.regulationId === activeLaw;
                  return (
                    <button
                      key={law.regulationId}
                      onClick={() => void loadLaw(law.regulationId)}
                      title={law.fullTitle}
                      className={`w-full text-left px-3 py-1 text-[0.78rem] transition-colors border-l-2 truncate ${
                        active
                          ? 'border-l-brand-primary bg-brand-primary/15 text-brand-primary font-semibold'
                          : 'border-l-transparent text-foreground/75 hover:bg-brand-primary/5 hover:text-foreground'
                      }`}
                    >
                      {law.title}
                    </button>
                  );
                })}
              </div>
            ),
          )}
        </nav>
      </aside>

      {/* ── Column 2: Table of contents ── */}
      <aside
        className={`${showSidebar ? 'w-64 lg:w-72' : 'w-0'} transition-all duration-200 border-r border-border-brand bg-surface/20 flex flex-col shrink-0 overflow-hidden`}
      >
        {source && (
          <div className="px-3 py-2.5 border-b border-border-brand shrink-0">
            <div className="text-[0.6rem] font-mono text-text-secondary/80 truncate">{source.fullTitle}</div>
            <div className="text-sm font-semibold truncate mt-0.5" title={source.title}>{source.title}</div>
          </div>
        )}
        <div className="library-nav flex-1 overflow-y-auto text-[0.8rem]">
          {tree && (
            <NavTree
              nodes={tree.children}
              activeNodeId={activeNodeId}
              onNavigate={scrollToNode}
              depth={0}
            />
          )}
          {loading && (
            <div className="px-4 py-8 text-center text-text-secondary">
              <span className="loading-dots">Parsing</span>
            </div>
          )}
        </div>
      </aside>

      {/* ── Reader ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="px-4 py-2 border-b border-border-brand flex items-center gap-3 bg-background/80 backdrop-blur shrink-0">
          <button
            onClick={() => {
              if (focusMode) setFocusMode(false);
              else setSidebarOpen(!sidebarOpen);
            }}
            className="p-1.5 rounded hover:bg-surface transition-colors text-text-secondary"
            title={focusMode ? 'Navigation einblenden' : 'Navigation ein-/ausblenden'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 12h18M3 6h18M3 18h18" /></svg>
          </button>

          {source && (
            <>
              {showSidebar ? (
                // Sidebars are visible → TOC panel already shows the title.
                // Keep just the jurisdiction pill + source link here, push the rest right.
                <>
                  <span className={`px-1.5 py-0.5 text-[0.6rem] font-mono rounded border ${JUR_CLS[source.jurisdiction] ?? ''}`}>
                    {source.jurisdiction}
                  </span>
                  {source.sourceUrl && (
                    <a
                      href={source.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 p-1 rounded hover:bg-brand-primary/15 text-text-secondary hover:text-brand-primary transition-colors"
                      title="Offizielle Quelle"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                    </a>
                  )}
                  <div className="flex-1" />
                </>
              ) : (
                // Sidebars hidden → show full title centered in the toolbar.
                <>
                  <span className={`px-1.5 py-0.5 text-[0.6rem] font-mono rounded border ${JUR_CLS[source.jurisdiction] ?? ''}`}>
                    {source.jurisdiction}
                  </span>
                  <div className="flex-1 flex justify-center min-w-0 px-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="hidden md:inline text-xs font-mono text-text-secondary truncate">{source.fullTitle}</span>
                      <span className="hidden md:inline text-text-secondary/40">—</span>
                      <span className="text-sm font-semibold truncate">{source.title}</span>
                      {source.sourceUrl && (
                        <a
                          href={source.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 p-1 rounded hover:bg-brand-primary/15 text-text-secondary hover:text-brand-primary transition-colors"
                          title="Offizielle Quelle"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                        </a>
                      )}
                    </div>
                  </div>
                </>
              )}

              <input
                type="text"
                placeholder="Suchen... (Ctrl+F)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-40 lg:w-52 px-2.5 py-1 text-xs rounded-lg border border-border-brand bg-surface/60 text-foreground placeholder:text-text-secondary/60 focus:outline-none focus:border-brand-primary"
              />
              {searchQuery && (
                <span className="text-[0.65rem] text-text-secondary">{searchMatchCount}</span>
              )}

              <div className="flex items-center gap-1 border-l border-border-brand pl-2" title="Schriftgröße in Pixel">
                <button onClick={() => setFontSize((s) => Math.max(13, s - 1))} className="px-1 py-0.5 text-xs rounded border border-border-brand hover:border-brand-primary" title="Kleiner">A-</button>
                <span className="text-[0.6rem] text-text-secondary w-5 text-center" title={`${fontSize}px Schriftgröße`}>{fontSize}</span>
                <button onClick={() => setFontSize((s) => Math.min(24, s + 1))} className="px-1 py-0.5 text-xs rounded border border-border-brand hover:border-brand-primary" title="Größer">A+</button>
              </div>

              <button
                onClick={() => setFocusMode((f) => !f)}
                title={focusMode ? 'Fokus-Modus verlassen (F / Esc)' : 'Fokus-Modus (F)'}
                className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
                  focusMode
                    ? 'border-brand-primary bg-brand-primary/15 text-brand-primary'
                    : 'border-border-brand hover:border-brand-primary text-text-secondary'
                }`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8V5a2 2 0 0 1 2-2h3" />
                  <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                  <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                  <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span className="hidden lg:inline">Fokus</span>
              </button>

              {isAdmin && !source.isTranslation && (
                <button
                  onClick={() => setShowTranslate((v) => !v)}
                  title="Dokument übersetzen (DeepL)"
                  className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
                    showTranslate
                      ? 'border-brand-primary bg-brand-primary/15 text-brand-primary'
                      : 'border-border-brand hover:border-brand-primary text-text-secondary'
                  }`}
                >
                  <span aria-hidden>🌐</span>
                  <span className="hidden lg:inline">Übersetzen</span>
                </button>
              )}
            </>
          )}
        </div>

        {/* Content */}
        <div ref={readerRef} className="flex-1 overflow-y-auto scroll-pt-20 relative">
          {/* Reading progress strip */}
          <div className="law-progress-track" aria-hidden>
            <div className="law-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          {error && (
            <div className="max-w-3xl mx-auto px-8 py-12">
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
            </div>
          )}

          {source && !loading && (
            <div className="max-w-3xl mx-auto px-8 pt-4 space-y-2">
              {source.isTranslation && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
                  ⚠️ Maschinell übersetzt mit DeepL — nicht Teil der kuratierten Wissensbasis.
                </div>
              )}
              {isAdmin && source.ingested && !source.isTranslation && source.originalLanguage &&
                !TRANSLATE_TARGETS.has(source.originalLanguage.toUpperCase()) && !showTranslate && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-xs text-sky-200">
                    <span>Dieses Dokument ist nicht auf Deutsch/Englisch. Übersetzen?</span>
                    <button onClick={() => setShowTranslate(true)} className="rounded bg-sky-500/20 px-2 py-0.5 font-medium hover:bg-sky-500/30">🌐 Übersetzen</button>
                  </div>
                )}
              {isAdmin && showTranslate && !source.isTranslation && (
                <TranslatePanel
                  documentId={source.regulationId}
                  bundled={!source.ingested}
                  originalLanguage={source.ingested ? source.originalLanguage : 'DE'}
                  onOpenTranslation={(tid) => void loadLaw(tid)}
                />
              )}
            </div>
          )}

          {tree && !loading && (
            <article
              className={`law-reader${focusMode ? ' law-reader-focus' : ''}`}
              style={{ fontSize: `${fontSize}px` }}
            >
              {tree.children.map((node) => (
                <ReaderNode key={node.id} node={node} searchQuery={searchQuery} regulationId={activeLaw} />
              ))}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── Nav Tree ───────────────────────────

function NavTree({
  nodes,
  activeNodeId,
  onNavigate,
  depth,
}: {
  nodes: LegislationNode[];
  activeNodeId: string | null;
  onNavigate: (id: string) => void;
  depth: number;
}) {
  return (
    <>
      {nodes.map((node) => (
        <NavNode key={node.id} node={node} activeNodeId={activeNodeId} onNavigate={onNavigate} depth={depth} />
      ))}
    </>
  );
}

function NavNode({
  node,
  activeNodeId,
  onNavigate,
  depth,
}: {
  node: LegislationNode;
  activeNodeId: string | null;
  onNavigate: (id: string) => void;
  depth: number;
}) {
  const hasChildren = node.children.length > 0;
  const isActive = activeNodeId === node.id;
  const containsActive = hasChildren && activeNodeId ? hasActiveChild(node, activeNodeId) : false;
  const [open, setOpen] = useState(depth === 0);
  const [kbOpen, setKbOpen] = useState(false);

  useEffect(() => {
    if (containsActive && !open) setOpen(true);
  }, [containsActive, open]);

  const { numText, titleText, fullLabel } = useMemo(() => splitNavLabel(node.label, node.shortLabel), [node.label, node.shortLabel]);
  const titlePreview = titleText && titleText.length > 25 ? titleText.slice(0, 25) + '…' : titleText;
  const kbCount = node.kbEntryIds.length;
  const isChapter = node.type === 'chapter';
  const articleCount = isChapter ? node.children.filter((c) => c.type === 'article').length : 0;
  const showArticleCount = isChapter && !open && articleCount > 0;

  return (
    <div>
      <button
        onClick={() => {
          if (hasChildren) setOpen(!open);
          onNavigate(node.id);
        }}
        title={fullLabel}
        className={`w-full text-left flex items-center gap-1 hover:bg-brand-primary/10 transition-colors border-l-2 ${
          isActive ? 'border-l-brand-primary bg-brand-primary/10 text-brand-primary font-semibold' : 'border-l-transparent text-text-secondary'
        } ${isChapter && depth === 0 ? 'mt-1 py-2 border-t border-t-border-brand/40 text-[0.78rem] uppercase tracking-wide' : 'py-1.5'} px-3`}
        style={{ paddingLeft: `${12 + depth * 12}px` }}
      >
        {hasChildren && (
          <span className="shrink-0 w-4 text-[0.7rem] opacity-60">
            {open ? '▾' : '▸'}
          </span>
        )}
        {!hasChildren && <span className="shrink-0 w-4" />}
        <span className={`shrink-0 ${isChapter ? 'font-semibold' : 'font-mono font-semibold'}`}>{numText}</span>
        {titlePreview && (
          <span className={`truncate font-normal ${isChapter ? '' : 'text-text-secondary/80'}`}>— {titlePreview}</span>
        )}
        {showArticleCount && (
          <span className="shrink-0 ml-auto text-[0.6rem] font-mono text-text-secondary/60" title={`${articleCount} Artikel`}>
            ({articleCount} Art.)
          </span>
        )}
        {kbCount > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); setKbOpen((o) => !o); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setKbOpen((o) => !o); } }}
            title={`${kbCount} KB-Einträge zu diesem Artikel`}
            className={`shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[0.6rem] font-mono rounded-full bg-brand-primary/15 text-brand-primary border border-brand-primary/30 hover:bg-brand-primary/25 transition-colors cursor-pointer ${showArticleCount ? '' : 'ml-auto'}`}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
            {kbCount}
          </span>
        )}
      </button>
      {kbOpen && kbCount > 0 && (
        <div
          className="px-3 py-1.5 bg-brand-primary/5 border-l-2 border-l-brand-primary/30 flex flex-wrap gap-1"
          style={{ paddingLeft: `${28 + depth * 12}px` }}
        >
          {node.kbEntryIds.map((id) => (
            <Link
              key={id}
              href={`/kb/${id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-[0.6rem] font-mono px-1.5 py-0.5 rounded bg-brand-primary/15 text-brand-primary border border-brand-primary/30 hover:bg-brand-primary/25 transition-colors"
            >
              {id}
            </Link>
          ))}
        </div>
      )}
      {hasChildren && open && (
        <NavTree nodes={node.children} activeNodeId={activeNodeId} onNavigate={onNavigate} depth={depth + 1} />
      )}
    </div>
  );
}

// Splits "Artikel 5 — Verbotene Praktiken" → { numText: "Art. 5", titleText: "Verbotene Praktiken" }.
function splitNavLabel(label: string, shortLabel: string): { numText: string; titleText: string; fullLabel: string } {
  const dashIdx = label.indexOf(' — ');
  if (dashIdx === -1) return { numText: shortLabel, titleText: '', fullLabel: label };
  return {
    numText: shortLabel,
    titleText: label.slice(dashIdx + 3),
    fullLabel: label,
  };
}

function hasActiveChild(node: LegislationNode, activeId: string): boolean {
  for (const c of node.children) {
    if (c.id === activeId) return true;
    if (hasActiveChild(c, activeId)) return true;
  }
  return false;
}

// ─────────────────────────── Reader Nodes ───────────────────────────

function ReaderNode({
  node,
  searchQuery,
  regulationId,
}: {
  node: LegislationNode;
  searchQuery: string;
  regulationId: string;
}) {
  const isChapter = node.type === 'chapter' || node.type === 'annex';
  const isArticle = node.type === 'article';
  const isSection = node.type === 'section' || node.type === 'subsection';

  const { numText, titleText } = splitNavLabel(node.label, node.shortLabel);
  // Chapter label format is "KAPITEL I — ALLGEMEINE BESTIMMUNGEN"; we want
  // "KAPITEL I" on one line and the title on the next.
  const chapterNum = node.label.split(' — ')[0] ?? node.label;
  const chapterTitle = node.label.includes(' — ') ? node.label.split(' — ').slice(1).join(' — ') : '';

  return (
    <section id={node.id} className={`scroll-mt-24 ${isArticle ? 'law-article' : ''}`}>
      {isChapter && (
        <>
          <div className="law-chapter">
            <Hl text={chapterNum} query={searchQuery} />
          </div>
          {chapterTitle && (
            <div className="law-chapter-title">
              <Hl text={chapterTitle} query={searchQuery} />
            </div>
          )}
        </>
      )}

      {isArticle && (
        <>
          <div className="law-article-number">
            <Hl text={numText} query={searchQuery} />
          </div>
          {titleText && (
            <div className="law-article-title">
              <Hl text={titleText} query={searchQuery} />
            </div>
          )}
          {node.kbEntryIds.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5 mb-3">
              {node.kbEntryIds.map((id) => (
                <Link
                  key={id}
                  href={`/kb/${id}`}
                  target="_blank"
                  className="inline-flex items-center px-1.5 py-0.5 text-[0.65rem] font-mono rounded bg-brand-primary/15 text-brand-primary border border-brand-primary/30 hover:bg-brand-primary/25 transition-colors opacity-70 hover:opacity-100"
                >
                  [{id}]
                </Link>
              ))}
            </div>
          )}
        </>
      )}

      {isSection && !isChapter && !isArticle && (
        <div className="mt-8 mb-3">
          <div className="text-base font-semibold text-foreground">
            <Hl text={node.label} query={searchQuery} />
          </div>
          {node.kbEntryIds.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {node.kbEntryIds.map((id) => (
                <Link
                  key={id}
                  href={`/kb/${id}`}
                  target="_blank"
                  className="text-[0.6rem] font-mono text-brand-primary/60 hover:text-brand-primary transition-colors"
                >
                  [{id}]
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {node.content && (
        <LawContent
          content={node.content}
          query={searchQuery}
          variant={node.label === 'Präambel' ? 'recitals' : 'paragraphs'}
        />
      )}

      {node.children.map((child) => (
        <ReaderNode key={child.id} node={child} searchQuery={searchQuery} regulationId={regulationId} />
      ))}
    </section>
  );
}

// ─────────────────────────── EUR-Lex content renderer ───────────────────────────

type LawBlock =
  | { type: 'paragraph'; marker: string; text: string }
  | { type: 'subparagraph'; marker: string; text: string }
  | { type: 'text'; text: string };

function parseLawBlocks(content: string): LawBlock[] {
  const lines = content.split('\n');
  const blocks: LawBlock[] = [];
  let current: LawBlock | null = null;

  const finish = () => {
    if (!current) return;
    if (current.text.trim()) blocks.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) {
      // Blank line separates blocks — but if the current block has no text yet
      // (e.g. marker line "(1)" alone) keep waiting for content.
      if (current && current.text.trim()) finish();
      continue;
    }

    // Numbered paragraph: "(1)" or "(1)   text"
    const paraMatch = trimmed.match(/^\((\d+)\)\s*(.*)$/);
    if (paraMatch) {
      finish();
      current = { type: 'paragraph', marker: `(${paraMatch[1]})`, text: paraMatch[2] };
      continue;
    }

    // Lettered subparagraph: "a)" or "a) text"
    const subMatch = trimmed.match(/^([a-z]{1,3})\)\s*(.*)$/);
    if (subMatch) {
      finish();
      current = { type: 'subparagraph', marker: `${subMatch[1]})`, text: subMatch[2] };
      continue;
    }

    if (!current) {
      current = { type: 'text', text: trimmed };
    } else {
      current.text = current.text ? `${current.text} ${trimmed}` : trimmed;
    }
  }
  finish();
  return blocks;
}

function LawContent({
  content,
  query,
  variant = 'paragraphs',
}: {
  content: string;
  query: string;
  variant?: 'paragraphs' | 'recitals';
}) {
  const blocks = useMemo(() => parseLawBlocks(content), [content]);
  // Fresh "seen glossary terms" set per article/section render so each gets
  // its own first-occurrence highlighting.
  const seen = new Set<string>();

  return (
    <div className="selection:bg-brand-primary/30">
      {blocks.map((b, i) => {
        if (b.type === 'paragraph') {
          if (variant === 'recitals') {
            return (
              <p key={i} className="law-recital">
                <span className="law-recital-marker">{b.marker}</span>
                <RichText text={b.text} query={query} seen={seen} />
              </p>
            );
          }
          return (
            <p key={i} className="law-paragraph">
              <span className="law-paragraph-marker">{b.marker}</span>{' '}
              <RichText text={b.text} query={query} seen={seen} />
            </p>
          );
        }
        if (b.type === 'subparagraph') {
          return (
            <p key={i} className="law-subparagraph">
              <span className="law-subparagraph-marker">{b.marker}</span>{' '}
              <RichText text={b.text} query={query} seen={seen} />
            </p>
          );
        }
        return (
          <p key={i} className={variant === 'recitals' ? 'law-recital-preface' : 'law-text'}>
            <RichText text={b.text} query={query} seen={seen} />
          </p>
        );
      })}
    </div>
  );
}

// ─────────────────────────── Inline highlighting (search + glossary) ───────────────────────────

// Word-boundary-aware glossary matcher, compiled once. German chars are part
// of the "word" character class so we don't split inside words like
// "DSGVO-Vorgaben" (term is "DSGVO" — boundary required on both sides).
const GLOSSARY_RE: RegExp | null = GLOSSARY_TERMS.length > 0
  ? new RegExp(
      `(?<![A-Za-zÄÖÜäöüß0-9_])(?:${GLOSSARY_TERMS.map((t) => escapeRegex(t)).join('|')})(?![A-Za-zÄÖÜäöüß0-9_])`,
      'g',
    )
  : null;

/**
 * Renders body text with two overlapping decorations:
 *   1. Inline glossary tooltips (only first occurrence per article — tracked
 *      via the shared `seen` Set passed in by `LawContent`).
 *   2. Search query highlighting on the remaining text segments.
 */
function RichText({ text, query, seen }: { text: string; query: string; seen: Set<string> }): ReactNode {
  if (!text) return null;
  if (!GLOSSARY_RE) return <Hl text={text} query={query} />;

  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  // Reset regex state for this scan.
  const re = new RegExp(GLOSSARY_RE.source, GLOSSARY_RE.flags);
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const term = m[0];
    if (seen.has(term)) continue;
    // Push the run of plain text before this match (with search highlighting).
    if (m.index > lastIdx) {
      parts.push(<Hl key={key++} text={text.slice(lastIdx, m.index)} query={query} />);
    }
    seen.add(term);
    const entry = GLOSSARY[term];
    parts.push(
      <span key={key++} className="glossary-term" title={entry.de}>
        <Hl text={term} query={query} />
      </span>,
    );
    lastIdx = m.index + term.length;
  }

  if (lastIdx < text.length) {
    parts.push(<Hl key={key++} text={text.slice(lastIdx)} query={query} />);
  }

  if (parts.length === 0) return <Hl text={text} query={query} />;
  return <>{parts}</>;
}

// Search-highlight only (no glossary). Used for titles + within RichText segments.
function Hl({ text, query }: { text: string; query: string }): ReactNode {
  if (!query || query.length < 2) return <>{text}</>;
  const re = new RegExp(`(${escapeRegex(query)})`, 'gi');
  const parts = text.split(re);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        re.test(part) ? (
          <mark key={i} className="bg-yellow-400/40 text-foreground rounded px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

// ─────────────────────────── Utils ───────────────────────────

function collectIds(node: LegislationNode): string[] {
  const ids = [node.id];
  for (const c of node.children) ids.push(...collectIds(c));
  return ids;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
