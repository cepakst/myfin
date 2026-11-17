import { Badge, Center, Group, Loader, MultiSelect, Select, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core';
import { useDeferredValue, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AccountsSnapshot } from '../../api';
import { Stat } from '../../components';
import { DataGrid } from '../../DataGrid';
import { czk, date, money, signColor } from '../../format';
import { PRODUCT_LABEL, type ProductType } from '../../../core/accounts/types';
import { AccountsEmpty } from './AccountsOverview';
import { categoryName, categoryOptions, groupSimilar, similarKey, TxCategorySelect, UNCAT_LABEL, useTxPicker } from './categoryUi';
import { DEFAULT_PERIOD, monthLabel, periodMonths, periodOptions } from './period';

/** rows rendered at once: thousands of rows with category buttons made the page slow */
const PAGE_SIZE = 100;

type Tx = AccountsSnapshot['txs'][number];

export const FLOW_LABEL: Record<Tx['flow'], string> = { income: 'Příjem', expense: 'Výdaj', transfer: 'Převod mezi účty', investment: 'Investice' };
const FLOW_COLOR: Record<Tx['flow'], string> = { income: 'teal', expense: 'red', transfer: 'gray', investment: 'indigo' };
const FLOW_HINT: Record<Tx['flow'], string> = {
  income: 'Příchozí platba, která není převodem z vlastního účtu.',
  expense: 'Odchozí platba, která není převodem na vlastní ani investiční účet.',
  transfer: 'Převod mezi vlastními účty (protiúčet je jeden z importovaných účtů nebo účet označený v Nastavení jako vlastní). Do příjmů ani výdajů se nepočítá.',
  investment: 'Převod na investiční účet (broker nebo účet označený v Nastavení jako investiční). Počítá se jako úspora, ne jako výdaj.',
};

/** Counterparty shown in the list: merchant, name, or account number */
function counterparty(t: Tx): string {
  return t.merchant ?? t.cpName ?? t.cpAccount ?? '';
}

function description(t: Tx): string {
  return [t.message, t.note].filter(Boolean).join(' · ');
}

export function AccountsTransactionsPage({ a }: { a: AccountsSnapshot }) {
  const [params, setParams] = useSearchParams();
  const ucet = params.getAll('ucet').join('|');
  const accountFilter = useMemo(() => (ucet ? ucet.split('|') : []), [ucet]);
  const kat = params.getAll('kategorie').join('|');
  const catFilter = useMemo(() => (kat ? kat.split('|').map((c) => (c === '-' ? '' : c)) : []), [kat]);
  const month = params.get('mesic') ?? '';
  // a month picked elsewhere (link from Výdaje a příjmy) is narrower than any period
  // an unknown period (old bookmark, year without data) falls back to the default
  const wanted = params.get('obdobi') ?? DEFAULT_PERIOD;
  const period = periodOptions(a).some((o) => o.value === wanted) ? wanted : DEFAULT_PERIOD;
  // "all" has no date limit (transactions dated after today included)
  const months = useMemo(() => (period === 'all' ? null : new Set(periodMonths(a, period))), [a, period]);
  // one counterparty in one direction (link from Zařadit)
  const cp = params.get('protistrana') ?? '';
  const [banks, setBanks] = useState<string[]>([]);
  const [products, setProducts] = useState<string[]>([]);
  const accById = useMemo(() => new Map(a.accounts.map((x) => [x.id, x])), [a.accounts]);
  const groups = useMemo(() => groupSimilar(a.txs), [a.txs]);
  const picker = useTxPicker(a, groups);

  const rows = useMemo(
    () =>
      a.txs
        .filter((t) => !accountFilter.length || accountFilter.includes(t.accountId))
        .filter((t) => !banks.length || banks.includes(t.bank))
        .filter((t) => !products.length || products.includes(accById.get(t.accountId)?.product ?? ''))
        .filter((t) => !catFilter.length || catFilter.includes(t.category))
        .filter((t) => (month ? t.date.startsWith(month) : !months || months.has(t.date.slice(0, 7))))
        .filter((t) => !cp || similarKey(t) === cp)
        .map((t) => ({ ...t, counterparty: counterparty(t), description: description(t), flowLabel: FLOW_LABEL[t.flow], categoryName: categoryName(a.categories, t.category) })),
    [a.txs, a.categories, accountFilter, banks, products, accById, catFilter, month, months, cp],
  );
  // the table renders in the background: a spinner on entry, an overlay while filters change
  const shownRows = useDeferredValue<typeof rows | null>(rows, null);
  const cpLabel = useMemo(() => (cp ? a.txs.find((t) => similarKey(t) === cp)?.cpLabel : undefined), [a.txs, cp]);
  if (a.accounts.length === 0) return <AccountsEmpty />;
  const setParam = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    p.delete(key);
    if (value !== null) p.set(key, value);
    setParams(p, { replace: true });
  };

  // like the overview: hidden accounts stay in the list but not in the totals
  const sumBy = (f: Tx['flow']) => rows.filter((r) => r.flow === f && !accById.get(r.accountId)?.hidden).reduce((s, r) => s + (r.amountCzk ?? 0), 0);
  const productsPresent = [...new Set(a.accounts.map((x) => x.product))];

  return (
    <Stack>
      {picker.modal}
      <Group align="flex-end">
        <MultiSelect
          label="Účty"
          placeholder={accountFilter.length ? undefined : 'Všechny účty'}
          data={a.accounts.map((x) => ({ value: x.id, label: `${x.displayName} (${x.bankName})` }))}
          value={accountFilter}
          onChange={(v) => {
            const p = new URLSearchParams(params);
            p.delete('ucet');
            for (const id of v) p.append('ucet', id);
            setParams(p, { replace: true });
          }}
          clearable
          w={360}
          data-testid="filter-accounts"
        />
        <MultiSelect
          label="Banky"
          placeholder={banks.length ? undefined : 'Všechny banky'}
          data={[...new Set(a.accounts.map((x) => x.bank))].map((b) => ({ value: b, label: a.accounts.find((x) => x.bank === b)!.bankName }))}
          value={banks}
          onChange={setBanks}
          clearable
          w={240}
        />
        <MultiSelect
          label="Produkty"
          placeholder={products.length ? undefined : 'Všechny produkty'}
          data={productsPresent.map((p) => ({ value: p, label: PRODUCT_LABEL[p as ProductType] }))}
          value={products}
          onChange={setProducts}
          clearable
          w={240}
        />
        <MultiSelect
          label="Kategorie"
          placeholder={catFilter.length ? undefined : 'Všechny kategorie'}
          data={[{ group: 'Bez kategorie', items: [{ value: '-', label: UNCAT_LABEL }] }, ...categoryOptions(a.categories)]}
          value={catFilter.map((c) => c || '-')}
          onChange={(v) => {
            const p = new URLSearchParams(params);
            p.delete('kategorie');
            for (const c of v) p.append('kategorie', c);
            setParams(p, { replace: true });
          }}
          clearable
          searchable
          w={260}
          data-testid="filter-categories"
        />
        {month ? (
          <Badge size="lg" variant="light" style={{ cursor: 'pointer' }} onClick={() => setParam('mesic', null)} title="Zrušit výběr měsíce">
            {monthLabel(month)} ✕
          </Badge>
        ) : (
          <Select
            label="Období"
            w={220}
            data={periodOptions(a)}
            value={period}
            onChange={(v) => v && setParam('obdobi', v === DEFAULT_PERIOD ? null : v)}
            allowDeselect={false}
            data-testid="filter-period"
          />
        )}
        {cp && (
          <Badge size="lg" variant="light" color="grape" style={{ cursor: 'pointer' }} onClick={() => setParam('protistrana', null)} title="Zrušit výběr protistrany" data-testid="filter-counterparty">
            {cp.startsWith('in|') ? 'Od' : 'Pro'}: {cpLabel ?? '?'} ✕
          </Badge>
        )}
      </Group>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label="Pohybů" value={rows.length.toLocaleString('cs-CZ')} hint="Počet pohybů odpovídajících filtrům nad tabulkou (bez fulltextového hledání)." />
        <Stat label="Příjmy" value={czk(sumBy('income'))} color="teal" hint={FLOW_HINT.income} />
        <Stat label="Výdaje" value={czk(-sumBy('expense'))} color="red" hint={FLOW_HINT.expense} />
        <Stat label="Na investice" value={czk(-sumBy('investment'))} hint={FLOW_HINT.investment} />
      </SimpleGrid>
      {shownRows === null ? (
        <Center h={240}>
          <Loader data-testid="transactions-loading" />
        </Center>
      ) : (
      <DataGrid
        label="Transakce"
        records={shownRows}
        pageSize={PAGE_SIZE}
        // new filters start on page 1; a category change (new snapshot) keeps the page
        pageResetKey={[ucet, kat, month, period, cp, banks.join(','), products.join(',')].join('|')}
        fetching={shownRows !== rows}
        idAccessor="key"
        defaultSort={{ column: 'date', direction: 'desc' }}
        maxHeight={640}
        searchPlaceholder="Hledat protistranu, zprávu, VS…"
        columns={[
          { accessor: 'date', title: 'Datum', render: (r) => date(r.date), width: 110 },
          { accessor: 'accountName', title: 'Účet', filterable: true },
          {
            accessor: 'counterparty',
            title: 'Protistrana',
            render: (r) => (
              <Stack gap={0}>
                <Text size="sm">{r.counterparty || '–'}</Text>
                {r.merchant && r.cpName && r.cpName !== r.merchant && (
                  <Text size="xs" c="dimmed">
                    {r.cpName}
                  </Text>
                )}
                {r.cpAccount && r.counterparty !== r.cpAccount && (
                  <Text size="xs" c="dimmed">
                    {r.cpAccount}
                  </Text>
                )}
              </Stack>
            ),
            searchValue: (r) => [r.counterparty, r.cpName, r.cpAccount, r.city, r.vs].filter(Boolean).join(' '),
          },
          {
            accessor: 'description',
            title: 'Popis',
            render: (r) => (
              <Text size="xs" lineClamp={2} title={r.description}>
                {r.description || '–'}
              </Text>
            ),
          },
          {
            accessor: 'categoryName',
            title: 'Kategorie',
            hint: 'Kategorii určuje (v tomto pořadí): ruční zařazení, vaše pravidla, převody mezi účty, typ transakce v bance, vestavěný slovník obchodníků a návrh podle dříve ručně zařazené stejné protistrany. Ikona vlevo ukazuje zdroj, tooltip důvod. Změnou kategorie můžete zařadit i všechny transakce stejné protistrany.',
            render: (r) => <TxCategorySelect t={r} a={a} onPick={picker.pick} />,
            width: 220,
          },
          { accessor: 'bankType', title: 'Typ (banka)', filterable: true, render: (r) => <Text size="xs">{r.bankType}</Text> },
          {
            accessor: 'flowLabel',
            title: 'Druh',
            filterable: true,
            hint: 'Jak se pohyb počítá do statistik: příjem, výdaj, převod mezi vlastními účty (nepočítá se), nebo investice (úspora).',
            render: (r) => (
              <Tooltip label={FLOW_HINT[r.flow]} multiline w={300} withArrow>
                <Badge color={FLOW_COLOR[r.flow]} variant="light" size="sm">
                  {r.flowLabel}
                </Badge>
              </Tooltip>
            ),
          },
          {
            accessor: 'amount',
            title: 'Částka',
            textAlign: 'right',
            render: (r) => (
              <Stack gap={0} align="flex-end">
                <Text size="sm" fw={600} c={signColor(r.amount)}>
                  {r.currency === 'CZK' ? money(r.amount, 'Kč') : money(r.amount, r.currency)}
                </Text>
                {r.origAmount !== undefined && r.origCurrency && r.origCurrency !== r.currency && (
                  <Text size="xs" c="dimmed">
                    {money(r.origAmount, r.origCurrency)}
                  </Text>
                )}
              </Stack>
            ),
          },
        ]}
      />
      )}
    </Stack>
  );
}
