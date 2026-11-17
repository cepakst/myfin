import { ActionIcon, Button, Group, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDeviceFloppy, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, useAccounts, type AccountsConfig } from '../../api';
import { Section } from '../../components';
import { DEFAULT_CATEGORIES, describeRule, LOCKED, type Category, type CategoryKind } from '../../../core/accounts/categories';
import { categoryOptions } from './categoryUi';

const KIND_OPTIONS = [
  { value: 'expense', label: 'Výdaj' },
  { value: 'income', label: 'Příjem' },
  { value: 'neutral', label: 'Mimo statistiky' },
];

function slug(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'kategorie';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** Settings: the user's categories, categorisation rules and manual assignments. */
export function CategoriesSettings() {
  const q = useAccounts();
  const qc = useQueryClient();
  const [cfg, setCfg] = useState<AccountsConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (q.data && !dirty) setCfg(structuredClone(q.data.config));
  }, [q.data, dirty]);
  // transactions per rule and per category as the server categorised them (one pass, not per keystroke)
  const counts = useMemo(() => {
    const byRule = new Map<string, number>();
    const byCat = new Map<string, number>();
    for (const t of q.data?.txs ?? []) {
      if (t.ruleId) byRule.set(t.ruleId, (byRule.get(t.ruleId) ?? 0) + 1);
      byCat.set(t.category, (byCat.get(t.category) ?? 0) + 1);
    }
    return { byRule, byCat };
  }, [q.data]);
  if (!q.data || !cfg) return null;
  const categories: Category[] = cfg.categories ?? DEFAULT_CATEGORIES;

  const upd = (fn: (c: AccountsConfig) => void) => {
    setDirty(true);
    setCfg((c) => {
      const n = structuredClone(c!);
      fn(n);
      return n;
    });
  };
  const updCats = (fn: (cats: Category[]) => void) =>
    upd((n) => {
      const cats = structuredClone(n.categories ?? DEFAULT_CATEGORIES);
      fn(cats);
      n.categories = cats;
    });

  const save = async () => {
    if (categories.some((c) => !c.name.trim())) {
      notifications.show({ message: 'Každá kategorie musí mít název.', color: 'red' });
      return;
    }
    setSaving(true);
    try {
      // only this section's part (the server keeps the rest); manual assignments only when cleared here,
      // so that categorising on other pages meanwhile is not undone
      const part: Parameters<typeof api.saveAccountsConfig>[0] = { categories: cfg.categories ?? null, rules: cfg.rules };
      if (Object.keys(cfg.overrides).length === 0) part.overrides = {};
      const snap = await api.saveAccountsConfig(part);
      setDirty(false);
      qc.setQueryData(['accounts'], snap);
      notifications.show({ message: 'Kategorie a pravidla uloženy', color: 'teal' });
    } catch (e) {
      notifications.show({ message: (e as Error).message, color: 'red' });
    } finally {
      setSaving(false);
    }
  };
  const manual = Object.keys(cfg.overrides).length;
  const ruleCat = (id: string) => categories.find((c) => c.id === id);

  return (
    <Section
      title="Kategorie a pravidla"
      right={
        <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={saving} onClick={() => void save()} data-testid="categories-save">
          Uložit kategorie
        </Button>
      }
    >
      <Stack>
        <Text size="xs" c="dimmed">
          Kategorie „Mimo statistiky“ (např. převody mezi účty) se nezapočítávají do příjmů ani výdajů. Smazáním kategorie se smažou i její pravidla a ruční zařazení – transakce se
          pak zařadí znovu automaticky.
        </Text>
        <Table data-testid="categories-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Název</Table.Th>
              <Table.Th>Druh</Table.Th>
              <Table.Th ta="right">Transakcí</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {categories.map((c, i) => (
              <Table.Tr key={c.id}>
                <Table.Td>
                  <TextInput size="xs" value={c.name} aria-label={`Název kategorie ${c.id}`} onChange={(e) => {
                    const v = e.currentTarget.value;
                    updCats((cats) => (cats[i].name = v));
                  }} />
                </Table.Td>
                <Table.Td>
                  <Select size="xs" w={160} data={KIND_OPTIONS} value={c.kind} allowDeselect={false} disabled={LOCKED.has(c.id)} aria-label={`Druh kategorie ${c.id}`} onChange={(v) => updCats((cats) => (cats[i].kind = v as CategoryKind))} />
                </Table.Td>
                <Table.Td ta="right">{counts.byCat.get(c.id) ?? 0}</Table.Td>
                <Table.Td>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    disabled={LOCKED.has(c.id)}
                    title={LOCKED.has(c.id) ? 'Tuto kategorii nelze smazat – podle ní se poznají převody mezi vlastními účty a investice.' : undefined}
                    aria-label={`Smazat kategorii ${c.name}`} onClick={() => updCats((cats) => cats.splice(i, 1))}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => updCats((cats) => cats.push({ id: slug('nova kategorie', new Set(cats.map((c) => c.id))), name: 'Nová kategorie', kind: 'expense' }))}
          >
            Přidat kategorii
          </Button>
          {cfg.categories && (
            <Button size="xs" variant="subtle" onClick={() => upd((n) => (n.categories = undefined))}>
              Obnovit výchozí kategorie
            </Button>
          )}
        </Group>

        <Text size="sm" fw={600}>
          Pravidla ({cfg.rules.length})
        </Text>
        {cfg.rules.length === 0 ? (
          <Text size="xs" c="dimmed">
            Zatím žádná pravidla. Vzniknou, když na stránce Zařadit nebo u transakce zvolíte kategorii pro všechny transakce stejné protistrany.
          </Text>
        ) : (
          <Table data-testid="rules-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Podmínka</Table.Th>
                <Table.Th>Kategorie</Table.Th>
                <Table.Th ta="right">
                  <span title="Kolik transakcí pravidlo zařadilo při posledním uložení (pravidlo výše nebo ruční zařazení má přednost).">Transakcí</span>
                </Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {cfg.rules.map((r, i) => (
                <Table.Tr key={r.id}>
                  <Table.Td>
                    <Text size="sm">{describeRule(r.match)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Select
                      size="xs"
                      w={200}
                      data={categoryOptions(categories)}
                      value={ruleCat(r.category) ? r.category : null}
                      allowDeselect={false}
                      aria-label="Kategorie pravidla"
                      onChange={(v) => v && upd((n) => (n.rules[i].category = v))}
                    />
                  </Table.Td>
                  <Table.Td ta="right">{counts.byRule.get(r.id) ?? 0}</Table.Td>
                  <Table.Td>
                    <ActionIcon variant="subtle" color="red" aria-label="Smazat pravidlo" onClick={() => upd((n) => n.rules.splice(i, 1))}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        <Group gap="xs">
          <Text size="sm">Ručně zařazených transakcí: {manual}</Text>
          {manual > 0 && (
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => upd((n) => (n.overrides = {}))}>
              Zrušit všechna ruční zařazení
            </Button>
          )}
        </Group>
      </Stack>
    </Section>
  );
}
