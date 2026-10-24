import { Alert, Anchor, Badge, Button, Grid, Group, List, SimpleGrid, Stack, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import type { Snapshot } from '../api';
import { Chart, Section, Stat, tooltipCzk } from '../components';
import { useSetDemo } from '../demo';
import { czk, date, pct, signColor } from '../format';
import { missingMarketData } from '../marketStatus';

export function OverviewPage({ s }: { s: Snapshot }) {
  const setDemo = useSetDemo();
  const t = s.performance.total;
  const daily = s.performance.daily;
  const fees = s.insights.total.tradeFeesCzk + s.insights.total.accountFeesCzk;
  const curYear = s.performance.years.at(-1);
  const open = s.positions.filter((p) => p.qty > 1e-9);
  const top = open.slice(0, 12);
  const rest = open.slice(12).reduce((a, p) => a + (p.valueCzk ?? 0), 0);
  const curTax = s.taxSummaries.at(-1);
  const missing = missingMarketData(s.instruments);
  const heldIds = new Set(open.map((p) => p.instrumentId));
  const missingHeld = missing.filter((i) => heldIds.has(i.id)).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  const missingOther = missing.length - missingHeld.length;

  return (
    <Stack>
      {!s.demo && s.files.length === 0 && (
        <Alert color="blue" title="Zatím tu nejsou žádné exporty">
          <Group justify="space-between">
            <Text size="sm">
              Nahrajte exporty od brokerů v{' '}
              <Anchor component={Link} to="/nastaveni">
                Nastavení
              </Anchor>
              , nebo si aplikaci nejdřív vyzkoušejte na ukázkových datech.
            </Text>
            <Button variant="light" onClick={() => setDemo(true)}>
              Zobrazit demo data
            </Button>
          </Group>
        </Alert>
      )}
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label="Hodnota portfolia" value={czk(t.value)} sub={`k ${date(s.today)} · ${open.length} pozic`} />
        <Stat label="Celkový zisk" value={czk(t.pnl)} color={signColor(t.pnl)} sub={`čistě investováno ${czk(t.invested)}`} />
        <Stat label="Výnos (TWR) celkem" value={pct(t.twr)} color={signColor(t.twr)} sub={`XIRR ${pct(t.xirr)} p. a.`} />
        <Stat label={`Letos (${curYear?.year})`} value={czk(curYear?.pnl)} color={signColor(curYear?.pnl)} sub={`TWR ${pct(curYear?.twr)}`} />
        <Stat label="Dividendy (čistě)" value={czk(s.insights.total.dividendsNetCzk)} sub={`sraženo ${czk(s.insights.total.withholdingCzk)}`} />
        <Stat label="Poplatky celkem" value={czk(fees)} sub={`${pct(t.pnl > 0 ? fees / t.pnl : null)} zisku`} />
        <Stat label="Realizované zisky / ztráty" value={czk(s.insights.total.gainsCzk - s.insights.total.lossesCzk)} sub={`ztráty snědly ${pct(s.insights.total.eatenRatio)} zisků`} />
        <Stat
          label={`Odhad daně ${curTax?.year}`}
          value={czk(curTax?.estimatedTaxTotalCzk)}
          sub={curTax?.mustFile ? 'přiznání podat' : curTax?.mustFile === false ? 'přiznání není nutné' : ''}
        />
      </SimpleGrid>

      <Section title="Vývoj hodnoty portfolia">
        <Chart
          height={360}
          option={{
            tooltip: { trigger: 'axis', valueFormatter: tooltipCzk },
            legend: { data: ['Hodnota', 'Čistě investováno'] },
            grid: { left: 70, right: 20, top: 40, bottom: 60 },
            xAxis: { type: 'time' },
            yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v / 1e6).toLocaleString('cs-CZ')} M` } },
            dataZoom: [{ type: 'inside' }, { type: 'slider' }],
            series: [
              { name: 'Hodnota', type: 'line', showSymbol: false, sampling: 'lttb', areaStyle: { opacity: 0.15 }, data: daily.map((d) => [d.date, Math.round(d.value)]) },
              { name: 'Čistě investováno', type: 'line', step: 'end', showSymbol: false, sampling: 'lttb', data: daily.map((d) => [d.date, Math.round(d.invested)]) },
            ],
          }}
        />
      </Section>

      <Grid>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Kumulativní výnos (TWR)">
            <Chart
              option={{
                tooltip: { trigger: 'axis', valueFormatter: (v) => pct(Number(v)) },
                grid: { left: 60, right: 20, top: 20, bottom: 30 },
                xAxis: { type: 'time' },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${Math.round(v * 100)} %` } },
                series: [{ type: 'line', showSymbol: false, sampling: 'lttb', areaStyle: { opacity: 0.1 }, data: daily.map((d) => [d.date, d.twr - 1]) }],
              }}
            />
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Rozložení portfolia">
            <Chart
              option={{
                tooltip: { trigger: 'item', valueFormatter: tooltipCzk },
                series: [
                  {
                    type: 'pie',
                    radius: ['40%', '72%'],
                    label: { formatter: '{b}\n{d} %', fontSize: 10 },
                    data: [...top.map((p) => ({ name: p.name.slice(0, 22), value: Math.round(p.valueCzk ?? 0) })), ...(rest > 0 ? [{ name: 'Ostatní', value: Math.round(rest) }] : [])],
                  },
                ],
              }}
            />
          </Section>
        </Grid.Col>
      </Grid>

      {s.tips.length > 0 && (
        <Section title="Tipy" right={<Link to="/optimalizace">Vše →</Link>}>
          <List spacing={4}>
            {s.tips.slice(0, 5).map((tip) => (
              <List.Item key={tip.id}>
                <Group gap={6}>
                  <Badge size="xs" color={tip.severity === 'warning' ? 'orange' : tip.severity === 'success' ? 'teal' : 'blue'}>
                    {tip.severity === 'warning' ? 'pozor' : tip.severity === 'success' ? 'příležitost' : 'info'}
                  </Badge>
                  <Text size="sm">{tip.title}</Text>
                </Group>
              </List.Item>
            ))}
          </List>
        </Section>
      )}

      {missingHeld.length + missingOther > 0 && (
        <Alert color="orange" title={`Instrumenty bez tržních dat: ${missingHeld.length + missingOther}`}>
          <Stack gap={4}>
            <Text size="sm">
              Pro tyto instrumenty se nepodařilo dohledat ověřený symbol Yahoo Finance. Cena se odhaduje z posledního obchodu nebo ocenění brokera, takže hodnota portfolia, výkonnost a ušlý potenciál mohou být nepřesné. Symbol doplníte v{' '}
              <Anchor component={Link} to="/nastaveni" size="sm">
                Nastavení a data
              </Anchor>{' '}
              (pomlčka „-“ = vědomě nepoužívat).
            </Text>
            {missingHeld.length > 0 && (
              <Text size="sm">
                Držené:{' '}
                {missingHeld.map((i, idx) => (
                  <span key={i.id}>
                    {idx > 0 && ', '}
                    <Anchor component={Link} to={`/instrument/${encodeURIComponent(i.id)}`} size="sm">
                      {i.name}
                    </Anchor>
                  </span>
                ))}
              </Text>
            )}
            {missingOther > 0 && (
              <Text size="sm" c="dimmed">
                Další již prodané: {missingOther}
              </Text>
            )}
          </Stack>
        </Alert>
      )}

      {s.warnings.length > 0 && (
        <Alert color="yellow" title="Upozornění k datům">
          <List size="sm">
            {s.warnings.slice(0, 10).map((w, i) => (
              <List.Item key={i}>
                {w.source}: {w.message}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
    </Stack>
  );
}
