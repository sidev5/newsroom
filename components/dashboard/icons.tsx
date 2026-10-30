type IconProps = { className?: string };

const base = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export function PinIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}

export function BookIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5V5.5Z" />
      <path d="M4 21.5A2.5 2.5 0 0 1 6.5 19H20" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function BrandMark({ className }: IconProps) {
  return (
    <svg width={32} height={32} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="#DAEBE3" stroke="#657166" strokeWidth="1.5" />
      <path d="M2.5 16h27M16 2c4 4 5.5 8.5 5.5 14S20 26 16 30M16 2c-4 4-5.5 8.5-5.5 14S12 26 16 30" fill="none" stroke="#657166" strokeWidth="1.2" />
    </svg>
  );
}

/** The Write mark: a pencil on a square outline, drawn in the site's palette (mint fill, deep-sage lines). */
export function WriteIcon({ className, size = 32 }: IconProps & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="2.75" y="2.75" width="26.5" height="26.5" rx="5" fill="#DAEBE3" stroke="#657166" strokeWidth="1.5" />
      <path d="M21.2 8.4a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L13.4 23l-4.6 1.2L10 19.6 21.2 8.4Z" fill="#FFFFFF" stroke="#657166" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M19.4 10.2l2.4 2.4" stroke="#657166" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}