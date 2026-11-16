import { Alert, Button, Group, Modal, Radio, Stack, Table, Text, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { DateRange, ImportMode } from '../core/exportStore';
import type { ImportPreview } from '../server/importer';
import { api } from './api';
import { date } from './format';

export const MODE_LABEL: Record<ImportMode, { label: string; description: string }> = {
  merge: {
    label: 'Sloučit',
    description: 'V období exportu platí nový export (nahradí uložené řádky). Mimo toto období zůstanou uložená data beze změny.',
  },
  keepExisting: {
    label: 'Ponechat stávající, přidat jen nové',
    description: 'Uložená data se nemění. Z exportu se přidají jen řádky z období, které zatím uložené není.',
  },
  replaceAll: {
    label: 'Nahradit celou historii',
    description: 'Export se použije jako kompletní historie účtu. Všechna uložená data tohoto typu se přesunou do archivu.',
  },
};

export interface ImportDecision {
  mode: ImportMode;
  range?: DateRange;
}

/** Shows what an import changes per year and lets the user choose how to resolve differences. */
export function ImportDialog({ preview: initial, onDecide }: { preview: ImportPreview; onDecide: (d: ImportDecision | null) => void }) {
  const [preview, setPreview] = useState(initial);
  const allowed = preview.units.reduce<ImportMode[]>((acc, u) => acc.filter((m) => u.allowedModes.includes(m)), ['merge', 'keepExisting', 'replaceAll']);
  // one mode applies to every account of a multi-account export; a forced replace for one account
  // would wipe the history of the others, so such an export has to be split
  const mixed = preview.units.length > 1 && preview.units.some((u) => u.allowedModes.length !== preview.units[0].allowedModes.length);
  const [mode, setMode] = useState<ImportMode>(allowed[0] ?? 'replaceAll');
  const single = preview.units.length === 1 && preview.units[0].rangeEditable ? preview.units[0] : undefined;
  const [range, setRange] = useState<DateRange | undefined>(single?.range);
  const [replanError, setReplanError] = useState<string | null>(null);
  const rangeValid = !range || (!!range.from && !!range.to && range.from <= range.to && (!single?.dataRange || (range.from <= single.dataRange.from && range.to >= single.dataRange.to)));

  // recompute the per-year numbers for a period entered by the user
  useEffect(() => {
    if (!range || !rangeValid || !single || (range.from === single.range.from && range.to === single.range.to)) return;
    let stale = false; // a newer range was entered meanwhile – ignore this response
    const t = setTimeout(() => {
      api
        .importReplan(preview.id, range)
        .then((p) => {
          if (stale) return;
          setPreview(p);
          setReplanError(null);
        })
        .catch((e: Error) => {
          if (!stale) setReplanError(e.message);
        });
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [range, rangeValid, single, preview.id]);

  return (
    <Modal opened closeOnClickOutside={false} closeOnEscape={false} onClose={() => onDecide(null)} title={`Import: ${preview.fileName}`} size="xl" data-testid="import-dialog">
      <Stack>
        {preview.units.map((u) => (
          <Stack key={u.unit} gap="xs">
            <Text fw={600}>{u.label}</Text>
            <Text size="sm">
              Období exportu: {date(u.range.from)} – {date(u.range.to)}
              {u.dataRange && ` · řádky ${date(u.dataRange.from)} – ${date(u.dataRange.to)}`}
              {u.plan.storedCoverage.length > 0 && ` · uloženo: ${u.plan.storedCoverage.map((c) => `${date(c.from)} – ${date(c.to)}`).join(', ')}`}
            </Text>
            {u === single && range && (
              <Group gap="xs" align="flex-end">
                <TextInput type="date" size="xs" label="Export platí od" value={range.from} onChange={(e) => setRange({ ...range, from: e.currentTarget.value })} data-testid="import-from" />
                <TextInput type="date" size="xs" label="do" value={range.to} onChange={(e) => setRange({ ...range, to: e.currentTarget.value })} data-testid="import-to" />
                <Text size="xs" c={rangeValid ? 'dimmed' : 'red'} maw={360}>
                  {rangeValid
                    ? 'Degiro období v souboru neuvádí. Pokud jste exportovali delší období, než pokrývají řádky, upravte ho – v celém období pak platí nový export.'
                    : 'Období musí zahrnovat všechny řádky exportu.'}
                </Text>
              </Group>
            )}
            <Table striped withTableBorder fz="sm" data-testid="import-years">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Rok</Table.Th>
                  <Table.Th ta="right">Uloženo</Table.Th>
                  <Table.Th ta="right">V exportu</Table.Th>
                  <Table.Th ta="right">Nové řádky</Table.Th>
                  <Table.Th ta="right">Chybí v exportu</Table.Th>
                  <Table.Th ta="right">Po importu</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {u.plan.years.map((y) => (
                  <Table.Tr key={y.year}>
                    <Table.Td>{y.year}</Table.Td>
                    <Table.Td ta="right">{y.stored}</Table.Td>
                    <Table.Td ta="right">{y.incoming}</Table.Td>
                    <Table.Td ta="right" c={y.added ? 'teal' : undefined}>
                      {y.added ? `+${y.added}` : '0'}
                    </Table.Td>
                    <Table.Td ta="right" c={y.removed ? 'red' : undefined}>
                      {y.removed ? `−${y.removed}` : '0'}
                    </Table.Td>
                    <Table.Td ta="right" fw={600}>
                      {y.result[mode]}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {u === single && replanError && (
              <Alert color="red" variant="light">
                {replanError}
              </Alert>
            )}
            {u.plan.removed > 0 && (
              <Alert color="orange" variant="light">
                {u.plan.removed} uložených řádků v období exportu v novém exportu chybí nebo se liší. Zkontrolujte, že jde o stejný účet a že export nebyl filtrovaný.
              </Alert>
            )}
            {u.warnings.map((w, i) => (
              <Alert key={i} color="yellow" variant="light">
                {w}
              </Alert>
            ))}
          </Stack>
        ))}
        {mixed && (
          <Alert color="red" variant="light">
            U některého účtu v tomto exportu lze jen nahradit celou historii. Takové nahrazení by smazalo historii i ostatních účtů. Exportujte účty v XTB jednotlivě.
          </Alert>
        )}
        <Radio.Group value={mode} onChange={(v) => setMode(v as ImportMode)} label="Co s rozdíly udělat?">
          <Stack gap="xs" mt="xs">
            {(['merge', 'keepExisting', 'replaceAll'] as ImportMode[]).map((m) => (
              <Radio key={m} value={m} label={MODE_LABEL[m].label} description={MODE_LABEL[m].description} disabled={!allowed.includes(m)} data-testid={`import-mode-${m}`} />
            ))}
          </Stack>
        </Radio.Group>
        <Text size="xs" c="dimmed">
          Nahrazené verze uložených dat se přesunou do archivu, odkud je lze ručně vrátit.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => onDecide(null)}>
            Zrušit
          </Button>
          <Button disabled={mixed || !rangeValid || !allowed.includes(mode)} onClick={() => onDecide({ mode, range: single ? range : undefined })} data-testid="import-confirm">
            Importovat
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
