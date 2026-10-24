import { Badge, Button, Group, Loader, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { profileFor, SITUATION_LABELS, withYearProfile, type TaxSituation } from '../../core/settings';
import { api, useStatus, type Settings, type Snapshot } from '../api';
import { Hint, Section } from '../components';
import { czk, SITUATIONS } from '../format';

type FxMethod = 'UNIFIED' | 'DAILY';
const DEFAULT = 'DEFAULT';

const fxLabel = (m: FxMethod) => (m === 'DAILY' ? 'denní kurz ČNB' : 'jednotný kurz');
const divLabel = (use16a: boolean) => (use16a ? '§16a (Příloha č. 4)' : 'obecný základ (Příloha č. 3)');

function Label({ text, hint }: { text: string; hint: string }) {
  return (
    <Group gap={4} wrap="nowrap">
      <Text size="sm" fw={500}>
        {text}
      </Text>
      <Hint label={hint} />
    </Group>
  );
}

/** Per-year tax settings editable directly on the Taxes page, with a comparison of FX method × dividend taxation. */
export function TaxYearSettings({ s, year }: { s: Snapshot; year: number }) {
  const qc = useQueryClient();
  const sq = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const computing = useStatus().data?.status === 'loading';
  const [saving, setSaving] = useState(false);
  const settings = sq.data?.settings;
  const profile = settings ? profileFor(settings, year) : undefined;
  const storedSituation = settings?.taxProfiles[year]?.situation;
  const [otherBase, setOtherBase] = useState<number | ''>('');
  useEffect(() => setOtherBase(profile?.otherTaxBase ?? ''), [profile?.otherTaxBase, year]);

  if (!settings || !profile) return null;
  const fxMethod: FxMethod = settings.fx.methodByYear[year] ?? 'UNIFIED';
  const use16a = year >= 2021 && (profile.foreign16a ?? true);

  const save = async (next: Settings) => {
    setSaving(true);
    try {
      await api.saveSettings({ taxProfiles: next.taxProfiles, fx: next.fx });
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['status'] });
    } catch (e) {
      notifications.show({ message: (e as Error).message, color: 'red' });
    } finally {
      setSaving(false);
    }
  };
  const setFx = (m: FxMethod, base: Settings = settings) => ({ ...base, fx: { ...base.fx, methodByYear: { ...base.fx.methodByYear, [year]: m } } });
  const commitOtherBase = () => {
    const v = otherBase === '' ? undefined : Number(otherBase);
    if (v !== profile.otherTaxBase) void save(withYearProfile(settings, year, { otherTaxBase: v }));
  };

  const scenarios = s.taxScenarios?.[year] ?? [];
  const best = scenarios.length ? Math.min(...scenarios.map((x) => x.estimatedTaxTotalCzk)) : null;
  const unifiedProvisional = s.fxYears.find((x) => x.year === year)?.rates.some((r) => r.provisional) ?? false;
  const busy = saving || computing;

  return (
    <Section
      title={`Daňová situace a volby pro rok ${year}`}
      right={
        busy ? (
          <Group gap={6}>
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              přepočítávám…
            </Text>
          </Group>
        ) : (
          <Text size="xs" c="dimmed">
            změny se ukládají hned
          </Text>
        )
      }
    >
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <Stack gap={4}>
            <Label text="Daňová situace" hint="Určuje, zda musíte podat přiznání (limity příjmů pro zaměstnance / OSVČ / paušální režim) a zda se uplatní sleva na poplatníka. Platí jen pro tento rok; volba Výchozí přebírá výchozí situaci z Nastavení." />
            <Select
              aria-label="Daňová situace"
              data={[{ value: DEFAULT, label: `Výchozí (${SITUATION_LABELS[settings.defaultSituation]})` }, ...SITUATIONS]}
              value={storedSituation ?? DEFAULT}
              allowDeselect={false}
              disabled={busy}
              onChange={(v) => {
                const next = !v || v === DEFAULT ? undefined : (v as TaxSituation);
                if (v && next !== storedSituation) void save(withYearProfile(settings, year, { situation: next }));
              }}
            />
          </Stack>
          <Stack gap={4}>
            <Label text="Jiný základ daně (Kč)" hint="Základ daně z ostatních příjmů (zaměstnání, podnikání). Slouží k odhadu sazby 15 / 23 % a koeficientu zápočtu v Příloze č. 3. Uloží se po opuštění pole nebo Enter." />
            <NumberInput
              aria-label="Jiný základ daně"
              thousandSeparator=" "
              placeholder="např. 600 000"
              min={0}
              value={otherBase}
              disabled={busy}
              onChange={(v) => setOtherBase(v === '' ? '' : Number(v))}
              onBlur={commitOtherBase}
              onKeyDown={(e) => e.key === 'Enter' && commitOtherBase()}
            />
          </Stack>
          <Stack gap={4}>
            <Label
              text="Zdanění zahraničních dividend"
              hint="§16a: samostatný základ, sazba 15 %, zápočet zahraniční daně v Příloze č. 4. Obecný základ: dividendy na ř. 38 se zápočtem v Příloze č. 3 – může být výhodnější při nízkých příjmech (sleva na poplatníka). Volba §16a existuje od roku 2021."
            />
            <SegmentedControl
              aria-label="Zdanění zahraničních dividend"
              fullWidth
              disabled={busy || year < 2021}
              value={use16a ? '16a' : 'general'}
              onChange={(v) => void save(withYearProfile(settings, year, { foreign16a: v === '16a' }))}
              data={[
                { value: '16a', label: '§16a' },
                { value: 'general', label: 'Obecný základ' },
              ]}
            />
          </Stack>
          <Stack gap={4}>
            <Label
              text="Přepočet měn"
              hint="Jednotný kurz = roční kurz vyhlášený GFŘ (pro běžný rok předběžný průměr). Denní kurz = kurz ČNB ke dni každé transakce. Metodu je nutné použít pro celý rok a všechny příjmy (§38 ZDP)."
            />
            <SegmentedControl
              aria-label="Přepočet měn"
              fullWidth
              disabled={busy}
              value={fxMethod}
              onChange={(v) => void save(setFx(v as FxMethod))}
              data={[
                { value: 'UNIFIED', label: 'Jednotný' },
                { value: 'DAILY', label: 'Denní ČNB' },
              ]}
            />
          </Stack>
        </SimpleGrid>
        {scenarios.length > 0 && (
          <>
            <Group gap={4}>
              <Text size="sm" fw={500}>
                Porovnání variant
              </Text>
              <Hint label="Odhad daně z investic pro všechny kombinace přepočtu měn a zdanění dividend při zvolené situaci a jiném základu daně. Zelená = nejnižší odhad daně." />
            </Group>
            <Table withTableBorder fz="sm" aria-label="Porovnání variant">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Přepočet měn</Table.Th>
                  <Table.Th>Dividendy</Table.Th>
                  <Table.Th ta="right">Základ §10</Table.Th>
                  <Table.Th ta="right">Daň CP</Table.Th>
                  <Table.Th ta="right">
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      Daň dividendy
                      <Hint label="Doplatek české daně ze zahraničních dividend. U §16a se zahraniční daň započte až do 15 %, takže při srážce 15 % bývá doplatek 0 Kč. V obecném základu je zápočet omezen poměrem (Příloha č. 3) a závisí na sazbě a slevách." />
                    </Group>
                  </Table.Th>
                  <Table.Th ta="right">Daň celkem</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {scenarios.map((x) => {
                  const current = x.fxMethod === fxMethod && x.use16a === use16a;
                  const isBest = best != null && x.estimatedTaxTotalCzk <= best + 0.5;
                  return (
                    <Table.Tr key={`${x.fxMethod}-${x.use16a}`} bg={current ? 'var(--mantine-color-indigo-light)' : undefined}>
                      <Table.Td>
                        {fxLabel(x.fxMethod)}
                        {x.fxMethod === 'UNIFIED' && unifiedProvisional && (
                          <Text span size="xs" c="dimmed">
                            {' '}
                            (předběžný)
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>{year < 2021 ? 'obecný základ (§16a až od 2021)' : divLabel(x.use16a)}</Table.Td>
                      <Table.Td ta="right">{czk(x.securitiesBaseCzk)}</Table.Td>
                      <Table.Td ta="right">{czk(x.estimatedTaxSecuritiesCzk)}</Table.Td>
                      <Table.Td ta="right">{czk(x.estimatedTaxDividendsCzk)}</Table.Td>
                      <Table.Td ta="right" fw={700} c={isBest ? 'teal' : undefined}>
                        {czk(x.estimatedTaxTotalCzk)}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          {isBest && (
                            <Badge size="sm" color="teal" variant="light">
                              nejvýhodnější
                            </Badge>
                          )}
                          {current ? (
                            <Badge size="sm" variant="filled">
                              zvoleno
                            </Badge>
                          ) : (
                            <Button
                              size="compact-xs"
                              variant="light"
                              disabled={busy}
                              onClick={() => void save(setFx(x.fxMethod, year >= 2021 ? withYearProfile(settings, year, { foreign16a: x.use16a }) : settings))}
                            >
                              Použít
                            </Button>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </>
        )}
      </Stack>
    </Section>
  );
}
