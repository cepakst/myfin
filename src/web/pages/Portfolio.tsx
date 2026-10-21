import { Anchor, Badge, Group, Progress, SegmentedControl, Stack, Tabs, Text, TextInput, Tooltip } from '@mantine/core';
import { DataTable, type DataTableSortStatus } from 'mantine-datatable';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Snapshot } from '../api';
import { czk, date, money, num, pct, signColor } from '../format';

type Lot = Snapshot['lots'][number];
type Pos = Snapshot['positions'][number];

function sortBy<T>(rows: T[], s: DataTableSortStatus<T>): T[] {
  const k = s.columnAccessor as keyof T;
  const dir = s.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[k] as unknown;
    const y = b[k] as unknown;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'cs')) * dir;
  });
}

export function TimeTestBadge({ lot }: { lot: Pick<Lot, 'timeTestPassed' | 'timeTestDate' | 'daysToTimeTest' | 'timeTestProgress'> }) {
  if (lot.timeTestPassed)
    return (
      <Badge color="teal" variant="light">
        splněn
      </Badge>
    );
  return (
    <Tooltip label={`Osvobozeno od ${date(lot.timeTestDate)} (zbývá ${lot.daysToTimeTest} dní)`}>
      <Stack gap={2} w={120}>
        <Text size="xs">{date(lot.timeTestDate)}</Text>
        <Progress value={lot.timeTestProgress * 100} size="sm" color={lot.daysToTimeTest < 180 ? 'yellow' : 'blue'} />
      </Stack>
    </Tooltip>
  );
}

function lotColumns(withName: boolean) {
  return [
    ...(withName
      ? [
          {
            accessor: 'name' as const,
            title: 'Instrument',
            sortable: true,
            render: (l: Lot) => (
              <Anchor component={Link} to={`/instrument/${encodeURIComponent(l.instrumentId)}`} size="sm">
                {l.name}
              </Anchor>
            ),
          },
        ]
      : []),
    { accessor: 'broker' as const, title: 'Broker' },
    { accessor: 'acqDate' as const, title: 'Nákup', sortable: true, render: (l: Lot) => date(l.acqDate) },
    { accessor: 'qty' as const, title: 'Kusů', textAlign: 'right' as const, render: (l: Lot) => num(l.qty) },
    {
      accessor: 'costCzk' as const,
      title: 'Nákupní cena',
      textAlign: 'right' as const,
      sortable: true,
      render: (l: Lot) => (
        <Tooltip label={`Daňový základ (vč. poplatků): ${czk(l.taxCostCzk)}`}>
          <span>{czk(l.costCzk + l.feesCzk)}</span>
        </Tooltip>
      ),
    },
    { accessor: 'valueCzk' as const, title: 'Hodnota', textAlign: 'right' as const, sortable: true, render: (l: Lot) => czk(l.valueCzk) },
    {
      accessor: 'unrealizedCzk' as const,
      title: 'Zisk',
      textAlign: 'right' as const,
      sortable: true,
      render: (l: Lot) => (
        <Text size="sm" c={signColor(l.unrealizedCzk)}>
          {czk(l.unrealizedCzk)} <Text span size="xs">({pct(l.unrealizedPct)})</Text>
        </Text>
      ),
    },
    { accessor: 'timeTestDate' as const, title: 'Časový test', sortable: true, render: (l: Lot) => <TimeTestBadge lot={l} /> },
    {
      accessor: 'origin' as const,
      title: '',
      render: (l: Lot) =>
        l.origin === 'FREE' || l.notes.length ? (
          <Tooltip label={l.notes.join('; ') || 'Bezplatně nabyté akcie'} multiline w={300}>
            <Badge size="xs" variant="outline">
              {l.origin === 'FREE' ? 'zdarma' : 'pozn.'}
            </Badge>
          </Tooltip>
        ) : null,
    },
  ];
}

export function LotsTable({ lots, withName = true }: { lots: Lot[]; withName?: boolean }) {
  const [sort, setSort] = useState<DataTableSortStatus<Lot>>({ columnAccessor: 'acqDate', direction: 'asc' });
  return <DataTable withTableBorder striped highlightOnHover fz="sm" records={sortBy(lots, sort)} columns={lotColumns(withName)} sortStatus={sort} onSortStatusChange={setSort} idAccessor="id" />;
}

export function PortfolioPage({ s }: { s: Snapshot }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<DataTableSortStatus<Pos>>({ columnAccessor: 'valueCzk', direction: 'desc' });
  const [expanded, setExpanded] = useState<string[]>([]);
  const lotsByInst = useMemo(() => {
    const m = new Map<string, Lot[]>();
    for (const l of s.lots) {
      const a = m.get(l.instrumentId) ?? [];
      a.push(l);
      m.set(l.instrumentId, a);
    }
    return m;
  }, [s.lots]);
  const q = query.toLowerCase();
  const positions = s.positions.filter((p) => p.qty > 1e-9 && (!q || p.name.toLowerCase().includes(q) || p.isin?.toLowerCase().includes(q)));
  const lots = s.lots.filter(
    (l) =>
      (!q || l.name.toLowerCase().includes(q)) &&
      (filter === 'all' || (filter === 'passed' && l.timeTestPassed) || (filter === 'soon' && !l.timeTestPassed && l.daysToTimeTest <= 365) || (filter === 'loss' && (l.unrealizedCzk ?? 0) < 0)),
  );

  return (
    <Stack>
      <Group justify="space-between">
        <TextInput placeholder="Hledat…" value={query} onChange={(e) => setQuery(e.currentTarget.value)} w={260} />
        <Text size="sm" c="dimmed">
          {positions.length} pozic · {s.lots.length} lotů · splněný test: {s.lots.filter((l) => l.timeTestPassed).length}
        </Text>
      </Group>
      <Tabs defaultValue="positions">
        <Tabs.List>
          <Tabs.Tab value="positions">Pozice</Tabs.Tab>
          <Tabs.Tab value="lots">Všechny loty (FIFO)</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="positions" pt="sm">
          <DataTable
            withTableBorder
            striped
            highlightOnHover
            fz="sm"
            idAccessor="instrumentId"
            records={sortBy(positions, sort)}
            sortStatus={sort}
            onSortStatusChange={setSort}
            rowExpansion={{
              expanded: { recordIds: expanded, onRecordIdsChange: setExpanded },
              content: ({ record }) => (
                <div style={{ padding: 8 }}>
                  <LotsTable lots={lotsByInst.get(record.instrumentId) ?? []} withName={false} />
                </div>
              ),
            }}
            columns={[
              {
                accessor: 'name',
                title: 'Instrument',
                sortable: true,
                render: (p) => (
                  <Stack gap={0}>
                    <Anchor component={Link} to={`/instrument/${encodeURIComponent(p.instrumentId)}`} size="sm" onClick={(e) => e.stopPropagation()}>
                      {p.name}
                    </Anchor>
                    <Text size="xs" c="dimmed">
                      {p.isin ?? p.instrumentId} · {p.brokers.join(', ')} · {p.type}
                    </Text>
                  </Stack>
                ),
              },
              { accessor: 'qty', title: 'Kusů', textAlign: 'right', render: (p) => num(p.qty) },
              { accessor: 'price', title: 'Cena', textAlign: 'right', render: (p) => <Tooltip label={`zdroj: ${p.priceSource ?? '–'}`}><span>{money(p.price, p.priceCurrency)}</span></Tooltip> },
              { accessor: 'costCzk', title: 'Nákupní cena', textAlign: 'right', sortable: true, render: (p) => czk(p.costCzk) },
              { accessor: 'valueCzk', title: 'Hodnota', textAlign: 'right', sortable: true, render: (p) => czk(p.valueCzk) },
              { accessor: 'weight', title: 'Váha', textAlign: 'right', sortable: true, render: (p) => pct(p.weight) },
              {
                accessor: 'unrealizedCzk',
                title: 'Nerealizovaný zisk',
                textAlign: 'right',
                sortable: true,
                render: (p) => (
                  <Text size="sm" c={signColor(p.unrealizedCzk)}>
                    {czk(p.unrealizedCzk)} <Text span size="xs">({pct(p.unrealizedPct)})</Text>
                  </Text>
                ),
              },
              { accessor: 'dividendsCzk', title: 'Dividendy', textAlign: 'right', sortable: true, render: (p) => czk(p.dividendsCzk) },
              {
                accessor: 'nextTimeTestDate',
                title: 'Časový test',
                sortable: true,
                render: (p) => (
                  <Stack gap={0}>
                    {p.timeTestedQty > 0 && (
                      <Text size="xs" c="teal">
                        splněno {num(p.timeTestedQty)} ks
                      </Text>
                    )}
                    {p.nextTimeTestDate && <Text size="xs">další: {date(p.nextTimeTestDate)}</Text>}
                    <Text size="xs" c="dimmed">
                      {p.lots} lotů
                    </Text>
                  </Stack>
                ),
              },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="lots" pt="sm">
          <SegmentedControl
            mb="sm"
            value={filter}
            onChange={setFilter}
            data={[
              { value: 'all', label: 'Vše' },
              { value: 'passed', label: 'Splněný test' },
              { value: 'soon', label: 'Test do 1 roku' },
              { value: 'loss', label: 'Ve ztrátě' },
            ]}
          />
          <LotsTable lots={lots} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
