/**
 * The RegCompass / AEGIS brand mark (compass) as a lightweight inline SVG —
 * the same logo used in the navbar. Used as the AEGIS avatar in response
 * headers instead of the heavy particle orb (which slowed the UI when rendered
 * per message). `spin` adds a cheap CSS rotation as a subtle "working"
 * indicator while AEGIS is generating.
 */
export function AegisMark({
  className = 'w-8 h-8',
  spin = false,
}: {
  className?: string;
  spin?: boolean;
}) {
  return (
    <svg
      className={`${spin ? 'animate-spin-slow ' : ''}${className} shrink-0 text-text-secondary`}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1="12" y1="1.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1" />
      <line x1="12" y1="20.5" x2="12" y2="22.5" stroke="currentColor" strokeWidth="1" />
      <line x1="1.5" y1="12" x2="3.5" y2="12" stroke="currentColor" strokeWidth="1" />
      <line x1="20.5" y1="12" x2="22.5" y2="12" stroke="currentColor" strokeWidth="1" />
      <polygon points="12,3 13.5,12 12,11 10.5,12" fill="#00BFFF" />
      <polygon points="12,21 13.5,12 12,13 10.5,12" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </svg>
  );
}
