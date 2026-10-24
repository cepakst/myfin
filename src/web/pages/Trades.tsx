import { Anchor, Badge, Group, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Snapshot } from '../api';
import { defaultYear, Stat, WithHint, YearSelect } from '../components';
import { DataGrid } from '../DataGrid';
import { czk, date, money, num, signColor } from '../format';

type R = Snapshot['realizations'][number];

type TaxStatus = 'časový test' | 'limit 100 tis.' | 'zdanitelné' | 'bez nákupu' | 'korp. akce';

const STATUS_COLOR: Record<TaxStatus, string> = { 'časový test': 'teal', 'limit 100 tis.': 'cyan', zdanitelné: 'orange', 'bez nákupu': 'gray', 'korp. akce': 'gray' };

function taxStatus(r: R, smallSalesExempt: boolean): TaxStatus {
  if (r.timeTestPassed) return 'časový test';
  if (r.origin === 'UNKNOWN') return r.qty === 0 ? 'korp. akce' : 'bez nákupu';
  return smallSalesExempt ? 'limit 100 tis.' : 'zdanitelné';
}

function statusHint(st: TaxStatus, r: R): string {
  switch (st) {
    case 'časový test':
      return `Osvobozeno: mezi nákupem (${date(r.acqDate)}) a prodejem uplynuly více než 3 roky – časový test splněn (§4 odst. 1 písm. u ZDP). Do přiznání se neuvádí.`;
    case 'limit 100 tis.':
      return `Časový test nesplněn (drženo ${r.holdingDays} dní), ale úhrn příjmů z prodejů CP bez časového testu v roce ${r.sellDate.slice(0, 4)} nepřesáhl 100 000 Kč – prodej je osvobozen (§4 odst. 1 písm. t ZDP).`;
    case 'zdanitelné':
      return `Časový test nesplněn (drženo ${r.holdingDays} dní z potřebných 3 let) a roční příjmy z prodejů CP přesáhly 100 000 Kč – zisk/ztráta vstupuje do dílčího základu daně podle §10 (Příloha č. 2).`;
    case 'bez nákupu':
      return 'K prodeji nebyl v exportech nalezen nákup (např. akcie převedené od jiného brokera nebo chybějící starší export). Výdaje nelze určit – doplňte chybějící export.';
    case 'korp. akce':
      return 'Hotovostní vypořádání z korporátní akce (např. prodej zlomků akcií po splitu nebo fúzi) bez nakoupených kusů.';
  }
}

export function TradesPage({ s }: { s: Snapshot }) {
  const [year, setYear] = useState(defaultYear(s));
  const smallExempt = s.securities.find((x) => x.year === year)?.smallSalesExempt ?? false;
  const rows = s.realizations.filter((r) => r.sellDate.startsWith(String(year))).map((r) => ({ ...r, taxStatus: taxStatus(r, smallExempt) }));
  const sum = (f: (r: R) => number) => rows.reduce((a, r) => a + f(r), 0);
  const gains = sum((r) => Math.max(0, r.gainCzk));
  const losses = sum((r) => Math.min(0, r.gainCzk));

  return (
    <Stack>
      <Group justify="space-between">
        <YearSelect years={s.years} value={year} onChange={setYear} />
        <Text size="sm" c="dimmed">
          Hodnoty v daňovém přepočtu (zvolený kurz pro rok); „ekonomicky“ = denní kurz ČNB.
        </Text>
      </Group>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label="Příjmy z prodejů" value={czk(sum((r) => r.proceedsCzk))} sub={`${rows.length} FIFO řádků`} hint="Součet prodejních cen všech prodejů v roce (včetně osvobozených), přepočtený zvoleným kurzem pro daňové účely." />
        <Stat label="Zisky" value={czk(gains)} color="teal" hint="Součet kladných výsledků jednotlivých FIFO řádků (příjem − nákupní cena − poplatky)." />
        <Stat label="Ztráty" value={czk(losses)} color="red" sub={gains > 0 ? `snědly ${Math.round((-losses / gains) * 100)} % zisků` : undefined} hint="Součet záporných výsledků. Ztráty lze daňově započíst jen proti ziskům z neosvobozených prodejů CP ve stejném roce." />
        <Stat label="Výsledek" value={czk(gains + losses)} color={signColor(gains + losses)} sub={`ekonomicky ${czk(sum((r) => r.econGainCzk))}`} hint="Zisky + ztráty v daňovém přepočtu. „Ekonomicky“ = stejný výpočet s denními kurzy ČNB ke dni nákupu a prodeje." />
      </SimpleGrid>
      <DataGrid
        label="Realizované obchody"
        idAccessor="id"
        records={rows}
        defaultSort={{ column: 'sellDate', direction: 'desc' }}
        searchPlaceholder="Hledat instrument, ISIN…"
        columns={[
          {
            accessor: 'name',
            title: 'Instrument',
            searchValue: (r) => `${r.name} ${r.instrumentId}`,
            render: (r) => (
              <Anchor component={Link} to={`/instrument/${encodeURIComponent(r.instrumentId)}`} size="sm">
                {r.name}
              </Anchor>
            ),
          },
          { accessor: 'broker', title: 'Broker', filterable: true },
          { accessor: 'acqDate', title: 'Nákup', render: (r) => date(r.acqDate) },
          { accessor: 'sellDate', title: 'Prodej', render: (r) => date(r.sellDate) },
          { accessor: 'holdingDays', title: 'Drženo', textAlign: 'right', render: (r) => `${r.holdingDays} d` },
          { accessor: 'qty', title: 'Kusů', textAlign: 'right', render: (r) => num(r.qty) },
          { accessor: 'sellPrice', title: 'Prodejní cena', textAlign: 'right', sortable: false, render: (r) => money(r.sellPrice, r.currency) },
          { accessor: 'proceedsCzk', title: 'Příjem', textAlign: 'right', render: (r) => czk(r.proceedsCzk) },
          {
            accessor: 'costCzk',
            title: 'Výdaje',
            textAlign: 'right',
            sortValue: (r) => r.costCzk + r.buyFeesCzk + r.sellFeesCzk,
            render: (r) => (
              <Tooltip label={`nákup ${czk(r.costCzk)} + poplatky nákup ${czk(r.buyFeesCzk)} + prodej ${czk(r.sellFeesCzk)}`}>
                <span>{czk(r.costCzk + r.buyFeesCzk + r.sellFeesCzk)}</span>
              </Tooltip>
            ),
          },
          {
            accessor: 'gainCzk',
            title: 'Zisk',
            textAlign: 'right',
            render: (r) => (
              <Text size="sm" c={signColor(r.gainCzk)}>
                {czk(r.gainCzk)}
              </Text>
            ),
          },
          {
            accessor: 'taxStatus',
            title: 'Daň',
            width: 150,
            noWrap: true,
            filterable: true,
            render: (r) => (
              <WithHint label={statusHint(r.taxStatus, r)}>
                <Badge color={STATUS_COLOR[r.taxStatus]} variant="light" style={{ overflow: 'visible' }}>
                  {r.taxStatus}
                </Badge>
              </WithHint>
            ),
          },
        ]}
      />
    </Stack>
  );
}
