import { Stack, Table, Text } from '@mantine/core';
import type { Snapshot } from '../api';
import { Chart, Section, tooltipCzk } from '../components';
import { czk, pct, signColor } from '../format';

const PARTS = [
  { key: 'realized', label: 'Realizované kapitálové zisky', sign: 1 },
  { key: 'unrealized', label: 'Změna nerealizovaných zisků', sign: 1 },
  { key: 'dividendsGross', label: 'Dividendy (hrubě)', sign: 1 },
  { key: 'withholdingTax', label: 'Srážková daň', sign: -1 },
  { key: 'interest', label: 'Úroky', sign: 1 },
  { key: 'otherIncome', label: 'Ostatní (korporátní akce…)', sign: 1 },
  { key: 'tradeFees', label: 'Poplatky za obchody', sign: -1 },
  { key: 'accountFees', label: 'Poplatky účtu', sign: -1 },
] as const;

export function YearsPage({ s }: { s: Snapshot }) {
  const ys = s.performance.years;
  return (
    <Stack>
      <Section title="Výnos po letech – struktura (Kč)">
        <Chart
          height={380}
          option={{
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: tooltipCzk },
            legend: { type: 'scroll' },
            grid: { left: 80, right: 20, top: 50, bottom: 30 },
            xAxis: { type: 'category', data: ys.map((y) => String(y.year)) },
            yAxis: { type: 'value' },
            series: [
              ...PARTS.map((p) => ({
                name: p.label,
                type: 'bar' as const,
                stack: 'pnl',
                data: ys.map((y) => Math.round(p.sign * y.breakdown[p.key])),
              })),
              { name: 'Celkem', type: 'line' as const, data: ys.map((y) => Math.round(y.pnl)), symbolSize: 8, lineStyle: { width: 0 }, itemStyle: { color: '#000' } },
            ],
          }}
        />
      </Section>
      <Section title="Procentní výnos">
        <Chart
          height={260}
          option={{
            tooltip: { trigger: 'axis', valueFormatter: (v) => pct(Number(v)) },
            legend: {},
            grid: { left: 60, right: 20, top: 40, bottom: 30 },
            xAxis: { type: 'category', data: ys.map((y) => String(y.year)) },
            yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${Math.round(v * 100)} %` } },
            series: [
              { name: 'TWR (časově vážený)', type: 'bar', data: ys.map((y) => y.twr) },
              { name: 'MWR (peněžně vážený)', type: 'bar', data: ys.map((y) => y.mwr) },
            ],
          }}
        />
        <Text size="xs" c="dimmed">
          TWR měří výkonnost investic nezávisle na vkladech a výběrech (srovnatelné s indexem). MWR (IRR) zohledňuje načasování vkladů – kolik skutečně vydělaly vaše peníze.
        </Text>
      </Section>
      <Section title="Tabulka">
        <Table.ScrollContainer minWidth={900}>
          <Table striped highlightOnHover withTableBorder fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th />
                {ys.map((y) => (
                  <Table.Th key={y.year} ta="right">
                    {y.year}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <Row label="Hodnota na začátku" vals={ys.map((y) => czk(y.startValue))} />
              <Row label="Nákupy (vč. poplatků)" vals={ys.map((y) => czk(y.buys))} />
              <Row label="Prodeje (po poplatcích)" vals={ys.map((y) => czk(y.sells))} />
              <Row label="Hodnota na konci" vals={ys.map((y) => czk(y.endValue))} />
              {PARTS.map((p) => (
                <Row key={p.key} label={p.label} vals={ys.map((y) => czk(p.sign * y.breakdown[p.key]))} colors={ys.map((y) => signColor(p.sign * y.breakdown[p.key]))} />
              ))}
              <Row bold label="Zisk / ztráta celkem" vals={ys.map((y) => czk(y.pnl))} colors={ys.map((y) => signColor(y.pnl))} />
              <Row bold label="TWR" vals={ys.map((y) => pct(y.twr))} colors={ys.map((y) => signColor(y.twr))} />
              <Row label="MWR (IRR)" vals={ys.map((y) => pct(y.mwr))} />
              <Row label="Podíl dividend na zisku" vals={ys.map((y) => (y.pnl > 0 ? pct((y.breakdown.dividendsGross - y.breakdown.withholdingTax) / y.pnl) : '–'))} />
              <Row label="Podíl poplatků na zisku" vals={ys.map((y) => (y.pnl > 0 ? pct((y.breakdown.tradeFees + y.breakdown.accountFees) / y.pnl) : '–'))} />
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Section>
    </Stack>
  );
}

function Row({ label, vals, colors, bold }: { label: string; vals: string[]; colors?: (string | undefined)[]; bold?: boolean }) {
  return (
    <Table.Tr fw={bold ? 700 : undefined}>
      <Table.Td>{label}</Table.Td>
      {vals.map((v, i) => (
        <Table.Td key={i} ta="right" c={colors?.[i]} style={{ whiteSpace: 'nowrap' }}>
          {v}
        </Table.Td>
      ))}
    </Table.Tr>
  );
}
