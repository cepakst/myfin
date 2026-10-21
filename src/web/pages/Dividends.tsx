import { Anchor, Badge, Group, SimpleGrid, Stack, Table, Tabs, Text } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Snapshot } from '../api';
import { Chart, Section, Stat, tooltipCzk, YearSelect } from '../components';
import { czk, date, money, pct } from '../format';
import { DapBlocks } from './Taxes';

export function DividendsPage({ s }: { s: Snapshot }) {
  const [year, setYear] = useState(s.years.at(-1)! - (s.years.length > 1 ? 1 : 0));
  const rep = s.dividendYears.find((d) => d.year === year)!;
  const pays = s.dividends.filter((d) => d.year === year);
  const dap = s.dap.find((x) => x.year === year)!;
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
        <Stat label="Zahraniční dividendy hrubě" value={czk(rep.foreign.grossCzk)} sub={`${pays.length} výplat`} />
        <Stat label="Sražená daň v zahraničí" value={czk(rep.foreign.withheldCzk)} sub={`započitatelná ${czk(rep.foreign.creditableCzk)}`} />
        <Stat label="Doplatek daně v ČR" value={czk(rep.foreign.dueCzk)} sub="15 % po zápočtu" />
        <Stat label="Lze žádat v zahraničí" value={czk(rep.foreign.reclaimableCzk)} sub="sraženo nad smluvní sazbu" color={rep.foreign.reclaimableCzk > 0 ? 'orange' : undefined} />
      </SimpleGrid>
      <Tabs defaultValue="countries">
        <Tabs.List>
          <Tabs.Tab value="countries">Podle států</Tabs.Tab>
          <Tabs.Tab value="dap">Do přiznání</Tabs.Tab>
          <Tabs.Tab value="payments">Jednotlivé výplaty</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="countries" pt="sm">
          <Table striped withTableBorder fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Stát</Table.Th>
                <Table.Th ta="right">Výplat</Table.Th>
                <Table.Th ta="right">Hrubě</Table.Th>
                <Table.Th ta="right">Sraženo</Table.Th>
                <Table.Th ta="right">Smluvní sazba</Table.Th>
                <Table.Th ta="right">Započitatelné</Table.Th>
                <Table.Th ta="right">Daň ČR 15 %</Table.Th>
                <Table.Th ta="right">Doplatek</Table.Th>
                <Table.Th ta="right">Vratitelné v zahraničí</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rep.byCountry.map((c) => (
                <Table.Tr key={c.country}>
                  <Table.Td>{c.country}</Table.Td>
                  <Table.Td ta="right">{c.count}</Table.Td>
                  <Table.Td ta="right">{czk(c.grossCzk)}</Table.Td>
                  <Table.Td ta="right">
                    {czk(c.withheldCzk)} <Text span size="xs" c="dimmed">({pct(c.grossCzk > 0 ? c.withheldCzk / c.grossCzk : null, 0)})</Text>
                  </Table.Td>
                  <Table.Td ta="right">{c.treatyRate == null ? 'bez smlouvy' : pct(c.treatyRate, 0)}</Table.Td>
                  <Table.Td ta="right">{czk(c.creditableCzk)}</Table.Td>
                  <Table.Td ta="right">{czk(c.czTaxCzk)}</Table.Td>
                  <Table.Td ta="right">{czk(c.dueCzk)}</Table.Td>
                  <Table.Td ta="right" c={c.reclaimableCzk > 0 ? 'orange' : undefined}>
                    {czk(c.reclaimableCzk)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {rep.domesticFinal.grossCzk > 0 && (
            <Text size="sm" mt="xs" c="dimmed">
              České dividendy: hrubě {czk(rep.domesticFinal.grossCzk)}, sraženo {czk(rep.domesticFinal.withheldCzk)} – zdaněno konečnou srážkovou daní, do přiznání se neuvádí.
            </Text>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="dap" pt="sm">
          <Stack>
            <DapBlocks blocks={dap.blocks.slice(1)} />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="payments" pt="sm">
          <DataTable
            withTableBorder
            striped
            fz="sm"
            idAccessor="id"
            records={pays}
            columns={[
              { accessor: 'date', title: 'Datum', render: (p) => date(p.date) },
              {
                accessor: 'name',
                title: 'Instrument',
                render: (p) => (
                  <Anchor component={Link} to={`/instrument/${encodeURIComponent(p.instrumentId)}`} size="sm">
                    {p.name}
                  </Anchor>
                ),
              },
              { accessor: 'country', title: 'Stát', render: (p) => (p.capitalReturn ? <Group gap={4}>{p.country}<Badge size="xs">vratka kapitálu</Badge></Group> : p.country) },
              { accessor: 'gross', title: 'Hrubě', textAlign: 'right', render: (p) => money(p.gross, p.currency) },
              { accessor: 'withheld', title: 'Sraženo', textAlign: 'right', render: (p) => `${money(p.withheld, p.currency)} (${pct(p.gross ? p.withheld / p.gross : null, 0)})` },
              { accessor: 'grossCzk', title: 'Hrubě Kč', textAlign: 'right', render: (p) => czk(p.grossCzk) },
              { accessor: 'creditableCzk', title: 'Započitatelné', textAlign: 'right', render: (p) => czk(p.creditableCzk) },
              { accessor: 'dueCzk', title: 'Doplatek', textAlign: 'right', render: (p) => (p.finalTaxed ? 'srážka CZ' : czk(p.dueCzk)) },
              { accessor: 'reclaimable', title: 'Vratitelné', textAlign: 'right', render: (p) => (p.reclaimable > 0 ? money(p.reclaimable, p.currency) : '–') },
            ]}
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
