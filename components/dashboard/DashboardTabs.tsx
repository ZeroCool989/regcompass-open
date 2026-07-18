'use client';

import { useEffect, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'regcompass-dashboard-tab';
type Tab = 'regulatory' | 'cost';

function isTab(v: unknown): v is Tab {
  return v === 'regulatory' || v === 'cost';
}

/**
 * Tab switcher. Persists the active tab in localStorage so a reload (or a
 * later visit) lands on the same view. Initial SSR render shows
 * "regulatory" by default; an effect on mount restores the saved tab.
 */
export function DashboardTabs({
  regulatory,
  cost,
}: {
  regulatory: ReactNode;
  cost: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>('regulatory');

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (isTab(saved)) setTab(saved);
    } catch {
      /* localStorage blocked — stay on default */
    }
  }, []);

  function pick(next: Tab): void {
    setTab(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <div className="border-b border-border-brand">
        <nav
          className="flex gap-1 -mb-px"
          role="tablist"
          aria-label="Dashboard-Ansicht wählen"
        >
          <TabButton active={tab === 'regulatory'} onClick={() => pick('regulatory')}>
            Regulatorik
          </TabButton>
          <TabButton active={tab === 'cost'} onClick={() => pick('cost')}>
            Kosten
          </TabButton>
        </nav>
      </div>
      <div hidden={tab !== 'regulatory'} role="tabpanel">
        {regulatory}
      </div>
      <div hidden={tab !== 'cost'} role="tabpanel">
        {cost}
      </div>
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      onClick={onClick}
      aria-selected={active}
      className={`px-5 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
        active
          ? 'border-brand-primary text-foreground'
          : 'border-transparent text-text-secondary hover:text-foreground hover:border-border-brand/60'
      }`}
    >
      {children}
    </button>
  );
}
