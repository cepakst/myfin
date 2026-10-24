import { Anchor, Grid, Group, SegmentedControl, Select, SimpleGrid, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Snapshot } from '../api';
import { Chart, Section, Stat, tooltipCzk } from '../components';
import { DataGrid } from '../DataGrid';
import { czk, date, num, pct, signColor } from '../format';

type TR = Snapshot['insights']['bestTrades'][number];

const instrumentLink =
  (size: 'xs' | 'sm') =>
  (r: { instrumentId: string; name: string }) => (
    <Anchor component={Link} to={`/instrument/${encodeURIComponent(r.instrumentId)}`} size={size}>
      {r.name}
    </Anchor>
  );

function TradeTable({ rows, label, dir }: { rows: TR[]; label: string; dir: 'asc' | 'desc' }) {
  return (
    <DataGrid
      label={label}
      fz="xs"
      maxHeight={420}
      idAccessor="tradeId"
      records={rows}
      defaultSort={{ column: 'gainCzk', direction: dir }}
      searchPlaceholder="Hledat instrument…"
      columns={[
        { accessor: 'name', title: 'Instrument', render: instrumentLink('xs') },
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

const days = (v: number | null) => (v == null ? '–' : `${Math.round(v)} dní`);

export function InsightsPage({ s }: { s: Snapshot }) {
  const [period, setPeriod] = useState<'all' | 'year'>('all');
  const [year, setYear] = useState(Number(s.today.slice(0, 4)));
  const years = Object.keys(s.insightsByYear ?? {})
    .map(Number)
    .sort((a, b) => b - a);
  const selYear = years.includes(year) ? year : years[0];
  const i = period === 'year' && selYear != null ? s.insightsByYear[selYear] : s.insights;
  // Charts always show the whole horizon; per-year values are what the period selector restricts
  const ys = s.insights.years;
  const periodText = period === 'year' ? `v roce ${selYear}` : 'za celý investiční horizont';

  return (
    <Stack>
      <Group gap="sm">
        <SegmentedControl
          aria-label="Období"
          value={period}
          onChange={(v) => setPeriod(v as 'all' | 'year')}
          data={[
            { value: 'all', label: 'Celý horizont' },
            { value: 'year', label: 'Rok' },
          ]}
        />
        {period === 'year' && (
          <Select
            aria-label="Rok přehledu"
            w={110}
            allowDeselect={false}
            data={years.map(String)}
            value={String(selYear)}
            onChange={(v) => v && setYear(Number(v))}
          />
        )}
        <Text size="sm" c="dimmed">
          Hodnoty {periodText}
        </Text>
      </Group>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat
          label="Ztráty snědly ze zisků"
          value={pct(i.total.eatenRatio)}
          sub={`zisky ${czk(i.total.gainsCzk)} / ztráty ${czk(i.total.lossesCzk)}`}
          hint="Jaký podíl realizovaných zisků z prodejů vymazaly realizované ztráty (ekonomicky, bez ohledu na daně)."
        />
        <Stat
          label="Poplatky / objem obchodů"
          value={pct(i.total.feeToVolume, 2)}
          sub={`${czk(i.total.tradeFeesCzk)} z ${czk(i.total.volumeCzk)}`}
          hint="Obchodní poplatky a transakční daně jako podíl z celkového objemu nákupů a prodejů."
        />
        <Stat
          label="Prům. držení ziskových"
          value={days(i.avgHoldingDaysWinners)}
          hint="Průměrná doba držení prodaných kusů, které skončily ziskem (vážená počtem kusů)."
        />
        <Stat label="Prům. držení ztrátových" value={days(i.avgHoldingDaysLosers)} hint="Průměrná doba držení prodaných kusů, které skončily ztrátou (vážená počtem kusů)." />
        <Stat
          label="Ušlý potenciál (absolutní)"
          value={czk(i.missedTotalCzk)}
          color="orange"
          sub={`uchráněno ${czk(i.avoidedTotalCzk)} · netto ${czk(i.missedNetCzk)}`}
          hint="Kolik by dnes měly navíc prodané kusy, kdybyste je drželi dodnes (součet jen u pozic, které od prodeje vzrostly). „Uchráněno“ je naopak pokles pozic, které jste prodali včas; „netto“ je rozdíl obou."
        />
        <Stat
          label="Ušlý potenciál po reinvestici"
          value={czk(i.missedNetReinvestedCzk)}
          color={i.missedNetReinvestedCzk > 0 ? 'orange' : 'teal'}
          sub={i.missedNetReinvestedCzk > 0 ? 'držení by vyšlo lépe' : 'reinvestice vyšla lépe'}
          hint="Netto rozdíl mezi dnešní hodnotou prodaných kusů a odhadem, kolik by dnes měly peníze z prodeje, pokud zůstaly v portfoliu a vydělávaly jako celé portfolio (časově vážený výnos od data prodeje). Kladné číslo = držet by bylo lepší."
        />
        <Stat label="Dividendy čistě" value={czk(i.total.dividendsNetCzk)} sub={`srážky ${czk(i.total.withholdingCzk)}`} hint="Přijaté dividendy po zahraniční srážkové dani, přepočtené denním kurzem ČNB." />
        <Stat label="Poplatky účtu" value={czk(i.total.accountFeesCzk)} sub="připojení k burzám apod." hint="Poplatky nesouvisející s konkrétním obchodem, např. roční poplatek za připojení k burze." />
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
      <Section title={`Ušlý potenciál – prodané pozice a jejich dnešní hodnota (${period === 'year' ? `prodeje v roce ${selYear}` : 'všechny prodeje'})`}>
        <DataGrid
          label="Ušlý potenciál"
          maxHeight={480}
          idAccessor="instrumentId"
          records={i.missed}
          defaultSort={{ column: 'diffCzk', direction: 'desc' }}
          searchPlaceholder="Hledat instrument, ISIN…"
          columns={[
            { accessor: 'name', title: 'Instrument', searchValue: (m) => `${m.name} ${m.instrumentId}`, render: instrumentLink('sm') },
            { accessor: 'soldQty', title: 'Prodáno ks', textAlign: 'right', render: (m) => num(m.soldQty) },
            { accessor: 'lastSellDate', title: 'Poslední prodej', render: (m) => date(m.lastSellDate) },
            { accessor: 'proceedsCzk', title: 'Utrženo', textAlign: 'right', render: (m) => czk(m.proceedsCzk) },
            { accessor: 'valueTodayCzk', title: 'Hodnota dnes', textAlign: 'right', render: (m) => czk(m.valueTodayCzk) },
            {
              accessor: 'diffCzk',
              title: 'Ušlo (absolutně)',
              textAlign: 'right',
              render: (m) => (
                <Text size="sm" c={m.diffCzk > 0 ? 'orange' : 'teal'}>
                  {czk(m.diffCzk)}
                </Text>
              ),
            },
            { accessor: 'reinvestedValueCzk', title: 'Reinvestice dnes', textAlign: 'right', render: (m) => czk(m.reinvestedValueCzk) },
            {
              accessor: 'diffReinvestedCzk',
              title: 'Ušlo po reinvestici',
              textAlign: 'right',
              render: (m) => (
                <Text size="sm" c={m.diffReinvestedCzk > 0 ? 'orange' : 'teal'}>
                  {czk(m.diffReinvestedCzk)}
                </Text>
              ),
            },
          ]}
        />
        <Text size="xs" c="dimmed" mt={4}>
          Hodnota dnes = prodané kusy (upravené o pozdější splity) × dnešní cena. Reinvestice dnes = čistý výnos z prodeje zhodnocený časově váženým výnosem celého portfolia od data
          prodeje do dneška – odhad pro případ, že peníze zůstaly investované v portfoliu. Jde o přiblížení: výnos portfolia do data prodeje zahrnuje i prodávaný titul a nezohledňuje
          skutečné načasování reinvestic. Kladné hodnoty (oranžově) = držení by vyšlo lépe.
        </Text>
      </Section>
      <Grid>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Nejlepší obchody">
            <TradeTable rows={i.bestTrades} label="Nejlepší obchody" dir="desc" />
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Nejhorší obchody">
            <TradeTable rows={i.worstTrades} label="Nejhorší obchody" dir="asc" />
          </Section>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
