declare module 'fast-formula-parser' {
  interface CellRef {
    sheet: string;
    row: number;
    col: number;
  }
  interface RangeRef {
    sheet: string;
    from: { row: number; col: number };
    to: { row: number; col: number };
  }
  export interface FnArg {
    value: unknown;
    isRangeRef: boolean;
    isCellRef: boolean;
  }
  export default class FormulaParser {
    constructor(config: { onCell: (ref: CellRef) => unknown; onRange: (ref: RangeRef) => unknown[][]; functions?: Record<string, (...args: FnArg[]) => unknown> });
    parse(formula: string, position: CellRef): unknown;
  }
}
