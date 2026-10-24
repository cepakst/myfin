import { Anchor, Badge, Group, SimpleGrid, Stack, Tabs, Text } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Snapshot } from '../api';
import { Chart, defaultYear, Section, Stat, tooltipCzk, YearSelect } from '../components';
import { DataGrid } from '../DataGrid';
import { czk, date, money, pct } from '../format';

type Pay = Snapshot['dividends'][number];

export interface InstrumentDividendSummary {
  instrumentId: string;
  name: string;
  country: string;
  count: number;
  grossCzk: number;
  withheldCzk: number;
  netCzk: number;
  creditableCzk: number;
  dueCzk: number;
  reclaimableCzk: number;
  withheldRate: number | null;
}

/** Aggregates dividend payments per instrument (amounts in the tax conversion of the year). */
export function summarizeByInstrument(pays: Pay[]): InstrumentDividendSummary[] {
  const m = new Map<string, InstrumentDividendSummary>();
  for (const p of pays) {
    let x = m.get(p.instrumentId);
    if (!x)
      m.set(
        p.instrumentId,
        (x = { instrumentId: p.instrumentId, name: p.name, country: p.country, count: 0, grossCzk: 0, withheldCzk: 0, netCzk: 0, creditableCzk: 0, dueCzk: 0, reclaimableCzk: 0, withheldRate: null }),
      );
    x.count++;
    x.grossCzk += p.grossCzk;
    x.withheldCzk += p.withheldCzk;
    x.netCzk += p.netCzk;
    x.creditableCzk += p.creditableCzk;
    if (!p.finalTaxed) x.dueCzk += p.dueCzk;
    x.reclaimableCzk += p.reclaimableCzk;
  }
  return [...m.values()].map((x) => ({ ...x, withheldRate: x.grossCzk > 0 ? x.withheldCzk / x.grossCzk : null }));
}

const instrumentLink = (r: { instrumentId: string; name: string }) => (
  <Anchor component={Link} to={`/instrument/${encodeURIComponent(r.instrumentId)}`} size="sm">
    {r.name}
  </Anchor>
);

export function DividendsPage({ s }: { s: Snapshot }) {
  const [year, setYear] = useState(defaultYear(s));
  const rep = s.dividendYears.find((d) => d.year === year)!;
  const pays = s.dividends.filter((d) => d.year === year);
  const byInstrument = summarizeByInstrument(pays);
  const byYear = s.years.map((y) => {
    const ps = s.dividends.filter((d) => d.year === y);
    return { y, net: ps.reduce((a, p) => a + p.netCzkDaily, 0), wht: ps.reduce((a, p) => a + p.withheldCzk, 0) };
  });

  return (
    <Stack>
      <Section title="Dividendy po letech">
        <Chart
          height={240}
          option={{
            tooltip: { trigger: 'axis', valueFormatter: tooltipCzk },
            legend: {},
            grid: { left: 70, right: 20, top: 40, bottom: 30 },
            xAxis: { type: 'category', data: byYear.map((b) => String(b.y)) },
            yAxis: { type: 'value' },
            series: [
              { name: 'Čistá dividenda', type: 'bar', stack: 'd', data: byYear.map((b) => Math.round(b.net)) },
              { name: 'Srážková daň', type: 'bar', stack: 'd', data: byYear.map((b) => Math.round(b.wht)) },
            ],
          }}
        />
      </Section>
      <Group>
        <YearSelect years={s.years} value={year} onChange={setYear} />
      </Group>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label="Zahraniční dividendy hrubě" value={czk(rep.foreign.grossCzk)} sub={`${pays.length} výplat`} hint="Hrubé zahraniční dividendy před srážkovou daní, přepočtené kurzem zvoleným pro daňové účely. Tato částka se uvádí v přiznání." />
        <Stat
          label="Sražená daň v zahraničí"
          value={czk(rep.foreign.withheldCzk)}
          sub={`započitatelná ${czk(rep.foreign.creditableCzk)}`}
          hint="Daň sražená zahraničním státem. Započíst proti české dani lze nejvýše do výše sazby podle smlouvy o zamezení dvojího zdanění (obvykle 15 %)."
        />
        <Stat label="Doplatek daně v ČR" value={czk(rep.foreign.dueCzk)} sub="15 % po zápočtu" hint="Česká daň 15 % z hrubé dividendy po odečtení započitatelné zahraniční daně – to, co v přiznání doplatíte." />
        <Stat
          label="Lze žádat v zahraničí"
          value={czk(rep.foreign.reclaimableCzk)}
          sub="sraženo nad smluvní sazbu"
          color={rep.foreign.reclaimableCzk > 0 ? 'orange' : undefined}
          hint="Část zahraniční daně sražená nad smluvní sazbu. V ČR ji započíst nelze; o vrácení je nutné žádat zahraniční správce daně."
        />
      </SimpleGrid>
      <Tabs defaultValue="countries">
        <Tabs.List>
          <Tabs.Tab value="countries">Podle států</Tabs.Tab>
          <Tabs.Tab value="instruments">Podle instrumentů</Tabs.Tab>
          <Tabs.Tab value="payments">Jednotlivé výplaty</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="countries" pt="sm">
          <DataGrid
            label="Dividendy podle států"
            idAccessor="country"
            records={rep.byCountry}
            defaultSort={{ column: 'grossCzk', direction: 'desc' }}
            searchPlaceholder="Hledat stát…"
            columns={[
              { accessor: 'country', title: 'Stát' },
              { accessor: 'count', title: 'Výplat', textAlign: 'right' },
              { accessor: 'grossCzk', title: 'Hrubě', textAlign: 'right', render: (c) => czk(c.grossCzk) },
              {
                accessor: 'withheldCzk',
                title: 'Sraženo',
                textAlign: 'right',
                render: (c) => (
                  <>
                    {czk(c.withheldCzk)}{' '}
                    <Text span size="xs" c="dimmed">
                      ({pct(c.grossCzk > 0 ? c.withheldCzk / c.grossCzk : null, 0)})
                    </Text>
                  </>
                ),
              },
              { accessor: 'treatyRate', title: 'Smluvní sazba', textAlign: 'right', render: (c) => (c.treatyRate == null ? 'bez smlouvy' : pct(c.treatyRate, 0)) },
              { accessor: 'creditableCzk', title: 'Započitatelné', textAlign: 'right', render: (c) => czk(c.creditableCzk) },
              { accessor: 'czTaxCzk', title: 'Daň ČR 15 %', textAlign: 'right', render: (c) => czk(c.czTaxCzk) },
              { accessor: 'dueCzk', title: 'Doplatek', textAlign: 'right', render: (c) => czk(c.dueCzk) },
              {
                accessor: 'reclaimableCzk',
                title: 'Vratitelné v zahraničí',
                textAlign: 'right',
                render: (c) => (
                  <Text span size="sm" c={c.reclaimableCzk > 0 ? 'orange' : undefined}>
                    {czk(c.reclaimableCzk)}
                  </Text>
                ),
              },
            ]}
          />
          {rep.domesticFinal.grossCzk > 0 && (
            <Text size="sm" mt="xs" c="dimmed">
              České dividendy: hrubě {czk(rep.domesticFinal.grossCzk)}, sraženo {czk(rep.domesticFinal.withheldCzk)} – zdaněno konečnou srážkovou daní, do přiznání se neuvádí.
            </Text>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="instruments" pt="sm">
          <DataGrid
            label="Dividendy podle instrumentů"
            idAccessor="instrumentId"
            records={byInstrument}
            defaultSort={{ column: 'grossCzk', direction: 'desc' }}
            searchPlaceholder="Hledat instrument, ISIN…"
            columns={[
              { accessor: 'name', title: 'Instrument', searchValue: (r) => `${r.name} ${r.instrumentId}`, render: instrumentLink },
              { accessor: 'country', title: 'Stát', filterable: true },
              { accessor: 'count', title: 'Výplat', textAlign: 'right' },
              { accessor: 'grossCzk', title: 'Hrubě', textAlign: 'right', render: (r) => czk(r.grossCzk) },
              {
                accessor: 'withheldCzk',
                title: 'Sraženo',
                textAlign: 'right',
                render: (r) => (
                  <>
                    {czk(r.withheldCzk)}{' '}
                    <Text span size="xs" c="dimmed">
                      ({pct(r.withheldRate, 0)})
                    </Text>
                  </>
                ),
              },
              { accessor: 'netCzk', title: 'Čistě', textAlign: 'right', render: (r) => czk(r.netCzk) },
              { accessor: 'creditableCzk', title: 'Započitatelné', textAlign: 'right', render: (r) => czk(r.creditableCzk) },
              { accessor: 'dueCzk', title: 'Doplatek', textAlign: 'right', render: (r) => czk(r.dueCzk) },
              {
                accessor: 'reclaimableCzk',
                title: 'Vratitelné',
                textAlign: 'right',
                render: (r) => (
                  <Text span size="sm" c={r.reclaimableCzk > 0 ? 'orange' : undefined}>
                    {czk(r.reclaimableCzk)}
                  </Text>
                ),
              },
            ]}
          />
        </Tabs.Panel>
        <Tabs.Panel value="payments" pt="sm">
          <DataGrid
            label="Jednotlivé výplaty dividend"
            idAccessor="id"
            records={pays}
            defaultSort={{ column: 'date', direction: 'desc' }}
            searchPlaceholder="Hledat instrument, ISIN…"
            columns={[
              { accessor: 'date', title: 'Datum', render: (p) => date(p.date) },
              { accessor: 'name', title: 'Instrument', searchValue: (p) => `${p.name} ${p.instrumentId}`, render: instrumentLink },
              { accessor: 'broker', title: 'Broker', filterable: true },
              {
                accessor: 'country',
                title: 'Stát',
                filterable: true,
                render: (p) =>
                  p.capitalReturn ? (
                    <Group gap={4}>
                      {p.country}
                      <Badge size="xs">vratka kapitálu</Badge>
                    </Group>
                  ) : (
                    p.country
                  ),
              },
              { accessor: 'gross', title: 'Hrubě', textAlign: 'right', sortValue: (p) => p.grossCzk, render: (p) => money(p.gross, p.currency) },
              {
                accessor: 'withheld',
                title: 'Sraženo',
                textAlign: 'right',
                sortValue: (p) => p.withheldCzk,
                render: (p) => `${money(p.withheld, p.currency)} (${pct(p.gross ? p.withheld / p.gross : null, 0)})`,
              },
              { accessor: 'grossCzk', title: 'Hrubě Kč', textAlign: 'right', render: (p) => czk(p.grossCzk) },
              { accessor: 'creditableCzk', title: 'Započitatelné', textAlign: 'right', render: (p) => czk(p.creditableCzk) },
              { accessor: 'dueCzk', title: 'Doplatek', textAlign: 'right', render: (p) => (p.finalTaxed ? 'srážka CZ' : czk(p.dueCzk)) },
              { accessor: 'reclaimable', title: 'Vratitelné', textAlign: 'right', sortValue: (p) => p.reclaimableCzk, render: (p) => (p.reclaimable > 0 ? money(p.reclaimable, p.currency) : '–') },
            ]}
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
