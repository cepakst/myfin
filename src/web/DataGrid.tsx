import { Group, MultiSelect, Stack, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { DataTable, type DataTableColumn, type DataTableRowExpansionProps, type DataTableSortStatus } from 'mantine-datatable';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { HintTitle } from './components';
import { distinctValues, filterRows, searchRows, sortRows, type GridColumnMeta } from './table';

const num = (n: number) => n.toLocaleString('cs-CZ');
/** "1–100 z 2 345" under a paginated table */
const pageText = ({ from, to, totalRecords }: { from: number; to: number; totalRecords: number }) => `${num(from)}–${num(to)} z ${num(totalRecords)}`;

export type GridColumn<T> = DataTableColumn<T> &
  Omit<GridColumnMeta<T>, 'accessor'> & {
    /** Show a multi-select value filter in the column header */
    filterable?: boolean;
    /** Explanation shown in a tooltip next to the column title */
    hint?: ReactNode;
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
  /** Rows per page; without it every row is rendered (fine for short tables only) */
  pageSize?: number;
  /** Loading overlay over the rows (e.g. while new filters are applied) */
  fetching?: boolean;
  /** Changing it returns to the first page (filters applied outside the grid); new records alone keep the page */
  pageResetKey?: string;
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
  pageSize,
  fetching,
  pageResetKey,
}: DataGridProps<T>) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [sort, setSort] = useState<DataTableSortStatus<T>>({
    columnAccessor: defaultSort?.column ?? '',
    direction: defaultSort?.direction ?? 'asc',
  });
  const metas = columns as (GridColumnMeta<T> & GridColumn<T>)[];
  // callers build `columns` inline (a new array on every render): the row work below must not
  // repeat for that, only when the records, the search, the filters or the order change
  const metasRef = useRef(metas);
  metasRef.current = metas;

  const filtered = useMemo(
    () => filterRows(searchRows(records, metasRef.current, query), metasRef.current, filters),
    [records, query, filters],
  );
  const shown = useMemo(() => {
    const col = metasRef.current.find((c) => c.accessor === sort.columnAccessor);
    return sortRows(filtered, col, sort.direction);
  }, [filtered, sort]);
  const filterable = columns.filter((c) => c.filterable).map((c) => String(c.accessor)).join('|');
  const options = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const c of metasRef.current) if (c.filterable) out.set(String(c.accessor), distinctValues(records, c as GridColumnMeta<T>));
    return out;
  }, [records, filterable]);

  // a new search, filter or order starts on the first page (also one set by the caller)
  const [page, setPage] = useState(1);
  const [resetKey, setResetKey] = useState(pageResetKey);
  if (resetKey !== pageResetKey) {
    setResetKey(pageResetKey);
    setPage(1);
  }
  const lastPage = pageSize ? Math.max(1, Math.ceil(shown.length / pageSize)) : 1;
  const current = Math.min(page, lastPage);
  const pageRows = useMemo(() => (pageSize ? shown.slice((current - 1) * pageSize, current * pageSize) : shown), [shown, pageSize, current]);
  const paginated = pageSize !== undefined && shown.length > pageSize;

  const cols: DataTableColumn<T>[] = columns.map((c) => {
    const { filterable, hint, sortValue: _s, searchValue: _q, filterValue: _f, ...col } = c;
    const out: DataTableColumn<T> = { sortable: true, ...col };
    if (hint) out.title = <HintTitle hint={hint}>{col.title}</HintTitle>;
    if (filterable) {
      const key = String(c.accessor);
      out.filtering = (filters[key]?.length ?? 0) > 0;
      out.filter = (
        <MultiSelect
          label="Zobrazit jen"
          data={options.get(key) ?? []}
          value={filters[key] ?? []}
          onChange={(v) => {
            setFilters((f) => ({ ...f, [key]: v }));
            setPage(1);
          }}
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
                onChange={(e) => {
                  setQuery(e.currentTarget.value);
                  setPage(1);
                }}
              />
            )}
            {toolbar}
          </Group>
          <Text size="xs" c="dimmed">
            {shown.length === records.length ? `${num(records.length)} záznamů` : `${num(shown.length)} z ${num(records.length)} záznamů`}
            {activeFilters && (
              <Text
                span
                size="xs"
                c="indigo"
                style={{ cursor: 'pointer' }}
                ml={6}
                onClick={() => {
                  setFilters({});
                  setPage(1);
                }}
              >
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
        records={pageRows}
        // mantine-datatable types pagination as all-or-nothing props
        {...((paginated ? { page: current, onPageChange: setPage, totalRecords: shown.length, recordsPerPage: pageSize, paginationText: pageText } : {}) as object)}
        fetching={fetching}
        columns={cols}
        sortStatus={sort}
        // A newly selected column always starts ascending instead of inheriting the previous direction
        onSortStatusChange={(next) => {
          setSort((prev) => (next.columnAccessor !== prev.columnAccessor ? { ...next, direction: 'asc' } : next));
          setPage(1);
        }}
        rowExpansion={rowExpansion}
        noRecordsText={noRecordsText}
        // mantine-datatable's own maxHeight only clips the table; the viewport must be limited to make it scroll
        scrollAreaProps={{ viewportProps: { style: { maxHeight } } }}
      />
    </Stack>
  );
}
