import Delta, { OpIterator } from 'quill-delta';
import Op from 'quill-delta/dist/Op';
import Module from '../core/module';

export type CellData = {
  content?: Delta['ops'];
  attributes?: Record<string, unknown>;
};

export type TableRowColumnOp = Omit<Op, 'insert'> & {
  insert?: { id: string };
};

export interface TableData {
  rows?: Delta['ops'];
  columns?: Delta['ops'];
  cells?: Record<string, CellData>;
}


export interface TableInsert {
  insert: {
    'table-embed': TableData;
  };
}

const parseCellIdentity = (identity: string) => {
  const parts = identity.split(':');
  return [Number(parts[0]) - 1, Number(parts[1]) - 1];
};

const stringifyCellIdentity = (row: number, column: number) =>
  `${row + 1}:${column + 1}`;

export const composePosition = (delta: Delta, index: number) => {
  let newIndex = index;
  const thisIter = new OpIterator(delta.ops);
  let offset = 0;
  while (thisIter.hasNext() && offset <= newIndex) {
    const length = thisIter.peekLength();
    const nextType = thisIter.peekType();
    thisIter.next();
    switch (nextType) {
      case 'delete':
        if (length > newIndex - offset) {
          return null;
        }
        newIndex -= length;
        break;
      case 'insert':
        newIndex += length;
        offset += length;
        break;
      default:
        offset += length;
        break;
    }
  }
  return newIndex;
};

const compactCellData = ({ content, attributes }: CellData) => {
  const data: CellData = {};
  if (content && content.length > 0) {
    data.content = content;
  }
  if (attributes && Object.keys(attributes).length > 0) {
    data.attributes = attributes;
  }
  return Object.keys(data).length > 0 ? data : null;
};

const compactTableData = ({ rows, columns, cells }: TableData) => {
  const data: TableData = {};
  if (rows && rows.length > 0) {
    data.rows = rows;
  }

  if (columns && columns.length > 0) {
    data.columns = columns;
  }

  if (cells && Object.keys(cells).length) {
    data.cells = cells;
  }

  return data;
};

const reindexCellIdentities = (cells: NonNullable<TableData['cells']>, { rows, columns }: TableData) => {
  const reindexedCells: NonNullable<TableData['cells']> = {};
  Object.keys(cells).forEach(identity => {
    let [row, column] = parseCellIdentity(identity);

    // @ts-expect-error Fix me later
    row = composePosition(rows, row);
    // @ts-expect-error Fix me later
    column = composePosition(columns, column);

    if (row !== null && column !== null) {
      const newPosition = stringifyCellIdentity(row, column);
      reindexedCells[newPosition] = cells[identity];
    }
  }, false);
  return reindexedCells;
};

export const tableHandler = {
  compose(a: TableData, b: TableData, keepNull?: boolean) {
    const rows = new Delta(a.rows || []).compose(new Delta(b.rows || [])).ops;
    const columns = new Delta(a.columns || []).compose(
      new Delta(b.columns || []),
    ).ops;

    const cells = reindexCellIdentities(a.cells || {}, {
      rows: new Delta(b.rows || []).ops,
      columns: new Delta(b.columns || []).ops,
    });

    Object.keys(b.cells || {}).forEach(identity => {
      const aCell = cells[identity] || {};
      // @ts-expect-error Fix me later
      const bCell = b.cells[identity];

      const content = new Delta(aCell.content || []).compose(
        new Delta(bCell.content || []),
      ).ops;

      const attributes = Delta.AttributeMap.compose(
        aCell.attributes,
        bCell.attributes,
        keepNull,
      );

      const cell = compactCellData({ content, attributes });
      if (cell) {
        cells[identity] = cell;
      } else {
        delete cells[identity];
      }
    });

    return compactTableData({ rows, columns, cells });
  },
  transform(a: TableData, b: TableData, priority: boolean) {
    const aDeltas = {
      rows: new Delta(a.rows || []),
      columns: new Delta(a.columns || []),
    };

    const bDeltas = {
      rows: new Delta(b.rows || []),
      columns: new Delta(b.columns || []),
    };

    const rows = aDeltas.rows.transform(bDeltas.rows, priority).ops;
    const columns = aDeltas.columns.transform(bDeltas.columns, priority).ops;

    const cells = reindexCellIdentities(b.cells || {}, {
      rows: bDeltas.rows.transform(aDeltas.rows, !priority).ops,
      columns: bDeltas.columns.transform(aDeltas.columns, !priority).ops,
    });

    Object.keys(a.cells || {}).forEach(identity => {
      let [row, column] = parseCellIdentity(identity);
      // @ts-expect-error Fix me later
      row = composePosition(rows, row);
      // @ts-expect-error Fix me later
      column = composePosition(columns, column);

      if (row !== null && column !== null) {
        const newIdentity = stringifyCellIdentity(row, column);

        // @ts-expect-error Fix me later
        const aCell = a.cells[identity];
        const bCell = cells[newIdentity];
        if (bCell) {
          const content = new Delta(aCell.content || []).transform(
            new Delta(bCell.content || []),
            priority,
          ).ops;

          const attributes = Delta.AttributeMap.transform(
            aCell.attributes,
            bCell.attributes,
            priority,
          );

          const cell = compactCellData({ content, attributes });
          if (cell) {
            cells[newIdentity] = cell;
          } else {
            delete cells[newIdentity];
          }
        }
      }
    });

    return compactTableData({ rows, columns, cells });
  },
  invert(change: TableData, base: TableData) {
    const rows = new Delta(change.rows || []).invert(
      new Delta(base.rows || []),
    ).ops;
    const columns = new Delta(change.columns || []).invert(
      new Delta(base.columns || []),
    ).ops;
    const cells = reindexCellIdentities(change.cells || {}, {
      rows,
      columns,
    });
    Object.keys(cells).forEach(identity => {
      const changeCell = cells[identity] || {};
      const baseCell = (base.cells || {})[identity] || {};
      const content = new Delta(changeCell.content || []).invert(
        new Delta(baseCell.content || []),
      ).ops;
      const attributes = Delta.AttributeMap.invert(
        changeCell.attributes,
        baseCell.attributes,
      );
      const cell = compactCellData({ content, attributes });
      if (cell) {
        cells[identity] = cell;
      } else {
        delete cells[identity];
      }
    });

    // Cells may be removed when their row or column is removed
    // by row/column deltas. We should add them back.
    Object.keys(base.cells || {}).forEach(identity => {
      const [row, column] = parseCellIdentity(identity);
      if (
        composePosition(new Delta(change.rows || []), row) === null ||
        composePosition(new Delta(change.columns || []), column) === null
      ) {
        // @ts-expect-error Fix me later
        cells[identity] = base.cells[identity];
      }
    });

    return compactTableData({ rows, columns, cells });
  },
};

class TableEmbed extends Module {
  static register() {
    Delta.registerEmbed('table-embed', tableHandler);
  }
}

export default TableEmbed;
