import { Anchor, Grid, SimpleGrid, Stack, Text } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { Link } from 'react-router-dom';
import type { Snapshot } from '../api';
import { Chart, Section, Stat, tooltipCzk } from '../components';
import { czk, date, num, pct, signColor } from '../format';

type TR = Snapshot['insights']['bestTrades'][number];

function TradeTable({ rows }: { rows: TR[] }) {
  return (
    <DataTable
      withTableBorder
      fz="xs"
      idAccessor="tradeId"
      records={rows}
      columns={[
        {
          accessor: 'name',
          title: 'Instrument',
          render: (r) => (
            <Anchor component={Link} to={`/instrument/${encodeURIComponent(r.instrumentId)}`} size="xs">
              {r.name}
            </Anchor>
          ),
        },
        { accessor: 'sellDate', title: 'Prodej', render: (r) => date(r.sellDate) },
        { accessor: 'holdingDays', title: 'Drženo', textAlign: 'right', render: (r) => `${Math.round(r.holdingDays)} d` },
        {
          accessor: 'gainCzk',
          title: 'Zisk',
          textAlign: 'right',
          render: (r) => (
            <Text size="xs" c={signColor(r.gainCzk)}>
              {czk(r.gainCzk)} ({pct(r.gainPct)})
            </Text>
          ),
        },
      ]}
    />
  );
}

export function InsightsPage({ s }: { s: Snapshot }) {
  const i = s.insights;
  const ys = i.years;
  return (
    <Stack>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label="Ztráty snědly ze zisků" value={pct(i.total.eatenRatio)} sub={`zisky ${czk(i.total.gainsCzk)} / ztráty ${czk(i.total.lossesCzk)}`} />
        <Stat label="Ušlý potenciál" value={czk(i.missedTotalCzk)} color="orange" sub="kdybyste prodané akcie drželi dodnes" />
        <Stat label="Uchráněno prodejem" value={czk(i.avoidedTotalCzk)} color="teal" sub="prodané akcie od té doby klesly" />
        <Stat label="Poplatky / objem obchodů" value={pct(i.total.feeToVolume, 2)} sub={`${czk(i.total.tradeFeesCzk)} z ${czk(i.total.volumeCzk)}`} />
        <Stat label="Prům. držení ziskových" value={i.avgHoldingDaysWinners == null ? '–' : `${Math.round(i.avgHoldingDaysWinners)} dní`} />
        <Stat label="Prům. držení ztrátových" value={i.avgHoldingDaysLosers == null ? '–' : `${Math.round(i.avgHoldingDaysLosers)} dní`} />
        <Stat label="Dividendy čistě" value={czk(i.total.dividendsNetCzk)} sub={`srážky ${czk(i.total.withholdingCzk)}`} />
        <Stat label="Poplatky účtu" value={czk(i.total.accountFeesCzk)} sub="připojení k burzám apod." />
      </SimpleGrid>
      <Grid>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Realizované zisky vs. ztráty">
            <Chart
              option={{
                tooltip: { trigger: 'axis', valueFormatter: tooltipCzk },
                legend: {},
                grid: { left: 70, right: 50, top: 40, bottom: 30 },
                xAxis: { type: 'category', data: ys.map((y) => String(y.year)) },
                yAxis: [{ type: 'value' }, { type: 'value', axisLabel: { formatter: (v: number) => `${Math.round(v * 100)} %` }, splitLine: { show: false } }],
                series: [
                  { name: 'Zisky', type: 'bar', data: ys.map((y) => Math.round(y.gainsCzk)), itemStyle: { color: '#12b886' } },
                  { name: 'Ztráty', type: 'bar', data: ys.map((y) => -Math.round(y.lossesCzk)), itemStyle: { color: '#fa5252' } },
                  { name: 'Úspěšnost obchodů', type: 'line', yAxisIndex: 1, data: ys.map((y) => y.winRate), tooltip: { valueFormatter: (v) => pct(Number(v)) } },
                ],
              }}
            />
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Poplatky po letech">
            <Chart
              option={{
                tooltip: { trigger: 'axis', valueFormatter: tooltipCzk },
                legend: {},
                grid: { left: 70, right: 20, top: 40, bottom: 30 },
                xAxis: { type: 'category', data: ys.map((y) => String(y.year)) },
                yAxis: { type: 'value' },
                series: [
                  { name: 'Obchodní poplatky a daně z transakcí', type: 'bar', stack: 'f', data: ys.map((y) => Math.round(y.tradeFeesCzk)) },
                  { name: 'Poplatky účtu', type: 'bar', stack: 'f', data: ys.map((y) => Math.round(y.accountFeesCzk)) },
                ],
              }}
            />
          </Section>
        </Grid.Col>
      </Grid>
      <Section title="Ušlý potenciál – prodané pozice a jejich dnešní hodnota">
        <DataTable
          withTableBorder
          striped
          fz="sm"
          maxHeight={420}
          idAccessor="instrumentId"
          records={i.missed}
          columns={[
            {
              accessor: 'name',
              title: 'Instrument',
              render: (m) => (
                <Anchor component={Link} to={`/instrument/${encodeURIComponent(m.instrumentId)}`} size="sm">
                  {m.name}
                </Anchor>
              ),
            },
            { accessor: 'soldQty', title: 'Prodáno ks', textAlign: 'right', render: (m) => num(m.soldQty) },
            { accessor: 'lastSellDate', title: 'Poslední prodej', render: (m) => date(m.lastSellDate) },
            { accessor: 'proceedsCzk', title: 'Utrženo', textAlign: 'right', render: (m) => czk(m.proceedsCzk) },
            { accessor: 'valueTodayCzk', title: 'Hodnota dnes', textAlign: 'right', render: (m) => czk(m.valueTodayCzk) },
            {
              accessor: 'diffCzk',
              title: 'Rozdíl',
              textAlign: 'right',
              render: (m) => (
                <Text size="sm" c={m.diffCzk > 0 ? 'orange' : 'teal'}>
                  {czk(m.diffCzk)}
                </Text>
              ),
            },
          ]}
        />
        <Text size="xs" c="dimmed" mt={4}>
          Hodnota dnes = prodané kusy (upravené o pozdější splity) × dnešní cena. Nezohledňuje, kam byly peníze z prodeje reinvestovány.
        </Text>
      </Section>
      <Grid>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Nejlepší obchody">
            <TradeTable rows={i.bestTrades} />
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Nejhorší obchody">
            <TradeTable rows={i.worstTrades} />
          </Section>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
