import { Accordion, Alert, Anchor, Badge, Button, Group, List, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { notifications } from '@mantine/notifications';
import { IconCloudDownload, IconDeviceFloppy, IconUpload } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useSnapshot, type ImportPreview, type InboxFile, type Settings } from '../api';
import { ImportDialog, MODE_LABEL, type ImportDecision } from '../ImportDialog';
import { AccountsSettings } from './accounts/AccountsSettings';
import { Section } from '../components';
import { DataGrid } from '../DataGrid';
import { useSetDemo } from '../demo';
import { date, SITUATIONS } from '../format';
import { MARKET_STATUS_COLOR, MARKET_STATUS_LABEL, MARKET_STATUS_ORDER, marketStatus, missingMarketData } from '../marketStatus';

const INBOX_STATUS: Record<InboxFile['status'], { label: string; color: string }> = {
  imported: { label: 'importováno', color: 'teal' },
  unchanged: { label: 'už uloženo', color: 'gray' },
  pending: { label: 'čeká na rozhodnutí', color: 'orange' },
  skipped: { label: 'přeskočeno', color: 'gray' },
  busy: { label: 'kopíruje se', color: 'blue' },
  unsupported: { label: 'nepodporovaný formát', color: 'gray' },
  error: { label: 'chyba', color: 'red' },
};

const INBOX_ACTION: Record<InboxFile['status'], string> = {
  imported: 'Importovat znovu',
  unchanged: 'Importovat znovu',
  pending: 'Vyřešit',
  skipped: 'Importovat',
  busy: '',
  unsupported: '',
  error: 'Zkusit znovu',
};

export function SettingsPage() {
  const qc = useQueryClient();
  const sq = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const snap = useSnapshot();
  const [st, setSt] = useState<Settings | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dialog, setDialog] = useState<{ preview: ImportPreview; resolve: (d: ImportDecision | null) => void } | null>(null);
  const setDemo = useSetDemo();
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
  /** Previews each export; asks only when stored rows would be removed, otherwise merges right away. */
  const runImports = async (previews: (() => Promise<ImportPreview>)[], fromInbox = false) => {
    setUploading(true);
    try {
      for (const get of previews) {
        let p: ImportPreview;
        try {
          p = await get();
        } catch (e) {
          notifications.show({ message: (e as Error).message, color: 'red', autoClose: false });
          continue;
        }
        // an unchanged upload is dropped; an unchanged file from the exports folder is marked as done
        if (p.units.every((u) => u.plan.unchanged) && !fromInbox) {
          await api.importCancel(p.id);
          notifications.show({ message: `${p.fileName}: nic nového – tato data už jsou uložená.`, color: 'blue' });
          continue;
        }
        const decision: ImportDecision | null = p.conflict ? await new Promise<ImportDecision | null>((resolve) => setDialog({ preview: p, resolve })) : { mode: 'merge' };
        if (!decision) {
          await api.importCancel(p.id);
          notifications.show({ message: `${p.fileName}: import zrušen, uložená data se nezměnila.`, color: 'gray' });
          continue;
        }
        try {
          const r = await api.importCommit(p.id, decision.mode, decision.range);
          notifications.show({
            message: `${p.fileName} importován (${MODE_LABEL[decision.mode].label.toLowerCase()}): ${r.units.map((u) => `${u.label} – nové řádky: ${u.added}${u.removed ? `, odebrané: ${u.removed}` : ''}`).join(', ')}`,
            color: 'teal',
          });
          if (!p.conflict) for (const w of p.units.flatMap((u) => u.warnings)) notifications.show({ message: w, color: 'yellow', autoClose: false });
        } catch (e) {
          notifications.show({ message: (e as Error).message, color: 'red', autoClose: false });
        }
      }
    } finally {
      setUploading(false);
      await qc.invalidateQueries({ queryKey: ['status'] });
    }
  };
  const instruments = s?.instruments ?? [];
  const missing = missingMarketData(instruments);
  const demo = sq.data.demo;

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Nastavení a data</Title>
        <Button leftSection={<IconDeviceFloppy size={16} />} onClick={save}>
          Uložit a přepočítat
        </Button>
      </Group>

      <Section title="Zdroj dat">
        <Stack gap="xs">
          <SegmentedControl
            maw={420}
            data={[
              { value: 'real', label: 'Moje exporty' },
              { value: 'demo', label: 'Demo data' },
            ]}
            value={demo ? 'demo' : 'real'}
            onChange={(v) => void setDemo(v === 'demo')}
            data-testid="data-source"
          />
          <Text size="sm" c="dimmed">
            Demo data jsou smyšlené portfolio (Degiro a XTB, od roku 2023) s obchody na skutečných instrumentech za skutečné historické ceny. Jsou součástí aplikace a vaše
            exporty ani nastavení neovlivní – daňová situace, symboly a další volby se v demo režimu ukládají zvlášť.
          </Text>
          {demo && (
            <Alert color="orange" title="Zobrazena demo data">
              Výsledky ve všech sekcích pocházejí z ukázkových exportů. Vlastní exporty importujete po přepnutí na „Moje exporty“.
            </Alert>
          )}
        </Stack>
      </Section>

      <Section title="Exporty od brokerů a výpisy z účtů">
        <Stack>
          <TextInput
            label="Složka s exporty"
            description={
              demo
                ? 'V demo režimu se exporty načítají z ukázkových dat aplikace. Složku pro vlastní exporty změníte po přepnutí na „Moje exporty“.'
                : `Výchozí: ${sq.data.defaultExportsDir}. Aplikace do této složky nic nezapisuje. Nové exporty v ní při načtení sama naimportuje (rozdělené po letech do svých dat); soubory, které se liší od uložených dat, počkají na vaše rozhodnutí níže.`
            }
            placeholder={sq.data.defaultExportsDir}
            value={st.exportsDir ?? ''}
            disabled={demo}
            onChange={(e) => upd((x) => (x.exportsDir = e.currentTarget.value || undefined))}
          />
          <Dropzone
            loading={uploading}
            disabled={demo}
            onDrop={(files) =>
              void runImports(files.map((f) => () => api.importPreview(f)))
            }
            data-testid="import-dropzone"
          >
            <Group justify="center" gap="md" mih={90} style={{ pointerEvents: 'none' }}>
              <IconUpload size={32} />
              <div>
                <Text>{demo ? 'V demo režimu nelze importovat' : 'Přetáhněte nové exporty sem'}</Text>
                <Text size="xs" c="dimmed">
                  Degiro: Transactions.csv a Account.csv · XTB: export .zip nebo .xlsx · Fio, Komerční banka a Raiffeisenbank: výpis nebo pohyby v CSV. Stačí export za nové období – data se uloží po letech a sloučí s uloženými. Pokud se export v překrývajícím se období od uložených dat liší, zeptám se, co s rozdíly.
                </Text>
              </div>
            </Group>
          </Dropzone>
          {s?.storage ? (
            <Stack gap={6} data-testid="storage">
              <Text size="sm" fw={600}>
                Uložená data
              </Text>
              {s.storage.units.length === 0 && (
                <Text size="sm" c="dimmed">
                  Zatím nejsou uložená žádná data.
                </Text>
              )}
              {s.storage.units.map((u) => (
                <div key={u.unit}>
                  <Text size="sm" fw={500}>
                    {u.label}: {u.coverage.map((c) => `${date(c.from)} – ${date(c.to)}`).join(', ') || '–'}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Řádky po letech: {u.years.map((y) => `${y.year}: ${y.rows}`).join(' · ')}
                    {u.openPositionsAsOf && ` · otevřené pozice k ${date(u.openPositionsAsOf)}`}
                  </Text>
                  {u.gaps.length > 0 && (
                    <Text size="xs" c="orange">
                      Nepokryté období: {u.gaps.map((g) => `${date(g.from)} – ${date(g.to)}`).join(', ')}
                    </Text>
                  )}
                </div>
              ))}
              <Text size="xs" c="dimmed">
                Uloženo v {s.storage.storeDir}. Tuto složku nemažte – obsahuje celou importovanou historii, i když staré exporty už smažete.
              </Text>
              {s.storage.inbox.length > 0 && (
                <Stack gap={4} mt="xs" data-testid="inbox">
                  <Text size="sm" fw={600}>
                    Soubory ve složce s exporty
                  </Text>
                  {s.storage.inbox.filter((f) => f.status !== 'unsupported').map((f) => (
                    <Group key={f.path} gap="xs" wrap="nowrap">
                      <Badge size="sm" variant="light" color={INBOX_STATUS[f.status].color}>
                        {INBOX_STATUS[f.status].label}
                      </Badge>
                      <Text size="sm">
                        {f.path} ({f.kind}){f.message && f.status !== 'pending' ? ` – ${f.message}` : ''}
                      </Text>
                      {f.status !== 'busy' && (
                        <Button
                          size="compact-xs"
                          variant={f.status === 'pending' || f.status === 'error' ? 'filled' : 'subtle'}
                          disabled={uploading}
                          onClick={() => void runImports([() => api.importInbox(f.path)], true)}
                        >
                          {INBOX_ACTION[f.status]}
                        </Button>
                      )}
                    </Group>
                  ))}
                  {s.storage.inbox.some((f) => f.status === 'unsupported') && (
                    <Text size="xs" c="dimmed">
                      Dalších {s.storage.inbox.filter((f) => f.status === 'unsupported').length} souborů není podporovaný export (Degiro, XTB, výpis Fio, KB nebo Raiffeisenbank v CSV) – ignorují se.
                    </Text>
                  )}
                </Stack>
              )}
            </Stack>
          ) : (
            s && (
              <List size="sm">
                {s.sources.map((x, i) => (
                  <List.Item key={i}>
                    {x.broker}: {x.file} – {x.rows} řádků
                  </List.Item>
                ))}
              </List>
            )
          )}
          {dialog && (
            <ImportDialog
              preview={dialog.preview}
              onDecide={(d) => {
                setDialog(null);
                dialog.resolve(d);
              }}
            />
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

      <AccountsSettings />

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
