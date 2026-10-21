import { Alert, Anchor, Stack, Text, Title } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { Link } from 'react-router-dom';
import type { Snapshot } from '../api';
import { czk, date, num, signColor } from '../format';

export function OptimizationPage({ s }: { s: Snapshot }) {
  return (
    <Stack>
      <Title order={3}>Daňová optimalizace {s.years.at(-1)}</Title>
      <Text size="sm" c="dimmed">
        Tipy vycházejí z aktuálních cen (k {date(s.today)}) a ze zvolené daňové situace. Daňové hodnoty používají přepočet zvolený pro daný rok; u běžného roku jde o odhad.
      </Text>
      {s.tips.map((t) => (
        <Alert key={t.id} color={t.severity === 'warning' ? 'orange' : t.severity === 'success' ? 'teal' : 'blue'} title={t.title} variant="light">
          <Stack gap="xs">
            <Text size="sm">{t.text}</Text>
            {t.items && t.items.length > 0 && (
              <DataTable
                withTableBorder
                fz="xs"
                maxHeight={320}
                idAccessor={(r) => r.lotId ?? r.instrumentId}
                records={t.items}
                columns={[
                  {
                    accessor: 'name',
                    title: 'Instrument',
                    render: (r) => (
                      <Anchor component={Link} to={`/instrument/${encodeURIComponent(r.instrumentId)}`} size="xs">
                        {r.name}
                      </Anchor>
                    ),
                  },
                  { accessor: 'acqDate', title: 'Nákup', render: (r) => date(r.acqDate) },
                  { accessor: 'qty', title: 'Kusů', textAlign: 'right', render: (r) => num(r.qty) },
                  { accessor: 'timeTestDate', title: 'Časový test', render: (r) => date(r.timeTestDate) },
                  { accessor: 'valueCzk', title: 'Hodnota', textAlign: 'right', render: (r) => czk(r.valueCzk) },
                  {
                    accessor: 'gainCzk',
                    title: 'Daňový zisk/ztráta',
                    textAlign: 'right',
                    render: (r) => (
                      <Text size="xs" c={signColor(r.gainCzk)}>
                        {czk(r.gainCzk)}
                      </Text>
                    ),
                  },
                ]}
              />
            )}
          </Stack>
        </Alert>
      ))}
      <Alert color="gray" title="Obecná pravidla">
        <Text size="sm">
          • Časový test: prodej je osvobozen, pokud doba mezi nabytím a prodejem přesáhne 3 roky. • Limit 100 000 Kč: osvobozeny jsou prodeje, jejichž úhrnné příjmy (bez prodejů s časovým testem) za rok nepřesáhnou 100 000 Kč. • Ztráty z prodeje CP lze započíst jen proti ziskům ze CP ve stejném roce, nelze je převádět. • Metodu přepočtu (jednotný / denní kurz) lze volit pro každý rok.
        </Text>
      </Alert>
    </Stack>
  );
}
