import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatCard } from "@/components/dashboard/StatCard";
import { TableGrid } from "@/components/dashboard/TableGrid";
import { FloorCapacityBanner } from "@/components/dashboard/FloorCapacityBanner";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { isFloorWaiter } from "@/lib/floorStaff";
import { ShoppingBag, DollarSign, LayoutGrid, Clock } from "lucide-react";
import { mapApiTable } from "@/types/pos";
import type { Table } from "@/types/pos";
import { formatCurrency } from "@/lib/utils";

export default function Dashboard() {
  const { user, hasPermission } = useAuth();
  const floorWaiter = isFloorWaiter(hasPermission, user?.role);

  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.dashboard.stats>> | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [statsRes, tablesRes] = await Promise.all([
          api.dashboard.stats(),
          api.dashboard.tables().then((r) => r.map(mapApiTable)),
        ]);
        if (!cancelled) {
          setStats(statsRes);
          setTables(tablesRes);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load dashboard");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <AppLayout>
        <PageHeader title="Dashboard" description="Real-time overview of today's operations" />
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive">
          {error}
        </div>
      </AppLayout>
    );
  }

  const salesCardLabel = floorWaiter ? "LD Commissions" : "Today's Sales";
  const salesCardValue = floorWaiter
    ? formatCurrency(stats?.myLd?.ldCommission ?? 0)
    : formatCurrency(stats?.todaysSales ?? 0);

  return (
    <AppLayout>
      <PageHeader
        title="Dashboard"
        description="Real-time overview of today's operations"
      />

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : stats ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatCard
              label="Today's Orders"
              value={stats.todaysOrders}
              icon={<ShoppingBag className="w-5 h-5" />}
              trend={{ value: 12, isPositive: true }}
            />
            <StatCard
              label={salesCardLabel}
              value={salesCardValue}
              icon={<DollarSign className="w-5 h-5" />}
              trend={{ value: 8, isPositive: true }}
            />
            <StatCard
              label="Open Tables"
              value={stats.openTables}
              icon={<LayoutGrid className="w-5 h-5" />}
            />
            <StatCard
              label="Pending Orders"
              value={stats.pendingOrders}
              icon={<Clock className="w-5 h-5" />}
            />
          </div>

          <div className="mb-4">
            <h2 className="text-lg font-semibold mb-4">Table Overview</h2>
            <FloorCapacityBanner tableCount={tables.length} />
          </div>
          <TableGrid
            tables={tables}
            displayAreas={["Lounge", "Club"]}
            linkPrefix="/pos/table"
            viewerEmployeeId={user?.employeeId}
            enforceTableLock={floorWaiter}
          />
        </>
      ) : null}
    </AppLayout>
  );
}
