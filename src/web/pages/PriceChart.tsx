import { Group, SegmentedControl, Text } from '@mantine/core';
import { useState } from 'react';
import type { InstrumentDetail } from '../api';
import { Chart } from '../components';
import { date, money, num } from '../format';
import { adjustPrice, adjustQuantity, splitFactor, splitLabel, type Split } from '../../core/analytics/splitAdjust';

type Trade = InstrumentDetail['trades'][number];
type Mode = 'adjusted' | 'actual';

const BUY = '#12b886';
const SELL = '#fa5252';
const SPLIT = '#7950f2';

/** ECharts renders string tooltips as HTML: values from exports (e.g. a currency cell) are escaped */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "akcie" for 1–4 (and fractions like 1,5), "akcií" for 5 and more */
const shareWord = (n: number) => (Number.isInteger(n) && n >= 5 ? 'akcií' : 'akcie');
/** prices adjusted for big splits can be fractions of a cent: up to 4 decimals instead of money()'s 2 */
const price = (n: number, cur: string) => `${num(n)} ${cur}`;

/** Explanation of one split for the hover label of its line. */
function splitText(s: Split, cur: string, adjusted: boolean): string {
  const shares = s.ratio >= 1 ? `1 akcie → ${num(s.ratio)} ${shareWord(s.ratio)}` : `${num(1 / s.ratio)} ${shareWord(1 / s.ratio)} → 1 akcie`;
  const kind = s.ratio >= 1 ? 'Split' : 'Zpětný split';
  const prices = adjusted
    ? `Ceny před tímto dnem jsou ${s.ratio >= 1 ? 'vyděleny' : 'vynásobeny'} ${num(s.ratio >= 1 ? s.ratio : 1 / s.ratio)}, aby navazovaly na dnešní akcie.`
    : `Cena za akcii se tento den ${s.ratio >= 1 ? 'snížila' : 'zvýšila'} zhruba ${num(s.ratio >= 1 ? s.ratio : 1 / s.ratio)}× (${cur}).`;
  return `${kind} ${splitLabel(s.ratio)} (${date(s.date)})\n${shares}\n${prices}`;
}

function tradeLine(t: Trade, splits: Split[], adjusted: boolean): string {
  const side = t.quantity > 0 ? 'Nákup' : 'Prodej';
  const actual = esc(`${side} ${num(Math.abs(t.quantity))} ks za ${money(t.price, t.currency)}`);
  const f = splitFactor(splits, t.date);
  if (!adjusted || f === 1) return actual;
  const after = esc(`po splitech odpovídá ${num(Math.abs(adjustQuantity(splits, t.date, t.quantity)))} ks za ${price(adjustPrice(splits, t.date, t.price), t.currency)}`);
  return `${actual}<br/><span style="opacity:.7">${after}</span>`;
}

/**
 * Price history with buys and sells. By default split-adjusted (as on charting sites), so a split
 * is not a crash; splits are marked by a vertical line explained on hover.
 */
export function PriceChart({ d, cur }: { d: InstrumentDetail; cur: string }) {
  const first = d.prices[0]?.date ?? '';
  // splits inside the shown history (older ones change nothing on the chart)
  const splits = (d.splits ?? []).filter((s) => s.date > first);
  const [mode, setMode] = useState<Mode>('adjusted');
  const adjusted = mode === 'adjusted' && splits.length > 0;
  const px = (dt: string, p: number) => (adjusted ? adjustPrice(splits, dt, p) : p);
  const trades = d.trades.filter((t) => t.currency === cur);
  const point = (t: Trade) => ({ value: [t.date, Number(px(t.date, t.price).toFixed(6))], trade: t });
  // the axis tooltip only shows the nearest price: a trade explains itself when hovered
  const tradeTooltip = { trigger: 'item' as const, formatter: (p: any) => `${esc(date(p.data.trade.date))}<br/>${p.marker}${tradeLine(p.data.trade, splits, adjusted)}` };

  return (
    <>
      {splits.length > 0 && (
        <Group justify="space-between" mb="xs">
          <Text size="xs" c="dimmed">
            {adjusted ? 'Ceny před splitem jsou přepočtené na dnešní akcie. Kusy a ceny ve výpisech zůstávají skutečné.' : 'Skutečné ceny v daný den – při splitu cena skočí.'}
          </Text>
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={(v) => setMode(v as Mode)}
            data={[
              { value: 'adjusted', label: 'Upraveno o splity' },
              { value: 'actual', label: 'Skutečné ceny' },
            ]}
            aria-label="Zobrazení cen"
            data-testid="split-mode"
          />
        </Group>
      )}
      <Chart
        height={380}
        option={{
          tooltip: {
            trigger: 'axis',
            formatter: (params: any) => {
              const list = (Array.isArray(params) ? params : [params]) as any[];
              const head = list[0] ? esc(date(String(list[0].value?.[0] ?? list[0].axisValue).slice(0, 10))) : '';
              // trade markers have their own item tooltip (ECharts leaves them out of the axis one)
              const lines = list.map((p) => `${p.marker}${p.seriesName}: ${esc(price(p.value[1], cur))}`);
              return [head, ...lines].join('<br/>');
            },
          },
          legend: {},
          grid: { left: 60, right: 20, top: 40, bottom: 60 },
          xAxis: { type: 'time' },
          yAxis: { type: 'value', scale: true },
          dataZoom: [{ type: 'inside' }, { type: 'slider' }],
          series: [
            {
              name: 'Cena',
              type: 'line',
              showSymbol: false,
              sampling: 'lttb',
              data: d.prices.map((p) => [p.date, Number(px(p.date, p.close).toFixed(6))]),
              markLine: splits.length
                ? {
                    symbol: 'none',
                    silent: false,
                    lineStyle: { color: SPLIT, type: 'dashed', width: 1.5 },
                    label: { show: true, position: 'insideEndTop', color: SPLIT, fontSize: 11, formatter: (p: any) => `${p.data.ratio >= 1 ? 'Split' : 'Zpětný split'} ${splitLabel(p.data.ratio)}` },
                    emphasis: { lineStyle: { width: 3 } },
                    // a horizontal tooltip on hover (a label would be rotated along the line)
                    tooltip: { trigger: 'item', formatter: (p: any) => esc(splitText(p.data, cur, adjusted)).split('\n').join('<br/>') },
                    data: splits.map((s) => ({ xAxis: s.date, ratio: s.ratio, date: s.date })),
                  }
                : undefined,
            },
            { name: 'Nákup', type: 'scatter', symbol: 'triangle', symbolSize: 11, itemStyle: { color: BUY }, tooltip: tradeTooltip, data: trades.filter((t) => t.quantity > 0).map(point) },
            { name: 'Prodej', type: 'scatter', symbol: 'triangle', symbolRotate: 180, symbolSize: 11, itemStyle: { color: SELL }, tooltip: tradeTooltip, data: trades.filter((t) => t.quantity < 0).map(point) },
          ],
        }}
      />
    </>
  );
}
