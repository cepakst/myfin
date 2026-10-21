import { Anchor, Badge, Group, SimpleGrid, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { DataTable, type DataTableSortStatus } from 'mantine-datatable';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Snapshot } from '../api';
import { Stat, YearSelect } from '../components';
import { czk, date, money, num, signColor } from '../format';

type R = Snapshot['realizations'][number];

export function TradesPage({ s }: { s: Snapshot }) {
  const [year, setYear] = useState(s.years.at(-1)!);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<DataTableSortStatus<R>>({ columnAccessor: 'sellDate', direction: 'desc' });
  const rows = s.realizations.filter((r) => r.sellDate.startsWith(String(year)) && (!q || r.name.toLowerCase().includes(q.toLowerCase())));
  const k = sort.columnAccessor as keyof R;
  const sorted = [...rows].sort((a, b) => {
    const x = a[k] as unknown;
    const y = b[k] as unknown;
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sort.direction === 'asc' ? d : -d;
  });
  const sum = (f: (r: R) => number) => rows.reduce((a, r) => a + f(r), 0);
  const gains = sum((r) => Math.max(0, r.gainCzk));
  const losses = sum((r) => Math.min(0, r.gainCzk));

  return (
    <Stack>
      <Group justify="space-between">
        <Group>
          <YearSelect years={s.years} value={year} onChange={setYear} />
          <TextInput placeholder="Hledat…" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
        </Group>
        <Text size="sm" c="dimmed">
          Hodnoty v daňovém přepočtu (zvolený kurz pro rok); „ekonomicky“ = denní kurz ČNB.
        </Text>
      </Group>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label="Příjmy z prodejů" value={czk(sum((r) => r.proceedsCzk))} sub={`${rows.length} FIFO řádků`} />
        <Stat label="Zisky" value={czk(gains)} color="teal" />
        <Stat label="Ztráty" value={czk(losses)} color="red" sub={gains > 0 ? `snědly ${Math.round((-losses / gains) * 100)} % zisků` : undefined} />
        <Stat label="Výsledek" value={czk(gains + losses)} color={signColor(gains + losses)} sub={`ekonomicky ${czk(sum((r) => r.econGainCzk))}`} />
      </SimpleGrid>
      <DataTable
        withTableBorder
        striped
        highlightOnHover
        fz="sm"
        idAccessor="id"
        records={sorted}
        sortStatus={sort}
        onSortStatusChange={setSort}
        columns={[
          {
            accessor: 'name',
            title: 'Instrument',
            sortable: true,
            render: (r) => (
              <Anchor component={Link} to={`/instrument/${encodeURIComponent(r.instrumentId)}`} size="sm">
                {r.name}
              </Anchor>
            ),
          },
          { accessor: 'broker', title: 'Broker' },
          { accessor: 'acqDate', title: 'Nákup', sortable: true, render: (r) => date(r.acqDate) },
          { accessor: 'sellDate', title: 'Prodej', sortable: true, render: (r) => date(r.sellDate) },
          { accessor: 'holdingDays', title: 'Drženo', textAlign: 'right', sortable: true, render: (r) => `${r.holdingDays} d` },
          { accessor: 'qty', title: 'Kusů', textAlign: 'right', render: (r) => num(r.qty) },
          { accessor: 'sellPrice', title: 'Prodejní cena', textAlign: 'right', render: (r) => money(r.sellPrice, r.currency) },
          { accessor: 'proceedsCzk', title: 'Příjem', textAlign: 'right', sortable: true, render: (r) => czk(r.proceedsCzk) },
          {
            accessor: 'costCzk',
            title: 'Výdaje',
            textAlign: 'right',
            sortable: true,
            render: (r) => (
              <Tooltip label={`nákup ${czk(r.costCzk)} + poplatky nákup ${czk(r.buyFeesCzk)} + prodej ${czk(r.sellFeesCzk)}`}>
                <span>{czk(r.costCzk + r.buyFeesCzk + r.sellFeesCzk)}</span>
              </Tooltip>
            ),
          },
          {
            accessor: 'gainCzk',
            title: 'Zisk',
            textAlign: 'right',
            sortable: true,
            render: (r) => (
              <Text size="sm" c={signColor(r.gainCzk)}>
                {czk(r.gainCzk)}
              </Text>
            ),
          },
          {
            accessor: 'timeTestPassed',
            title: 'Daň',
            render: (r) =>
              r.timeTestPassed ? (
                <Badge color="teal" variant="light">
                  časový test
                </Badge>
              ) : r.origin === 'UNKNOWN' ? (
                <Badge color="gray" variant="light">
                  {r.qty === 0 ? 'hotovost z korp. akce' : 'bez nákupu'}
                </Badge>
              ) : (
                <Badge color="orange" variant="light">
                  zdanitelné
                </Badge>
              ),
          },
        ]}
      />
    </Stack>
  );
}
