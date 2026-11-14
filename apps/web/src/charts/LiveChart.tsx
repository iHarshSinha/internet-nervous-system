import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { colors } from '../theme.ts';
import { useClockZone, zone } from '../time.ts';
import type { ChartSeries } from './TimeChart.tsx';

const axis = (unit?: string): uPlot.Axis => ({
  stroke: colors.low,
  grid: { stroke: 'rgba(255,255,255,0.05)', width: 1 },
  ticks: { show: false },
  font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
  ...(unit && { values: (_u: uPlot, splits: number[]) => splits.map((v) => `${fmt(v)}${unit}`) }),
});

/** 1200 -> "1.2k", 3400000 -> "3.4M": axis labels stay short. */
function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(v * 100) / 100);
}

/**
 * A uPlot chart drawn from data handed to it (times in seconds first, then
 * one column per series). The chart object is built once; new data only
 * calls setData, which is cheap.
 */
export function LiveChart({
  data,
  series,
  height = 160,
  unit,
}: {
  data: uPlot.AlignedData;
  series: ChartSeries[];
  height?: number;
  unit?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const local = useClockZone((s) => s.local);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const p = new uPlot(
      {
        width: el.clientWidth,
        height,
        legend: { show: false },
        tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), zone()),
        cursor: { y: false, points: { size: 5 } },
        scales: {
          x: { time: true },
          y: { range: (_u, _min, max) => [0, max > 0 ? max * 1.15 : 1] },
        },
        axes: [axis(), { ...axis(unit), size: 48 }],
        series: [
          {},
          ...series.map((s) => ({
            label: s.label,
            stroke: s.stroke,
            width: s.width ?? 1.5,
            ...(s.fill && { fill: s.fill }),
            ...(s.dash && { dash: s.dash }),
            points: { show: false },
          })),
        ],
      },
      [[], ...series.map(() => [])],
      el,
    );
    plot.current = p;
    const observer = new ResizeObserver(() => p.setSize({ width: el.clientWidth, height }));
    observer.observe(el);
    return () => {
      observer.disconnect();
      p.destroy();
      plot.current = null;
    };
    // The chart's shape is fixed for its lifetime; data flows in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, local]);

  useEffect(() => {
    plot.current?.setData(data);
  }, [data, local]);

  return <div ref={box} className="w-full" />;
}

/** A small legend under a chart. */
export function Legend({ series }: { series: ChartSeries[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.84rem] text-mid">
      {series.map((s) => (
        <span key={s.label} className="flex items-center gap-1.5">
          <span className="h-0.5 w-3.5 rounded" style={{ background: s.stroke }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}
