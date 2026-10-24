import { Accordion, Alert, Anchor, Badge, Button, Group, List, NumberInput, Select, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { notifications } from '@mantine/notifications';
import { IconCloudDownload, IconDeviceFloppy, IconUpload } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useSnapshot, type Settings } from '../api';
import { Section } from '../components';
import { DataGrid } from '../DataGrid';
import { SITUATIONS } from '../format';
import { MARKET_STATUS_COLOR, MARKET_STATUS_LABEL, MARKET_STATUS_ORDER, marketStatus, missingMarketData } from '../marketStatus';

export function SettingsPage() {
  const qc = useQueryClient();
  const sq = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const snap = useSnapshot();
  const [st, setSt] = useState<Settings | null>(null);
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    if (sq.data) setSt(structuredClone(sq.data.settings));
  }, [sq.data]);
  if (!st || !sq.data) return <Text>Načítám…</Text>;

  const s = snap.data;
  const save = async () => {
    await api.saveSettings(st);
    notifications.show({ message: 'Uloženo – přepočítávám…', color: 'teal' });
    await qc.invalidateQueries({ queryKey: ['settings'] });
    await qc.invalidateQueries({ queryKey: ['status'] });
  };
  const upd = (f: (x: Settings) => void) => {
    const c = structuredClone(st);
    f(c);
    setSt(c);
  };
  const instruments = s?.instruments ?? [];
  const missing = missingMarketData(instruments);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Nastavení a data</Title>
        <Button leftSection={<IconDeviceFloppy size={16} />} onClick={save}>
          Uložit a přepočítat
        </Button>
      </Group>

      <Section title="Exporty od brokerů">
        <Stack>
          <TextInput
            label="Složka s exporty"
            description={`Výchozí: ${sq.data.defaultExportsDir}. Načítají se soubory .csv (Degiro Transactions + Account) a .xlsx/.zip (XTB) včetně podsložek.`}
            placeholder={sq.data.defaultExportsDir}
            value={st.exportsDir ?? ''}
            onChange={(e) => upd((x) => (x.exportsDir = e.currentTarget.value || undefined))}
          />
          <Dropzone
            loading={uploading}
            onDrop={async (files) => {
              setUploading(true);
              try {
                const r = await api.upload(files);
                notifications.show({ message: `Nahráno: ${r.saved.map((x) => `${x.file} (${x.kind})`).join(', ')}`, color: 'teal' });
                await qc.invalidateQueries({ queryKey: ['status'] });
              } catch (e) {
                notifications.show({ message: (e as Error).message, color: 'red' });
              } finally {
                setUploading(false);
              }
            }}
          >
            <Group justify="center" gap="md" mih={90} style={{ pointerEvents: 'none' }}>
              <IconUpload size={32} />
              <div>
                <Text>Přetáhněte nové exporty sem</Text>
                <Text size="xs" c="dimmed">
                  Degiro: Transactions.csv a Account.csv · XTB: export .zip nebo .xlsx. Nový export stejného typu nahradí předchozí (starý se přesune do _archiv).
                </Text>
              </div>
            </Group>
          </Dropzone>
          {s && (
            <List size="sm">
              {s.sources.map((x, i) => (
                <List.Item key={i}>
                  {x.broker}: {x.file} – {x.rows} řádků
                </List.Item>
              ))}
            </List>
          )}
          <Group>
            <Button variant="light" onClick={() => api.reload(false).then(() => qc.invalidateQueries({ queryKey: ['status'] }))}>
              Znovu načíst exporty
            </Button>
            <Button variant="light" leftSection={<IconCloudDownload size={16} />} onClick={() => api.reload(true).then(() => qc.invalidateQueries({ queryKey: ['status'] }))}>
              Aktualizovat tržní ceny
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            Data zůstávají jen v tomto počítači (složky exports/ a data/). Z internetu se stahují pouze kurzy ČNB a tržní ceny z Yahoo Finance (posílají se jen ISIN/tickery).
          </Text>
        </Stack>
      </Section>

      <Section title="Daňová situace a přepočet měn">
        <Stack>
          <Select
            label="Výchozí daňová situace"
            description="Použije se pro roky, které nemají vlastní nastavení."
            data={SITUATIONS}
            value={st.defaultSituation}
            onChange={(v) => v && upd((x) => (x.defaultSituation = v as Settings['defaultSituation']))}
            maw={400}
          />
          <Text size="sm">
            Daňovou situaci, jiný základ daně, způsob zdanění dividend a přepočet měn pro jednotlivé roky nastavíte na stránce{' '}
            <Anchor component={Link} to="/dane">
              Daně
            </Anchor>
            , kde uvidíte i porovnání variant.
          </Text>
          <Accordion variant="separated">
            <Accordion.Item value="rates">
              <Accordion.Control>Jednotné kurzy (zobrazit / ručně přepsat)</Accordion.Control>
              <Accordion.Panel>
                <Stack>
                  {s?.fxYears.map((fy) => (
                    <div key={fy.year}>
                      <Text fw={600} size="sm">
                        {fy.year}
                      </Text>
                      <SimpleGrid cols={{ base: 3, md: 6 }}>
                        {fy.rates.map((r) => (
                          <NumberInput
                            key={r.currency}
                            size="xs"
                            label={`${r.currency} (${r.source === 'official' ? 'GFŘ' : r.source === 'override' ? 'ruční' : r.provisional ? 'předběžný' : 'vypočtený'})`}
                            decimalScale={3}
                            placeholder={String(r.rate)}
                            value={st.fx.unifiedOverrides[fy.year]?.[r.currency] ?? ''}
                            onChange={(v) =>
                              upd((x) => {
                                const m = (x.fx.unifiedOverrides[fy.year] ??= {});
                                if (v === '') delete m[r.currency];
                                else m[r.currency] = Number(v);
                              })
                            }
                          />
                        ))}
                      </SimpleGrid>
                    </div>
                  ))}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </Stack>
      </Section>

      <Section title="Instrumenty – tržní symboly a stát emitenta">
        <Alert color="blue" variant="light" mb="sm">
          Symbol Yahoo Finance se dohledává automaticky podle ISIN a ověřuje proti ceně obchodu. Pokud chybí nebo je špatně, zadejte jej ručně (např. „ELUX-B.ST“). Pomlčka „-“ = nepoužívat tržní data.
          {missing.length > 0 && (
            <Text size="sm" mt={4} c="orange" fw={500}>
              Bez tržních dat: {missing.length} {missing.length === 1 ? 'instrument' : missing.length < 5 ? 'instrumenty' : 'instrumentů'} – jejich cena se odhaduje z posledního obchodu nebo ocenění brokera. V tabulce jsou nahoře.
            </Text>
          )}
        </Alert>
        <DataGrid
          label="Instrumenty"
          fz="xs"
          maxHeight={500}
          idAccessor="id"
          records={instruments}
          defaultSort={{ column: 'hasMarket', direction: 'asc' }}
          searchPlaceholder="Hledat název, ISIN, symbol…"
          columns={[
            { accessor: 'name', title: 'Instrument', searchValue: (i) => `${i.name} ${i.isin ?? ''} ${i.id}`, render: (i) => `${i.name} (${i.isin ?? i.id})` },
            { accessor: 'symbol', title: 'Použitý symbol', render: (i) => `${i.symbol ?? '–'} ${i.symbolNote ? `· ${i.symbolNote}` : ''}` },
            {
              accessor: 'hasMarket',
              title: 'Tržní data',
              filterable: true,
              filterValue: (i) => MARKET_STATUS_LABEL[marketStatus(i)],
              sortValue: (i) => MARKET_STATUS_ORDER.indexOf(marketStatus(i)),
              render: (i) => {
                const m = marketStatus(i);
                return (
                  <Badge size="sm" variant="light" color={MARKET_STATUS_COLOR[m]}>
                    {MARKET_STATUS_LABEL[m]}
                  </Badge>
                );
              },
            },
            {
              accessor: 'override',
              title: 'Ruční symbol',
              sortable: false,
              render: (i) => (
                <TextInput
                  size="xs"
                  w={130}
                  value={st.symbolOverrides[i.id] === '' ? '-' : (st.symbolOverrides[i.id] ?? '')}
                  onChange={(e) =>
                    upd((x) => {
                      const v = e.currentTarget.value.trim();
                      if (!v) delete x.symbolOverrides[i.id];
                      else x.symbolOverrides[i.id] = v === '-' ? '' : v;
                    })
                  }
                />
              ),
            },
            {
              accessor: 'country',
              title: 'Stát (dividendy)',
              // Sort by the saved value so a row does not move while its override is being typed
              sortValue: (i) => sq.data?.settings.countryOverrides[i.id] ?? i.country,
              render: (i) => (
                <TextInput
                  size="xs"
                  w={60}
                  maxLength={2}
                  placeholder={i.country ?? ''}
                  value={st.countryOverrides[i.id] ?? ''}
                  onChange={(e) =>
                    upd((x) => {
                      const v = e.currentTarget.value.toUpperCase();
                      if (!v) delete x.countryOverrides[i.id];
                      else x.countryOverrides[i.id] = v;
                    })
                  }
                />
              ),
            },
          ]}
        />
      </Section>
    </Stack>
  );
}
