import { AlertTriangle } from "lucide-react";
import { MAX_FLOOR_TABLES } from "@/lib/tableCapacity";

interface FloorCapacityBannerProps {
  tableCount: number;
}

/** Shown when the floor map reaches soft capacity (call for maintenance). */
export function FloorCapacityBanner({ tableCount }: FloorCapacityBannerProps) {
  if (tableCount < MAX_FLOOR_TABLES) return null;
  return (
    <div
      role="alert"
      className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-amber-950 dark:text-amber-100"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="space-y-1">
          <p className="font-semibold text-sm tracking-wide uppercase">
            System overload — for maintenance
          </p>
          <p className="text-sm text-muted-foreground dark:text-amber-100/80">
            Floor has {tableCount} tables (limit {MAX_FLOOR_TABLES}). Call for maintenance before
            adding more — the map is at capacity and may be hard to use.
          </p>
        </div>
      </div>
    </div>
  );
}
