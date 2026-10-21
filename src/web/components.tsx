import { ActionIcon, Card, CopyButton, Group, Paper, Select, Text, Tooltip, useComputedColorScheme } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import type { ReactNode } from 'react';
import { czkRaw } from './format';

export function Chart({ option, height = 320 }: { option: EChartsOption; height?: number }) {
  const scheme = useComputedColorScheme('light');
  return (
    <ReactECharts
      option={withDefaults(option)}
      theme={scheme === 'dark' ? 'dark' : undefined}
      style={{ height, width: '100%' }}
      notMerge
      lazyUpdate
    />
  );
}

const axisNum = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });

// Legend on top (never collides with x-axis labels), Czech number format on value axes.
function withDefaults(option: EChartsOption): EChartsOption {
  const o: Record<string, any> = { backgroundColor: 'transparent', ...option };
  const fixLegend = (l: any) => (l && l.top === undefined && l.bottom === undefined && l.orient !== 'vertical' ? { type: 'scroll', ...l, top: 0 } : l);
  if (o.legend) o.legend = Array.isArray(o.legend) ? o.legend.map(fixLegend) : fixLegend(o.legend);
  const hasTopLegend = o.legend && (Array.isArray(o.legend) ? o.legend : [o.legend]).some((l: any) => l.top === 0);
  if ((o.xAxis || o.yAxis) && !o.grid) o.grid = { containLabel: true, left: 10, right: 20, bottom: 10, top: hasTopLegend ? 40 : 20 };
  const fixAxis = (a: any) =>
    a && a.type === 'value' && !a.axisLabel?.formatter ? { ...a, axisLabel: { ...a.axisLabel, formatter: (v: number) => axisNum.format(v) } } : a;
  for (const k of ['xAxis', 'yAxis']) if (o[k]) o[k] = Array.isArray(o[k]) ? o[k].map(fixAxis) : fixAxis(o[k]);
  return o as EChartsOption;
}

export function Stat({ label, value, sub, color }: { label: string; value: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <Paper withBorder p="md" radius="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
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

export function Section({ title, children, right }: { title: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" mb="sm">
        <Text fw={600}>{title}</Text>
        {right}
      </Group>
      {children}
    </Card>
  );
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
