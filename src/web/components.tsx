import { ActionIcon, Card, CopyButton, Group, Paper, Select, Text, Tooltip, useComputedColorScheme } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { IconCheck, IconCopy, IconInfoCircle } from '@tabler/icons-react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useMemo, type ReactNode } from 'react';
import { czkRaw } from './format';
import { legendRows } from './chartLegend';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Chart({ option, height = 320, onEvents }: { option: EChartsOption; height?: number; onEvents?: Record<string, (params: any) => void> }) {
  const scheme = useComputedColorScheme('light');
  const { ref, width } = useElementSize();
  // a resize alone must not replace the option (that would reset zoom and hidden series): only a
  // change of the legend layout does
  const layout = legendLayout(option, width);
  const full = useMemo(() => withDefaults(option, layout), [option, layout]);
  return (
    <div ref={ref} style={{ minHeight: height }}>
      {width > 0 && (
        <ReactECharts option={full} theme={scheme === 'dark' ? 'dark' : undefined} style={{ height, width: '100%' }} notMerge lazyUpdate onEvents={onEvents} />
      )}
    </div>
  );
}

/** legend rows shown before the legend turns into one scrolling row with arrows */
const MAX_LEGEND_ROWS = 3;
const LEGEND_ROW = 22;
let measureCtx: CanvasRenderingContext2D | null | undefined;

function textWidth(s: string): number {
  if (measureCtx === undefined) measureCtx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!measureCtx) return s.length * 7;
  measureCtx.font = '12px sans-serif';
  return measureCtx.measureText(s).width;
}

/** Rows of each top legend ("" = no legend to lay out): 1–3 = wrapped, 0 = one scrolling row. */
function legendLayout(option: EChartsOption, width: number): string {
  const o = option as Record<string, any>;
  const list = !o.legend ? [] : Array.isArray(o.legend) ? o.legend : [o.legend];
  return list
    .map((l: any) => {
      if (!isAutoLegend(l)) return '-';
      const rows = legendRows(legendNames(o, l), width, textWidth);
      return String(rows > MAX_LEGEND_ROWS ? 0 : rows);
    })
    .join(',');
}

/** a legend placed by these defaults: shown, horizontal, no position or type of its own */
const isAutoLegend = (l: any) => l && l.show !== false && l.top === undefined && l.bottom === undefined && l.orient !== 'vertical' && !l.type;

function legendNames(o: Record<string, any>, l: any): string[] {
  if (Array.isArray(l.data)) return l.data.map((d: any) => (typeof d === 'string' ? d : String(d?.name ?? '')));
  const series = Array.isArray(o.series) ? o.series : o.series ? [o.series] : [];
  const names: string[] = [];
  for (const s of series) {
    // pie legends list the slices
    if (s.type === 'pie') for (const d of s.data ?? []) names.push(String(d?.name ?? ''));
    else if (s.name) names.push(String(s.name));
  }
  return [...new Set(names)];
}

const axisNum = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });

// Legend on top (never collides with x-axis labels): wrapped into up to 3 rows, beyond that one
// scrolling row with arrows. Czech number format on value axes.
function withDefaults(option: EChartsOption, layout: string): EChartsOption {
  const o: Record<string, any> = { backgroundColor: 'transparent', ...option };
  const rowsOf = layout.split(',');
  let extraRows = 0;
  let i = 0;
  const fixLegend = (l: any) => {
    const rows = Number(rowsOf[i++]);
    if (!isAutoLegend(l)) return l;
    if (!rows) return { type: 'scroll', ...l, top: 0 };
    extraRows = Math.max(extraRows, rows - 1);
    return { type: 'plain', ...l, top: 0 };
  };
  if (o.legend) o.legend = Array.isArray(o.legend) ? o.legend.map(fixLegend) : fixLegend(o.legend);
  const hasTopLegend = o.legend && (Array.isArray(o.legend) ? o.legend : [o.legend]).some((l: any) => l.top === 0);
  if ((o.xAxis || o.yAxis) && !o.grid) o.grid = { containLabel: true, left: 10, right: 20, bottom: 10, top: hasTopLegend ? 40 : 20 };
  // the plot moves down by the extra legend rows
  if (extraRows && o.grid && !Array.isArray(o.grid) && typeof o.grid.top === 'number') o.grid = { ...o.grid, top: o.grid.top + extraRows * LEGEND_ROW };
  const fixAxis = (a: any) =>
    a && a.type === 'value' && !a.axisLabel?.formatter ? { ...a, axisLabel: { ...a.axisLabel, formatter: (v: number) => axisNum.format(v) } } : a;
  for (const k of ['xAxis', 'yAxis']) if (o[k]) o[k] = Array.isArray(o[k]) ? o[k].map(fixAxis) : fixAxis(o[k]);
  return o as EChartsOption;
}

export function Stat({ label, value, sub, color, hint }: { label: string; value: ReactNode; sub?: ReactNode; color?: string; hint?: ReactNode }) {
  return (
    <Paper withBorder p="md" radius="md">
      <Group gap={4} wrap="nowrap">
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          {label}
        </Text>
        {hint && <Hint label={hint} />}
      </Group>
      <Text fw={700} size="xl" c={color}>
        {value}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed">
          {sub}
        </Text>
      )}
    </Paper>
  );
}

export function Section({ title, children, right, hint }: { title: ReactNode; children: ReactNode; right?: ReactNode; hint?: ReactNode }) {
  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" mb="sm">
        <Group gap={6} wrap="nowrap">
          <Text fw={600}>{title}</Text>
          {hint && <Hint label={hint} />}
        </Group>
        {right}
      </Group>
      {children}
    </Card>
  );
}

const hintStyle = { whiteSpace: 'pre-line' } as const;

/** Small info icon with an explanatory tooltip; newlines in string labels render as paragraph breaks */
export function Hint({ label }: { label: ReactNode }) {
  return (
    <Tooltip label={label} multiline w={360} withArrow events={{ hover: true, focus: true, touch: true }} style={hintStyle}>
      <IconInfoCircle
        size={14}
        style={{ opacity: 0.6, cursor: 'help', flexShrink: 0 }}
        tabIndex={0}
        aria-label="Nápověda"
        // Inside a sortable table header the icon must not toggle sorting (mouse or Enter key)
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </Tooltip>
  );
}

/** Column or row title followed by an info icon */
export function HintTitle({ children, hint }: { children: ReactNode; hint: ReactNode }) {
  return (
    <Group component="span" gap={4} wrap="nowrap" style={{ display: 'inline-flex' }}>
      {children}
      <Hint label={hint} />
    </Group>
  );
}

/** Wraps any element (e.g. a badge) with an explanatory tooltip */
export function WithHint({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip label={label} multiline w={340} withArrow events={{ hover: true, focus: true, touch: true }} style={hintStyle}>
      <span style={{ cursor: 'help', display: 'inline-flex' }} tabIndex={0}>
        {children}
      </span>
    </Tooltip>
  );
}

/** The current calendar year when it is available, otherwise the latest year with data */
export function defaultYear(s: { years: number[]; today: string }): number {
  const cur = Number(s.today.slice(0, 4));
  return s.years.includes(cur) ? cur : s.years.at(-1)!;
}

export function YearSelect({ years, value, onChange }: { years: number[]; value: number; onChange: (y: number) => void }) {
  return (
    <Select
      w={110}
      data={[...years].reverse().map((y) => String(y))}
      value={String(value)}
      onChange={(v) => v && onChange(Number(v))}
      allowDeselect={false}
      aria-label="Rok"
    />
  );
}

/** Value with a copy-to-clipboard button – for DAP fields */
export function CopyValue({ value, display }: { value: number | string; display?: ReactNode }) {
  const raw = typeof value === 'number' ? czkRaw(value) : value;
  return (
    <Group gap={4} wrap="nowrap" justify="flex-end">
      <Text ff="monospace" fw={600}>
        {display ?? raw}
      </Text>
      <CopyButton value={raw} timeout={1500}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Zkopírováno' : 'Kopírovat'} withArrow>
            <ActionIcon size="sm" variant="subtle" color={copied ? 'teal' : 'gray'} onClick={copy}>
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

export const tooltipCzk = (v: unknown) => (typeof v === 'number' ? `${Math.round(v).toLocaleString('cs-CZ')} Kč` : String(v));
