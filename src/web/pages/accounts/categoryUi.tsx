import { Badge, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBook, IconHandClick, IconRobot, IconSparkles, IconBuildingBank, IconArrowsExchange, IconQuestionMark } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type AccountsSnapshot } from '../../api';
import { ruleForGroup, UNCATEGORIZED, type CategoryRule, type CategorySource } from '../../../core/accounts/categories';
import { czk } from '../../format';

type Tx = AccountsSnapshot['txs'][number];
type Category = AccountsSnapshot['categories'][number];

export const UNCAT_LABEL = 'Nezařazeno';

/** Stable colours for category charts */
const PALETTE = ['#4c6ef5', '#12b886', '#fab005', '#fa5252', '#7950f2', '#15aabf', '#fd7e14', '#82c91e', '#e64980', '#228be6', '#40c057', '#be4bdb', '#868e96', '#f76707', '#0ca678', '#5c7cfa', '#ff922b', '#20c997', '#94d82d'];
export function categoryColor(categories: Category[], id: string): string {
  if (id === UNCATEGORIZED) return '#adb5bd';
  const i = categories.findIndex((c) => c.id === id);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

export function categoryName(categories: Category[], id: string): string {
  return id === UNCATEGORIZED ? UNCAT_LABEL : (categories.find((c) => c.id === id)?.name ?? id);
}

const KIND_GROUP: Record<Category['kind'], string> = { expense: 'Výdaje', income: 'Příjmy', neutral: 'Mimo statistiky' };

export function categoryOptions(categories: Category[]) {
  return (['expense', 'income', 'neutral'] as const).map((k) => ({ group: KIND_GROUP[k], items: categories.filter((c) => c.kind === k).map((c) => ({ value: c.id, label: c.name })) }));
}

const SOURCE: Record<CategorySource, { label: string; icon: typeof IconBook; color: string }> = {
  manual: { label: 'ručně', icon: IconHandClick, color: 'blue' },
  rule: { label: 'pravidlo', icon: IconBook, color: 'indigo' },
  flow: { label: 'převod', icon: IconArrowsExchange, color: 'gray' },
  bank: { label: 'banka', icon: IconBuildingBank, color: 'gray' },
  dictionary: { label: 'slovník', icon: IconRobot, color: 'teal' },
  learned: { label: 'návrh', icon: IconSparkles, color: 'orange' },
  none: { label: 'nezařazeno', icon: IconQuestionMark, color: 'gray' },
};

/** Small icon telling where the category came from; the tooltip explains why. */
export function SourceIcon({ t }: { t: Pick<Tx, 'categorySource' | 'categoryReason'> }) {
  const s = SOURCE[t.categorySource];
  // a native title instead of a Tooltip: thousands of rows stay cheap
  return (
    <span title={`${s.label}: ${t.categoryReason}`} style={{ display: 'inline-flex', flexShrink: 0 }} data-testid={`source-${t.categorySource}`}>
      <s.icon size={14} color={`var(--mantine-color-${s.color}-6)`} aria-label={s.label} />
    </span>
  );
}

export function SourceBadge({ source }: { source: CategorySource }) {
  const s = SOURCE[source];
  return (
    <Badge size="xs" variant="light" color={s.color} leftSection={<s.icon size={10} />}>
      {s.label}
    </Badge>
  );
}

let ruleSeq = 0;
export function newRuleId(): string {
  return `r-${Date.now().toString(36)}-${(ruleSeq++).toString(36)}`;
}

/** Saves category assignments and rules; the accounts snapshot is replaced by the server's answer. */
export function useCategorize() {
  const qc = useQueryClient();
  return async (assign: Record<string, string | null>, rules: CategoryRule[] = [], message?: string) => {
    try {
      const snap = await api.categorize(assign, rules);
      qc.setQueryData(['accounts'], snap);
      if (message) notifications.show({ message, color: 'teal' });
      return true;
    } catch (e) {
      notifications.show({ message: (e as Error).message, color: 'red' });
      return false;
    }
  };
}

/** Czech plural: 1 transakce, 2–4 transakce, 5+ transakcí */
export function plural(n: number, one: string, few: string, many: string): string {
  return n === 1 ? one : n >= 2 && n <= 4 ? few : many;
}

/** Transactions grouped by counterparty and direction (see `similarKey`) */
export function groupSimilar(txs: Tx[]): Map<string, Tx[]> {
  const m = new Map<string, Tx[]>();
  for (const t of txs) {
    const k = similarKey(t);
    const l = m.get(k);
    if (l) l.push(t);
    else m.set(k, [t]);
  }
  return m;
}

export function similarKey(t: Pick<Tx, 'cpKey' | 'amount'>): string {
  return `${t.amount >= 0 ? 'in' : 'out'}|${t.cpKey}`;
}

/**
 * Assigns a whole counterparty group: a rule for the group (also future transactions). Manual
 * assignments to the same category are dropped (the rule covers them); manual assignments to a
 * different category are deliberate exceptions and are kept.
 */
export function groupAssignment(txs: Tx[], category: string): { assign: Record<string, string | null>; rules: CategoryRule[]; kept: number } {
  const rule = ruleForGroup(txs[0], category, newRuleId());
  // no counterparty to describe (e.g. a fee without a name): assign the transactions themselves
  if (!rule) return { assign: Object.fromEntries(txs.map((t) => [t.key, category])), rules: [], kept: 0 };
  const assign: Record<string, string | null> = {};
  let kept = 0;
  for (const t of txs) {
    if (t.categorySource !== 'manual') continue;
    if (t.category === category) assign[t.key] = null;
    else kept++;
  }
  return { assign, rules: [rule], kept };
}

/**
 * Category changes of single transactions for a whole page. Picking a category for a transaction
 * whose counterparty has more transactions asks (one modal per page) whether to assign them all.
 */
export function useTxPicker(a: AccountsSnapshot, groups: Map<string, Tx[]>) {
  const save = useCategorize();
  const [pending, setPending] = useState<{ t: Tx; category: string } | null>(null);
  const pick = (t: Tx, category: string | null) => {
    if (category === null) {
      void save({ [t.key]: null }, [], 'Kategorie vrácena na automatickou');
      return;
    }
    const similar = groups.get(similarKey(t)) ?? [t];
    if (similar.length > 1 && ruleForGroup(t, category, 'probe')) setPending({ t, category });
    else void save({ [t.key]: category }, [], 'Zařazeno');
  };
  const similar = pending ? (groups.get(similarKey(pending.t)) ?? [pending.t]) : [];
  const decision = pending ? groupAssignment(similar, pending.category) : null;
  const apply = async (scope: 'one' | 'all') => {
    if (!pending || !decision) return;
    setPending(null);
    const done = similar.length - decision.kept;
    if (scope === 'one') await save({ [pending.t.key]: pending.category }, [], 'Zařazeno');
    else await save(decision.assign, decision.rules, `Zařazeno: ${done} ${plural(done, 'transakce', 'transakce', 'transakcí')}, vytvořeno pravidlo`);
  };
  const n = similar.length;
  const modal = (
    <Modal opened={pending !== null} onClose={() => setPending(null)} title="Zařadit i podobné transakce?" centered>
      {pending && decision && (
        <Stack>
          <Text size="sm">
            Protistrana <b>{pending.t.cpLabel}</b> má {n} {pending.t.amount >= 0 ? plural(n, 'příchozí', 'příchozí', 'příchozích') : plural(n, 'odchozí', 'odchozí', 'odchozích')}{' '}
            {plural(n, 'transakci', 'transakce', 'transakcí')} (celkem {czk(similar.reduce((s, x) => s + (x.amountCzk ?? 0), 0))}). Chcete je všechny zařadit do kategorie „
            {categoryName(a.categories, pending.category)}“? Vytvoří se pravidlo, takže se tak zařadí i budoucí transakce.
            {decision.kept > 0 && ` Ručně zařazené do jiné kategorie (${decision.kept}) zůstanou beze změny.`}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => void apply('one')}>
              Jen tuto
            </Button>
            <Button onClick={() => void apply('all')} data-testid="assign-all">
              Všechny ({n}) + pravidlo
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
  return { pick, modal };
}

/** Category of one transaction: a light button that turns into a picker on click (fast for long lists). */
export function TxCategorySelect({ t, a, onPick }: { t: Tx; a: AccountsSnapshot; onPick: (t: Tx, category: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <Group gap={4} wrap="nowrap">
      <SourceIcon t={t} />
      {!editing ? (
        <Button
          size="compact-xs"
          variant={t.category ? 'light' : 'outline'}
          color={t.categorySource === 'learned' ? 'orange' : t.category ? 'gray' : 'red'}
          w={170}
          styles={{ inner: { justifyContent: 'flex-start' } }}
          onClick={() => setEditing(true)}
          aria-label={`Kategorie: ${categoryName(a.categories, t.category)}`}
          data-testid="tx-category"
        >
          {categoryName(a.categories, t.category)}
        </Button>
      ) : (
        <Select
          autoFocus
          defaultDropdownOpened
          onDropdownClose={() => setEditing(false)}
          size="xs"
          w={170}
          data={categoryOptions(a.categories)}
          value={t.category || null}
          placeholder={UNCAT_LABEL}
          searchable
          allowDeselect={false}
          clearable={t.categorySource === 'manual'}
          aria-label="Kategorie"
          // picking the shown category confirms it (e.g. a suggestion), so react to every submit
          onOptionSubmit={(v) => {
            setEditing(false);
            onPick(t, v);
          }}
          onChange={(v) => {
            if (v === null) {
              setEditing(false);
              onPick(t, null);
            }
          }}
          comboboxProps={{ withinPortal: true }}
        />
      )}
    </Group>
  );
}
