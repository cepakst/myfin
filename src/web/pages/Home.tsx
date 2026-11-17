import { Alert, Anchor, Button, Group, SegmentedControl, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AccountsSnapshot, Snapshot } from '../api';
import { Chart, Section, Stat, tooltipCzk } from '../components';
import { useSetDemo } from '../demo';
import { czk, date, pct, signColor } from '../format';
import { accountOpenings, netWorthChange, netWorthSeries } from '../../core/networth';
import { PRODUCT_LABEL, type ProductType } from '../../core/accounts/types';

const monthLabel = (m: string) => `${Number(m.slice(5, 7))}/${m.slice(0, 4)}`;

const ASSET_LABEL: Record<string, string> = { STOCK: 'Akcie', ETF: 'ETF', FUND: 'Fondy', RIGHT: 'Práva', CFD: 'CFD', OTHER: 'Ostatní investice' };

type Period = '1' | '12' | 'all';

/** Start page: net worth across both modules. Each part renders as soon as its data are ready. */
export function HomePage({ s, a }: { s?: Snapshot; a?: AccountsSnapshot }) {
  const setDemo = useSetDemo();
  const [period, setPeriod] = useState<Period>('12');
  const hasAccounts = !!a && a.accounts.some((x) => !x.hidden);
  // net worth needs both modules: until both snapshots are loaded it would jump
  const ready = !!a && !!s;
  const hasInvestments = !!s && s.files.length > 0;
  const empty = !hasAccounts && !hasInvestments && !!s && !!a;

  const series = netWorthSeries(hasAccounts ? a.months : [], hasInvestments ? s.performance.daily : []);
  const flows = hasAccounts ? a.months : [];
  // the current balances (not the month-end of the series) for the headline
  const accountsCzk = hasAccounts ? a.totals.balanceCzk : 0;
  const portfolio = hasInvestments ? s.performance.total.value : 0;
  const openings = hasAccounts ? accountOpenings(a.accounts, a.txs) : [];
  const ch12 = ready ? netWorthChange(series, flows, 12, openings) : null;
  const ch = ready ? netWorthChange(series, flows, period === 'all' ? series.length : Number(period), openings) : null;
  const today = (a?.today ?? s?.today ?? '').slice(0, 7);
  // statements may contain scheduled payments in the future: "this month" is the calendar month
  const thisMonth = a?.months.filter((m) => m.month <= today).at(-1);
  const lastStatement = hasAccounts ? a.accounts.filter((x) => !x.hidden).map((x) => x.lastDate ?? '').sort().at(-1) : undefined;
  const staleStatements = !!lastStatement && !!a && Date.parse(a.today) - Date.parse(lastStatement) > 45 * 86400000;
  const startIdx = Math.max(0, series.length - 36);

  // composition: accounts by product, investments by asset type; negative balances are liabilities
  const parts = new Map<string, number>();
  let liabilities = 0;
  for (const acc of hasAccounts ? a.accounts : []) {
    if (acc.hidden || acc.balanceCzk === null) continue;
    if (acc.balanceCzk < 0) liabilities += acc.balanceCzk;
    else {
      const k = `Účty – ${(PRODUCT_LABEL[acc.product as ProductType] ?? 'ostatní').toLowerCase()}`;
      parts.set(k, (parts.get(k) ?? 0) + acc.balanceCzk);
    }
  }
  for (const p of hasInvestments ? s.positions : []) {
    if (!p.valueCzk || p.valueCzk <= 0) continue;
    const k = ASSET_LABEL[p.type] ?? ASSET_LABEL.OTHER;
    parts.set(k, (parts.get(k) ?? 0) + p.valueCzk);
  }
  const composition = [...parts].filter(([, v]) => v >= 1).sort((x, y) => y[1] - x[1]);

  // biggest spending categories of the last 12 months (visible accounts, same months as the totals)
  const from12 = a?.months.slice(-12)[0]?.month ?? '';
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
  const unrealized = hasInvestments ? s.positions.reduce((sum, p) => sum + (p.unrealizedCzk ?? 0), 0) : 0;
  const dividendsYear = hasInvestments ? s.dividendYears.find((d) => d.year === Number(s.today.slice(0, 4))) : undefined;

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
          label="Čisté jmění"
          value={ready ? czk(accountsCzk + portfolio) : '…'}
          sub={`účty ${a ? czk(accountsCzk) : '…'} · investice ${s ? czk(portfolio) : '…'}`}
          hint="Zůstatky zobrazených bankovních účtů (úvěry se odečítají) + tržní hodnota investičních pozic v Kč. Hotovost ležící u brokera není započtena."
        />
        <Stat
          label={ch12 && series.length <= 12 ? `Změna od ${monthLabel(ch12.from)}` : 'Změna za 12 měsíců'}
          value={ch12 ? czk(ch12.change) : ready ? '–' : '…'}
          color={signColor(ch12?.change)}
          sub={ch12 ? `${pct(ch12.start > 0 ? ch12.change / ch12.start : null)} · od konce ${monthLabel(ch12.from)}` : undefined}
          hint="Rozdíl čistého jmění mezi koncem měsíce před rokem a dneškem. Rozpad najdete níže v části „Co změnilo majetek“."
        />
        <Stat
          label="Ušetřeno za 12 měsíců"
          value={hasAccounts ? czk(a.totals.income12m - a.totals.expense12m) : '–'}
          color={signColor(hasAccounts ? a.totals.income12m - a.totals.expense12m : undefined)}
          sub={hasAccounts ? `míra úspor ${pct(a.totals.savingsRate12m)}` : a ? 'bez výpisů z účtů' : undefined}
          hint="Příjmy minus výdaje na bankovních účtech za posledních 12 měsíců (bez převodů mezi vlastními účty a investic)."
        />
        <Stat
          label={thisMonth ? `Tento měsíc (${monthLabel(thisMonth.month)})` : 'Tento měsíc'}
          value={thisMonth ? czk(thisMonth.net) : '–'}
          color={signColor(thisMonth?.net)}
          sub={thisMonth ? `příjmy ${czk(thisMonth.income)} · výdaje ${czk(thisMonth.expense)}` : undefined}
          hint="Příjmy minus výdaje na bankovních účtech v aktuálním měsíci (bez převodů mezi vlastními účty a investic)."
        />
      </SimpleGrid>

      {ready && series.length > 1 && (
        <Section title="Vývoj čistého jmění" hint="Zůstatky na účtech a hodnota investičních pozic ke konci měsíce (aktuální měsíc k dnešku).">
          <Chart
            height={340}
            option={{
              tooltip: { trigger: 'axis', valueFormatter: tooltipCzk },
              legend: {},
              xAxis: { type: 'category', data: series.map((p) => monthLabel(p.month)) },
              yAxis: { type: 'value' },
              dataZoom: [{ type: 'inside', startValue: startIdx }, { type: 'slider', startValue: startIdx, height: 18, bottom: 0 }],
              series: [
                { name: 'Účty', type: 'line', stack: 'total', areaStyle: {}, symbol: 'none', data: series.map((p) => Math.round(p.accounts)) },
                { name: 'Investice', type: 'line', stack: 'total', areaStyle: {}, symbol: 'none', data: series.map((p) => Math.round(p.investments)) },
                { name: 'Vloženo do investic', type: 'line', symbol: 'none', lineStyle: { type: 'dashed', width: 1 }, data: series.map((p) => Math.round(p.invested)) },
              ],
            }}
          />
        </Section>
      )}

      {(ch || composition.length > 0) && (
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          {ch && (
            <Section
              title="Co změnilo majetek"
              hint="Změna čistého jmění rozdělená na peníze ušetřené z příjmů, zhodnocení investic a zbytek."
              right={
                <SegmentedControl
                  size="xs"
                  value={period}
                  onChange={(v) => setPeriod(v as Period)}
                  data={[
                    { value: '1', label: 'Tento měsíc' },
                    { value: '12', label: '12 měsíců' },
                    { value: 'all', label: 'Vše' },
                  ]}
                  aria-label="Období změny"
                />
              }
            >
              <Table data-testid="networth-change">
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td>Čisté jmění na konci {monthLabel(ch.from)}</Table.Td>
                    <Table.Td ta="right">{czk(ch.start)}</Table.Td>
                  </Table.Tr>
                  <ChangeRow label="Ušetřeno z příjmů" value={ch.saved} hint="Příjmy minus výdaje na bankovních účtech v období." />
                  <ChangeRow label="Zhodnocení investic" value={ch.marketGain} hint="Změna rozdílu mezi tržní hodnotou pozic a vloženým kapitálem – pohyb cen a kurzů a poplatky za obchody." />
                  {Math.abs(ch.investedElsewhere) >= 1 && (
                    <ChangeRow
                      label="Investováno z jiných zdrojů"
                      value={ch.investedElsewhere}
                      hint="Kapitál vložený do investic, který brokerům neposlaly sledované bankovní účty (vklady z jiných účtů, reinvestované dividendy). Záporná hodnota znamená peníze poslané brokerovi, které zatím leží nezainvestované."
                    />
                  )}
                  {Math.abs(ch.newAccounts) >= 1 && (
                    <ChangeRow
                      label="Nově přidané účty"
                      value={ch.newAccounts}
                      hint="Počáteční zůstatky účtů, jejichž výpisy začínají až v tomto období. Nejde o skutečnou změnu majetku – jen o data, která aplikace dřív neměla."
                    />
                  )}
                  <ChangeRow
                    label="Ostatní"
                    value={ch.other}
                    hint="Zbytek: převody na účty mimo přehled (neznámé nebo skryté) a z nich, výběry od brokera, kurzové rozdíly účtů v cizí měně a odhadnuté zůstatky."
                  />
                  <Table.Tr>
                    <Table.Td fw={600}>Dnes</Table.Td>
                    <Table.Td ta="right" fw={600}>
                      {czk(ch.end)}{' '}
                      <Text span size="sm" c={signColor(ch.change)}>
                        ({ch.change >= 0 ? '+' : ''}
                        {czk(ch.change)})
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            </Section>
          )}
          {composition.length > 0 && (
            <Section title="Složení majetku" hint="Kladné zůstatky účtů podle typu produktu a investice podle druhu cenného papíru; podíly jsou z hrubého majetku (bez závazků).">
              <Chart
                height={260}
                option={{
                  tooltip: { trigger: 'item', valueFormatter: tooltipCzk },
                  series: [{ type: 'pie', radius: ['45%', '75%'], data: composition.map(([name, value]) => ({ name, value: Math.round(value) })), label: { formatter: '{b}\n{d} %' } }],
                }}
              />
              {liabilities < 0 && (
                <Text size="sm" c="dimmed">
                  Závazky (záporné zůstatky účtů): {czk(liabilities)}
                </Text>
              )}
            </Section>
          )}
        </SimpleGrid>
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
                Zůstatek: <b>{czk(accountsCzk)}</b> · účtů: {a.accounts.filter((x) => !x.hidden).length}
              </Text>
              <Text size="sm">
                Za 12 měsíců: příjmy <b>{czk(a.totals.income12m)}</b> · výdaje <b>{czk(a.totals.expense12m)}</b> · investováno <b>{czk(a.totals.invested12m)}</b>
              </Text>
              {topCats.length > 0 && (
                <Text size="sm">
                  Největší výdaje za 12 měsíců:{' '}
                  {topCats.map((c, i) => (
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
              {a.categorization.uncategorized > 0 && (
                <Text size="sm">
                  Nezařazených transakcí: {a.categorization.uncategorized}{' '}
                  <Anchor component={Link} to="/ucty/zaradit" size="sm">
                    Zařadit →
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
                Hodnota: <b>{czk(portfolio)}</b> k {date(s.today)} · čistě vloženo <b>{czk(s.performance.total.invested)}</b>
              </Text>
              <Text size="sm">
                Celkový zisk: <b>{czk(s.performance.total.pnl)}</b> (TWR {pct(s.performance.total.twr)}) · nerealizovaný <b>{czk(unrealized)}</b>
              </Text>
              {dividendsYear && (
                <Text size="sm">
                  Dividendy {dividendsYear.year} (čistě): <b>{czk(dividendsYear.netCzk)}</b>
                </Text>
              )}
              {s.taxSummaries.length > 0 && (
                <Text size="sm">
                  Odhad daně {s.taxSummaries.at(-1)!.year}: <b>{czk(s.taxSummaries.at(-1)!.estimatedTaxTotalCzk)}</b>
                </Text>
              )}
            </Stack>
          )}
        </Section>
      </SimpleGrid>
      {staleStatements && (
        <Text size="xs" c="dimmed" data-testid="stale-statements">
          Poslední pohyb na účtech je z {date(lastStatement)} – zůstatky účtů mohou být neaktuální. Nahrajte novější výpisy.
        </Text>
      )}
    </Stack>
  );
}

function ChangeRow({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm" title={hint}>
          {value >= 0 ? '+ ' : '− '}
          {label}
        </Text>
      </Table.Td>
      <Table.Td ta="right">
        <Text size="sm" c={signColor(value)}>
          {czk(Math.abs(value))}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}
