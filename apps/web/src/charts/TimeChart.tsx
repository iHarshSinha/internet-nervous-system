import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { getSeries, useSeries, type RoomSeries } from '../store/series.ts';
import { colors } from '../theme.ts';

export interface ChartSeries {
  label: string;
  stroke: string;
  fill?: string;
  width?: number;
  dash?: number[];
}

interface Props {
  room: string;
  /** Turn the room's series into uPlot columns: [times in seconds, ...values]. */
  build(series: RoomSeries): uPlot.AlignedData;
  series: ChartSeries[];
  height?: number;
  unit?: string;
  /** A stretch of time to shade (ms), for example while an incident was open; end null = now. */
  band?: { from: number; to: number | null; color: string };
}

const axis = (unit?: string): uPlot.Axis => ({
  stroke: colors.low,
  grid: { stroke: 'rgba(26,36,50,0.7)', width: 1 },
  ticks: { show: false },
  font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
  ...(unit && { values: (_u: uPlot, splits: number[]) => splits.map((v) => `${v}${unit}`) }),
});

/**
 * A uPlot time-series chart fed straight from the series store. uPlot is
 * built for streaming data; the chart redraws at most once per animation
 * frame however many frames arrive, and React never re-renders it.
 */
export function TimeChart({ room, build, series, height = 200, unit, band }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const buildRef = useRef(build);
  buildRef.current = build;
  const bandRef = useRef(band);
  bandRef.current = band;

  useEffect(() => {
    const el = box.current;
    if (!el) return;

    const empty: uPlot.AlignedData = [[], ...series.map(() => [])];
    const plot = new uPlot(
      {
        width: el.clientWidth,
        height,
        legend: { show: false },
        // Times in UTC, matching the clock in the header and the data sources.
        tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), 'Etc/UTC'),
        cursor: { y: false, points: { size: 6 } },
        scales: {
          x: { time: true },
          y: { range: (_u, _min, max) => [0, max > 0 ? max * 1.1 : 1] },
        },
        axes: [axis(), { ...axis(unit), size: 52 }],
        hooks: {
          // Shade the band behind the lines, clipped to the plotted area.
          drawClear: [
            (u) => {
              const b = bandRef.current;
              if (!b) return;
              const x0 = u.valToPos(b.from / 1000, 'x', true);
              const x1 = u.valToPos((b.to ?? Date.now()) / 1000, 'x', true);
              const left = Math.max(u.bbox.left, Math.min(x0, x1));
              const right = Math.min(u.bbox.left + u.bbox.width, Math.max(x0, x1));
              if (right <= left) return;
              u.ctx.save();
              u.ctx.fillStyle = b.color;
              u.ctx.fillRect(left, u.bbox.top, Math.max(2, right - left), u.bbox.height);
              u.ctx.restore();
            },
          ],
        },
        series: [
          {},
          ...series.map((s) => ({
            label: s.label,
            stroke: s.stroke,
            width: s.width ?? 1.5,
            ...(s.fill && { fill: s.fill }),
            ...(s.dash && { dash: s.dash }),
            points: { show: false },
            spanGaps: false,
          })),
        ],
      },
      empty,
      el,
    );

    let raf = 0;
    const draw = () => {
      raf = 0;
      const s = getSeries(room);
      if (s?.loaded) plot.setData(buildRef.current(s));
    };
    const unsubscribe = useSeries.subscribe(() => {
      raf ||= requestAnimationFrame(draw);
    });
    draw();

    const observer = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    observer.observe(el);
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
      observer.disconnect();
      plot.destroy();
    };
    // The chart's shape is fixed for its lifetime; data flows through the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, height]);

  return <div ref={box} className="w-full" />;
}

/**
 * Sorted columns from a point map: times (uPlot wants seconds) and one column
 * per field. Where consecutive points are further apart than `gapMs` (the
 * server was not running, or no data came in) a null is inserted, so the line
 * breaks instead of drawing a straight bridge across the hole.
 */
export function columns<P>(
  map: Map<number, P>,
  fields: ((p: P) => number | null | undefined)[],
  gapMs: number,
): uPlot.AlignedData {
  const times = [...map.keys()].sort((a, b) => a - b);
  const xs: number[] = [];
  const ys: (number | null)[][] = fields.map(() => []);
  times.forEach((t, i) => {
    const prev = times[i - 1];
    if (prev !== undefined && t - prev > gapMs) {
      xs.push((prev + gapMs / 2) / 1000);
      for (const col of ys) col.push(null);
    }
    xs.push(t / 1000);
    fields.forEach((f, j) => ys[j]!.push(f(map.get(t)!) ?? null));
  });
  return [xs, ...ys] as uPlot.AlignedData;
}
