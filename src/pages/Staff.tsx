import { useEffect, useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  tableStickyHeaderRowClassName,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Search, Edit, KeyRound, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

export interface StaffMember {
  id: string;
  code: string;
  name: string;
  nickname: string;
  type: string;
  allowance: number;
  hourly: number;
  budget: number;
  commissionRate: number;   // Fixed ₱ commission on ladies drinks
  incentiveRate: number;    // Fixed ₱ incentive amount (× branch LD)
  tableIncentive: number;   // ₱ per distinct table with LD
  hasQuota: boolean;
  quotaAmount: number;      // LD sales ₱ target to unlock commission/incentives
  hasLogin: boolean;
  status: "active" | "inactive";
}

const fallbackRoles = ["Administrator", "Staff", "Operations Staff"];

const emptyStaff = (): Omit<StaffMember, "id"> => ({
  code: "",
  name: "",
  nickname: "",
  type: "Staff",
  allowance: 0,
  hourly: 0,
  budget: 0,
  commissionRate: 0,
  incentiveRate: 0,
  tableIncentive: 0,
  hasQuota: false,
  quotaAmount: 0,
  hasLogin: false,
  status: "active",
});

export default function Staff() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [roleOptions, setRoleOptions] = useState<string[]>(fallbackRoles);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [staffSortBy, setStaffSortBy] = useState<"name" | "code" | "budget">("name");
  const [staffSortDir, setStaffSortDir] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<StaffMember | null>(null);
  const [form, setForm] = useState(emptyStaff());
  const [newPassword, setNewPassword] = useState("password");
  const [saving, setSaving] = useState(false);

  const handleDelete = async (s: StaffMember) => {
    if (!window.confirm(`Delete "${s.name}"? They will be permanently removed from the staff list and cannot log in. You can add them again later.`)) return;
    try {
      await api.staff.delete(s.id);
      toast.success(`${s.name} deleted`);
      loadStaff();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  const loadStaff = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.staff.list();
      setStaff(list.map(s => ({
        id: s.id,
        code: s.code,
        name: s.name,
        nickname: s.nickname,
        type: s.type,
        allowance: s.allowance,
        hourly: s.hourly,
        budget: s.budget,
        commissionRate: s.commissionRate,
        incentiveRate: s.incentiveRate,
        tableIncentive: s.tableIncentive ?? 0,
        hasQuota: !!s.hasQuota,
        quotaAmount: s.quotaAmount ?? 0,
        hasLogin: s.hasLogin,
        status: s.status as "active" | "inactive",
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load staff");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStaff();
    api.staff.roles()
      .then((roles) => {
        const names = roles.map((r) => r.name).filter(Boolean);
        if (names.length) setRoleOptions(names);
      })
      .catch(() => setRoleOptions(fallbackRoles));
  }, []);

  const filteredStaff = useMemo(() => {
    const q = search.toLowerCase();
    const rows = staff.filter((s) => {
      const matchesSearch =
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.code.toLowerCase().includes(q) ||
        s.nickname.toLowerCase().includes(q);
      const matchesType = typeFilter === "All" || s.type === typeFilter;
      const matchesStatus =
        statusFilter === "All" || s.status.toLowerCase() === statusFilter.toLowerCase();
      return matchesSearch && matchesType && matchesStatus;
    });
    const dir = staffSortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (staffSortBy === "budget") return (a.budget - b.budget) * dir;
      if (staffSortBy === "code") return a.code.localeCompare(b.code) * dir;
      return a.name.localeCompare(b.name) * dir;
    });
  }, [staff, search, typeFilter, statusFilter, staffSortBy, staffSortDir]);


  const openAdd = () => {
    setForm(emptyStaff());
    setNewPassword("password");
    setAddOpen(true);
  };

  const openEdit = (member: StaffMember) => {
    setEditingStaff(member);
    setForm({
      code: member.code,
      name: member.name,
      nickname: member.nickname,
      type: member.type,
      allowance: 0,
      hourly: 0,
      budget: member.budget,
      commissionRate: member.commissionRate,
      incentiveRate: member.incentiveRate,
      tableIncentive: member.tableIncentive ?? 0,
      hasQuota: !!member.hasQuota,
      quotaAmount: member.quotaAmount ?? 0,
      hasLogin: member.hasLogin,
      status: member.status,
    });
    setNewPassword("");
    setEditOpen(true);
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.code.trim() || !form.name.trim()) {
      toast.error("Code and Name are required");
      return;
    }
    setSaving(true);
    try {
      await api.staff.create({ ...form, allowance: 0, hourly: 0, password: newPassword.trim() || "password" });
      setAddOpen(false);
      setForm(emptyStaff());
      setNewPassword("password");
      toast.success("Staff added");
      loadStaff();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add staff");
    } finally {
      setSaving(false);
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStaff || !form.code.trim() || !form.name.trim()) return;
    setSaving(true);
    try {
      const updated = await api.staff.update(editingStaff.id, { ...form, allowance: 0, hourly: 0 });
      setEditOpen(false);
      setEditingStaff(null);
      setForm(emptyStaff());
      toast.success("Staff updated");
      if (updated.autoRecompute?.ok) {
        toast.success(`Payroll commission recomputed (${updated.autoRecompute.from} to ${updated.autoRecompute.to})`);
      } else if (updated.autoRecompute && !updated.autoRecompute.ok) {
        toast.warning("Staff saved, but payroll auto-recompute failed. Please run Compute Payouts.");
      }
      loadStaff();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update staff");
    } finally {
      setSaving(false);
    }
  };

  const handleResetPassword = async (member: StaffMember) => {
    const password = window.prompt(`Enter new password for ${member.name}:`, "password");
    if (password === null) return;
    if (!password.trim()) {
      toast.error("Password cannot be empty");
      return;
    }
    try {
      await api.staff.resetPassword(member.id, password.trim());
      toast.success(`Password updated for ${member.code}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to reset password");
    }
  };

  const formFields = (
    <div className="space-y-5">
      {/* Basic Info */}
      <div className="pb-2 border-b">
        <h4 className="text-sm font-semibold text-muted-foreground">Basic Information</h4>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="code">Employee ID / Code</Label>
          <p className="text-xs text-muted-foreground">Unique code for login (e.g. EMP001)</p>
          <Input
            id="code"
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            placeholder="e.g. EMP001"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Full Name</Label>
          <p className="text-xs text-muted-foreground">Legal or display name</p>
          <Input
            id="name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Full name"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="nickname">Nickname</Label>
          <Input
            id="nickname"
            value={form.nickname}
            onChange={(e) => setForm((f) => ({ ...f, nickname: e.target.value }))}
            placeholder="Nickname"
          />
        </div>
        <div className="space-y-2">
          <Label>Type / Role</Label>
          <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {roleOptions.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!editOpen && (
        <div className="space-y-2">
          <Label htmlFor="newPassword">Initial Password</Label>
          <p className="text-xs text-muted-foreground">
            This password will be used for first login. Share it securely with the staff member.
          </p>
          <Input
            id="newPassword"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Set temporary password"
          />
        </div>
      )}

      {/* Compensation */}
      <div className="pb-2 border-b mt-6">
        <h4 className="text-sm font-semibold text-muted-foreground">Compensation</h4>
      </div>
      <div className="space-y-2">
        <Label htmlFor="budget">Budget (₱)</Label>
        <p className="text-xs text-muted-foreground">Base pay value used in payroll</p>
        <Input
          id="budget"
          type="number"
          min={0}
          value={form.budget || ""}
          onChange={(e) => setForm((f) => ({ ...f, budget: Number(e.target.value) || 0, allowance: 0, hourly: 0 }))}
        />
      </div>

      {/* Commission & Incentives */}
      <div className="pb-2 border-b mt-6">
        <h4 className="text-sm font-semibold text-muted-foreground">Commission & Incentives</h4>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="commissionRate">Commission (₱)</Label>
          <p className="text-xs text-muted-foreground">Fixed amount per ladies drink sold</p>
          <Input
            id="commissionRate"
            type="number"
            min={0}
            step={0.01}
            value={form.commissionRate || ""}
            onChange={(e) => setForm((f) => ({ ...f, commissionRate: Number(e.target.value) || 0 }))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="incentiveRate">Incentive (₱ × branch LD)</Label>
          <p className="text-xs text-muted-foreground">Multiplied by total LD (kabuuan) for the payroll period</p>
          <Input
            id="incentiveRate"
            type="number"
            min={0}
            step={0.01}
            value={form.incentiveRate || ""}
            onChange={(e) => setForm((f) => ({ ...f, incentiveRate: Number(e.target.value) || 0 }))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="tableIncentive">Table incentive (₱)</Label>
          <p className="text-xs text-muted-foreground">Per distinct table with this staff&apos;s LD</p>
          <Input
            id="tableIncentive"
            type="number"
            min={0}
            step={0.01}
            value={form.tableIncentive || ""}
            onChange={(e) => setForm((f) => ({ ...f, tableIncentive: Number(e.target.value) || 0 }))}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2 pt-6">
            <input
              id="hasQuota"
              type="checkbox"
              className="h-4 w-4"
              checked={form.hasQuota}
              onChange={(e) => setForm((f) => ({ ...f, hasQuota: e.target.checked }))}
            />
            <Label htmlFor="hasQuota">Require LD sales quota</Label>
          </div>
          {form.hasQuota && (
            <>
              <Label htmlFor="quotaAmount">Quota amount (₱ LD sales)</Label>
              <Input
                id="quotaAmount"
                type="number"
                min={0}
                step={0.01}
                value={form.quotaAmount || ""}
                onChange={(e) => setForm((f) => ({ ...f, quotaAmount: Number(e.target.value) || 0 }))}
              />
            </>
          )}
        </div>
      </div>

      {editOpen && (
        <>
          <div className="pb-2 border-b mt-6">
            <h4 className="text-sm font-semibold text-muted-foreground">Status</h4>
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as "active" | "inactive" }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      )}
    </div>
  );

  return (
    <AppLayout>
      <PageHeader title="Staff & Accounts" description="Manage staff members and their accounts">
        <Button onClick={openAdd}>
          <Plus className="w-4 h-4 mr-2" />
          Add Staff
        </Button>
      </PageHeader>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col sm:flex-row flex-wrap gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, code, or nickname..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Type/Role" />
          </SelectTrigger>
          <SelectContent>
            {["All", ...roleOptions].map((type) => (
              <SelectItem key={type} value={type}>{type}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="All">All</SelectItem>
            <SelectItem value="Active">Active</SelectItem>
            <SelectItem value="Inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Sort:</span>
          <Select
            value={`${staffSortBy}-${staffSortDir}`}
            onValueChange={(v) => {
              const [by, dir] = v.split("-") as ["name" | "code" | "budget", "asc" | "desc"];
              setStaffSortBy(by);
              setStaffSortDir(dir);
            }}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name-asc">Name (A → Z)</SelectItem>
              <SelectItem value="name-desc">Name (Z → A)</SelectItem>
              <SelectItem value="code-asc">Code (A → Z)</SelectItem>
              <SelectItem value="code-desc">Code (Z → A)</SelectItem>
              <SelectItem value="budget-desc">Budget (high → low)</SelectItem>
              <SelectItem value="budget-asc">Budget (low → high)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <Table wrapperClassName="max-h-[650px]">
          <TableHeader>
            <TableRow className={tableStickyHeaderRowClassName}>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Nickname</TableHead>
              <TableHead>Type/Role</TableHead>
              <TableHead className="text-right">Budget</TableHead>
              <TableHead>Login</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[100px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : filteredStaff.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  No records found
                </TableCell>
              </TableRow>
            ) : (
              filteredStaff.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">{s.code}</TableCell>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.nickname}</TableCell>
                  <TableCell>{s.type}</TableCell>
                  <TableCell className="text-right">{formatCurrency(s.budget)}</TableCell>
                  <TableCell>
                    {s.hasLogin ? (
                      <Badge variant="default" className="bg-success/20 text-success border-success/30">Yes</Badge>
                    ) : (
                      <Badge variant="secondary">No</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.status === "active" ? "default" : "secondary"}>{s.status}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(s)} title="Edit">
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Reset Password"
                        onClick={() => handleResetPassword(s)}
                      >
                        <KeyRound className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title="Delete"
                        onClick={() => handleDelete(s)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Staff</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAddSubmit}>
            {formFields}
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Adding…" : "Add Staff"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={(open) => { setEditOpen(open); if (!open) setEditingStaff(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Staff</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditSubmit}>
            {formFields}
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save Changes"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
