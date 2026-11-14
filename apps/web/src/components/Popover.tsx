import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A button that opens a small panel above it (map tools in the corner).
 * Closes on a click outside or on Escape. Controlled, so the panel's own
 * buttons can close it after acting.
 */
export function Popover({
  open,
  onOpenChange,
  label,
  button,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  label: string;
  button: ReactNode;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onOpenChange(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => onOpenChange(!open)}
        className={`glass flex h-9 items-center rounded-md transition hover:border-white/25 ${open ? 'border-white/30' : ''}`}
      >
        {button}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className="glass absolute right-0 bottom-full mb-2 animate-[rise_.25s_both] rounded-lg"
        >
          {children}
        </div>
      )}
    </div>
  );
}
