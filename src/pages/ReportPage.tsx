import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { BarChart3, Upload, FileSpreadsheet, TrendingUp, Package, CheckCircle, XCircle, Loader2 } from "lucide-react";
import * as XLSX from "xlsx";
import { getSnapshotDates, loadSnapshots } from "@/lib/snapshotService";

interface PivotRow {
  spc_name: string;
  order_day: string;
  vendor_count: number;
  suggest_items: number;
  po_created: number;
}

interface CompareRow {
  vendor_code: string;
  barcode: string;
  product_name: string;
  suggest_qty: number;
  actual_qty: number;
  match: boolean;
  diff: number;
}

export default function ReportPage() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("pivot");
  const [snapshotDates, setSnapshotDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [pivotData, setPivotData] = useState<PivotRow[]>([]);
  const [compareData, setCompareData] = useState<CompareRow[]>([]);
  const [actualPOFile, setActualPOFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Load available dates
  useEffect(() => {
    getSnapshotDates().then(dates => {
      setSnapshotDates(dates);
      if (dates.length > 0) setSelectedDate(dates[0]);
    }).catch(() => {});
  }, []);

  // Load pivot data from snapshots
  const loadPivotData = async () => {
    if (!selectedDate) return;
    setLoading(true);
    try {
      const snapshots = await loadSnapshots(selectedDate);
      const pivotMap = new Map<string, PivotRow>();
      
      for (const snap of snapshots) {
        const rows = snap.data as any[];
        for (const row of rows) {
          const key = `${snap.spc_name}|${row.order_day || "N/A"}`;
          if (!pivotMap.has(key)) {
            pivotMap.set(key, { spc_name: snap.spc_name, order_day: row.order_day || "N/A", vendor_count: 0, suggest_items: 0, po_created: 0 });
          }
          const p = pivotMap.get(key)!;
          p.suggest_items++;
          if (row.final_suggest_qty > 0) p.po_created++;
        }
        // Count unique vendors per SPC+OrderDay
        const vendorSet = new Map<string, Set<string>>();
        for (const row of rows) {
          const key = `${snap.spc_name}|${row.order_day || "N/A"}`;
          if (!vendorSet.has(key)) vendorSet.set(key, new Set());
          vendorSet.get(key)!.add(row.vendor_code);
        }
        for (const [key, vSet] of vendorSet) {
          if (pivotMap.has(key)) pivotMap.get(key)!.vendor_count = vSet.size;
        }
      }

      setPivotData([...pivotMap.values()].sort((a, b) => a.spc_name.localeCompare(b.spc_name) || a.order_day.localeCompare(b.order_day)));
      toast({ title: "โหลดข้อมูล Pivot สำเร็จ", description: `${pivotMap.size} แถว` });
    } catch (err: any) {
      toast({ title: "โหลดไม่สำเร็จ", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  // Import Actual PO Excel
  const handleActualPOUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedDate) return;
    setLoading(true);
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const actualRows: any[] = XLSX.utils.sheet_to_json(ws);

      // Load suggest data
      const snapshots = await loadSnapshots(selectedDate);
      const suggestMap = new Map<string, { qty: number; name: string; vendor: string }>();
      for (const snap of snapshots) {
        for (const row of snap.data as any[]) {
          if (row.final_suggest_qty > 0) {
            suggestMap.set(row.barcode_unit || row.sku_code, {
              qty: row.final_suggest_qty,
              name: row.product_name_la,
              vendor: row.vendor_code,
            });
          }
        }
      }

      // Match
      const compared: CompareRow[] = [];
      for (const actual of actualRows) {
        const barcode = actual["Products to Purchase/barcode"] || actual["barcode"] || actual["Barcode"] || "";
        const actualQty = Number(actual["Products to Purchase/Quantity"] || actual["qty"] || actual["Quantity"] || 0);
        const vendorCode = actual["partner_id"] || actual["vendor_code"] || "";
        const suggest = suggestMap.get(barcode);
        compared.push({
          vendor_code: vendorCode || suggest?.vendor || "",
          barcode,
          product_name: suggest?.name || actual["Product name"] || "",
          suggest_qty: suggest?.qty || 0,
          actual_qty: actualQty,
          match: suggest ? Math.abs(suggest.qty - actualQty) < 0.01 : false,
          diff: actualQty - (suggest?.qty || 0),
        });
      }

      setCompareData(compared);
      toast({ title: "เปรียบเทียบสำเร็จ", description: `${compared.length} รายการ` });
    } catch (err: any) {
      toast({ title: "Import ไม่สำเร็จ", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  // KPI summary
  const kpi = useMemo(() => {
    if (compareData.length === 0) return { total: 0, matched: 0, rate: 0, totalSuggest: 0, totalActual: 0 };
    const matched = compareData.filter(r => r.match).length;
    return {
      total: compareData.length,
      matched,
      rate: compareData.length > 0 ? Math.round((matched / compareData.length) * 100) : 0,
      totalSuggest: compareData.reduce((s, r) => s + r.suggest_qty, 0),
      totalActual: compareData.reduce((s, r) => s + r.actual_qty, 0),
    };
  }, [compareData]);

  const pivotTotals = useMemo(() => ({
    vendors: pivotData.reduce((s, r) => s + r.vendor_count, 0),
    items: pivotData.reduce((s, r) => s + r.suggest_items, 0),
    pos: pivotData.reduce((s, r) => s + r.po_created, 0),
  }), [pivotData]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold">Report Dashboard</h1>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedDate} onValueChange={setSelectedDate}>
            <SelectTrigger className="h-8 w-[180px] text-xs">
              <SelectValue placeholder="เลือกวันที่" />
            </SelectTrigger>
            <SelectContent>
              {snapshotDates.map(d => (
                <SelectItem key={d} value={d} className="text-xs">📅 {d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={loadPivotData} disabled={loading || !selectedDate} className="text-xs">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <BarChart3 className="w-3.5 h-3.5 mr-1" />}
            โหลดข้อมูล
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 pt-2 border-b border-border">
          <TabsList className="h-9">
            <TabsTrigger value="pivot" className="text-xs gap-1.5">
              <BarChart3 className="w-3.5 h-3.5" /> Pivot Report
            </TabsTrigger>
            <TabsTrigger value="compare" className="text-xs gap-1.5">
              <TrendingUp className="w-3.5 h-3.5" /> Compare PO
            </TabsTrigger>
          </TabsList>
        </div>

        {/* PIVOT TAB */}
        <TabsContent value="pivot" className="flex-1 overflow-auto p-4 mt-0">
          {pivotData.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <BarChart3 className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-sm">เลือกวันที่แล้วกด "โหลดข้อมูล"</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4 mb-4">
                <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Total Vendors</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{pivotTotals.vendors}</p></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Suggest Items</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{pivotTotals.items.toLocaleString()}</p></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">PO Created (Suggest &gt; 0)</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{pivotTotals.pos.toLocaleString()}</p></CardContent></Card>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SPC Name</TableHead>
                    <TableHead>Order Day</TableHead>
                    <TableHead className="text-right">Vendors</TableHead>
                    <TableHead className="text-right">Suggest Items</TableHead>
                    <TableHead className="text-right">PO Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pivotData.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{r.spc_name}</TableCell>
                      <TableCell>{r.order_day}</TableCell>
                      <TableCell className="text-right">{r.vendor_count}</TableCell>
                      <TableCell className="text-right">{r.suggest_items.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{r.po_created.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </TabsContent>

        {/* COMPARE TAB */}
        <TabsContent value="compare" className="flex-1 overflow-auto p-4 mt-0">
          <div className="flex items-center gap-3 mb-4">
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleActualPOUpload} />
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={loading || !selectedDate} className="text-xs">
              <Upload className="w-3.5 h-3.5 mr-1" /> Import Actual PO (Excel)
            </Button>
            <span className="text-xs text-muted-foreground">อัพโหลดไฟล์ PO จริงจากระบบเพื่อเปรียบเทียบ</span>
          </div>

          {compareData.length > 0 && (
            <>
              <div className="grid grid-cols-4 gap-4 mb-4">
                <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Total Items</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{kpi.total}</p></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Matched</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold text-green-600">{kpi.matched}</p></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Conversion Rate</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{kpi.rate}%</p></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Gap (Actual - Suggest)</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{(kpi.totalActual - kpi.totalSuggest).toLocaleString()}</p></CardContent></Card>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Barcode</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Suggest Qty</TableHead>
                    <TableHead className="text-right">Actual Qty</TableHead>
                    <TableHead className="text-right">Diff</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {compareData.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs">{r.vendor_code}</TableCell>
                      <TableCell className="text-xs font-mono">{r.barcode}</TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate">{r.product_name}</TableCell>
                      <TableCell className="text-right text-xs">{r.suggest_qty}</TableCell>
                      <TableCell className="text-right text-xs">{r.actual_qty}</TableCell>
                      <TableCell className="text-right text-xs">{r.diff}</TableCell>
                      <TableCell>
                        {r.match ? (
                          <Badge variant="default" className="text-[10px]"><CheckCircle className="w-3 h-3 mr-1" />Match</Badge>
                        ) : (
                          <Badge variant="destructive" className="text-[10px]"><XCircle className="w-3 h-3 mr-1" />Gap</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}

          {compareData.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
              <FileSpreadsheet className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-sm">Import ไฟล์ PO จริงเพื่อเปรียบเทียบกับ Suggest</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
