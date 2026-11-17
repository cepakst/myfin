import { ActionIcon, Button, Checkbox, Group, NumberInput, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDeviceFloppy, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, useAccounts, type AccountsConfig } from '../../api';
import { Section } from '../../components';
import { normAccount } from '../../../core/accounts/analytics';
import { PRODUCT_LABEL, type ProductType } from '../../../core/accounts/types';

const PRODUCT_OPTIONS = Object.entries(PRODUCT_LABEL).map(([value, label]) => ({ value, label }));

/** Settings of the accounts module: names, product types, balances, own accounts. */
export function AccountsSettings() {
  const q = useAccounts();
  const qc = useQueryClient();
  const [cfg, setCfg] = useState<AccountsConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // a recomputation (e.g. a new export imported meanwhile) must not discard unsaved edits
  useEffect(() => {
    if (q.data && !dirty) setCfg(structuredClone(q.data.config));
  }, [q.data, dirty]);
  if (!q.data || !cfg) return null;
  const a = q.data;

  const upd = (fn: (c: AccountsConfig) => void) => {
    setDirty(true);
    setCfg((c) => {
      const n = structuredClone(c!);
      fn(n);
      return n;
    });
  };
  const acc = (c: AccountsConfig, id: string) => (c.accounts[id] ??= {});

  const save = async () => {
    const invalid = cfg.ownAccounts.filter((o) => !normAccount(o.account));
    if (invalid.length) {
      notifications.show({ message: `Neplatné číslo účtu: ${invalid.map((o) => o.account || '(prázdné)').join(', ')}. Použijte formát [předčíslí-]číslo/kód banky.`, color: 'red' });
      return;
    }
    setSaving(true);
    try {
      // only this section's part: the server keeps categories, rules and assignments
      const snap = await api.saveAccountsConfig({ accounts: cfg.accounts, ownAccounts: cfg.ownAccounts });
      setDirty(false);
      qc.setQueryData(['accounts'], snap);
      notifications.show({ message: 'Nastavení účtů uloženo', color: 'teal' });
    } catch (e) {
      notifications.show({ message: (e as Error).message, color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Bankovní účty"
      right={
        <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={saving} onClick={() => void save()} data-testid="accounts-save">
          Uložit účty
        </Button>
      }
    >
      <Stack>
        {a.accounts.length === 0 ? (
          <Text size="sm" c="dimmed">
            Zatím nejsou importované žádné výpisy z účtů.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={760}>
            <Table data-testid="accounts-settings">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Účet</Table.Th>
                  <Table.Th>Vlastní název</Table.Th>
                  <Table.Th>Produkt</Table.Th>
                  <Table.Th>Zůstatek k datu</Table.Th>
                  <Table.Th>Skrýt</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {a.accounts.map((x) => {
                  const c = cfg.accounts[x.id] ?? {};
                  return (
                    <Table.Tr key={x.id}>
                      <Table.Td>
                        <Text size="sm">{x.id}</Text>
                        <Text size="xs" c="dimmed">
                          {x.bankName}
                          {x.exportName ? ` · ${x.exportName}` : ''} · {x.currency}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <TextInput
                          size="xs"
                          placeholder={x.exportName ?? `${x.bankName} ${x.number}`}
                          value={c.alias ?? ''}
                          aria-label={`Název účtu ${x.id}`}
                          onChange={(e) => {
                            const v = e.currentTarget.value;
                            upd((n) => (acc(n, x.id).alias = v || undefined));
                          }}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Select
                          size="xs"
                          data={PRODUCT_OPTIONS}
                          value={c.product ?? x.productInferred}
                          aria-label={`Produkt ${x.id}`}
                          allowDeselect={false}
                          onChange={(v) => upd((n) => (acc(n, x.id).product = v === x.productInferred ? undefined : (v as ProductType)))}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          <TextInput
                            size="xs"
                            type="date"
                            w={140}
                            value={c.anchor?.date ?? ''}
                            aria-label={`Datum zůstatku ${x.id}`}
                            onChange={(e) => {
                              const d = e.currentTarget.value;
                              // prefilled with the balance currently shown for the account
                              upd((n) => (acc(n, x.id).anchor = d ? { date: d, balance: n.accounts[x.id]?.anchor?.balance ?? x.balance } : undefined));
                            }}
                          />
                          <NumberInput
                            size="xs"
                            w={140}
                            decimalScale={2}
                            decimalSeparator=","
                            thousandSeparator=" "
                            placeholder={x.anchored && !c.anchor ? 'z výpisu' : 'zůstatek'}
                            value={c.anchor?.balance ?? ''}
                            aria-label={`Zůstatek ${x.id}`}
                            onChange={(v) =>
                              upd((n) => {
                                // clearing the amount removes the entered balance
                                acc(n, x.id).anchor = typeof v === 'number' ? { date: n.accounts[x.id]?.anchor?.date ?? a.today, balance: v } : undefined;
                              })
                            }
                          />
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Checkbox checked={!!c.hidden} aria-label={`Skrýt ${x.id}`} onChange={(e) => {
                          const v = e.currentTarget.checked;
                          upd((n) => (acc(n, x.id).hidden = v || undefined));
                        }} />
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        <Text size="xs" c="dimmed">
          Zůstatek k datu zadejte u účtů, jejichž export zůstatek neobsahuje (Raiffeisenbank): zůstatek na konci zadaného dne, například ten aktuální z internetového bankovnictví.
          Zůstatky v ostatních dnech se dopočítají z pohybů. Skryté účty se nezapočítávají do zůstatků ani statistik.
        </Text>

        <Text size="sm" fw={600}>
          Další vlastní účty
        </Text>
        <Text size="xs" c="dimmed">
          Platby mezi importovanými účty se poznají samy a nepočítají se do příjmů ani výdajů. Sem přidejte vlastní účty u jiných bank (převody na ně se také nepočítají) a účty
          brokerů nebo investic (převody na ně se počítají jako investice, ne jako výdaj). Formát: [předčíslí-]číslo/kód banky.
        </Text>
        {cfg.ownAccounts.map((o, i) => (
          <Group key={i} gap="xs" wrap="nowrap">
            <TextInput size="xs" w={220} value={o.account} aria-label="Číslo účtu" placeholder="123456789/0800" onChange={(e) => {
              const v = e.currentTarget.value;
              upd((n) => (n.ownAccounts[i].account = v));
            }} />
            <TextInput size="xs" w={220} value={o.label ?? ''} aria-label="Popis" placeholder="Popis" onChange={(e) => {
              const v = e.currentTarget.value;
              upd((n) => (n.ownAccounts[i].label = v || undefined));
            }} />
            <Select
              size="xs"
              w={200}
              data={[
                { value: 'own', label: 'Vlastní účet' },
                { value: 'investment', label: 'Investiční účet' },
              ]}
              value={o.kind}
              allowDeselect={false}
              aria-label="Druh účtu"
              onChange={(v) => upd((n) => (n.ownAccounts[i].kind = v === 'investment' ? 'investment' : 'own'))}
            />
            <ActionIcon variant="subtle" color="red" aria-label="Odebrat účet" onClick={() => upd((n) => n.ownAccounts.splice(i, 1))}>
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        ))}
        <Group>
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => upd((n) => n.ownAccounts.push({ account: '', kind: 'own' }))}>
            Přidat účet
          </Button>
        </Group>
      </Stack>
    </Section>
  );
}
