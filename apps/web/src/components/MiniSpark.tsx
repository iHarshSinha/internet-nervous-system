/** A tiny trend line for a stat tile. Null values leave a gap. */
export function MiniSpark({
  values,
  color,
  height = 28,
}: {
  values: (number | null | undefined)[];
  color: string;
  height?: number;
}) {
  const nums = values.filter((v): v is number => typeof v === 'number');
  if (nums.length < 2) return <div style={{ height }} />;
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const span = max - min || 1;
  const w = 100;
  const step = w / Math.max(1, values.length - 1);

  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (typeof v !== 'number') {
      pen = false;
      return;
    }
    const x = i * step;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    d += `${pen ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)} `;
    pen = true;
  });

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className="block w-full"
      style={{ height }}
    >
      <path d={d} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
