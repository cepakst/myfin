import { Alert, Anchor, Button, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import type { AccountsSnapshot, Snapshot } from '../api';
import { Chart, Section, Stat, tooltipCzk } from '../components';
import { useSetDemo } from '../demo';
import { czk, date, pct, signColor } from '../format';

const monthLabel = (m: string) => `${Number(m.slice(5, 7))}/${m.slice(0, 4)}`;

/** Portfolio value at the end of each month (last daily point of the month) */
function portfolioByMonth(s: Snapshot | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of s?.performance.daily ?? []) out.set(p.date.slice(0, 7), p.value);
  return out;
}

/** Start page: overview of both modules. Each part renders as soon as its data are ready. */
export function HomePage({ s, a }: { s?: Snapshot; a?: AccountsSnapshot }) {
  const setDemo = useSetDemo();
  const hasAccounts = !!a && a.accounts.length > 0;
  const hasInvestments = !!s && s.files.length > 0;
  const accountsCzk = hasAccounts ? a.totals.balanceCzk : 0;
  const portfolio = hasInvestments ? s.performance.total.value : 0;
  const thisMonth = a?.months.at(-1);

  const pByMonth = portfolioByMonth(hasInvestments ? s : undefined);
  const months = [...new Set([...(a?.months.map((m) => m.month) ?? []), ...pByMonth.keys()])].sort();
  const accByMonth = new Map(a?.months.map((m) => [m.month, m.balance]) ?? []);
  let lastP = 0;
  const pSeries = months.map((m) => (lastP = pByMonth.get(m) ?? lastP));
  const startIdx = Math.max(0, months.length - 36);

  const empty = !hasAccounts && !hasInvestments && !!s && !!a;

  // biggest spending categories of the last 12 months (visible accounts)
  const from12 = a?.months.slice(-12)[0]?.month ?? ''; // the same 12 months as the account totals
  const hiddenAcc = new Set(a?.accounts.filter((x) => x.hidden).map((x) => x.id) ?? []);
  const catSums = new Map<string, number>();
  for (const t of a?.txs ?? []) {
    if (t.flow !== 'expense' || !t.category || hiddenAcc.has(t.accountId) || t.date.slice(0, 7) < from12) continue;
    catSums.set(t.category, (catSums.get(t.category) ?? 0) - (t.amountCzk ?? 0));
  }
  const topCats = [...catSums]
    .map(([id, sum]) => ({ id, sum, name: a?.categories.find((c) => c.id === id)?.name ?? id }))
    .sort((x, y) => y.sum - x.sum)
    .slice(0, 3);

  return (
    <Stack>
      {empty && !s.demo && (
        <Alert color="blue" title="Vítejte v aplikaci Myfin" data-testid="home-empty">
          <Group justify="space-between">
            <Text size="sm">
              Zatím tu nejsou žádná data. Uložte exporty od brokerů (Degiro, XTB) a výpisy z účtů (Fio, KB, Raiffeisenbank) do složky s exporty, nebo je nahrajte v{' '}
              <Anchor component={Link} to="/nastaveni">
                Nastavení
              </Anchor>
              .
            </Text>
            <Button variant="light" onClick={() => setDemo(true)}>
              Zobrazit demo data
            </Button>
          </Group>
        </Alert>
      )}
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat
          label="Celkový majetek"
          value={czk(accountsCzk + portfolio)}
          sub={s ? `k ${date(s.today)}` : 'investice se ještě načítají'}
          hint="Zůstatky na bankovních účtech + hodnota investičního portfolia (tržní hodnota pozic v Kč)."
        />
        <Stat label="Na účtech" value={a ? czk(accountsCzk) : '…'} sub={hasAccounts ? `${a.accounts.filter((x) => !x.hidden).length} účtů` : 'bez výpisů'} hint="Součet zůstatků zobrazených bankovních účtů." />
        <Stat
          label="Investice"
          value={s ? czk(portfolio) : '…'}
          sub={hasInvestments ? `zisk ${czk(s.performance.total.pnl)}` : s ? 'bez exportů' : undefined}
          color={undefined}
          hint="Tržní hodnota investičního portfolia. Podrobnosti v modulu Investice."
        />
        <Stat
          label={thisMonth ? `Tento měsíc (${monthLabel(thisMonth.month)})` : 'Tento měsíc'}
          value={thisMonth ? czk(thisMonth.net) : '–'}
          color={signColor(thisMonth?.net)}
          sub={thisMonth ? `příjmy ${czk(thisMonth.income)} · výdaje ${czk(thisMonth.expense)}` : undefined}
          hint="Příjmy minus výdaje na bankovních účtech v aktuálním měsíci (bez převodů mezi vlastními účty a investic)."
        />
      </SimpleGrid>

      {months.length > 1 && (
        <Section title="Vývoj majetku" hint="Zůstatky na účtech a hodnota portfolia ke konci měsíce.">
          <Chart
            height={340}
            option={{
              tooltip: { trigger: 'axis', valueFormatter: tooltipCzk },
              legend: {},
              xAxis: { type: 'category', data: months.map(monthLabel) },
              yAxis: { type: 'value' },
              dataZoom: [{ type: 'inside', startValue: startIdx }, { type: 'slider', startValue: startIdx, height: 18, bottom: 0 }],
              series: [
                { name: 'Účty', type: 'line', stack: 'total', areaStyle: {}, symbol: 'none', data: months.map((m) => Math.round(accByMonth.get(m) ?? 0)) },
                { name: 'Investice', type: 'line', stack: 'total', areaStyle: {}, symbol: 'none', data: pSeries.map((v) => Math.round(v)) },
              ],
            }}
          />
        </Section>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Section title="Účty" right={<Anchor component={Link} to="/ucty" size="sm">Přehled účtů →</Anchor>}>
          {!a ? (
            <Text size="sm" c="dimmed">
              Načítám…
            </Text>
          ) : !hasAccounts ? (
            <Text size="sm" c="dimmed">
              Zatím žádné výpisy z účtů.
            </Text>
          ) : (
            <Stack gap={4}>
              <Text size="sm">
                Příjmy za 12 měsíců: <b>{czk(a.totals.income12m)}</b>
              </Text>
              <Text size="sm">
                Výdaje za 12 měsíců: <b>{czk(a.totals.expense12m)}</b>
              </Text>
              <Text size="sm">
                Míra úspor: <b>{pct(a.totals.savingsRate12m)}</b> · investováno <b>{czk(a.totals.invested12m)}</b>
              </Text>
              {topCats.length > 0 && (
                <Text size="sm">
                  Největší výdaje za 12 měsíců: {topCats.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 && ', '}
                      {c.name} <b>{czk(c.sum)}</b>
                    </span>
                  ))}{' '}
                  <Anchor component={Link} to="/ucty/kategorie" size="sm">
                    (vše)
                  </Anchor>
                </Text>
              )}
            </Stack>
          )}
        </Section>
        <Section title="Investice" right={<Anchor component={Link} to="/investice" size="sm">Přehled investic →</Anchor>}>
          {!s ? (
            <Text size="sm" c="dimmed">
              Načítám…
            </Text>
          ) : !hasInvestments ? (
            <Text size="sm" c="dimmed">
              Zatím žádné exporty od brokerů.
            </Text>
          ) : (
            <Stack gap={4}>
              <Text size="sm">
                Celkový zisk: <b>{czk(s.performance.total.pnl)}</b> (TWR {pct(s.performance.total.twr)})
              </Text>
              <Text size="sm">
                Čistě investováno: <b>{czk(s.performance.total.invested)}</b>
              </Text>
              <Text size="sm">
                Odhad daně {s.taxSummaries.at(-1)?.year}: <b>{czk(s.taxSummaries.at(-1)?.estimatedTaxTotalCzk)}</b>
              </Text>
            </Stack>
          )}
        </Section>
      </SimpleGrid>
    </Stack>
  );
}
