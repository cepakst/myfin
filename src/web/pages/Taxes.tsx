import { Alert, Badge, Group, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import type { Snapshot } from '../api';
import { CopyValue, Section, Stat, YearSelect } from '../components';
import { czk } from '../format';

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
  const [year, setYear] = useState(s.years.at(-1)! - (s.years.length > 1 ? 1 : 0));
  const sec = s.securities.find((x) => x.year === year)!;
  const sum = s.taxSummaries.find((x) => x.year === year)!;
  const dap = s.dap.find((x) => x.year === year)!;
  const fxY = s.fxYears.find((x) => x.year === year);
  const provisional = fxY?.rates.some((r) => r.provisional && fxY.method === 'UNIFIED');

  return (
    <Stack>
      <Group justify="space-between">
        <Group>
          <YearSelect years={s.years} value={year} onChange={setYear} />
          <Badge size="lg" variant="light">
            {sum.situationLabel}
          </Badge>
          <Badge size="lg" variant="outline">
            kurz: {fxY?.method === 'DAILY' ? 'denní ČNB' : 'jednotný'}
          </Badge>
        </Group>
        {sum.mustFile != null && (
          <Badge size="lg" color={sum.mustFile ? 'orange' : 'teal'}>
            {sum.mustFile ? 'Daňové přiznání podat' : 'Přiznání není nutné'}
          </Badge>
        )}
      </Group>
      {provisional && (
        <Alert color="yellow">Rok ještě neskončil nebo GFŘ dosud nevydalo jednotný kurz – použit předběžný průměr měsíčních kurzů ČNB. Hodnoty se mohou změnit.</Alert>
      )}
      {sum.notes.map((n, i) => (
        <Alert key={i} color={n.severity === 'error' ? 'red' : n.severity === 'warning' ? 'orange' : 'blue'} variant="light">
          {n.text}
        </Alert>
      ))}
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label="Příjmy z prodeje CP" value={czk(sec.totalProceedsCzk)} sub={`z toho časový test ${czk(sec.timeTestProceedsCzk)}`} />
        <Stat label="Pro limit 100 000 Kč" value={czk(sec.limitProceedsCzk)} sub={sec.smallSalesExempt ? 'v limitu – osvobozeno' : 'limit překročen'} color={sec.smallSalesExempt ? 'teal' : 'orange'} />
        <Stat label="Základ daně §10" value={czk(sec.taxable.baseCzk)} sub={`zisky ${czk(sec.taxable.gainsCzk)} / ztráty ${czk(-sec.taxable.lossesCzk)}`} />
        <Stat label="Odhad daně celkem" value={czk(sum.estimatedTaxTotalCzk)} sub={`CP ${czk(sum.estimatedTaxSecuritiesCzk)} · dividendy ${czk(sum.estimatedTaxDividendsCzk)}`} />
      </SimpleGrid>
      <Text size="sm" c="dimmed">
        Hodnoty k přepsání do daňového přiznání (tlačítkem zkopírujete celé číslo v Kč). Výpočet: FIFO, výdaje = pořizovací cena + poplatky při nákupu i prodeji, přepočet {fxY?.method === 'DAILY' ? 'denním kurzem ČNB' : 'jednotným kurzem'}.
      </Text>
      <DapBlocks blocks={dap.blocks} />
      <Section title="Osvobozené prodeje">
        <Table fz="sm">
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>Zisk z prodejů se splněným časovým testem</Table.Td>
              <Table.Td ta="right">{czk(sec.timeTestGainCzk)}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>Osvobozený zisk celkem</Table.Td>
              <Table.Td ta="right">{czk(sec.exemptGainCzk)}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>Ztráty z osvobozených prodejů (nelze uplatnit)</Table.Td>
              <Table.Td ta="right">{czk(sec.exemptLossCzk)}</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </Section>
      <Text size="xs" c="dimmed">
        Aplikace slouží jako podklad, nikoli jako daňové poradenství. Před podáním si ověřte aktuální tiskopis a pokyny Finanční správy.
      </Text>
    </Stack>
  );
}
