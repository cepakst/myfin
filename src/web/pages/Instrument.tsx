import { Alert, Anchor, Badge, Center, Group, Loader, SimpleGrid, Stack, Tabs, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, type Snapshot } from '../api';
import { Chart, Section, Stat } from '../components';
import { DataGrid } from '../DataGrid';
import { czk, date, money, num, signColor } from '../format';
import { LotsTable, priceSourceText } from './Portfolio';
import { missingMarketData } from '../marketStatus';

export function InstrumentPage({ s }: { s: Snapshot }) {
  const id = decodeURIComponent(useParams().id ?? '');
  const q = useQuery({ queryKey: ['instrument', id], queryFn: () => api.instrument(id) });
  const inst = s.instruments.find((i) => i.id === id);
  const pos = s.positions.find((p) => p.instrumentId === id);
  if (q.isLoading) return <Center h={300}><Loader /></Center>;
  if (!q.data || !inst) return <Text>Instrument nenalezen. <Anchor component={Link} to="/portfolio">Zpět</Anchor></Text>;
  const d = q.data;
  const cur = d.currency ?? inst.currency;
  const buys = d.trades.filter((t) => t.quantity > 0 && t.currency === cur);
  const sells = d.trades.filter((t) => t.quantity < 0 && t.currency === cur);
  const realized = d.realizations.reduce((a, r) => a + r.gainCzk, 0);
  const divs = d.dividends.reduce((a, p) => a + p.netCzkDaily, 0);

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={3}>{inst.name}</Title>
          <Text size="sm" c="dimmed">
            {inst.isin ?? inst.id} · {inst.type} · {inst.exchange ?? inst.brokerSymbol ?? ''} · Yahoo: {inst.symbol ?? 'nenalezeno'} {inst.symbolNote ? `(${inst.symbolNote})` : ''}
          </Text>
        </div>
        <Badge size="lg" variant="light">
          {inst.country ?? '?'}
        </Badge>
      </Group>
      {missingMarketData([inst]).length > 0 && (
        <Alert color="orange" variant="light" title="Chybí tržní data">
          Pro tento instrument se nepodařilo dohledat ověřený symbol Yahoo Finance{inst.symbolSource === 'override' ? ' (ruční symbol nevrací data)' : ''}. Cena a hodnota se odhadují z posledního obchodu nebo ocenění brokera. Symbol doplníte v{' '}
          <Anchor component={Link} to="/nastaveni">
            Nastavení a data
          </Anchor>
          .
        </Alert>
      )}
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label="Držené kusy" value={num(pos?.qty ?? 0)} sub={pos?.price ? `cena ${pos.priceSource !== 'market' ? '≈ ' : ''}${money(pos.price, pos.priceCurrency)}` : undefined} hint={pos?.price ? priceSourceText(pos.priceSource, pos.priceDate) : undefined} />
        <Stat label="Hodnota" value={czk(pos?.valueCzk ?? 0)} sub={`nákup ${czk(pos?.costCzk ?? 0)}`} />
        <Stat label="Nerealizovaný zisk" value={czk(pos?.unrealizedCzk ?? 0)} color={signColor(pos?.unrealizedCzk)} />
        <Stat label="Realizováno + dividendy" value={czk(realized + divs)} color={signColor(realized + divs)} sub={`obchody ${czk(realized)} · dividendy ${czk(divs)}`} />
      </SimpleGrid>
      <Section title={`Cena (${cur}) s nákupy a prodeji`}>
        {d.prices.length === 0 ? (
          <Text c="dimmed" size="sm">
            Pro tento instrument nejsou tržní data. Symbol lze doplnit v Nastavení.
          </Text>
        ) : (
          <Chart
            height={380}
            option={{
              tooltip: { trigger: 'axis' },
              legend: {},
              grid: { left: 60, right: 20, top: 40, bottom: 60 },
              xAxis: { type: 'time' },
              yAxis: { type: 'value', scale: true },
              dataZoom: [{ type: 'inside' }, { type: 'slider' }],
              series: [
                { name: 'Cena', type: 'line', showSymbol: false, sampling: 'lttb', data: d.prices.map((p) => [p.date, Number(p.close.toFixed(4))]) },
                { name: 'Nákup', type: 'scatter', symbol: 'triangle', symbolSize: 11, itemStyle: { color: '#12b886' }, data: buys.map((t) => [t.date, t.price, t.quantity]) },
                { name: 'Prodej', type: 'scatter', symbol: 'triangle', symbolRotate: 180, symbolSize: 11, itemStyle: { color: '#fa5252' }, data: sells.map((t) => [t.date, t.price, t.quantity]) },
              ],
            }}
          />
        )}
      </Section>
      <Tabs defaultValue="lots">
        <Tabs.List>
          <Tabs.Tab value="lots">Otevřené loty ({d.lots.length})</Tabs.Tab>
          <Tabs.Tab value="trades">Obchody ({d.trades.length})</Tabs.Tab>
          <Tabs.Tab value="real">Realizace ({d.realizations.length})</Tabs.Tab>
          <Tabs.Tab value="div">Dividendy ({d.dividends.length})</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="lots" pt="sm">
          <LotsTable lots={d.lots} withName={false} />
        </Tabs.Panel>
        <Tabs.Panel value="trades" pt="sm">
          <DataGrid
            label="Obchody"
            idAccessor="id"
            records={d.trades}
            defaultSort={{ column: 'dateTime', direction: 'desc' }}
            columns={[
              { accessor: 'dateTime', title: 'Datum', render: (t) => `${date(t.date)} ${t.dateTime.slice(11, 16)}` },
              { accessor: 'broker', title: 'Broker', filterable: true },
              { accessor: 'quantity', title: 'Kusů', textAlign: 'right', render: (t) => <Text size="sm" c={t.quantity > 0 ? 'teal' : 'red'}>{num(t.quantity)}</Text> },
              { accessor: 'price', title: 'Cena', textAlign: 'right', render: (t) => money(t.price, t.currency) },
              { accessor: 'amount', title: 'Objem', textAlign: 'right', render: (t) => money(t.amount, t.currency) },
              { accessor: 'fees', title: 'Poplatky', textAlign: 'right', sortable: false, render: (t) => t.fees.map((f) => money(f.amount, f.currency)).join(' + ') || '–' },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="real" pt="sm">
          <DataGrid
            label="Realizace"
            idAccessor="id"
            records={d.realizations}
            defaultSort={{ column: 'sellDate', direction: 'desc' }}
            columns={[
              { accessor: 'acqDate', title: 'Nákup', render: (r) => date(r.acqDate) },
              { accessor: 'sellDate', title: 'Prodej', render: (r) => date(r.sellDate) },
              { accessor: 'qty', title: 'Kusů', textAlign: 'right', render: (r) => num(r.qty) },
              { accessor: 'proceedsCzk', title: 'Příjem', textAlign: 'right', render: (r) => czk(r.proceedsCzk) },
              { accessor: 'gainCzk', title: 'Zisk (daňově)', textAlign: 'right', render: (r) => <Text size="sm" c={signColor(r.gainCzk)}>{czk(r.gainCzk)}</Text> },
              { accessor: 'timeTestPassed', title: 'Časový test', filterable: true, filterValue: (r) => (r.timeTestPassed ? 'splněn' : 'ne'), render: (r) => (r.timeTestPassed ? <Badge color="teal">splněn</Badge> : <Badge color="gray">ne</Badge>) },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="div" pt="sm">
          <DataGrid
            label="Dividendy"
            idAccessor="id"
            records={d.dividends}
            defaultSort={{ column: 'date', direction: 'desc' }}
            columns={[
              { accessor: 'date', title: 'Datum', render: (p) => date(p.date) },
              { accessor: 'gross', title: 'Hrubě', textAlign: 'right', render: (p) => money(p.gross, p.currency) },
              { accessor: 'withheld', title: 'Sraženo', textAlign: 'right', render: (p) => money(p.withheld, p.currency) },
              { accessor: 'netCzkDaily', title: 'Čistě Kč', textAlign: 'right', render: (p) => czk(p.netCzkDaily) },
            ]}
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
