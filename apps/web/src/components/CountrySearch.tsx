import { useEffect, useMemo, useRef, useState } from 'react';
import { countryName, loadCountries } from '../geo.ts';
import { useGlobe } from '../store/globe.ts';
import { selectCountry } from '../store/ui.ts';
import { flag, healthColor } from '../theme.ts';
import { Popover } from './Popover.tsx';

/** A magnifying glass, drawn so it matches the other thin icons. */
function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="M12.8 12.8 17 17" strokeLinecap="round" />
    </svg>
  );
}

/** Lower case without accents, so "cote" finds Côte d'Ivoire. */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Find a country and fly there. A button in the map tools (or the "/" key)
 * opens a small search box; arrow keys move, Enter selects.
 */
export function CountrySearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [codes, setCodes] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadCountries().then((all) => setCodes(all.map((f) => f.properties.cc)));
  }, []);

  // "/" opens search from anywhere on the page (unless you are typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select');
      if (e.key === '/' && !typing && !open) {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // After the panel has rendered.
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const q = fold(query.trim());
    const named = codes.map((cc) => ({ cc, name: countryName(cc) }));
    if (!q) return named.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 7);
    return named
      .map((c) => {
        const name = fold(c.name);
        // Best first: exact code, then names starting with the text, then containing it.
        const rank =
          c.cc.toLowerCase() === q
            ? 0
            : name.startsWith(q)
              ? 1
              : name.includes(` ${q}`)
                ? 2
                : name.includes(q)
                  ? 3
                  : 9;
        return { ...c, rank };
      })
      .filter((c) => c.rank < 9)
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
      .slice(0, 7);
  }, [query, codes]);

  function pick(cc: string) {
    selectCountry(cc);
    setOpen(false);
  }

  const { countries } = useGlobe.getState();

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Find a country (press /)"
      button={
        <span className="grid size-9 place-items-center text-hi">
          <SearchIcon />
        </span>
      }
    >
      <div className="w-[min(320px,86vw)] p-2">
        <input
          ref={input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter' && results[active]) {
              pick(results[active].cc);
            }
          }}
          placeholder="Find a country"
          aria-label="Country name or code"
          className="w-full rounded-md bg-white/[0.05] px-3 py-2 text-[1rem] text-hi ring-1 ring-line outline-none placeholder:text-low focus:ring-white/25"
        />
        <ul className="mt-1.5" role="listbox">
          {results.length === 0 && (
            <li className="px-3 py-2 text-[0.95rem] text-low">No country by that name</li>
          )}
          {results.map((c, i) => {
            const h = countries.get(c.cc)?.h;
            return (
              <li key={c.cc} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(c.cc)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-[0.98rem] transition ${i === active ? 'bg-white/[0.07] text-hi' : 'text-mid'}`}
                >
                  <span>{flag(c.cc)}</span>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="font-mono text-[0.8rem]" style={{ color: healthColor(h) }}>
                    {h ?? ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Popover>
  );
}
