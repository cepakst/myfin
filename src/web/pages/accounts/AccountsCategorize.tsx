import { Alert, Anchor, Badge, Button, Group, Progress, Select, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AccountsSnapshot } from '../../api';
import { Section, Stat } from '../../components';
import { czk, date, pct } from '../../format';
import type { CategoryRule } from '../../../core/accounts/categories';
import { AccountsEmpty } from './AccountsOverview';
import { categoryName, categoryOptions, groupAssignment, groupSimilar, plural, useCategorize } from './categoryUi';

type Tx = AccountsSnapshot['txs'][number];

interface Group {
  key: string;
  label: string;
  txs: Tx[];
  sum: number;
  accounts: string[];
  sample?: string;
  last: string;
  suggested?: string;
}

/** Transactions of the counterparty (in the same direction) on the Transakce page */
const groupLink = (g: Group, uncategorized = false) => `/ucty/transakce?protistrana=${encodeURIComponent(g.key)}${uncategorized ? '&kategorie=-' : ''}&obdobi=all`;

function toGroups(txs: Tx[]): Group[] {
  return [...groupSimilar(txs)]
    .map(([key, list]) => ({
      key,
      label: list[0].cpLabel,
      txs: list,
      sum: list.reduce((s, t) => s + (t.amountCzk ?? 0), 0),
      accounts: [...new Set(list.map((t) => t.accountName))],
      sample: list.map((t) => t.message ?? t.note).find(Boolean),
      last: list.map((t) => t.date).sort().at(-1)!,
      suggested: list.find((t) => t.categorySource === 'learned')?.category,
    }))
    .sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum));
}


const PAGE = 40;

/**
 * Work queue for categorisation: uncategorised transactions grouped by counterparty and sorted by
 * their impact, so that a few decisions categorise most of the spending. Each decision creates a
 * rule that also categorises future transactions of the same counterparty.
 */
export function AccountsCategorizePage({ a }: { a: AccountsSnapshot }) {
  const save = useCategorize();
  const [shown, setShown] = useState(PAGE);
  // one decision at a time: a second pick before the answer would create a duplicate rule
  const [busy, setBusy] = useState(false);
  const hidden = useMemo(() => new Set(a.accounts.filter((x) => x.hidden).map((x) => x.id)), [a.accounts]);
  const visible = useMemo(() => a.txs.filter((t) => !hidden.has(t.accountId)), [a.txs, hidden]);
  const open = useMemo(() => toGroups(visible.filter((t) => t.categorySource === 'none')), [visible]);
  const suggestions = useMemo(() => toGroups(visible.filter((t) => t.categorySource === 'learned')), [visible]);
  if (a.accounts.length === 0) return <AccountsEmpty />;

  const c = a.categorization;
  const share = c.expenseTotalCzk > 0 ? c.expenseCategorizedCzk / c.expenseTotalCzk : 1;
  const opts = categoryOptions(a.categories);

  const run = async (assign: Record<string, string | null>, rules: CategoryRule[], message: string) => {
    if (busy) return;
    setBusy(true);
    await save(assign, rules, message);
    setBusy(false);
  };
  const decide = (g: Group, category: string) => {
    const d = groupAssignment(g.txs, category);
    const n = g.txs.length - d.kept;
    void run(d.assign, d.rules, `„${g.label}“: ${n} ${plural(n, 'transakce zařazena', 'transakce zařazeny', 'transakcí zařazeno')} do „${categoryName(a.categories, category)}“`);
  };
  const confirmAll = () => {
    const assign: Record<string, string | null> = {};
    const rules: CategoryRule[] = [];
    for (const g of suggestions) {
      if (!g.suggested) continue;
      const d = groupAssignment(g.txs, g.suggested);
      Object.assign(assign, d.assign);
      rules.push(...d.rules);
    }
    void run(assign, rules, `Potvrzeno: ${suggestions.length} ${plural(suggestions.length, 'návrh', 'návrhy', 'návrhů')}`);
  };

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, md: 3 }}>
        <Stat
          label="Zařazené výdaje"
          value={pct(share, 0)}
          sub={`${czk(c.expenseCategorizedCzk)} z ${czk(c.expenseTotalCzk)}`}
          hint="Podíl výdajů (podle částky), které mají kategorii. Návrhy se počítají až po potvrzení. Převody mezi vlastními účty a investice se nepočítají."
        />
        <Stat label="Nezařazené transakce" value={c.uncategorized.toLocaleString('cs-CZ')} sub={`${open.length} protistran`} hint="Transakce, pro které žádná vrstva automatické kategorizace nenašla kategorii." />
        <Stat label="Návrhy k potvrzení" value={c.suggestions.toLocaleString('cs-CZ')} sub={`${suggestions.length} protistran`} hint="Kategorie odhadnutá podle toho, jak jste dříve ručně zařadili stejnou protistranu." />
      </SimpleGrid>
      <Progress value={share * 100} size="lg" radius="xl" aria-label="Zařazené výdaje" />

      {suggestions.length > 0 && (
        <Section
          title="Návrhy"
          hint="Stejnou protistranu jste dříve zařadili ručně. Potvrzením vznikne pravidlo pro všechny její transakce."
          right={
            <Button size="xs" onClick={confirmAll} loading={busy} data-testid="confirm-all">
              Potvrdit všechny návrhy
            </Button>
          }
        >
          <Table striped>
            <Table.Tbody>
              {suggestions.map((g) => (
                <Table.Tr key={g.key}>
                  <Table.Td>
                    <Anchor component={Link} to={groupLink(g)} size="sm" fw={500} title="Zobrazit transakce protistrany">
                      {g.label}
                    </Anchor>
                    <Text size="xs" c="dimmed">
                      {g.txs.length}× · {czk(g.sum)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="light" color="orange">
                      {categoryName(a.categories, g.suggested ?? '')}
                    </Badge>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Button size="compact-xs" variant="light" disabled={busy} onClick={() => g.suggested && decide(g, g.suggested)}>
                      Potvrdit
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Section>
      )}

      <Section
        title="Nezařazené podle protistrany"
        hint="Seřazeno podle součtu částek – nahoře jsou protistrany, jejichž zařazení nejvíc zpřesní přehled výdajů. Zvolením kategorie se zařadí všechny transakce protistrany a vznikne pravidlo pro budoucí transakce."
        right={
          <Anchor component={Link} to="/ucty/transakce?kategorie=-&obdobi=all" size="sm">
            Zařadit jednotlivě →
          </Anchor>
        }
      >
        {open.length === 0 ? (
          <Alert color="teal" data-testid="all-categorized">
            Všechny transakce jsou zařazené.
          </Alert>
        ) : (
          <Table.ScrollContainer minWidth={720}>
            <Table striped highlightOnHover data-testid="uncategorized-groups">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Protistrana</Table.Th>
                  <Table.Th>Příklad zprávy</Table.Th>
                  <Table.Th ta="right">Počet</Table.Th>
                  <Table.Th ta="right">Součet</Table.Th>
                  <Table.Th>Kategorie</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {open.slice(0, shown).map((g) => (
                  <Table.Tr key={g.key}>
                    <Table.Td>
                      <Anchor component={Link} to={groupLink(g, true)} size="sm" fw={500} title="Zobrazit nezařazené transakce protistrany" data-testid="group-link">
                        {g.label}
                      </Anchor>
                      <Text size="xs" c="dimmed">
                        {g.accounts.join(', ')} · naposledy {date(g.last)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" lineClamp={2}>
                        {g.sample ?? '–'}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">{g.txs.length}</Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" fw={600} c={g.sum >= 0 ? 'teal' : undefined}>
                        {czk(g.sum)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        w={200}
                        data={opts}
                        placeholder="Vybrat kategorii"
                        searchable
                        value={null}
                        disabled={busy}
                        aria-label={`Kategorie pro ${g.label}`}
                        onChange={(v) => v && decide(g, v)}
                        comboboxProps={{ withinPortal: true }}
                      />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        {open.length > shown && (
          <Group justify="center" mt="sm">
            <Button variant="subtle" onClick={() => setShown((n) => n + PAGE)}>
              Zobrazit dalších {Math.min(PAGE, open.length - shown)} z {open.length - shown}
            </Button>
          </Group>
        )}
      </Section>
    </Stack>
  );
}
