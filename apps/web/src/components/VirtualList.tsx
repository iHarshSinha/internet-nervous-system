import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, type ReactNode, type UIEvent } from 'react';

/**
 * A scrolling list that only puts the rows in view (plus a few) into the
 * page. With hundreds of rows arriving every second, rendering all of them
 * would cost the browser layout and paint for rows nobody can see; this
 * keeps the work proportional to the window, not to the list.
 *
 * Rows may differ in height: each is measured once it is drawn.
 */
export function VirtualList<T>({
  items,
  getKey,
  estimate,
  renderRow,
  className = '',
  overscan = 6,
  onScroll,
  label,
}: {
  items: readonly T[];
  getKey(item: T, index: number): string;
  /** A first guess at a row's height in pixels (rows are measured afterwards). */
  estimate: number;
  renderRow(item: T, index: number): ReactNode;
  /** Must give the list a height (for example `h-[60vh]` or `max-h-80`). */
  className?: string;
  overscan?: number;
  onScroll?(e: UIEvent<HTMLDivElement>): void;
  label?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => estimate,
    getItemKey: (i) => getKey(items[i]!, i),
    overscan,
  });

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      role="list"
      aria-label={label}
      className={`overflow-y-auto overscroll-contain ${className}`}
    >
      <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.key}
            role="listitem"
            data-index={row.index}
            ref={virtual.measureElement}
            className="absolute inset-x-0 top-0"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            {renderRow(items[row.index]!, row.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
