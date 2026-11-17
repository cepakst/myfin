import { Alert, Anchor, Badge, Button, Group, List, SegmentedControl, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AccountsSnapshot } from '../../api';
import { Chart, Section, Stat, tooltipCzk, WithHint } from '../../components';
import { useSetDemo } from '../../demo';
import { czk, date, money, pct, signColor } from '../../format';
import { PRODUCT_LABEL, type ProductType } from '../../../core/accounts/types';

type Account = AccountsSnapshot['accounts'][number];
type GroupBy = 'account' | 'bank' | 'product';

const monthLabel = (m: string) => `${Number(m.slice(5, 7))}/${m.slice(0, 4)}`;

function groupKey(a: Account, by: GroupBy): string {
  if (by === 'bank') return a.bankName;
  if (by === 'product') return PRODUCT_LABEL[a.product as ProductType];
  return a.displayName;
}

export function AccountsEmpty() {
  const setDemo = useSetDemo();
  return (
    <Alert color="blue" title="Zatím tu nejsou žádné výpisy z účtů" data-testid="accounts-empty">
      <Group justify="space-between">
        <Text size="sm">
          Uložte výpisy ve formátu CSV z Fio banky nebo Komerční banky, pohyby v CSV nebo PDF výpisy z Raiffeisenbank do složky s exporty (například do podsložek <code>fio</code>, <code>kb</code>, <code>rb</code>), nebo
          je nahrajte v{' '}
          <Anchor component={Link} to="/nastaveni">
            Nastavení
          </Anchor>
          . Aplikaci si můžete vyzkoušet i na ukázkových datech.
        </Text>
        <Button variant="light" onClick={() => setDemo(true)}>
          Zobrazit demo data
        </Button>
      </Group>
    </Alert>
  );
}

export function AccountsOverviewPage({ a }: { a: AccountsSnapshot }) {
  const [by, setBy] = useState<GroupBy>('account');
  if (a.accounts.length === 0) return <AccountsEmpty />;
  const visible = a.accounts.filter((x) => !x.hidden);
  const months = a.months.map((m) => m.month);

  // stacked month-end balances per group (CZK)
  const groups = new Map<string, number[]>();
  for (const acc of visible) {
    const k = groupKey(acc, by);
    const arr = groups.get(k) ?? months.map(() => 0);
    acc.monthly.forEach((m, i) => (arr[i] += m.balanceCzk ?? 0));
    groups.set(k, arr);
  }
  const startIdx = Math.max(0, months.length - 36);
  const flows = a.months.slice(-24);
  const t = a.totals;

  return (
    <Stack>
      <SimpleGrid cols={{ base: 2, md: 5 }}>
        <Stat
          label="Zůstatek na účtech"
          value={czk(t.balanceCzk)}
          sub={`${visible.length} účtů · k ${date(visible[0]?.balanceDate ?? a.today)}`}
          hint="Součet zůstatků všech zobrazených účtů. Účty v cizí měně jsou přepočtené denním kurzem ČNB. Skryté účty (Nastavení) se nezapočítávají."
        />
        <Stat label="Příjmy (12 měsíců)" value={czk(t.income12m)} color="teal" hint="Příchozí platby za posledních 12 měsíců bez převodů mezi vlastními účty." />
        <Stat label="Výdaje (12 měsíců)" value={czk(t.expense12m)} color="red" hint="Odchozí platby za posledních 12 měsíců bez převodů mezi vlastními účty a bez peněz poslaných na investice." />
        <Stat
          label="Míra úspor"
          value={pct(t.savingsRate12m)}
          color={signColor(t.savingsRate12m)}
          sub={`ušetřeno ${czk(t.income12m - t.expense12m)}`}
          hint="(Příjmy − výdaje) / příjmy za posledních 12 měsíců. Peníze poslané na investice se do výdajů nepočítají – jsou to úspory."
        />
        <Stat label="Investováno (12 měsíců)" value={czk(t.invested12m)} hint="Čisté převody na investiční účty (brokeři a účty označené v Nastavení jako investiční) za posledních 12 měsíců." />
      </SimpleGrid>

      {(a.categorization.uncategorized > 0 || a.categorization.suggestions > 0) && (
        <Alert color="blue" data-testid="categorize-hint">
          <Group justify="space-between">
            <Text size="sm">
              Zařazeno {pct(a.categorization.expenseTotalCzk > 0 ? a.categorization.expenseCategorizedCzk / a.categorization.expenseTotalCzk : 1, 0)} výdajů. Nezařazených transakcí:{' '}
              {a.categorization.uncategorized}
              {a.categorization.suggestions > 0 ? `, návrhů k potvrzení: ${a.categorization.suggestions}` : ''}.
            </Text>
            <Button component={Link} to="/ucty/zaradit" size="xs" variant="light">
              Zařadit
            </Button>
          </Group>
        </Alert>
      )}

      <Section title="Účty" hint="Zůstatek k poslednímu dni s daty. U účtů, jejichž export zůstatek neobsahuje (Raiffeisenbank bez PDF výpisů), zadejte aktuální zůstatek v Nastavení.">
        <Table.ScrollContainer minWidth={640}>
          <Table striped highlightOnHover data-testid="accounts-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Účet</Table.Th>
                <Table.Th>Banka</Table.Th>
                <Table.Th>Produkt</Table.Th>
                <Table.Th ta="right">Zůstatek</Table.Th>
                <Table.Th ta="right">Pohybů</Table.Th>
                <Table.Th>Poslední pohyb</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {a.accounts.map((acc) => (
                <Table.Tr key={acc.id} opacity={acc.hidden ? 0.5 : 1}>
                  <Table.Td>
                    <Anchor component={Link} to={`/ucty/transakce?ucet=${encodeURIComponent(acc.id)}`} size="sm">
                      {acc.displayName}
                    </Anchor>
                    <Text size="xs" c="dimmed">
                      {acc.id}
                      {acc.hidden ? ' · skrytý' : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td>{acc.bankName}</Table.Td>
                  <Table.Td>{PRODUCT_LABEL[acc.product as ProductType]}</Table.Td>
                  <Table.Td ta="right">
                    <Group gap={6} justify="flex-end" wrap="nowrap">
                      {!acc.anchored && acc.txCount > 0 && (
                        <WithHint label="Export neobsahuje zůstatek – zobrazen je součet pohybů od nuly. Aktuální zůstatek zadejte v Nastavení.">
                          <Badge color="orange" variant="light" size="xs">
                            odhad
                          </Badge>
                        </WithHint>
                      )}
                      <Text size="sm" fw={600}>
                        {acc.currency === 'CZK' ? czk(acc.balance) : money(acc.balance, acc.currency)}
                      </Text>
                    </Group>
                    {acc.currency !== 'CZK' && (
                      <Text size="xs" c="dimmed">
                        {czk(acc.balanceCzk)}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td ta="right">{acc.txCount}</Table.Td>
                  <Table.Td>{date(acc.lastDate)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Section>

      <Section
        title="Zůstatky v čase"
        hint="Zůstatky ke konci měsíce v Kč. Vychází ze zůstatků uvedených ve výpisech (nebo zadaných v Nastavení) a z pohybů mezi nimi."
        right={
          <SegmentedControl
            size="xs"
            value={by}
            onChange={(v) => setBy(v as GroupBy)}
            data={[
              { value: 'account', label: 'Účty' },
              { value: 'bank', label: 'Banky' },
              { value: 'product', label: 'Produkty' },
            ]}
            aria-label="Seskupit podle"
          />
        }
      >
        <Chart
          height={340}
          option={{
            tooltip: { trigger: 'axis', valueFormatter: tooltipCzk },
            legend: {},
            xAxis: { type: 'category', data: months.map(monthLabel) },
            yAxis: { type: 'value' },
            dataZoom: [{ type: 'inside', startValue: startIdx }, { type: 'slider', startValue: startIdx, height: 18, bottom: 0 }],
            series: [...groups].map(([name, data]) => ({ name, type: 'line', stack: 'total', areaStyle: {}, symbol: 'none', data: data.map((v) => Math.round(v)) })),
          }}
        />
      </Section>

      <Section title="Příjmy a výdaje po měsících" hint="Bez převodů mezi vlastními účty. Peníze poslané na investice jsou zobrazené zvlášť.">
        <Chart
          height={320}
          option={{
            tooltip: { trigger: 'axis', valueFormatter: tooltipCzk },
            legend: {},
            xAxis: { type: 'category', data: flows.map((m) => monthLabel(m.month)) },
            yAxis: { type: 'value' },
            series: [
              { name: 'Příjmy', type: 'bar', data: flows.map((m) => Math.round(m.income)), itemStyle: { color: '#12b886' } },
              { name: 'Výdaje', type: 'bar', data: flows.map((m) => Math.round(m.expense)), itemStyle: { color: '#fa5252' } },
              { name: 'Investováno', type: 'bar', data: flows.map((m) => Math.round(m.invested)), itemStyle: { color: '#4c6ef5' } },
              { name: 'Ušetřeno', type: 'line', data: flows.map((m) => Math.round(m.net)), itemStyle: { color: '#868e96' } },
            ],
          }}
        />
      </Section>

      {a.warnings.length > 0 && (
        <Alert color="yellow" title={`Upozornění (${a.warnings.length})`} data-testid="accounts-warnings">
          <List size="sm">
            {a.warnings.slice(0, 30).map((w, i) => (
              <List.Item key={i}>
                <b>{w.source}:</b> {w.message}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
    </Stack>
  );
}
