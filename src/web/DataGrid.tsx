import { Group, MultiSelect, Stack, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { DataTable, type DataTableColumn, type DataTableRowExpansionProps, type DataTableSortStatus } from 'mantine-datatable';
import { useMemo, useState, type ReactNode } from 'react';
import { distinctValues, filterRows, searchRows, sortRows, type GridColumnMeta } from './table';

export type GridColumn<T> = DataTableColumn<T> &
  Omit<GridColumnMeta<T>, 'accessor'> & {
    /** Show a multi-select value filter in the column header */
    filterable?: boolean;
  };

export interface DataGridProps<T> {
  records: T[];
  columns: GridColumn<T>[];
  idAccessor: (keyof T & string) | ((r: T) => string);
  defaultSort?: { column: string; direction: 'asc' | 'desc' };
  /** Height of the scrollable body; the header stays visible while scrolling */
  maxHeight?: number;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Extra controls rendered next to the search box */
  toolbar?: ReactNode;
  fz?: 'xs' | 'sm';
  rowExpansion?: DataTableRowExpansionProps<T>;
  noRecordsText?: string;
  /** Accessible name of the table */
  label?: string;
}

/**
 * Table with sorting on every column (unless `sortable: false`), full-text search, optional per-column value filters
 * and a scrollable body. Use for every table with more than a handful of rows.
 */
export function DataGrid<T>({
  records,
  columns,
  idAccessor,
  defaultSort,
  maxHeight = 560,
  searchable = true,
  searchPlaceholder = 'Hledat…',
  toolbar,
  fz = 'sm',
  rowExpansion,
  noRecordsText = 'Žádné záznamy',
  label,
}: DataGridProps<T>) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [sort, setSort] = useState<DataTableSortStatus<T>>({
    columnAccessor: defaultSort?.column ?? '',
    direction: defaultSort?.direction ?? 'asc',
  });
  const metas = columns as (GridColumnMeta<T> & GridColumn<T>)[];

  const filtered = useMemo(() => filterRows(searchRows(records, metas, query), metas, filters), [records, metas, query, filters]);
  const shown = useMemo(() => {
    const col = metas.find((c) => c.accessor === sort.columnAccessor);
    return sortRows(filtered, col, sort.direction);
  }, [filtered, metas, sort]);

  const cols: DataTableColumn<T>[] = columns.map((c) => {
    const { filterable, sortValue: _s, searchValue: _q, filterValue: _f, ...col } = c;
    const out: DataTableColumn<T> = { sortable: true, ...col };
    if (filterable) {
      const key = String(c.accessor);
      const options = distinctValues(records, c as GridColumnMeta<T>);
      out.filtering = (filters[key]?.length ?? 0) > 0;
      out.filter = (
        <MultiSelect
          label="Zobrazit jen"
          data={options}
          value={filters[key] ?? []}
          onChange={(v) => setFilters((f) => ({ ...f, [key]: v }))}
          clearable
          searchable
          comboboxProps={{ withinPortal: false }}
          w={260}
        />
      );
    }
    return out;
  });

  const activeFilters = Object.values(filters).some((v) => v.length > 0);
  return (
    <Stack gap="xs">
      {(searchable || toolbar) && (
        <Group justify="space-between" gap="xs">
          <Group gap="xs">
            {searchable && (
              <TextInput
                size="xs"
                w={240}
                leftSection={<IconSearch size={14} />}
                placeholder={searchPlaceholder}
                aria-label="Hledat v tabulce"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
            )}
            {toolbar}
          </Group>
          <Text size="xs" c="dimmed">
            {shown.length === records.length ? `${records.length} záznamů` : `${shown.length} z ${records.length} záznamů`}
            {activeFilters && (
              <Text span size="xs" c="indigo" style={{ cursor: 'pointer' }} ml={6} onClick={() => setFilters({})}>
                · zrušit filtry
              </Text>
            )}
          </Text>
        </Group>
      )}
      <DataTable<T>
        aria-label={label}
        withTableBorder
        striped
        highlightOnHover
        fz={fz}
        minHeight={shown.length ? undefined : 150}
        idAccessor={idAccessor as never}
        records={shown}
        columns={cols}
        sortStatus={sort}
        // A newly selected column always starts ascending instead of inheriting the previous direction
        onSortStatusChange={(next) =>
          setSort((prev) => (next.columnAccessor !== prev.columnAccessor ? { ...next, direction: 'asc' } : next))
        }
        rowExpansion={rowExpansion}
        noRecordsText={noRecordsText}
        // mantine-datatable's own maxHeight only clips the table; the viewport must be limited to make it scroll
        scrollAreaProps={{ viewportProps: { style: { maxHeight } } }}
      />
    </Stack>
  );
}
