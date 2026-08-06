import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { TableGrid } from "@/components/dashboard/TableGrid";
import { useAuth } from "@/contexts/AuthContext";
import { isFloorWaiter } from "@/lib/floorStaff";
import { api } from "@/lib/api";
import { mapApiTable } from "@/types/pos";
import type { Table } from "@/types/pos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, ArrowRightLeft, ArrowRight } from "lucide-react";
import { toast } from "sonner";

export default function POS() {
  const location = useLocation();
  const { hasPermission, user } = useAuth();
  const floorWaiter = isFloorWaiter(hasPermission);
  const canAddTable = hasPermission("manage_settings");
  const canMergeTables = hasPermission("transfer_table_orders") || hasPermission("manage_settings");
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addTableOpen, setAddTableOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addArea, setAddArea] = useState<"Lounge" | "Club">("Lounge");
  const [editTableOpen, setEditTableOpen] = useState(false);
  const [editingTable, setEditingTable] = useState<Table | null>(null);
  const [editName, setEditName] = useState("");
  const [editArea, setEditArea] = useState<"Lounge" | "Club">("Lounge");
  const [saving, setSaving] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [sourceTableId, setSourceTableId] = useState("");
  const [targetTableId, setTargetTableId] = useState("");
  const [mergeReason, setMergeReason] = useState("");
  const [merging, setMerging] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferSourceTableId, setTransferSourceTableId] = useState("");
  const [transferTargetTableId, setTransferTargetTableId] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [transferring, setTransferring] = useState(false);

  const posDisplayAreas = ["Lounge", "Club"] as const;

  const loadTables = async () => {
    setLoading(true);
    setError(null);
    try {
      const tablesRes = await api.dashboard.tables();
      setTables(tablesRes.map(mapApiTable));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tables");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTables();
  }, [location.pathname]);

  const handleAddTable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addName.trim()) {
      toast.error("Table name is required");
      return;
    }
    setSaving(true);
    try {
      await api.dashboard.createTable({ name: addName.trim(), area: addArea });
      setAddTableOpen(false);
      setAddName("");
      setAddArea("Lounge" as const);
      toast.success("Table added");
      loadTables();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add table");
    } finally {
      setSaving(false);
    }
  };

  const openEditTable = (table: Table) => {
    setEditingTable(table);
    setEditName(table.name);
    setEditArea(table.area === "LD" ? "Lounge" : table.area);
    setEditTableOpen(true);
  };

  const handleEditTable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTable || !editName.trim()) {
      toast.error("Table name is required");
      return;
    }
    setSaving(true);
    try {
      await api.dashboard.updateTable(editingTable.id, { name: editName.trim(), area: editArea as string });
      setEditTableOpen(false);
      setEditingTable(null);
      toast.success("Table updated");
      loadTables();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update table");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTable = async (table: Table) => {
    if (table.status !== "available") {
      toast.error("Only available tables can be removed");
      return;
    }
    if (!confirm(`Remove table "${table.name}"? This cannot be undone.`)) return;
    try {
      await api.dashboard.deleteTable(table.id);
      toast.success("Table removed");
      loadTables();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove table");
    }
  };

  const openMergeDialog = () => {
    setSourceTableId("");
    setTargetTableId("");
    setMergeReason("");
    setMergeOpen(true);
  };

  const handleMergeTables = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceTableId || !targetTableId) {
      toast.error("Select source and target tables");
      return;
    }
    if (sourceTableId === targetTableId) {
      toast.error("Source and target tables must be different");
      return;
    }
    const source = tables.find((t) => t.id === sourceTableId);
    const target = tables.find((t) => t.id === targetTableId);
    if (!source?.currentOrderId || !target?.currentOrderId) {
      toast.error("Both tables must have active orders");
      return;
    }

    setMerging(true);
    try {
      await api.tables.merge({
        sourceOrderId: source.currentOrderId,
        targetOrderId: target.currentOrderId,
        transferredBy: user?.id || "0",
        reason: mergeReason.trim() || undefined,
      });
      toast.success(`Merged ${source.name} into ${target.name}`);
      setMergeOpen(false);
      loadTables();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to merge tables");
    } finally {
      setMerging(false);
    }
  };

  const openTransferDialog = () => {
    setTransferSourceTableId("");
    setTransferTargetTableId("");
    setTransferReason("");
    setTransferOpen(true);
  };

  const handleTransferTable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transferSourceTableId || !transferTargetTableId) {
      toast.error("Select source and target tables");
      return;
    }
    if (transferSourceTableId === transferTargetTableId) {
      toast.error("Source and target tables must be different");
      return;
    }
    const source = tables.find((t) => t.id === transferSourceTableId);
    const target = tables.find((t) => t.id === transferTargetTableId);
    if (!source?.currentOrderId) {
      toast.error("Source table must have an active order");
      return;
    }
    if (!target) {
      toast.error("Select a target table");
      return;
    }

    const willSwap = Boolean(target.currentOrderId) || target.status === "occupied";

    setTransferring(true);
    try {
      const result = await api.tables.transfer({
        fromTable: source.id,
        toTable: target.id,
        transferredBy: user?.id || "0",
        reason: transferReason.trim() || undefined,
        transferAll: true,
      });
      const swapped = result.action === "swap" || willSwap;
      toast.success(
        swapped
          ? `Swapped ${source.area} - ${source.name} with ${target.area} - ${target.name}`
          : `Moved all orders from ${source.area} - ${source.name} to ${target.area} - ${target.name}`
      );
      setTransferOpen(false);
      loadTables();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to transfer table");
    } finally {
      setTransferring(false);
    }
  };

  if (error) {
    return (
      <AppLayout>
        <PageHeader title="Point of Sale" description="Select a table to start or view an order" />
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive">
          {error}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <PageHeader
        title="Point of Sale"
        description="Select a table to start or view an order"
      >
        {canAddTable && (
          <Button onClick={() => setAddTableOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Add Table
          </Button>
        )}
        {canMergeTables && (
          <>
            <Button variant="outline" onClick={openTransferDialog}>
              <ArrowRight className="w-4 h-4 mr-2" />
              Transfer Table
            </Button>
            <Button variant="outline" onClick={openMergeDialog}>
              <ArrowRightLeft className="w-4 h-4 mr-2" />
              Merge Tables
            </Button>
          </>
        )}
      </PageHeader>
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {posDisplayAreas.map((area) => (
            <div key={area} className="space-y-3">
              <div className="h-6 w-32 rounded bg-muted animate-pulse" />
              <div className="grid grid-cols-2 gap-2">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <TableGrid
          tables={tables}
          displayAreas={posDisplayAreas}
          showTableActions={canAddTable}
          onEditTable={canAddTable ? openEditTable : undefined}
          onDeleteTable={canAddTable ? handleDeleteTable : undefined}
          viewerEmployeeId={user?.employeeId}
          enforceTableLock={floorWaiter}
        />
      )}

      <Dialog open={addTableOpen} onOpenChange={setAddTableOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Table</DialogTitle>
            <p className="text-sm text-muted-foreground">Extend your floor with a new table. It will appear in the selected area.</p>
          </DialogHeader>
          <form onSubmit={handleAddTable} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tableName">Table Name / ID</Label>
              <Input
                id="tableName"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="e.g. L7, C9, LD5"
              />
            </div>
            <div className="space-y-2">
              <Label>Area</Label>
              <Select value={addArea} onValueChange={(v) => setAddArea(v as "Lounge" | "Club")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {posDisplayAreas.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddTableOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Adding…" : "Add Table"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editTableOpen} onOpenChange={(open) => { setEditTableOpen(open); if (!open) setEditingTable(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Table</DialogTitle>
            <p className="text-sm text-muted-foreground">Change table name or area. Table ID: {editingTable?.id}</p>
          </DialogHeader>
          <form onSubmit={handleEditTable} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="editTableName">Table Name</Label>
              <Input
                id="editTableName"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="e.g. L7, C9"
              />
            </div>
            <div className="space-y-2">
              <Label>Area</Label>
              <Select value={editArea} onValueChange={(v) => setEditArea(v as "Lounge" | "Club")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {posDisplayAreas.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditTableOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Merge Tables</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Move all items from source table order into target table order.
            </p>
          </DialogHeader>
          <form onSubmit={handleMergeTables} className="space-y-4">
            <div className="space-y-2">
              <Label>Source table (from)</Label>
              <Select value={sourceTableId} onValueChange={setSourceTableId}>
                <SelectTrigger><SelectValue placeholder="Select occupied table" /></SelectTrigger>
                <SelectContent>
                  {tables
                    .filter((t) => t.status === "occupied" && t.currentOrderId)
                    .map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.area} - {t.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Target table (to)</Label>
              <Select value={targetTableId} onValueChange={setTargetTableId}>
                <SelectTrigger><SelectValue placeholder="Select occupied table" /></SelectTrigger>
                <SelectContent>
                  {tables
                    .filter((t) => t.status === "occupied" && t.currentOrderId)
                    .map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.area} - {t.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mergeReason">Reason (optional)</Label>
              <Input
                id="mergeReason"
                value={mergeReason}
                onChange={(e) => setMergeReason(e.target.value)}
                placeholder="e.g. Customer requested one bill"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setMergeOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={merging}>{merging ? "Merging…" : "Merge"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Transfer Table</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Move to an empty table, or swap with an occupied one (bills stay separate). Use Merge to combine into one bill.
            </p>
          </DialogHeader>
          <form onSubmit={handleTransferTable} className="space-y-4">
            <div className="space-y-2">
              <Label>From table (has active order)</Label>
              <Select value={transferSourceTableId} onValueChange={setTransferSourceTableId}>
                <SelectTrigger><SelectValue placeholder="Select occupied table" /></SelectTrigger>
                <SelectContent>
                  {tables
                    .filter((t) => t.status === "occupied" && t.currentOrderId)
                    .map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.area} - {t.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>To table (empty = move, occupied = swap)</Label>
              <Select value={transferTargetTableId} onValueChange={setTransferTargetTableId}>
                <SelectTrigger><SelectValue placeholder="Select any other table" /></SelectTrigger>
                <SelectContent>
                  {tables
                    .filter((t) => t.id !== transferSourceTableId)
                    .map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.area} - {t.name}
                        {t.status === "occupied" || t.currentOrderId ? " (swap)" : " (move)"}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="transferReason">Reason (optional)</Label>
              <Input
                id="transferReason"
                value={transferReason}
                onChange={(e) => setTransferReason(e.target.value)}
                placeholder="e.g. Moved to Lounge"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setTransferOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={transferring}>{transferring ? "Transferring…" : "Transfer"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
