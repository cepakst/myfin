import { Alert, Anchor, Badge, Button, Group, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { IconFileSpreadsheet } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Snapshot } from '../api';
import { CopyValue, defaultYear, HintTitle, Section, Stat, WithHint, YearSelect } from '../components';
import { czk } from '../format';
import { G } from '../glossary';
import { TaxYearSettings } from './TaxYearSettings';

export function DapBlocks({ blocks }: { blocks: Snapshot['dap'][number]['blocks'] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <Section key={i} title={b.title}>
          {b.description && (
            <Text size="sm" c="dimmed" mb="xs">
              {b.description}
            </Text>
          )}
          {b.fields.length > 0 && (
            <Table withTableBorder fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={110}>Řádek</Table.Th>
                  <Table.Th>Položka</Table.Th>
                  <Table.Th ta="right">Hodnota</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {b.fields.map((f, j) => (
                  <Table.Tr key={j}>
                    <Table.Td>
                      <Badge variant="light">{f.row}</Badge>
                    </Table.Td>
                    <Table.Td>
                      {f.label}
                      {f.note && (
                        <Text size="xs" c="dimmed">
                          {f.note}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <CopyValue value={f.value} display={typeof f.value === 'number' ? czk(f.value) : f.value} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Section>
      ))}
    </>
  );
}

export function TaxesPage({ s }: { s: Snapshot }) {
  const [year, setYear] = useState(defaultYear(s));
  const sec = s.securities.find((x) => x.year === year)!;
  const sum = s.taxSummaries.find((x) => x.year === year)!;
  const dap = s.dap.find((x) => x.year === year)!;
  const div = s.dividendYears.find((x) => x.year === year)!;
  const fxY = s.fxYears.find((x) => x.year === year);
  const provisional = fxY?.rates.some((r) => r.provisional && fxY.method === 'UNIFIED');

  return (
    <Stack>
      <Group justify="space-between">
        <Group>
          <YearSelect years={s.years} value={year} onChange={setYear} />
          <WithHint label="Excel s podrobným rozpisem výpočtu: jednotlivé prodeje (párování FIFO, kurzy, časový test), dividendy se zápočtem daně, použité kurzy a řádky přiznání odvozené vzorci. Hodí se pro kontrolu nebo dotaz finančního úřadu.">
            <Button component="a" href={`/api/tax-report/${year}`} download variant="light" leftSection={<IconFileSpreadsheet size={16} />} data-testid="tax-report">
              Stáhnout podklady (Excel)
            </Button>
          </WithHint>
        </Group>
        {sum.mustFile != null && (
          <WithHint label={sum.filingReason ?? ''}>
            <Badge size="lg" color={sum.mustFile ? 'orange' : 'teal'}>
              {sum.mustFile ? 'Daňové přiznání podat' : 'Přiznání není nutné'}
            </Badge>
          </WithHint>
        )}
      </Group>
      <TaxYearSettings s={s} year={year} />
      {provisional && (
        <Alert color="yellow">Rok ještě neskončil nebo GFŘ dosud nevydalo jednotný kurz – použit předběžný průměr měsíčních kurzů ČNB. Hodnoty se mohou změnit.</Alert>
      )}
      {sum.notes.map((n, i) => (
        <Alert key={i} color={n.severity === 'error' ? 'red' : n.severity === 'warning' ? 'orange' : 'blue'} variant="light">
          {n.text}
        </Alert>
      ))}
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat
          label="Příjmy z prodeje CP"
          value={czk(sec.totalProceedsCzk)}
          sub={`z toho časový test ${czk(sec.timeTestProceedsCzk)}`}
          hint="Úhrn prodejních cen všech cenných papírů prodaných v roce, včetně prodejů osvobozených časovým testem (držení déle než 3 roky)."
        />
        <Stat
          label="Pro limit 100 000 Kč"
          value={czk(sec.limitProceedsCzk)}
          sub={sec.smallSalesExempt ? 'v limitu – osvobozeno' : 'limit překročen'}
          color={sec.smallSalesExempt ? 'teal' : 'orange'}
          hint="Příjmy z prodejů bez splněného časového testu. Pokud za rok nepřesáhnou 100 000 Kč, jsou všechny osvobozeny (§4 odst. 1 písm. t ZDP). Rozhoduje příjem (prodejní cena), ne zisk."
        />
        <Stat
          label="Základ daně §10"
          value={czk(sec.taxable.baseCzk)}
          sub={`zisky ${czk(sec.taxable.gainsCzk)} / ztráty ${czk(-sec.taxable.lossesCzk)}`}
          hint="Dílčí základ daně z ostatních příjmů (Příloha č. 2): zdanitelné příjmy − výdaje (nákupní cena a poplatky). Ztráty se započtou jen proti ziskům ze CP v tomtéž roce; záporný výsledek = 0 Kč."
        />
        <Stat
          label="Odhad daně celkem"
          value={czk(sum.estimatedTaxTotalCzk)}
          sub={`CP ${czk(sum.estimatedTaxSecuritiesCzk)} · dividendy ${czk(sum.estimatedTaxDividendsCzk)}${sum.year >= 2021 && sum.foreignDividendsCzk > 0 ? ` (${sum.use16a ? 'bez §16a' : 's §16a'} ${czk(sum.use16a ? sum.estimatedTaxDividendsGeneralCzk : sum.estimatedTaxDividends16aCzk)})` : ''}`}
          hint={`${G.taxEstimate}\n„CP“ = prodeje cenných papírů a úroky, „dividendy“ = zahraniční dividendy; v závorce daň z dividend při opačné volbě (§16a / obecný základ).`}
        />
      </SimpleGrid>
      <Text size="sm" c="dimmed">
        Hodnoty k přepsání do daňového přiznání (tlačítkem zkopírujete celé číslo v Kč). Výpočet: FIFO, výdaje = pořizovací cena + poplatky při nákupu i prodeji, přepočet {fxY?.method === 'DAILY' ? 'denním kurzem ČNB' : 'jednotným kurzem'}.
      </Text>
      <Title order={4} mt="sm">
        Cenné papíry (§10)
      </Title>
      <DapBlocks blocks={dap.blocks.slice(0, 1)} />
      <Section title="Osvobozené prodeje">
        <Table fz="sm">
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>
                <HintTitle hint={G.ttGain}>Zisk z prodejů se splněným časovým testem</HintTitle>
              </Table.Td>
              <Table.Td ta="right">{czk(sec.timeTestGainCzk)}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <HintTitle hint={G.exemptGain}>Osvobozený zisk celkem</HintTitle>
              </Table.Td>
              <Table.Td ta="right">{czk(sec.exemptGainCzk)}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <HintTitle hint={G.exemptLoss}>Ztráty z osvobozených prodejů (nelze uplatnit)</HintTitle>
              </Table.Td>
              <Table.Td ta="right">{czk(sec.exemptLossCzk)}</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </Section>
      <Group mt="sm" gap="xs">
        <Title order={4}>Dividendy a kapitálové příjmy (§8)</Title>
        <Anchor component={Link} to="/dividendy" size="sm">
          rozpis po státech a výplatách →
        </Anchor>
      </Group>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label="Zahraniční dividendy hrubě" value={czk(div.foreign.grossCzk)} hint="Hrubé zahraniční dividendy přepočtené kurzem zvoleným pro daňové účely – částka do přiznání." />
        <Stat label="Sražená daň v zahraničí" value={czk(div.foreign.withheldCzk)} sub={`započitatelná ${czk(div.foreign.creditableCzk)}`} hint="Zahraniční daň lze započíst nejvýše do smluvní sazby (obvykle 15 %)." />
        <Stat label="Doplatek daně v ČR" value={czk(div.foreign.dueCzk)} hint="Česká daň 15 % po zápočtu zahraniční daně." />
        <Stat
          label="Lze žádat v zahraničí"
          value={czk(div.foreign.reclaimableCzk)}
          color={div.foreign.reclaimableCzk > 0 ? 'orange' : undefined}
          hint="Daň sražená nad smluvní sazbu – v ČR ji započíst nelze, o vrácení se žádá v zahraničí."
        />
      </SimpleGrid>
      <DapBlocks blocks={dap.blocks.slice(1)} />
      <Text size="xs" c="dimmed">
        Aplikace slouží jako podklad, nikoli jako daňové poradenství. Před podáním si ověřte aktuální tiskopis a pokyny Finanční správy.
      </Text>
    </Stack>
  );
}
