import { Anchor, Group, SegmentedControl, Select, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AccountsSnapshot } from '../../api';
import { Chart, Section, Stat, tooltipCzk } from '../../components';
import { czk, pct } from '../../format';
import { AccountsEmpty } from './AccountsOverview';
import { categoryColor, categoryName } from './categoryUi';
import { DEFAULT_PERIOD, monthLabel, periodMonths, periodOptions as periodChoices } from './period';

type Tx = AccountsSnapshot['txs'][number];
type Kind = 'expense' | 'income';
const TAXES = 'taxes';

/** Spending and income by category for a period, with the monthly trend and top counterparties. */
export function AccountsCategoriesPage({ a }: { a: AccountsSnapshot }) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>('expense');
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [selected, setSelected] = useState<string | null>(null);

  const months = useMemo(() => periodMonths(a, period), [a, period]);

  const hidden = useMemo(() => new Set(a.accounts.filter((x) => x.hidden).map((x) => x.id)), [a.accounts]);
  const txs = useMemo(() => {
    const set = new Set(months);
    return a.txs.filter((t) => t.flow === kind && !hidden.has(t.accountId) && t.amountCzk !== null && set.has(t.date.slice(0, 7)));
  }, [a.txs, kind, hidden, months]);
  if (a.accounts.length === 0) return <AccountsEmpty />;

  // expenses are shown as positive amounts (a refund lowers its category)
  const val = (t: Tx) => (kind === 'expense' ? -(t.amountCzk ?? 0) : (t.amountCzk ?? 0));
  const byCat = new Map<string, { sum: number; count: number }>();
  for (const t of txs) {
    const e = byCat.get(t.category) ?? { sum: 0, count: 0 };
    e.sum += val(t);
    e.count++;
    byCat.set(t.category, e);
  }
  const rows = [...byCat].map(([id, e]) => ({ id, name: categoryName(a.categories, id), ...e })).sort((x, y) => y.sum - x.sum);
  const total = rows.reduce((s, r) => s + r.sum, 0);
  // taxes are a large, non-discretionary expense for the self-employed: also shown without them
  const taxes = kind === 'expense' ? (byCat.get(TAXES)?.sum ?? 0) : 0;
  const nMonths = Math.max(1, months.length);
  const sel = selected !== null && byCat.has(selected) ? selected : (rows[0]?.id ?? null);

  // top counterparties of the selected category
  const tops = new Map<string, { sum: number; count: number }>();
  for (const t of txs.filter((x) => x.category === sel)) {
    const e = tops.get(t.cpLabel) ?? { sum: 0, count: 0 };
    e.sum += val(t);
    e.count++;
    tops.set(t.cpLabel, e);
  }
  const topRows = [...tops].sort((x, y) => y[1].sum - x[1].sum).slice(0, 12);

  const monthIdx = new Map(months.map((m, i) => [m, i]));
  const series = rows.map((r) => {
    const data = months.map(() => 0);
    for (const t of txs) if (t.category === r.id) data[monthIdx.get(t.date.slice(0, 7))!] += val(t);
    return { name: r.name, type: 'bar' as const, stack: 'total', data: data.map((v) => Math.round(v)), itemStyle: { color: categoryColor(a.categories, r.id) } };
  });
  const periodOptions = periodChoices(a);
  // the transactions page shows the same period (or the month clicked in the chart)
  const txLink = (cat: string, month?: string) => `/ucty/transakce?kategorie=${encodeURIComponent(cat || '-')}${month ? `&mesic=${month}` : period === DEFAULT_PERIOD ? '' : `&obdobi=${period}`}`;
  const catByName = new Map(rows.map((r) => [r.name, r.id]));

  return (
    <Stack>
      <Group>
        <SegmentedControl
          value={kind}
          onChange={(v) => setKind(v as Kind)}
          data={[
            { value: 'expense', label: 'Výdaje' },
            { value: 'income', label: 'Příjmy' },
          ]}
          aria-label="Výdaje nebo příjmy"
        />
        <Select w={220} data={periodOptions} value={period} onChange={(v) => v && setPeriod(v)} allowDeselect={false} aria-label="Období" />
        {months.length > 0 && (
          <Text size="sm" c="dimmed">
            {monthLabel(months[0])} – {monthLabel(months.at(-1)!)}
          </Text>
        )}
      </Group>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat
          label={kind === 'expense' ? 'Výdaje celkem' : 'Příjmy celkem'}
          value={czk(total)}
          sub={`${txs.length} transakcí${taxes ? ` · bez daní ${czk(total - taxes)}` : ''}`}
          hint={`Součet za zvolené období bez převodů mezi vlastními účty a investic. Skryté účty se nezapočítávají.${taxes ? ' „Bez daní“ nepočítá kategorii Daně (daň z příjmů, sociální pojištění a další platby úřadům).' : ''}`}
        />
        <Stat
          label="Měsíční průměr"
          value={czk(total / nMonths)}
          sub={`${nMonths} měsíců${taxes ? ` · bez daní ${czk((total - taxes) / nMonths)}` : ''}`}
          hint="Součet za období vydělený počtem měsíců v období."
        />
        <Stat label="Největší kategorie" value={rows[0]?.name ?? '–'} sub={rows[0] ? `${czk(rows[0].sum)} · ${pct(total ? rows[0].sum / total : null, 0)}` : undefined} />
        <Stat label="Nezařazeno" value={czk(byCat.get('')?.sum ?? 0)} sub={pct(total ? (byCat.get('')?.sum ?? 0) / total : null, 0)} hint="Část bez kategorie. Zařadíte ji na stránce Zařadit." />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Section title="Podle kategorií">
          <Chart
            height={320}
            option={{
              tooltip: { trigger: 'item', valueFormatter: tooltipCzk },
              series: [
                {
                  type: 'pie',
                  radius: ['45%', '75%'],
                  data: rows.filter((r) => r.sum > 0).map((r) => ({ name: r.name, value: Math.round(r.sum), itemStyle: { color: categoryColor(a.categories, r.id) } })),
                  label: { formatter: '{b}' },
                },
              ],
            }}
          />
        </Section>
        <Section title="Po měsících" hint="Kliknutím na sloupec zobrazíte transakce kategorie v daném měsíci.">
          <Chart
            height={320}
            onEvents={{
              click: (p: { seriesName?: string; dataIndex?: number }) => {
                const id = p.seriesName !== undefined ? catByName.get(p.seriesName) : undefined;
                if (id !== undefined && p.dataIndex !== undefined) navigate(txLink(id, months[p.dataIndex]));
              },
            }}
            option={{
              tooltip: { trigger: 'axis', valueFormatter: tooltipCzk },
              legend: { show: false },
              xAxis: { type: 'category', data: months.map(monthLabel) },
              yAxis: { type: 'value' },
              series,
            }}
          />
        </Section>
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Section title="Kategorie" hint="Kliknutím na řádek zobrazíte největší protistrany kategorie vpravo.">
          <Table highlightOnHover data-testid="category-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Kategorie</Table.Th>
                <Table.Th ta="right">Součet</Table.Th>
                <Table.Th ta="right">Podíl</Table.Th>
                <Table.Th ta="right">Měsíčně</Table.Th>
                <Table.Th ta="right">Počet</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => (
                <Table.Tr key={r.id} onClick={() => setSelected(r.id)} style={{ cursor: 'pointer' }} bg={r.id === sel ? 'var(--mantine-color-default-hover)' : undefined}>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: categoryColor(a.categories, r.id), flexShrink: 0 }} />
                      <Anchor component={Link} to={txLink(r.id)} size="sm" onClick={(e) => e.stopPropagation()}>
                        {r.name}
                      </Anchor>
                    </Group>
                  </Table.Td>
                  <Table.Td ta="right">{czk(r.sum)}</Table.Td>
                  <Table.Td ta="right">{pct(total ? r.sum / total : null, 0)}</Table.Td>
                  <Table.Td ta="right">{czk(r.sum / nMonths)}</Table.Td>
                  <Table.Td ta="right">{r.count}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Section>
        <Section title={sel !== null ? `Největší protistrany – ${categoryName(a.categories, sel)}` : 'Největší protistrany'}>
          <Table>
            <Table.Tbody>
              {topRows.map(([name, e]) => (
                <Table.Tr key={name}>
                  <Table.Td>
                    <Text size="sm">{name}</Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="xs" c="dimmed">
                      {e.count}×
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">{czk(e.sum)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Section>
      </SimpleGrid>
    </Stack>
  );
}
