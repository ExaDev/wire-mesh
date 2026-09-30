// A table whose rows become labelled cards on a phone (see `stackedTable` in App.css.ts). Switching `display` on table elements makes Safari and VoiceOver drop their table semantics, so every element carries its ARIA role explicitly, which keeps the table a table to assistive technology in both layouts.

import { Table } from "@mantine/core";
import { stackedTable } from "../App.css.js";

export interface StackedColumn {
  /** The column's name: its header text, and what each of its cells shows above its value on a phone. */
  label: string;
  /** True for a column with no header text of its own, such as a row's action buttons. */
  headerless?: boolean;
}

export interface StackedRow {
  key: string;
  /** One node per column, in column order. */
  cells: readonly React.ReactNode[];
}

export interface StackedTableProps {
  columns: readonly StackedColumn[];
  rows: readonly StackedRow[];
}

export function StackedTable({
  columns,
  rows,
}: Readonly<StackedTableProps>): React.JSX.Element {
  return (
    <Table striped className={stackedTable}>
      <Table.Thead role="rowgroup">
        <Table.Tr role="row">
          {columns.map((column) => (
            <Table.Th key={column.label} role="columnheader">
              {column.headerless === true ? null : column.label}
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody role="rowgroup">
        {rows.map((row) => (
          <Table.Tr key={row.key} role="row">
            {columns.map((column, index) => (
              <Table.Td
                key={column.label}
                role="cell"
                data-label={column.label}
              >
                {row.cells[index]}
              </Table.Td>
            ))}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
