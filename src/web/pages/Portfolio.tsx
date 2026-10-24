import { Anchor, Badge, Progress, SegmentedControl, Stack, Tabs, Text, Tooltip } from '@mantine/core';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Snapshot } from '../api';
import { DataGrid, type GridColumn } from '../DataGrid';
import { czk, date, money, num, pct, signColor } from '../format';
import { G } from '../glossary';

type Lot = Snapshot['lots'][number];

export function priceSourceText(source: string | null, priceDate?: string | null): string {
  const at = priceDate ? ` (${date(priceDate)})` : '';
  if (source === 'market') return `Tržní cena Yahoo Finance${at}`;
  if (source === 'trade') return `Odhad: cena posledního obchodu${at} – chybí tržní data, doplňte symbol v Nastavení`;
  if (source === 'broker') return `Odhad: ocenění od brokera${at} – chybí tržní data, doplňte symbol v Nastavení`;
  return 'Cena není k dispozici';
}

export function PriceCell({ price, currency, source, priceDate }: { price: number | null; currency: string | null; source: string | null; priceDate?: string | null }) {
  const estimated = source !== 'market';
  return (
    <Tooltip label={priceSourceText(source, priceDate)} multiline maw={320}>
      <Text span size="sm" c={estimated ? 'orange' : undefined}>
        {estimated && price != null ? '≈ ' : ''}
        {money(price, currency)}
      </Text>
    </Tooltip>
  );
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

function lotColumns(withName: boolean): GridColumn<Lot>[] {
  return [
    ...(withName
      ? [
          {
            accessor: 'name' as const,
            title: 'Instrument',
            searchValue: (l: Lot) => `${l.name} ${l.instrumentId}`,
            render: (l: Lot) => (
              <Anchor component={Link} to={`/instrument/${encodeURIComponent(l.instrumentId)}`} size="sm">
                {l.name}
              </Anchor>
            ),
          },
        ]
      : []),
    { accessor: 'broker' as const, title: 'Broker', filterable: true },
    { accessor: 'acqDate' as const, title: 'Nákup', render: (l: Lot) => date(l.acqDate) },
    { accessor: 'qty' as const, title: 'Kusů', hint: G.lotQty, textAlign: 'right' as const, render: (l: Lot) => num(l.qty) },
    {
      accessor: 'costCzk' as const,
      title: 'Nákupní cena',
      hint: G.lotCost,
      textAlign: 'right' as const,
      sortValue: (l: Lot) => l.costCzk + l.feesCzk,
      render: (l: Lot) => (
        <Tooltip label={`Daňový základ (vč. poplatků): ${czk(l.taxCostCzk)}`}>
          <span>{czk(l.costCzk + l.feesCzk)}</span>
        </Tooltip>
      ),
    },
    { accessor: 'valueCzk' as const, title: 'Hodnota', hint: G.posValue, textAlign: 'right' as const, render: (l: Lot) => czk(l.valueCzk) },
    {
      accessor: 'unrealizedCzk' as const,
      title: 'Zisk',
      hint: G.unrealizedPos,
      textAlign: 'right' as const,
      render: (l: Lot) => (
        <Text size="sm" c={signColor(l.unrealizedCzk)}>
          {czk(l.unrealizedCzk)} <Text span size="xs">({pct(l.unrealizedPct)})</Text>
        </Text>
      ),
    },
    { accessor: 'timeTestDate' as const, title: 'Časový test', hint: G.timeTest, render: (l: Lot) => <TimeTestBadge lot={l} /> },
    {
      accessor: 'origin' as const,
      title: '',
      sortable: false,
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

export function LotsTable({ lots, withName = true, toolbar, searchable = true }: { lots: Lot[]; withName?: boolean; toolbar?: ReactNode; searchable?: boolean }) {
  return (
    <DataGrid
      label="Loty"
      idAccessor="id"
      records={lots}
      columns={lotColumns(withName)}
      defaultSort={{ column: 'acqDate', direction: 'asc' }}
      searchable={searchable}
      searchPlaceholder="Hledat instrument, ISIN…"
      toolbar={toolbar}
    />
  );
}

export function PortfolioPage({ s }: { s: Snapshot }) {
  const [filter, setFilter] = useState('all');
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
  const positions = s.positions.filter((p) => p.qty > 1e-9);
  const lots = s.lots.filter(
    (l) =>
      filter === 'all' || (filter === 'passed' && l.timeTestPassed) || (filter === 'soon' && !l.timeTestPassed && l.daysToTimeTest <= 365) || (filter === 'loss' && (l.unrealizedCzk ?? 0) < 0),
  );

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {positions.length} pozic · {s.lots.length} lotů · splněný test: {s.lots.filter((l) => l.timeTestPassed).length}
      </Text>
      <Tabs defaultValue="positions">
        <Tabs.List>
          <Tabs.Tab value="positions">Pozice</Tabs.Tab>
          <Tabs.Tab value="lots">Všechny loty (FIFO)</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="positions" pt="sm">
          <DataGrid
            label="Pozice"
            maxHeight={680}
            idAccessor="instrumentId"
            records={positions}
            defaultSort={{ column: 'valueCzk', direction: 'desc' }}
            searchPlaceholder="Hledat název, ISIN…"
            rowExpansion={{
              expanded: { recordIds: expanded, onRecordIdsChange: setExpanded },
              content: ({ record }) => (
                <div style={{ padding: 8 }}>
                  <LotsTable lots={lotsByInst.get(record.instrumentId) ?? []} withName={false} searchable={false} />
                </div>
              ),
            }}
            columns={[
              {
                accessor: 'name',
                title: 'Instrument',
                searchValue: (p) => `${p.name} ${p.isin ?? ''} ${p.instrumentId} ${p.brokers.join(' ')} ${p.type}`,
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
              { accessor: 'qty', title: 'Kusů', hint: 'Počet držených kusů (součet otevřených lotů, upraveno o splity).', textAlign: 'right', render: (p) => num(p.qty) },
              {
                accessor: 'price',
                title: 'Cena',
                hint: G.price,
                textAlign: 'right',
                sortable: false,
                render: (p) => <PriceCell price={p.price} currency={p.priceCurrency} source={p.priceSource} priceDate={p.priceDate} />,
              },
              { accessor: 'costCzk', title: 'Nákupní cena', hint: G.posCost, textAlign: 'right', render: (p) => czk(p.costCzk) },
              { accessor: 'valueCzk', title: 'Hodnota', hint: G.posValue, textAlign: 'right', render: (p) => czk(p.valueCzk) },
              { accessor: 'weight', title: 'Váha', hint: G.weight, textAlign: 'right', render: (p) => pct(p.weight) },
              {
                accessor: 'unrealizedCzk',
                title: 'Nerealizovaný zisk',
                hint: G.unrealizedPos,
                textAlign: 'right',
                render: (p) => (
                  <Text size="sm" c={signColor(p.unrealizedCzk)}>
                    {czk(p.unrealizedCzk)} <Text span size="xs">({pct(p.unrealizedPct)})</Text>
                  </Text>
                ),
              },
              { accessor: 'dividendsCzk', title: 'Dividendy', hint: G.posDividends, textAlign: 'right', render: (p) => czk(p.dividendsCzk) },
              {
                accessor: 'nextTimeTestDate',
                title: 'Časový test',
                hint: G.posTimeTest,
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
          <LotsTable
            lots={lots}
            toolbar={
              <SegmentedControl
                size="xs"
                aria-label="Filtr lotů"
                value={filter}
                onChange={setFilter}
                data={[
                  { value: 'all', label: 'Vše' },
                  { value: 'passed', label: 'Splněný test' },
                  { value: 'soon', label: 'Test do 1 roku' },
                  { value: 'loss', label: 'Ve ztrátě' },
                ]}
              />
            }
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
