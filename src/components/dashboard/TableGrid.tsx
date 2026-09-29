import { Table, areas } from "@/types/pos";
import { TableCard } from "./TableCard";

/** When provided, only these areas are shown (e.g. ["Lounge", "Club"] to hide LD). */
interface TableGridProps {
  tables: Table[];
  linkPrefix?: string;
  showTableActions?: boolean;
  onEditTable?: (table: Table) => void;
  onDeleteTable?: (table: Table) => void;
  displayAreas?: readonly string[];
  viewerEmployeeId?: string;
  enforceTableLock?: boolean;
}

export function TableGrid({
  tables,
  linkPrefix = "/pos/table",
  showTableActions,
  onEditTable,
  onDeleteTable,
  displayAreas,
  viewerEmployeeId,
  enforceTableLock,
}: TableGridProps) {
  const areasToShow = displayAreas ?? areas;
  const tablesByArea = areasToShow.reduce((acc, area) => {
    acc[area] = tables.filter((t) => t.area === area);
    return acc;
  }, {} as Record<string, Table[]>);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {areasToShow.map((area) => (
        <div key={area} className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg">{area}</h3>
            <span className="text-sm text-muted-foreground">
              {tablesByArea[area].filter((t) => t.status === "available" && !t.lockedByEmployeeId).length} / {tablesByArea[area].length} available
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {tablesByArea[area].map((table) => (
              <TableCard
                key={table.id}
                table={table}
                linkTo={`${linkPrefix}/${encodeURIComponent(table.id)}`}
                showActions={showTableActions}
                onEdit={onEditTable}
                onDelete={onDeleteTable}
                viewerEmployeeId={viewerEmployeeId}
                enforceTableLock={enforceTableLock}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
