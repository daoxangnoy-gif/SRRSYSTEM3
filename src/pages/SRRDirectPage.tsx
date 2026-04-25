import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Loader2,
  Calculator,
  Download,
  ChevronLeft,
  ChevronRight,
  Database,
  Search,
  X,
  FileSpreadsheet,
  Check,
  CheckSquare,
  Columns,
  XCircle,
  Save,
  Eye,
  ChevronDown,
  ChevronUp as ChevronUpIcon,
  RefreshCw,
  Filter,
  Play,
  Trash2,
  FolderOpen,
  CalendarDays,
  Upload,
  BarChart3,
  Info,
} from "lucide-react";
import { SRRReportTab } from "@/components/SRRReportTab";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import * as XLSX from "xlsx";
import {
  SrrImportFilter,
  type SrrImportMode,
  type ImportedItem,
  type ImportedVendor,
} from "@/components/SrrImportFilter";
import { SrrFiltersPopover } from "@/components/SrrFiltersPopover";
import { ImportSkipDialog, ImportSkipBar, type SkippedItem } from "@/components/ImportSkipDialog";
import { TableChipSearch, applyChipFilter, type SearchChip } from "@/components/TableChipSearch";
import { SnapshotBatchPicker } from "@/components/SnapshotBatchPicker";
import {
  buildSnapshotBatchesFromDocs,
  getSnapshotBatches,
  loadSnapshotBatch,
  mergeSnapshotBatches,
  type SnapshotBatch,
} from "@/lib/snapshotService";
import { ListImportPO, getLocalPOBatches } from "@/pages/SRRPage";

// --- Types ---
interface D2SRow {
  id: string;
  sku_code: string;
  main_barcode: string;
  product_name_la: string;
  product_name_en: string;
  vendor_code: string;
  vendor_display: string;
  spc_name: string;
  order_day: string;
  delivery_day: string;
  trade_term: string;
  rank_sales: string;
  rank_is_default: boolean;
  store_name: string;
  type_store: string;
  unit_name: string;
  avg_sales_store: number;
  orig_avg_sales_store: number;
  min_store: number;
  max_store: number;
  stock_store: number;
  stock_dc: number;
  order_cycle: number;
  orig_order_cycle: number;
  leadtime: number;
  srr_suggest: number;
  on_order_store: number;
  final_order_qty: number;
  moq: number;
  final_order_uom: number;
  /** FinalOrder UOM = FinalOrderR_up / MOQ (display column, ROUNDUP) */
  final_order_uom_div: number;
  order_uom_edit: string;
  doh_asis: number;
  doh_tobe: number;
  po_cost: number;
  po_cost_unit: number;
  /** Original PO cost from DB (before any import override) */
  orig_po_cost: number;
  orig_po_cost_unit: number;
  item_type: string;
  buying_status: string;
  unit_of_measure: string;
  po_group: string;
  // Data Master classification fields (added per spec A→AJ)
  division_group: string;
  division: string;
  department: string;
  sub_department: string;
  class_name: string;
  sub_class: string;
  calculated: boolean;
  safety: number;
  /** True when row was populated by Import Mode (Qty from Excel imported to Order UOM EDIT).
   *  In this case FinalOrder UOM column displays Qty × MOQ instead of the original formula. */
  is_import_row?: boolean;
}

interface VendorDocument {
  id: string;
  vendor_code: string;
  vendor_display: string;
  store_name: string;
  type_store: string;
  spc_name: string;
  date_key: string;
  created_at: string;
  item_count: number;
  suggest_count: number;
  data: D2SRow[];
  edit_count: number;
  edited_columns: string[];
  /** Source mode that generated this document — used to split tree by Filter / Vendor / Barcode */
  source?: "filter" | "vendor" | "import";
}

// --- Helpers ---
async function fetchAllRows<T>(table: string, selectCols: string, filter?: (q: any) => any): Promise<T[]> {
  const all: T[] = [];
  const batchSize = 1000;
  let offset = 0;
  while (true) {
    let q: any = (supabase as any)
      .from(table)
      .select(selectCols)
      .range(offset, offset + batchSize - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    offset += batchSize;
    if (data.length < batchSize) break;
  }
  return all;
}

// --- D2S Snapshot DB persistence ---
function dateKeyToISO(dk: string): string {
  // YYYYMMDD -> YYYY-MM-DD
  if (dk.includes("-")) return dk;
  return `${dk.substring(0, 4)}-${dk.substring(4, 6)}-${dk.substring(6, 8)}`;
}
function isoToDateKey(iso: string): string {
  // YYYY-MM-DD -> YYYYMMDD
  return iso.replace(/-/g, "").substring(0, 8);
}

async function loadD2SSnapshots(): Promise<any[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  const { data, error } = await (supabase as any)
    .from("srr_d2s_snapshots")
    .select("*")
    .gte("date_key", cutoffStr)
    .order("date_key", { ascending: false });
  if (error) throw error;
  return data || [];
}

// Get distinct snapshot dates (YYYY-MM-DD) within last 30 days
async function getD2SSnapshotDates(): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  const { data, error } = await (supabase as any)
    .from("srr_d2s_snapshots")
    .select("date_key")
    .gte("date_key", cutoffStr)
    .order("date_key", { ascending: false });
  if (error) throw error;
  const dates = [...new Set(((data || []) as any[]).map((r: any) => r.date_key as string))] as string[];
  return dates;
}

// Load snapshots for a specific date (YYYY-MM-DD)
async function loadD2SSnapshotsByDate(dateKey: string): Promise<any[]> {
  const { data, error } = await (supabase as any)
    .from("srr_d2s_snapshots")
    .select("*")
    .eq("date_key", dateKey)
    .order("spc_name", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function saveD2SSnapshots(
  docs: {
    spc_name: string;
    vendor_code: string;
    vendor_display: string;
    store_name: string;
    type_store: string;
    source: string;
    item_count: number;
    suggest_count: number;
    data: any[];
    edit_count: number;
    edited_columns: string[];
  }[],
  userId: string,
  dateKey: string,
  createdAtIso?: string,
): Promise<void> {
  // Compute minute window for this batch (preserves earlier Read & Cal runs)
  let windowStartIso: string | null = null;
  let windowEndIso: string | null = null;
  if (createdAtIso) {
    const start = new Date(createdAtIso); start.setSeconds(0, 0);
    const end = new Date(start.getTime() + 60_000);
    windowStartIso = start.toISOString();
    windowEndIso = end.toISOString();
  }

  // Overwrite only the exact Direct document keys being re-saved.
  // Key = date + minute window + SPC + source + vendor + store, so other vendors/stores survive.
  const pairs = [...new Set(docs.map((d) => `${d.spc_name}||${d.source || "filter"}||${d.vendor_code}||${d.store_name}`))];
  for (const pair of pairs) {
    const [spc, src, vendorCode, storeName] = pair.split("||");
    let q = (supabase as any)
      .from("srr_d2s_snapshots")
      .delete()
      .eq("date_key", dateKey)
      .eq("spc_name", spc)
      .eq("source", src)
      .eq("vendor_code", vendorCode)
      .eq("store_name", storeName);
    if (windowStartIso && windowEndIso) {
      q = q.gte("created_at", windowStartIso).lt("created_at", windowEndIso);
    }
    await q;
  }
  const batchSize = 50;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize).map((d) => {
      const row: any = {
        date_key: dateKey,
        spc_name: d.spc_name,
        vendor_code: d.vendor_code,
        vendor_display: d.vendor_display,
        store_name: d.store_name,
        type_store: d.type_store,
        source: d.source,
        item_count: d.item_count,
        suggest_count: d.suggest_count,
        data: d.data,
        edit_count: d.edit_count,
        edited_columns: d.edited_columns,
        user_id: userId,
      };
      if (createdAtIso) row.created_at = new Date(createdAtIso).toISOString();
      return row;
    });
    const { error } = await (supabase as any).from("srr_d2s_snapshots").insert(batch);
    if (error) throw error;
  }
}

async function deleteD2SSnapshot(id: string): Promise<void> {
  await (supabase as any).from("srr_d2s_snapshots").delete().eq("id", id);
}

async function fetchD2SDataRPC(
  vendorCodes: string[] | null,
  spcNames: string[] | null,
  orderDays: string[] | null,
  itemTypes: string[] | null,
  onProgress?: (loaded: number) => void,
): Promise<any[]> {
  const allRows: any[] = [];
  const pageSize = 1000;
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await supabase
      .rpc("get_srr_d2s_data", {
        p_vendor_codes: vendorCodes,
        p_spc_names: spcNames,
        p_order_days: orderDays,
        p_item_types: itemTypes,
      } as any)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) {
      hasMore = false;
    } else {
      allRows.push(...data);
      offset += pageSize;
      onProgress?.(allRows.length);
      if (data.length < pageSize) hasMore = false;
    }
  }
  return allRows;
}

// --- Calculation ---
const SAFETY_BY_RANK: Record<string, number> = { A: 21, B: 14, C: 10, D: 7 };

function recalcD2SRow(row: D2SRow): D2SRow {
  // SRR Suggest = IF(IF(Stock<=0,0,Stock) <= Min, Min - IF(Stock<=0,0,Stock) + Avg*OC, 0)
  const stockClamped = row.stock_store <= 0 ? 0 : row.stock_store;
  let srrSuggest = 0;
  if (row.min_store > 0 && stockClamped <= row.min_store) {
    srrSuggest = row.min_store - stockClamped + row.avg_sales_store * row.order_cycle;
  }
  srrSuggest = Math.max(0, srrSuggest);

  const moq = row.moq || 1;

  // FinalOrder Qty = IF(SRR Suggest - On Order <= 0, 0, SRR Suggest - On Order)  [raw, no MOQ rounding]
  const calcFinalOrderQty = Math.max(srrSuggest - row.on_order_store, 0);
  // FinalOrder UOM = IFERROR(ROUNDUP(Qty/MOQ, 0), 0)  [integer UOM count]
  const calcFinalOrderUom = moq > 0 ? Math.ceil(calcFinalOrderQty / moq) : 0;

  // Order UOM EDIT override: when user enters a UOM qty (or import provides Qty),
  // it overrides FinalOrder so Save PO / suggest counters recognize the quantity.
  const hasUomEdit = row.order_uom_edit !== "" && row.order_uom_edit != null && !isNaN(Number(row.order_uom_edit));
  const uomEditNum = hasUomEdit ? Number(row.order_uom_edit) : 0;
  const finalOrderQty = hasUomEdit ? uomEditNum * moq : calcFinalOrderQty;
  // FinalOrderR_up (column AF):
  //  - Import mode: when row came from Import Barcode → display Qty × MOQ (Order UOM EDIT × MOQ)
  //  - Filter mode: keep original formula (UomEdit override OR ROUNDUP(Qty/MOQ))
  const finalOrderUom =
    row.is_import_row && hasUomEdit ? uomEditNum * moq : hasUomEdit ? uomEditNum : calcFinalOrderUom;
  const effectiveFinal = finalOrderQty;

  // AsIs DOH = IFERROR(Stock/Avg, 0)
  const dohAsis = row.avg_sales_store > 0 ? row.stock_store / row.avg_sales_store : 0;
  // ToBe DOH per Excel literal: IFERROR((Stock+FinalQty+OnOrder)-(Avg*OC)/Avg, 0)
  // Operator precedence: (Stock+FinalQty+OnOrder) - ((Avg*OC)/Avg) = (Stock+FinalQty+OnOrder) - OC
  const dohTobe = row.avg_sales_store > 0 ? row.stock_store + effectiveFinal + row.on_order_store - row.order_cycle : 0;

  // FinalOrder UOM (new column) = ROUNDUP(FinalOrderR_up / MOQ, 0)
  const finalOrderUomDiv = moq > 0 ? Math.ceil(finalOrderUom / moq) : 0;

  return {
    ...row,
    srr_suggest: Math.round(srrSuggest * 100) / 100,
    final_order_qty: Math.round(finalOrderQty * 100) / 100,
    final_order_uom: Math.round(finalOrderUom * 100) / 100,
    final_order_uom_div: finalOrderUomDiv,
    doh_asis: Math.round(dohAsis * 100) / 100,
    doh_tobe: Math.round(dohTobe * 100) / 100,
  };
}

function buildD2SRows(rawRows: any[]): D2SRow[] {
  return rawRows.map((r: any, idx: number) => {
    const rank = r.rank_sales || "D";
    const rankIsDefault = !r.rank_sales || r.rank_sales === "" || r.rank_sales === "D";
    const moq = Number(r.moq) || 1;
    const poCostVal = Number(r.po_cost) || 0;
    const poCostUnit = Number(r.po_cost_unit) || (moq > 0 ? poCostVal / moq : 0);
    const vendorDisplay = r.vendor_code ? `${r.vendor_code} - ${r.vendor_display_name || r.vendor_code}` : "";
    const oc = Number(r.order_cycle) || 0;

    const row: D2SRow = {
      id: `d2s-${r.sku_code || idx}-${r.store_name || idx}`,
      sku_code: r.sku_code || "",
      main_barcode: r.main_barcode || "",
      product_name_la: r.product_name_la || "",
      product_name_en: r.product_name_en || "",
      vendor_code: r.vendor_code || "",
      vendor_display: vendorDisplay,
      spc_name: r.spc_name || "",
      order_day: r.order_day || "",
      delivery_day: r.delivery_day || "",
      trade_term: r.trade_term || "",
      rank_sales: rank,
      rank_is_default: rankIsDefault,
      store_name: r.store_name || "",
      type_store: r.type_store || "",
      unit_name: `1x${moq}`,
      avg_sales_store: Number(r.avg_sales_store) || 0,
      orig_avg_sales_store: Number(r.avg_sales_store) || 0,
      min_store: Number(r.min_store) || 0,
      max_store: Number(r.max_store) || 0,
      stock_store: Number(r.stock_store) || 0,
      stock_dc: Number(r.stock_dc) || 0,
      order_cycle: oc,
      orig_order_cycle: oc,
      leadtime: Number(r.leadtime) || 0,
      srr_suggest: 0,
      on_order_store: Number(r.on_order_store) || 0,
      final_order_qty: 0,
      moq,
      final_order_uom: 0,
      final_order_uom_div: 0,
      order_uom_edit: "",
      doh_asis: 0,
      doh_tobe: 0,
      po_cost: poCostVal,
      po_cost_unit: Math.round(poCostUnit * 100) / 100,
      orig_po_cost: poCostVal,
      orig_po_cost_unit: Math.round(poCostUnit * 100) / 100,
      item_type: r.item_type || "",
      buying_status: r.buying_status || "",
      unit_of_measure: r.unit_of_measure || "",
      po_group: r.po_group || "",
      division_group: r.division_group || "",
      division: r.division || "",
      department: r.department || "",
      sub_department: r.sub_department || "",
      class_name: r.class || "",
      sub_class: r.sub_class || "",
      calculated: true,
      safety: SAFETY_BY_RANK[rank?.toUpperCase()] ?? 7,
    };
    return recalcD2SRow(row);
  });
}

// --- Columns (Spec A→AJ exact order) ---
const D2S_COLUMNS: { key: keyof D2SRow; label: string; group?: string }[] = [
  { key: "store_name", label: "Store Name" }, // A
  { key: "type_store", label: "Type Store" }, // B
  { key: "division_group", label: "Division Group" }, // C
  { key: "division", label: "Division" }, // D
  { key: "department", label: "Department" }, // E
  { key: "sub_department", label: "Sub-Department" }, // F
  { key: "class_name", label: "Class" }, // G
  { key: "sub_class", label: "Sub-Class" }, // H
  { key: "item_type", label: "Item Type" }, // I
  { key: "buying_status", label: "Buying Status" }, // J
  { key: "vendor_display", label: "Vendor" }, // K
  { key: "po_group", label: "PO Group" }, // L
  { key: "trade_term", label: "Trade Term" }, // M
  { key: "spc_name", label: "SPC Name" }, // N
  { key: "order_day", label: "Order Day" }, // O
  { key: "delivery_day", label: "Delivery Day" }, // P
  { key: "sku_code", label: "ID (SKU)" }, // Q
  { key: "product_name_la", label: "Product Name (LA)" }, // R
  { key: "product_name_en", label: "Product Name (EN)" }, // S
  { key: "rank_sales", label: "Sale Rank" }, // T
  { key: "unit_name", label: "UnitName" }, // U
  { key: "avg_sales_store", label: "Avg Unit Sale/Day", group: "Sales" }, // V
  { key: "min_store", label: "Min Store", group: "Min/Max" }, // W
  { key: "stock_store", label: "Store Stock", group: "Stock" }, // X
  { key: "stock_dc", label: "Stock DC", group: "Stock" }, // Y
  { key: "order_cycle", label: "Order Cycle" }, // Z
  { key: "leadtime", label: "LeadTimeDelivery" }, // AA
  { key: "srr_suggest", label: "SRR Suggest (pcs)" }, // AB
  { key: "on_order_store", label: "On Order (pcs)" }, // AC
  { key: "final_order_qty", label: "FinalOrder Qty" }, // AD
  { key: "moq", label: "MOQ" }, // AE
  { key: "final_order_uom", label: "FinalOrderR_up" }, // AF (renamed from "FinalOrder UOM")
  { key: "final_order_uom_div", label: "FinalOrder UOM" }, // AF2 (= FinalOrderR_up / MOQ)
  { key: "order_uom_edit", label: "Order UOM EDIT" }, // AG
  { key: "doh_asis", label: "AsIs DOH" }, // AH
  { key: "doh_tobe", label: "ToBe DOH" }, // AI
  { key: "po_cost_unit", label: "PO Cost Unit" }, // AJ
];

const ALL_D2S_KEYS = D2S_COLUMNS.map((c) => c.key);
const HIGHLIGHT_D2S = new Set([
  "srr_suggest",
  "final_order_qty",
  "final_order_uom",
  "final_order_uom_div",
  "doh_asis",
  "doh_tobe",
  "stock_dc",
]);
const TRUNCATE_D2S = new Set(["product_name_la", "product_name_en", "vendor_display", "store_name"]);
const EDITABLE_D2S = new Set(["order_uom_edit", "order_cycle"]);
const DOH_RED_THRESHOLD_D2S = 30;

function formatCellValue(val: any, key: string): string {
  if (val === null || val === undefined || val === "") return "";
  if (typeof val === "number") {
    if (val === 0) return "";
    return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(val);
}

function getDefaultWidth(key: string): number {
  if (TRUNCATE_D2S.has(key)) return 180;
  if (key === "vendor_display") return 200;
  if (key === "store_name") return 140;
  if (key === "sku_code" || key === "main_barcode") return 120;
  if (key === "order_uom_edit") return 110;
  return 90;
}

// --- Date helpers ---
function getDateKey(): string {
  const now = new Date();
  return (
    now.getFullYear().toString() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0")
  );
}

function isWithin30Days(dateKey: string): boolean {
  const y = parseInt(dateKey.substring(0, 4));
  const m = parseInt(dateKey.substring(4, 6)) - 1;
  const d = parseInt(dateKey.substring(6, 8));
  const docDate = new Date(y, m, d);
  return new Date().getTime() - docDate.getTime() < 30 * 24 * 60 * 60 * 1000;
}

/**
 * Build a batch key "yyyymmddHHMM" from a doc's created_at.
 * Docs from the same Read & Cal run share the same minute → same batch.
 */
function getBatchKey(doc: { date_key: string; created_at?: string }): string {
  if (!doc.created_at) return doc.date_key.replace(/-/g, "");
  const dt = new Date(doc.created_at);
  if (isNaN(dt.getTime())) return doc.date_key.replace(/-/g, "");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}${p(dt.getMonth() + 1)}${p(dt.getDate())}${p(dt.getHours())}${p(dt.getMinutes())}`;
}

/**
 * Display label for a batch key — same as key (yyyymmddHHMM).
 */
function fmtTreeStamp(batchKey: string, _docs: { created_at?: string }[]): string {
  return batchKey;
}
function MultiSelect({
  label,
  options,
  selected,
  onChange,
  searchable = true,
  compact = false,
}: {
  label: string;
  options: { value: string; display: string }[];
  selected: string[];
  onChange: (val: string[]) => void;
  searchable?: boolean;
  compact?: boolean;
}) {
  const [search, setSearch] = useState("");
  const filtered = searchable
    ? options.filter(
        (o) =>
          o.display.toLowerCase().includes(search.toLowerCase()) ||
          o.value.toLowerCase().includes(search.toLowerCase()),
      )
    : options;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "text-xs justify-between",
            compact ? "h-7 min-w-[100px] max-w-[180px] px-2" : "h-8 min-w-[120px] max-w-[200px]",
          )}
        >
          <span className="truncate">{selected.length === 0 ? label : `${label} (${selected.length})`}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        {searchable && (
          <div className="flex items-center gap-1 mb-2">
            <Search className="w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="ค้นหา..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 text-xs"
            />
          </div>
        )}
        <div className="flex items-center gap-2 mb-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs px-2"
            onClick={() => onChange(filtered.map((o) => o.value))}
          >
            เลือกทั้งหมด
          </Button>
          <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => onChange([])}>
            ล้าง
          </Button>
        </div>
        <ScrollArea className="h-48">
          {filtered.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 px-2 py-1 hover:bg-muted rounded cursor-pointer">
              <Checkbox
                checked={selected.includes(opt.value)}
                onCheckedChange={(checked) => {
                  onChange(checked ? [...selected, opt.value] : selected.filter((v) => v !== opt.value));
                }}
              />
              <span className="text-xs truncate">{opt.display}</span>
            </label>
          ))}
          {filtered.length === 0 && <p className="text-xs text-muted-foreground px-2 py-4">ไม่พบข้อมูล</p>}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================
// MAIN D2S PAGE
// ============================================================
const d2sStateRef = { current: null as any };

export default function SRRDirectPage() {
  const { user } = useAuth();
  const [vendorDocs, setVendorDocsRaw] = useState<VendorDocument[]>(d2sStateRef.current?.vendorDocs || []);
  const setVendorDocs = useCallback((updater: VendorDocument[] | ((prev: VendorDocument[]) => VendorDocument[])) => {
    setVendorDocsRaw((prev) => (typeof updater === "function" ? updater(prev) : updater));
  }, []);

  const [loading, setLoading] = useState(false);
  const [calcProgress, setCalcProgress] = useState(0);
  const [loadingPhase, setLoadingPhase] = useState("");
  const [activeTab, setActiveTab] = useState<string>(d2sStateRef.current?.activeTab || "read-cal");
  const cancelCalcRef = useRef(false);
  const [dataReady, setDataReady] = useState(false);
  const [dataLoadingMsg, setDataLoadingMsg] = useState("");

  // Snapshot date filter (mirrors DC)
  const [snapshotDates, setSnapshotDates] = useState<string[]>([]);
  const [snapshotBatches, setSnapshotBatches] = useState<SnapshotBatch[]>([]);
  const [poRefreshKey, setPoRefreshKey] = useState(0);
  // Filter Date is per-mode (Filter / Vendor / Import) so each mode keeps its own date selection
  const [selectedBatchValuesByMode, setSelectedBatchValuesByMode] = useState<
    Record<"filter" | "vendor" | "import", string[]>
  >(d2sStateRef.current?.selectedBatchValuesByMode || { filter: [], vendor: [], import: [] });
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const listPoBatches = useMemo(() => getLocalPOBatches("srr_saved_pos_d2s"), [poRefreshKey]);
  const documentBatches = useMemo(
    () => mergeSnapshotBatches(buildSnapshotBatchesFromDocs(vendorDocs), snapshotBatches),
    [vendorDocs, snapshotBatches],
  );

  // SPC selection
  const [selectedSpcForCal, setSelectedSpcForCal] = useState<string[]>([]);
  const [spcOptions, setSpcOptions] = useState<{ value: string; display: string }[]>([]);

  // Vendor filter for Read & Cal (subset)
  const [vendorFilterCal, setVendorFilterCal] = useState<string[]>([]);
  const [vendorOptionsForCal, setVendorOptionsForCal] = useState<{ value: string; display: string }[]>([]);
  // Type Store filter for Read & Cal (Jmart / Kokkok / U-dee)
  const [typeStoreCal, setTypeStoreCal] = useState<string[]>([]);
  // PRE-PREPARE filters
  const [orderDayCal, setOrderDayCal] = useState<string[]>([]);
  const [itemTypeCal, setItemTypeCal] = useState<string[]>([]);
  const [storeCal, setStoreCal] = useState<string[]>([]);
  const [buyingStatusCal, setBuyingStatusCal] = useState<string[]>([]);
  const [poGroupCal, setPoGroupCal] = useState<string[]>([]);
  const [vendorMasterAll, setVendorMasterAll] = useState<
    { vendor_code: string; vendor_name: string; spc_name: string; order_day: string }[]
  >([]);
  const [preFilterOptions, setPreFilterOptions] = useState<{
    itemTypes: { value: string; display: string }[];
    buyingStatuses: { value: string; display: string }[];
    poGroups: { value: string; display: string }[];
    stores: { value: string; display: string }[];
  }>({ itemTypes: [], buyingStatuses: [], poGroups: [], stores: [] });
  const TYPE_STORE_OPTIONS = useMemo(
    () => [
      { value: "Jmart", display: "Jmart" },
      { value: "Kokkok", display: "Kokkok" },
      { value: "U-dee", display: "U-dee" },
    ],
    [],
  );

  // PRE-PREPARE: Vendor/Order Day from vendor_master scoped to selected SPC
  const preVendorOptions = useMemo(() => {
    const pool =
      selectedSpcForCal.length > 0
        ? vendorMasterAll.filter((v) => selectedSpcForCal.includes(v.spc_name))
        : vendorMasterAll;
    const seen = new Map<string, string>();
    for (const v of pool) if (v.vendor_code && !seen.has(v.vendor_code)) seen.set(v.vendor_code, v.vendor_name);
    return [...seen.entries()]
      .map(([k, n]) => ({ value: k, display: `${k} - ${n}` }))
      .sort((a, b) => a.value.localeCompare(b.value));
  }, [vendorMasterAll, selectedSpcForCal]);
  const preOrderDayOptions = useMemo(() => {
    const pool =
      selectedSpcForCal.length > 0
        ? vendorMasterAll.filter((v) => selectedSpcForCal.includes(v.spc_name))
        : vendorMasterAll;
    return [...new Set(pool.map((v) => v.order_day).filter(Boolean))].sort().map((d) => ({ value: d, display: d }));
  }, [vendorMasterAll, selectedSpcForCal]);

  // Import Mode — persisted across navigation
  const [importMode, setImportMode] = useState<SrrImportMode>(
    (d2sStateRef.current?.importMode as SrrImportMode) || "filter",
  );
  const [importedItems, setImportedItems] = useState<ImportedItem[]>(d2sStateRef.current?.importedItems || []);
  const [importedSkuSet, setImportedSkuSet] = useState<Set<string>>(
    new Set(d2sStateRef.current?.importedSkuSetArr || []),
  );
  /** Per-store qty: key = `${sku}|${store}` (store="" → applies to all stores of that sku) */
  const [importedQtyByKey, setImportedQtyByKey] = useState<Map<string, number>>(
    new Map(d2sStateRef.current?.importedQtyByKeyArr || []),
  );
  /** Per-SKU po cost (NOT per-store, per spec) */
  const [importedPoCostBySku, setImportedPoCostBySku] = useState<Map<string, number>>(
    new Map(d2sStateRef.current?.importedPoCostBySkuArr || []),
  );
  /** Set of `${sku}|${store}` pairs to filter rows. If a sku has any store-specified entry, only those stores are kept. */
  const [importedStoreBySku, setImportedStoreBySku] = useState<Map<string, Set<string>>>(
    new Map((d2sStateRef.current?.importedStoreBySkuArr || []).map(([k, v]: [string, string[]]) => [k, new Set(v)])),
  );
  const [importedSkippedKeys, setImportedSkippedKeys] = useState<string[]>(
    d2sStateRef.current?.importedSkippedKeys || [],
  );
  const [importedSkippedItems, setImportedSkippedItems] = useState<SkippedItem[]>(
    d2sStateRef.current?.importedSkippedItems || [],
  );
  const [importSkipDialogOpen, setImportSkipDialogOpen] = useState(false);
  const [importedVendors, setImportedVendors] = useState<ImportedVendor[]>(d2sStateRef.current?.importedVendors || []);

  // Tab 1: tree (5-level: SPC > Date > Vendor > TypeStore > Store)
  const [docSearch, setDocSearch] = useState("");
  const [expandedSPCs, setExpandedSPCs] = useState<Set<string>>(new Set());
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [expandedVendors, setExpandedVendors] = useState<Set<string>>(new Set());
  const [expandedTypeStores, setExpandedTypeStores] = useState<Set<string>>(new Set());
  const [previewDoc, setPreviewDoc] = useState<VendorDocument | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());

  // Tab 2: filters (load from stateRef for persistence)
  const [itemTypeFilter, setItemTypeFilter] = useState<string[]>(d2sStateRef.current?.itemTypeFilter || []);
  const [selectedDocSpc, setSelectedDocSpc] = useState<string[]>(d2sStateRef.current?.selectedDocSpc || []);
  const [orderDayFilter, setOrderDayFilter] = useState<string[]>(d2sStateRef.current?.orderDayFilter || []);
  const [vendorFilter, setVendorFilter] = useState<string[]>(d2sStateRef.current?.vendorFilter || []);
  const [storeFilter, setStoreFilter] = useState<string[]>(d2sStateRef.current?.storeFilter || []);
  const [typeStoreFilter, setTypeStoreFilter] = useState<string[]>(d2sStateRef.current?.typeStoreFilter || []);
  const [buyingStatusFilter, setBuyingStatusFilter] = useState<string[]>(d2sStateRef.current?.buyingStatusFilter || []);
  const [poGroupFilter, setPoGroupFilter] = useState<string[]>(d2sStateRef.current?.poGroupFilter || []);
  const [showOnlyFinalGt0, setShowOnlyFinalGt0] = useState<boolean>(d2sStateRef.current?.showOnlyFinalGt0 || false);
  // Tab 2 mode toggle (independent from Tab 1) — "filter" | "vendor" | "import"(=barcode)
  const [tab2Mode, setTab2Mode] = useState<"filter" | "vendor" | "import">(
    (d2sStateRef.current?.tab2Mode as "filter" | "vendor" | "import") || "filter",
  );
  const [vendorOptions, setVendorOptions] = useState<{ value: string; display: string }[]>([]);

  // Bulk-assign inputs
  const [assignMinValue, setAssignMinValue] = useState<string>(d2sStateRef.current?.assignMinValue || "3");
  const [assignOcValue, setAssignOcValue] = useState<string>(d2sStateRef.current?.assignOcValue || "");

  // Tab 2 display
  const [showData, setShowData] = useState<D2SRow[]>(d2sStateRef.current?.showData || []);
  const [page, setPage] = useState(d2sStateRef.current?.page || 0);
  const [pageSize, setPageSize] = useState(d2sStateRef.current?.pageSize || 30);

  // Tab 2: Odoo-style chip search
  const [tableSearchChips, setTableSearchChips] = useState<SearchChip[]>([]);
  const TABLE_SEARCH_COLS = useMemo(
    () => [
      { key: "store_name", label: "Store" },
      { key: "type_store", label: "Type Store" },
      { key: "vendor_display", label: "Vendor" },
      { key: "vendor_code", label: "Vendor Code" },
      { key: "sku_code", label: "SKU" },
      { key: "main_barcode", label: "Barcode" },
      { key: "product_name_en", label: "Product (EN)" },
      { key: "product_name_la", label: "Product (LA)" },
      { key: "spc_name", label: "SPC" },
      { key: "po_group", label: "PO Group" },
      { key: "rank_sales", label: "Rank" },
      { key: "order_day", label: "Order Day" },
      { key: "item_type", label: "Item Type" },
    ],
    [],
  );
  const TABLE_SEARCH_KEYS = useMemo(() => TABLE_SEARCH_COLS.map((c) => c.key), [TABLE_SEARCH_COLS]);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [selectedCols, setSelectedCols] = useState<Set<string>>(new Set());
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [resizing, setResizing] = useState<{ col: string; startX: number; startW: number } | null>(null);
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  const [lastClickedRow, setLastClickedRow] = useState<number | null>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set(ALL_D2S_KEYS));
  // Saved column views (persist in localStorage)
  const D2S_VIEWS_KEY = "srr_d2s_column_views";
  const [savedViews, setSavedViews] = useState<{ name: string; columns: string[] }[]>(() => {
    try { return JSON.parse(localStorage.getItem(D2S_VIEWS_KEY) || "[]"); } catch { return []; }
  });
  const [newViewName, setNewViewName] = useState("");
  const persistViews = (views: { name: string; columns: string[] }[]) => {
    setSavedViews(views);
    try { localStorage.setItem(D2S_VIEWS_KEY, JSON.stringify(views)); } catch {}
  };
  const saveCurrentView = () => {
    const name = newViewName.trim();
    if (!name) return;
    const next = [...savedViews.filter(v => v.name !== name), { name, columns: Array.from(visibleColumns) }];
    persistViews(next);
    setNewViewName("");
    toast({ title: "บันทึก View สำเร็จ", description: name });
  };
  const loadView = (view: { name: string; columns: string[] }) => {
    setVisibleColumns(new Set(view.columns));
    toast({ title: `โหลด View: ${view.name}` });
  };
  const deleteView = (name: string) => {
    persistViews(savedViews.filter(v => v.name !== name));
  };

  // Store types for export
  const [storeTypes, setStoreTypes] = useState<
    { ship_to: string; code: string; type_store: string; type_doc: string; store_name: string }[]
  >([]);
  const [pickingType, setPickingType] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportDescription, setExportDescription] = useState("");
  const importFileRef = useRef<HTMLInputElement>(null);
  const [showImportSkipped, setShowImportSkipped] = useState<SkippedItem[]>([]);

  const { toast } = useToast();
  const displayColumns = useMemo(() => D2S_COLUMNS.filter((c) => visibleColumns.has(c.key)), [visibleColumns]);

  // Persist state (filters + showData + assign values + per-mode date + import context for mode isolation)
  useEffect(() => {
    return () => {
      d2sStateRef.current = {
        vendorDocs,
        activeTab,
        page,
        pageSize,
        itemTypeFilter,
        selectedDocSpc,
        orderDayFilter,
        vendorFilter,
        storeFilter,
        typeStoreFilter,
        buyingStatusFilter,
        poGroupFilter,
        showOnlyFinalGt0,
        tab2Mode,
        showData,
        assignMinValue,
        assignOcValue,
        // --- mode isolation persistence ---
        importMode,
        selectedBatchValuesByMode,
        importedItems,
        importedSkuSetArr: Array.from(importedSkuSet),
        importedQtyByKeyArr: Array.from(importedQtyByKey.entries()),
        importedPoCostBySkuArr: Array.from(importedPoCostBySku.entries()),
        importedStoreBySkuArr: Array.from(importedStoreBySku.entries()).map(([k, v]) => [k, Array.from(v)]),
        importedSkippedKeys,
        importedSkippedItems,
        importedVendors,
      };
    };
  });

  // Load SPC list + restore docs from DB
  useEffect(() => {
    fetchAllRows<any>("vendor_master", "vendor_code, vendor_name_en, vendor_name_la, spc_name, order_day").then(
      (vms) => {
        const spcs = [...new Set(vms.map((v: any) => v.spc_name).filter(Boolean))].sort() as string[];
        setSpcOptions(spcs.map((s) => ({ value: s, display: s })));
        setVendorMasterAll(
          vms
            .filter((v: any) => v.vendor_code)
            .map((v: any) => ({
              vendor_code: v.vendor_code,
              vendor_name: v.vendor_name_en || v.vendor_name_la || v.vendor_code,
              spc_name: v.spc_name || "",
              order_day: v.order_day || "",
            })),
        );
      },
    );
    supabase.rpc("get_srr_pre_filter_options" as any).then(({ data }) => {
      const row = (data as any[])?.[0];
      if (row) {
        setPreFilterOptions({
          itemTypes: (row.item_types || []).map((v: string) => ({ value: v, display: v })),
          buyingStatuses: (row.buying_statuses || []).map((v: string) => ({ value: v, display: v })),
          poGroups: (row.po_groups || []).map((v: string) => ({ value: v, display: v })),
          stores: (row.stores || []).map((s: any) => ({
            value: s.store_name,
            display: `${s.store_name} (${s.type_store})`,
          })),
        });
      }
    });
    supabase
      .from("store_type")
      .select("ship_to, code, type_store, type_doc, store_name")
      .then(({ data }) => {
        if (data) {
          setStoreTypes(data as any);
          if (data.length > 0 && !pickingType) setPickingType(data[0].ship_to);
        }
      });
    if (vendorDocs.length === 0) {
      loadD2SSnapshots()
        .then((snaps) => {
          if (!snaps || snaps.length === 0) return;
          const docs: VendorDocument[] = snaps.map((s: any) => ({
            id: s.id,
            vendor_code: s.vendor_code,
            vendor_display: s.vendor_display || s.vendor_code,
            store_name: s.store_name,
            type_store: s.type_store || "",
            spc_name: s.spc_name,
            date_key: isoToDateKey(s.date_key),
            created_at: s.created_at,
            item_count: s.item_count,
            suggest_count: s.suggest_count,
            data: s.data || [],
            edit_count: s.edit_count || 0,
            edited_columns: s.edited_columns || [],
            source: (s.source as any) || "filter",
          }));
          setVendorDocs(docs);
        })
        .catch((err) => console.error("Load D2S snapshots failed:", err));
    }
    // Load distinct snapshot dates (for Filter Date dropdown)
    Promise.all([getD2SSnapshotDates(), getSnapshotBatches("srr_d2s_snapshots")])
      .then(([dates, batches]) => {
        setSnapshotDates(dates);
        setSnapshotBatches(batches);
      })
      .catch((err) => console.error("Load D2S snapshot dates failed:", err));
  }, []);

  // Active mode for the Filter Date picker — Tab 2 uses tab2Mode, otherwise importMode (Tab 1/3)
  const activeDateMode: "filter" | "vendor" | "import" =
    activeTab === "show-edit" ? tab2Mode : (importMode as "filter" | "vendor" | "import");

  // Replace docs of a specific mode without touching other modes' docs
  const replaceDocsForMode = (mode: "filter" | "vendor" | "import", incoming: VendorDocument[]) => {
    setVendorDocs((prev) => {
      const others = prev.filter((d) => (d.source || "filter") !== mode);
      const tagged = incoming.map((d) => ({ ...d, source: mode }));
      return [...others, ...tagged];
    });
  };

  // Filter Date: load snapshots for a specific date, batch ISO, or "today" — applies to current mode only
  const loadHistoricalDate = async (key: string, mode: "filter" | "vendor" | "import" = activeDateMode) => {
    try {
      setLoadingSnapshots(true);
      const isBatch = key !== "today" && key.includes("T");
      const snaps =
        key === "today"
          ? await loadD2SSnapshots()
          : isBatch
            ? await loadSnapshotBatch(key, "srr_d2s_snapshots")
            : await loadD2SSnapshotsByDate(key);
      const docs: VendorDocument[] = (snaps || []).map((s: any) => ({
        id: s.id,
        vendor_code: s.vendor_code,
        vendor_display: s.vendor_display || s.vendor_code,
        store_name: s.store_name,
        type_store: s.type_store || "",
        spc_name: s.spc_name,
        date_key: isoToDateKey(s.date_key),
        created_at: s.created_at,
        item_count: s.item_count,
        suggest_count: s.suggest_count,
        data: s.data || [],
        edit_count: s.edit_count || 0,
        edited_columns: s.edited_columns || [],
        source: mode,
      }));
      replaceDocsForMode(mode, docs);
      setShowData([]);
      const label =
        key === "today" ? "ล่าสุด" : isBatch ? snapshotBatches.find((b) => b.value === key)?.label || key : key;
      toast({ title: `โหลดข้อมูล ${label} (${mode})`, description: `${docs.length} document(s)` });
    } catch (err: any) {
      toast({ title: "โหลดข้อมูลไม่สำเร็จ", description: err.message, variant: "destructive" });
    } finally {
      setLoadingSnapshots(false);
    }
  };

  // Multi-batch loader: merges snapshots from several batch timestamps — applies to current mode only
  const loadHistoricalBatches = async (keys: string[], mode: "filter" | "vendor" | "import" = activeDateMode) => {
    if (keys.length === 0) {
      await loadHistoricalDate("today", mode);
      return;
    }
    if (keys.length === 1) {
      await loadHistoricalDate(keys[0], mode);
      return;
    }
    try {
      setLoadingSnapshots(true);
      const arrays = await Promise.all(keys.map((k) => loadSnapshotBatch(k, "srr_d2s_snapshots")));
      const seen = new Set<string>();
      const merged: any[] = [];
      for (const arr of arrays)
        for (const s of arr || []) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          merged.push(s);
        }
      const docs: VendorDocument[] = merged.map((s: any) => ({
        id: s.id,
        vendor_code: s.vendor_code,
        vendor_display: s.vendor_display || s.vendor_code,
        store_name: s.store_name,
        type_store: s.type_store || "",
        spc_name: s.spc_name,
        date_key: isoToDateKey(s.date_key),
        created_at: s.created_at,
        item_count: s.item_count,
        suggest_count: s.suggest_count,
        data: s.data || [],
        edit_count: s.edit_count || 0,
        edited_columns: s.edited_columns || [],
        source: mode,
      }));
      replaceDocsForMode(mode, docs);
      setShowData([]);
      toast({ title: `โหลด ${keys.length} batch (${mode})`, description: `${docs.length} document(s)` });
    } catch (err: any) {
      toast({ title: "โหลดข้อมูลไม่สำเร็จ", description: err.message, variant: "destructive" });
    } finally {
      setLoadingSnapshots(false);
    }
  };

  // Tree grouping: Batch (yyyymmddHHMM) > SPC > Vendor > TypeStore > Store
  // Each Read & Cal run = its own batch (separated by minute of created_at).
  const docTree = useMemo(() => {
    const tree = new Map<string, Map<string, Map<string, Map<string, VendorDocument[]>>>>();
    const search = docSearch.toLowerCase();
    for (const doc of vendorDocs) {
      if ((doc.source || "filter") !== importMode) continue;
      if (
        search &&
        !doc.spc_name.toLowerCase().includes(search) &&
        !doc.vendor_code.toLowerCase().includes(search) &&
        !doc.vendor_display.toLowerCase().includes(search) &&
        !doc.store_name.toLowerCase().includes(search)
      )
        continue;
      const batchKey = getBatchKey(doc);
      if (!tree.has(batchKey)) tree.set(batchKey, new Map());
      const spcMap = tree.get(batchKey)!;
      if (!spcMap.has(doc.spc_name)) spcMap.set(doc.spc_name, new Map());
      const vendorMap = spcMap.get(doc.spc_name)!;
      const vendorKey = doc.vendor_code;
      if (!vendorMap.has(vendorKey)) vendorMap.set(vendorKey, new Map());
      const typeStoreMap = vendorMap.get(vendorKey)!;
      const tsKey = doc.type_store || "(No Type)";
      if (!typeStoreMap.has(tsKey)) typeStoreMap.set(tsKey, []);
      typeStoreMap.get(tsKey)!.push(doc);
    }
    return tree;
  }, [vendorDocs, docSearch, importMode]);

  // Tab 2: only consider docs from Tab 2's own mode toggle (independent of Tab 1)
  const docsForTab2 = useMemo(() => {
    return vendorDocs.filter((d) => (d.source || "filter") === tab2Mode);
  }, [vendorDocs, tab2Mode]);

  // Derived filter options (mode-scoped)
  const docDerivedOptions = useMemo(() => {
    const allRows = docsForTab2.flatMap((d) => d.data);
    const vendors = new Map<string, string>();
    const orderDays = new Set<string>();
    const itemTypes = new Set<string>();
    const stores = new Set<string>();
    const typeStores = new Set<string>();
    const buyingStatuses = new Set<string>();
    const poGroups = new Set<string>();
    for (const row of allRows) {
      if (row.vendor_code) vendors.set(row.vendor_code, row.vendor_display || row.vendor_code);
      if (row.order_day) orderDays.add(row.order_day);
      if (row.item_type) itemTypes.add(row.item_type);
      if (row.store_name) stores.add(row.store_name);
      if (row.type_store) typeStores.add(row.type_store);
      if (row.buying_status) buyingStatuses.add(row.buying_status);
      if (row.po_group) poGroups.add(row.po_group);
    }
    return {
      vendors: [...vendors.entries()]
        .map(([k, v]) => ({ value: k, display: `${k} - ${v}` }))
        .sort((a, b) => a.value.localeCompare(b.value)),
      orderDays: [...orderDays].sort().map((d) => ({ value: d, display: d })),
      itemTypes: [...itemTypes].sort().map((t) => ({ value: t, display: t })),
      stores: [...stores].sort().map((s) => ({ value: s, display: s })),
      typeStores: [...typeStores].sort().map((t) => ({ value: t, display: t })),
      buyingStatuses: [...buyingStatuses].sort().map((b) => ({ value: b, display: b })),
      poGroups: [...poGroups].sort().map((p) => ({ value: p, display: p })),
    };
  }, [docsForTab2]);

  const availableDocSpcs = useMemo(() => {
    const spcs = [...new Set(docsForTab2.map((d) => d.spc_name))].sort();
    return spcs.map((s) => ({
      value: s,
      display: `${s} (${docsForTab2.filter((d) => d.spc_name === s).reduce((a, d) => a + d.item_count, 0)} items)`,
    }));
  }, [docsForTab2]);

  useEffect(() => {
    const allRows = docsForTab2.flatMap((d) => d.data);
    let filtered = allRows;
    if (selectedDocSpc.length > 0) filtered = filtered.filter((r) => selectedDocSpc.includes(r.spc_name));
    if (orderDayFilter.length > 0) filtered = filtered.filter((r) => orderDayFilter.includes(r.order_day));
    const seen = new Map<string, string>();
    for (const r of filtered)
      if (r.vendor_code && !seen.has(r.vendor_code)) seen.set(r.vendor_code, r.vendor_display || r.vendor_code);
    setVendorOptions(
      [...seen.entries()]
        .map(([k, v]) => ({ value: k, display: `${k} - ${v}` }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    );
  }, [selectedDocSpc, orderDayFilter, docsForTab2]);

  const loadFilterOptions = async () => {
    // Vendor Mode: imported vendor_codes → derive SPC from vendor_master
    if (importMode === "vendor") {
      if (importedVendors.length === 0) {
        toast({ title: "ยัง import vendor_code", variant: "destructive" });
        return;
      }
      setDataReady(false);
      setDataLoadingMsg(`Resolve ${importedVendors.length} vendor...`);
      try {
        const vCodes = [...new Set(importedVendors.map((v) => v.vendor_code).filter(Boolean))];
        const vms = await fetchAllRows<any>(
          "vendor_master",
          "vendor_code, spc_name, vendor_name_la, vendor_name_en",
          (q) => q.in("vendor_code", vCodes),
        );
        if (vms.length === 0) {
          const allSkipped: SkippedItem[] = vCodes.map((v) => ({
            kind: "vendor" as const,
            key: v,
            reason: "ไม่พบใน Vendor Master",
            detail: "vendor_code นี้ไม่มีใน vendor_master",
          }));
          setImportedSkippedItems(allSkipped);
          setImportSkipDialogOpen(true);
          toast({ title: "ไม่พบ vendor ใน Master", variant: "destructive" });
          setDataLoadingMsg("");
          return;
        }
        const foundCodes = new Set<string>(vms.map((v: any) => v.vendor_code).filter(Boolean));
        const skippedVendors = vCodes.filter((v) => !foundCodes.has(v));
        const spcSet = new Set<string>();
        for (const v of vms) if (v.spc_name) spcSet.add(v.spc_name);
        // For Read & Cal we display vendor list & lock SPCs derived from imported vendors
        const seen = new Map<string, string>();
        for (const m of vms) {
          if (m.vendor_code && !seen.has(m.vendor_code))
            seen.set(m.vendor_code, m.vendor_name_en || m.vendor_name_la || m.vendor_code);
        }
        setVendorOptionsForCal(
          [...seen.entries()]
            .map(([k, v]) => ({ value: k, display: `${k} - ${v}` }))
            .sort((a, b) => a.value.localeCompare(b.value)),
        );
        setSelectedSpcForCal([...spcSet].sort());
        setVendorFilterCal([...foundCodes]);
        const skippedItems: SkippedItem[] = skippedVendors.map((v) => ({
          kind: "vendor" as const,
          key: v,
          reason: "ไม่พบใน Vendor Master",
          detail: "vendor_code นี้ไม่มีใน vendor_master",
        }));
        setImportedSkippedItems(skippedItems);
        setDataReady(true);
        setDataLoadingMsg("");
        toast({
          title: "เตรียมข้อมูลเสร็จ (Vendor)",
          description: `Match ${foundCodes.size}/${vCodes.length} vendor · ${spcSet.size} SPC${skippedVendors.length ? ` · Skip ${skippedVendors.length}` : ""}`,
        });
        if (skippedItems.length > 0) setImportSkipDialogOpen(true);
      } catch (err: any) {
        toast({ title: "Error", description: err.message, variant: "destructive" });
        setDataLoadingMsg("");
      }
      return;
    }

    // Import Mode: resolve barcodes/SKUs → derive vendor + SPC
    if (importMode === "import") {
      if (importedItems.length === 0) {
        toast({ title: "ยัง import ไฟล์", variant: "destructive" });
        return;
      }
      setDataReady(false);
      setDataLoadingMsg(`Resolve ${importedItems.length} รายการ...`);
      try {
        const keys = importedItems.map((i) => i.key);
        const found = new Map<string, { sku_code: string; vendor_code: string; vendor_display_name: string }>();
        const matchedKeys = new Set<string>();
        const keyToSku = new Map<string, string>();
        const chunkSize = 80; // keep URL length safely under PostgREST/server limit
        for (let i = 0; i < keys.length; i += chunkSize) {
          const slice = keys.slice(i, i + chunkSize);
          setDataLoadingMsg(`Resolve ${Math.min(i + chunkSize, keys.length)}/${keys.length}...`);
          const inExpr = slice.map((k) => `"${String(k).replace(/"/g, '\\"')}"`).join(",");
          const { data, error } = await (supabase as any)
            .from("data_master")
            .select("sku_code, main_barcode, barcode, vendor_code, vendor_display_name")
            .or(`main_barcode.in.(${inExpr}),barcode.in.(${inExpr}),sku_code.in.(${inExpr})`);
          if (error) throw error;
          for (const row of (data || []) as any[]) {
            if (!row.sku_code) continue;
            if (row.main_barcode && slice.includes(row.main_barcode)) {
              matchedKeys.add(row.main_barcode);
              keyToSku.set(row.main_barcode, row.sku_code);
            }
            if (row.barcode && slice.includes(row.barcode)) {
              matchedKeys.add(row.barcode);
              keyToSku.set(row.barcode, row.sku_code);
            }
            if (slice.includes(row.sku_code)) {
              matchedKeys.add(row.sku_code);
              keyToSku.set(row.sku_code, row.sku_code);
            }
            if (!found.has(row.sku_code))
              found.set(row.sku_code, {
                sku_code: row.sku_code,
                vendor_code: row.vendor_code || "",
                vendor_display_name: row.vendor_display_name || row.vendor_code || "",
              });
          }
        }
        // Build per-(sku,store) qty + per-sku poCost + sku→stores mapping
        const qtyByKey = new Map<string, number>(); // key = `${sku}|${store}` or `${sku}|` (no store)
        const poCostMap = new Map<string, number>(); // per-SKU only
        const storeBySku = new Map<string, Set<string>>(); // sku → set of stores from file (only if specified)
        let dbgQtyZero = 0;
        let dbgQtyOk = 0;
        let dbgNoSku = 0;
        const dbgSampleRaw: any[] = [];
        for (const it of importedItems) {
          if (dbgSampleRaw.length < 5) dbgSampleRaw.push({ key: it.key, qty: it.qty, qtyType: typeof it.qty, store: it.storeName });
          const sku = keyToSku.get(it.key);
          if (!sku) { dbgNoSku++; continue; }
          const store = (it.storeName || "").trim();
          const qtyNum = Number(it.qty);
          if (!isNaN(qtyNum) && qtyNum > 0) {
            qtyByKey.set(`${sku}|${store}`, qtyNum);
            dbgQtyOk++;
          } else {
            dbgQtyZero++;
          }
          if (it.poCost && it.poCost > 0) poCostMap.set(sku, it.poCost);
          if (store) {
            if (!storeBySku.has(sku)) storeBySku.set(sku, new Set());
            storeBySku.get(sku)!.add(store);
          }
        }
        console.log(`[IMPORT PREPARE DBG] qtyOk=${dbgQtyOk} qtyZero=${dbgQtyZero} noSku=${dbgNoSku}`);
        console.log(`[IMPORT PREPARE DBG SAMPLE RAW]`, dbgSampleRaw);
        console.log(
          `[IMPORT PREPARE] importedItems=${importedItems.length}, matched=${matchedKeys.size}, qtyByKey.size=${qtyByKey.size}, storeBySku.size=${storeBySku.size}`,
        );
        // Sample: first 3 entries to verify keys
        const sampleQty = Array.from(qtyByKey.entries()).slice(0, 5);
        console.log(`[IMPORT PREPARE SAMPLE qtyByKey]`, sampleQty);
        const sampleStores = Array.from(storeBySku.entries()).slice(0, 3).map(([k, v]) => [k, Array.from(v)]);
        console.log(`[IMPORT PREPARE SAMPLE storeBySku]`, sampleStores);
        const skipped = importedItems.map((i) => i.key).filter((k) => !matchedKeys.has(k));
        const skippedItems: SkippedItem[] = skipped.map((k) => {
          // ถ้ามี storeName ใน imported item ที่ skip → mark kind=store
          const it = importedItems.find((x) => x.key === k);
          return {
            kind: "sku" as const,
            key: k,
            reason: "ไม่พบใน Master",
            detail: it?.storeName ? `Store: ${it.storeName}` : "barcode/SKU นี้ไม่มีใน data_master",
          };
        });
        setImportedSkippedKeys(skipped);
        setImportedSkippedItems(skippedItems);
        setImportedSkuSet(new Set(found.keys()));
        setImportedQtyByKey(qtyByKey);
        setImportedPoCostBySku(poCostMap);
        setImportedStoreBySku(storeBySku);
        if (found.size === 0) {
          setDataLoadingMsg("");
          toast({ title: "ไม่พบรายการใน Master", variant: "destructive" });
          if (skippedItems.length) setImportSkipDialogOpen(true);
          return;
        }

        const vendorCodes = [...new Set([...found.values()].map((v) => v.vendor_code).filter(Boolean))];
        setDataLoadingMsg(`โหลด Vendor Master (${vendorCodes.length})...`);
        const vms = await fetchAllRows<any>("vendor_master", "vendor_code, spc_name", (q) =>
          q.in("vendor_code", vendorCodes),
        );
        const spcSet = new Set<string>();
        for (const v of vms) if (v.spc_name) spcSet.add(v.spc_name);
        setVendorOptionsForCal(
          [...found.values()]
            .map((v) => ({ value: v.vendor_code, display: `${v.vendor_code} - ${v.vendor_display_name}` }))
            .sort((a, b) => a.value.localeCompare(b.value)),
        );
        setSelectedSpcForCal([...spcSet].sort());
        setDataReady(true);
        setDataLoadingMsg("");
        toast({
          title: "เตรียมข้อมูลเสร็จ (Import)",
          description: `Match ${matchedKeys.size}/${importedItems.length} · ${spcSet.size} SPC · ${vendorCodes.length} Vendor${skipped.length ? ` · Skip ${skipped.length}` : ""}`,
        });
        if (skipped.length) setImportSkipDialogOpen(true);
      } catch (err: any) {
        toast({ title: "Error", description: err.message, variant: "destructive" });
        setDataLoadingMsg("");
      }
      return;
    }

    if (selectedSpcForCal.length === 0) {
      toast({ title: "กรุณาเลือก SPC Name ก่อน", variant: "destructive" });
      return;
    }
    setDataReady(false);
    setDataLoadingMsg("กำลังเตรียมข้อมูล...");
    try {
      const vms = await fetchAllRows<any>("vendor_master", "vendor_code", (q) => q.in("spc_name", selectedSpcForCal));
      if (vms.length === 0) {
        toast({ title: "ไม่พบ Vendor", variant: "destructive" });
        setDataLoadingMsg("");
        return;
      }
      const vCodes = [...new Set(vms.map((v: any) => v.vendor_code).filter(Boolean))];
      const vendorMasters = await fetchAllRows<any>("data_master", "vendor_code, vendor_display_name", (q) =>
        q
          .in("vendor_code", vCodes)
          .eq("packing_size_qty", 1)
          .eq("stock_unit_flag", "Y")
          .eq("product_owner", "Lanexang Green Property Sole Co.,Ltd"),
      );
      const seen = new Map<string, string>();
      for (const m of vendorMasters) {
        if (m.vendor_code && !seen.has(m.vendor_code)) seen.set(m.vendor_code, m.vendor_display_name || m.vendor_code);
      }
      setVendorOptionsForCal(
        [...seen.entries()]
          .map(([k, v]) => ({ value: k, display: `${k} - ${v}` }))
          .sort((a, b) => a.value.localeCompare(b.value)),
      );
      setDataReady(true);
      setDataLoadingMsg("");
      toast({ title: "เตรียมข้อมูลเสร็จ", description: `${selectedSpcForCal.length} SPC · ${seen.size} Vendor` });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setDataLoadingMsg("");
    }
  };

  // Read & Cal
  const readAndCalc = async () => {
    if (selectedSpcForCal.length === 0 || !dataReady) {
      toast({ title: "กรุณาเตรียมข้อมูลก่อน", variant: "destructive" });
      return;
    }
    setLoading(true);
    cancelCalcRef.current = false;
    setCalcProgress(0);
    const t0 = performance.now();
    const dateKey = getDateKey();
    const now = new Date();
    const newDocs: VendorDocument[] = [];

    try {
      for (let i = 0; i < selectedSpcForCal.length; i++) {
        if (cancelCalcRef.current) {
          toast({ title: "ยกเลิกการคำนวณ", description: `${i}/${selectedSpcForCal.length} SPC` });
          break;
        }
        const spcName = selectedSpcForCal[i];
        setCalcProgress(Math.round((i / selectedSpcForCal.length) * 100));
        setLoadingPhase(`[${i + 1}/${selectedSpcForCal.length}] ${spcName}...`);

        const vcFilter =
          importMode === "import"
            ? [...new Set(vendorOptionsForCal.map((v) => v.value))]
            : vendorFilterCal.length > 0
              ? vendorFilterCal
              : null;
        const odParam = orderDayCal.length > 0 ? orderDayCal : null;
        const itParam = itemTypeCal.length > 0 ? itemTypeCal : null;
        let rawRows = await fetchD2SDataRPC(vcFilter, [spcName], odParam, itParam);
        if (buyingStatusCal.length > 0) rawRows = rawRows.filter((r: any) => buyingStatusCal.includes(r.buying_status));
        if (poGroupCal.length > 0) rawRows = rawRows.filter((r: any) => poGroupCal.includes(r.po_group));
        if (storeCal.length > 0) rawRows = rawRows.filter((r: any) => storeCal.includes(r.store_name));

        let filteredRaw = rawRows;
        if (importMode === "import" && importedSkuSet.size > 0) {
          const beforeCount = rawRows.length;
          let skuMissCount = 0,
            storeMissCount = 0;
          filteredRaw = rawRows.filter((r: any) => {
            if (!importedSkuSet.has(r.sku_code)) {
              skuMissCount++;
              return false;
            }
            const stores = importedStoreBySku.get(r.sku_code);
            if (stores && stores.size > 0) {
              if (!stores.has(r.store_name)) {
                storeMissCount++;
                return false;
              }
              return true;
            }
            return true;
          });
          console.log(
            `[IMPORT FILTER] SPC=${spcName} raw=${beforeCount} → kept=${filteredRaw.length} (sku_miss=${skuMissCount}, store_miss=${storeMissCount}); importedSkuSet.size=${importedSkuSet.size}, storeBySku.size=${importedStoreBySku.size}`,
          );
          // Sample mismatch debug
          if (filteredRaw.length > 0 && storeMissCount > 0) {
            const sample = rawRows.find(
              (r) =>
                importedSkuSet.has(r.sku_code) &&
                importedStoreBySku.get(r.sku_code) &&
                !importedStoreBySku.get(r.sku_code)!.has(r.store_name),
            );
            if (sample) {
              const wantStores = [...(importedStoreBySku.get(sample.sku_code) || [])];
              console.log(
                `[IMPORT FILTER SAMPLE] sku=${sample.sku_code} rpc.store="${sample.store_name}" wantStores=`,
                wantStores,
              );
            }
          }
        }
        if (filteredRaw.length === 0) continue;

        let calculated = buildD2SRows(filteredRaw);
        // Apply Import overrides: Qty → order_uom_edit (per store), Po cost → po_cost / po_cost_unit (per SKU, all stores)
        if (importMode === "import" && (importedQtyByKey.size > 0 || importedPoCostBySku.size > 0)) {
          let appliedQty = 0;
          let appliedPc = 0;
          let missQty = 0;
          calculated = calculated.map((r) => {
            // Look up qty: prefer per-store key, fall back to sku-level (no store specified in file)
            const qStore = importedQtyByKey.get(`${r.sku_code}|${r.store_name}`);
            const qSku = importedQtyByKey.get(`${r.sku_code}|`);
            const q = qStore ?? qSku;
            const pc = importedPoCostBySku.get(r.sku_code);
            if (!q && !pc) {
              if (importedQtyByKey.size > 0) missQty++;
              return r;
            }
            const moq = r.moq || 1;
            const next = { ...r };
            // Po cost = per SKU (independent of store, only override if provided)
            if (pc && pc > 0) {
              next.po_cost = pc;
              next.po_cost_unit = Math.round((moq > 0 ? pc / moq : pc) * 100) / 100;
              appliedPc++;
            }
            // Qty → order_uom_edit; FinalOrder = Qty * MOQ is handled by recalcD2SRow via order_uom_edit override.
            // Also flag is_import_row so FinalOrderR_up column shows Qty × MOQ (import mode rule).
            if (q && q > 0) {
              next.order_uom_edit = String(q);
              next.is_import_row = true;
              appliedQty++;
            }
            return recalcD2SRow(next);
          });
          console.log(
            `[IMPORT OVERRIDE] SPC=${spcName} rows=${calculated.length} appliedQty=${appliedQty} appliedPc=${appliedPc} missQty=${missQty} qtyMap.size=${importedQtyByKey.size}`,
          );
          // Sample: dump first row that had qty applied to verify
          if (appliedQty > 0) {
            const sampleApplied = calculated.find((r) => r.is_import_row);
            if (sampleApplied) {
              console.log(
                `[IMPORT OVERRIDE SAMPLE] sku=${sampleApplied.sku_code} store="${sampleApplied.store_name}" order_uom_edit=${sampleApplied.order_uom_edit} final_order_uom=${sampleApplied.final_order_uom}`,
              );
            }
          } else if (importedQtyByKey.size > 0) {
            // Diagnostic: show first calculated row vs first qty key, to spot key-format mismatches
            const firstRow = calculated[0];
            const firstKey = Array.from(importedQtyByKey.keys())[0];
            console.warn(
              `[IMPORT OVERRIDE NO-MATCH] no qty applied. row.sku|store="${firstRow?.sku_code}|${firstRow?.store_name}" first qtyKey="${firstKey}"`,
            );
          }
        }
        // Always exclude Kokkok-Fc (out of scope for Direct ordering)
        calculated = calculated.filter((r) => r.type_store !== "Kokkok-Fc");
        // Filter by Type Store (Jmart / Kokkok / U-dee)
        if (typeStoreCal.length > 0) {
          calculated = calculated.filter((r) => typeStoreCal.includes(r.type_store));
        }
        if (calculated.length === 0) continue;

        // Group by vendor + store
        const vendorStoreMap = new Map<string, D2SRow[]>();
        for (const row of calculated) {
          const key = `${row.vendor_code || "UNKNOWN"}|${row.store_name || "UNKNOWN"}`;
          if (!vendorStoreMap.has(key)) vendorStoreMap.set(key, []);
          vendorStoreMap.get(key)!.push(row);
        }

        for (const [key, rows] of vendorStoreMap) {
          const [vc, sn] = key.split("|");
          const ts = rows[0]?.type_store || "";
          newDocs.push({
            id: `d2s-doc-${importMode}-${dateKey}-${spcName}-${vc}-${sn}`,
            vendor_code: vc,
            vendor_display: rows[0]?.vendor_display || vc,
            store_name: sn,
            type_store: ts,
            spc_name: spcName,
            date_key: dateKey,
            created_at: now.toISOString(),
            item_count: rows.length,
            suggest_count: rows.filter((r) => r.final_order_qty > 0).length,
            data: rows,
            edit_count: 0,
            edited_columns: [],
            source: importMode as "filter" | "vendor" | "import",
          });
        }
      }

      setCalcProgress(100);
      setLoadingPhase("เสร็จสิ้น");

      // Replace only same mode + same batch + same SPC + same Vendor + same Store.
      const newDocKeys = new Set(newDocs.map((d) => `${d.source || importMode}|${getBatchKey(d)}|${d.spc_name}|${d.vendor_code}|${d.store_name}`));
      const finalDocs = [
        ...vendorDocs.filter((d) => {
          if (!isWithin30Days(d.date_key)) return false;
          const docKey = `${d.source || "filter"}|${getBatchKey(d)}|${d.spc_name}|${d.vendor_code}|${d.store_name}`;
          return !newDocKeys.has(docKey);
        }),
        ...newDocs,
      ];
      setVendorDocs(finalDocs);

      if (newDocs.length > 0) {
        const latestBatchValue = newDocs[0].created_at;
        setSnapshotBatches((prev) => [
          { value: latestBatchValue, label: fmtTreeStamp(dateKey, newDocs), date_key: dateKeyToISO(dateKey), count: newDocs.length },
          ...prev.filter((b) => String(b.value).slice(0, 19) !== String(latestBatchValue).slice(0, 19)),
        ]);
        setSelectedBatchValuesByMode((prev) => ({ ...prev, [importMode]: [latestBatchValue] }));
      }
      if (tab2Mode === importMode) {
        let merged = newDocs.flatMap((d) => d.data);
        merged.sort((a, b) => {
          const s = a.store_name.localeCompare(b.store_name);
          if (s !== 0) return s;
          return a.vendor_code.localeCompare(b.vendor_code);
        });
        setShowData(merged);
        setSelectedRows(new Set());
        setActiveCell(null);
        setPage(0);
      }

      // AUTO-SAVE to DB
      let savedNote = "";
      if (user && newDocs.length > 0) {
        try {
          const batchCreatedAt = newDocs[0].created_at;
          await saveD2SSnapshots(
            newDocs.map((d) => ({
              spc_name: d.spc_name,
              vendor_code: d.vendor_code,
              vendor_display: d.vendor_display,
              store_name: d.store_name,
              type_store: d.type_store,
              source: d.source || "filter",
              item_count: d.item_count,
              suggest_count: d.suggest_count,
              data: d.data,
              edit_count: d.edit_count,
              edited_columns: d.edited_columns,
            })),
            user.id,
            dateKeyToISO(dateKey),
            batchCreatedAt,
          );
          // Refresh available batches so dropdown reflects all preserved Read & Cal runs
          try {
            const batches = await getSnapshotBatches("srr_d2s_snapshots");
            setSnapshotBatches(batches);
          } catch {}
          savedNote = " · บันทึกแล้ว";
        } catch (saveErr: any) {
          console.error("Auto-save D2S to DB failed:", saveErr);
          toast({ title: "⚠️ บันทึก DB ไม่สำเร็จ", description: saveErr.message, variant: "destructive" });
        }
      }

      const totalItems = newDocs.reduce((s, d) => s + d.item_count, 0);
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      toast({
        title: `✅ Read & Cal สำเร็จ (${elapsed}s)`,
        description: `${newDocs.length} Vendor Docs · ${totalItems.toLocaleString()} รายการ${savedNote}`,
      });
      setTimeout(() => {
        setCalcProgress(0);
        setLoadingPhase("");
      }, 2000);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  // Doc management
  const deleteVendorDoc = async (docId: string) => {
    setVendorDocs((prev) => prev.filter((d) => d.id !== docId));
    try {
      await deleteD2SSnapshot(docId);
    } catch (e: any) {
      console.error("DB delete failed:", e);
    }
    toast({ title: "ลบ Document สำเร็จ" });
  };
  // Mode-scoped: only act on docs of the currently active importMode
  const clearAllDocuments = async () => {
    const modeDocs = vendorDocs.filter((d) => (d.source || "filter") === importMode);
    const ids = modeDocs.map((d) => d.id);
    if (ids.length === 0) {
      toast({ title: "ไม่มี Document ใน Mode นี้" });
      return;
    }
    const idSet = new Set(ids);
    setVendorDocs((prev) => prev.filter((d) => !idSet.has(d.id)));
    setShowData([]);
    setSelectedDocIds((prev) => {
      const n = new Set(prev);
      ids.forEach((id) => n.delete(id));
      return n;
    });
    try {
      await (supabase as any).from("srr_d2s_snapshots").delete().in("id", ids);
    } catch (e: any) {
      console.error(e);
    }
    const modeLabel = importMode === "filter" ? "Filter" : importMode === "vendor" ? "Import Vendor" : "Import SKU";
    toast({ title: `ล้าง Document (${modeLabel}) แล้ว`, description: `ลบ ${ids.length} รายการ` });
  };
  const selectAllDocs = () => {
    const modeIds = vendorDocs.filter((d) => (d.source || "filter") === importMode).map((d) => d.id);
    setSelectedDocIds((prev) => {
      const n = new Set(prev);
      modeIds.forEach((id) => n.add(id));
      return n;
    });
  };
  const unselectAllDocs = () => {
    const modeIds = new Set(vendorDocs.filter((d) => (d.source || "filter") === importMode).map((d) => d.id));
    setSelectedDocIds((prev) => {
      const n = new Set(prev);
      modeIds.forEach((id) => n.delete(id));
      return n;
    });
  };
  const toggleDocSelect = (id: string) => {
    setSelectedDocIds((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const deleteSelectedDocs = async () => {
    const modeIdSet = new Set(vendorDocs.filter((d) => (d.source || "filter") === importMode).map((d) => d.id));
    const ids = [...selectedDocIds].filter((id) => modeIdSet.has(id));
    if (ids.length === 0) return;
    const count = ids.length;
    const idSet = new Set(ids);
    setVendorDocs((prev) => prev.filter((d) => !idSet.has(d.id)));
    setSelectedDocIds((prev) => {
      const n = new Set(prev);
      ids.forEach((id) => n.delete(id));
      return n;
    });
    try {
      await (supabase as any).from("srr_d2s_snapshots").delete().in("id", ids);
    } catch (e: any) {
      console.error(e);
    }
    toast({ title: "ลบ Document สำเร็จ", description: `ลบ ${count} เอกสาร` });
  };

  // Show filtered (sort by Store Name > Vendor) — scoped to Tab 2's mode (filter / vendor / import)
  const showFilteredData = () => {
    if (docsForTab2.length === 0) {
      const modeLabel =
        tab2Mode === "filter" ? "Mode Filter" : tab2Mode === "vendor" ? "Import Vendor" : "Import Barcode";
      toast({
        title: `ยังไม่มี Document ใน ${modeLabel}`,
        description: "ไปที่ Tab 1 แล้วกด Read & Cal ใน mode นี้ก่อน",
        variant: "destructive",
      });
      return;
    }
    let docs = docsForTab2;
    if (selectedDocSpc.length > 0) docs = docs.filter((d) => selectedDocSpc.includes(d.spc_name));
    if (vendorFilter.length > 0) docs = docs.filter((d) => vendorFilter.includes(d.vendor_code));
    let merged = docs.flatMap((d) => d.data);
    if (orderDayFilter.length > 0) merged = merged.filter((r) => orderDayFilter.includes(r.order_day));
    if (itemTypeFilter.length > 0) merged = merged.filter((r) => itemTypeFilter.includes(r.item_type));
    if (storeFilter.length > 0) merged = merged.filter((r) => storeFilter.includes(r.store_name));
    if (typeStoreFilter.length > 0) merged = merged.filter((r) => typeStoreFilter.includes(r.type_store));
    if (buyingStatusFilter.length > 0) merged = merged.filter((r) => buyingStatusFilter.includes(r.buying_status));
    if (poGroupFilter.length > 0) merged = merged.filter((r) => poGroupFilter.includes(r.po_group));
    // Sort by Store Name A-Z, then Vendor A-Z
    merged.sort((a, b) => {
      const s = a.store_name.localeCompare(b.store_name);
      if (s !== 0) return s;
      return a.vendor_code.localeCompare(b.vendor_code);
    });
    setShowData(merged);
    setPage(0);
    setSelectedRows(new Set());
    setActiveCell(null);
    toast({ title: `แสดง ${merged.length.toLocaleString()} รายการ` });
  };

  // Edit handlers
  const updateAvgSales = (rowId: string, value: string) => {
    const numVal = parseFloat(value);
    const newVal = isNaN(numVal) ? 0 : numVal;
    setShowData((rows) => rows.map((r) => (r.id !== rowId ? r : recalcD2SRow({ ...r, avg_sales_store: newVal }))));
    setVendorDocs((prev) =>
      prev.map((doc) => ({
        ...doc,
        data: doc.data.map((r) => (r.id !== rowId ? r : recalcD2SRow({ ...r, avg_sales_store: newVal }))),
        edit_count: doc.data.some((r) => r.id === rowId) ? doc.edit_count + 1 : doc.edit_count,
        edited_columns: doc.data.some((r) => r.id === rowId)
          ? [...new Set([...doc.edited_columns, "avg_sales_store"])]
          : doc.edited_columns,
      })),
    );
  };

  const updateOrderUomEdit = (rowId: string, value: string) => {
    setShowData((rows) => rows.map((r) => (r.id !== rowId ? r : recalcD2SRow({ ...r, order_uom_edit: value }))));
    setVendorDocs((prev) =>
      prev.map((doc) => ({
        ...doc,
        data: doc.data.map((r) => (r.id !== rowId ? r : recalcD2SRow({ ...r, order_uom_edit: value }))),
        edit_count: doc.data.some((r) => r.id === rowId) ? doc.edit_count + 1 : doc.edit_count,
        edited_columns: doc.data.some((r) => r.id === rowId)
          ? [...new Set([...doc.edited_columns, "order_uom_edit"])]
          : doc.edited_columns,
      })),
    );
  };

  const updateOrderCycle = (rowId: string, value: string) => {
    const numVal = parseFloat(value);
    const newVal = isNaN(numVal) ? 0 : numVal;
    setShowData((rows) => rows.map((r) => (r.id !== rowId ? r : recalcD2SRow({ ...r, order_cycle: newVal }))));
    setVendorDocs((prev) =>
      prev.map((doc) => ({
        ...doc,
        data: doc.data.map((r) => (r.id !== rowId ? r : recalcD2SRow({ ...r, order_cycle: newVal }))),
        edit_count: doc.data.some((r) => r.id === rowId) ? doc.edit_count + 1 : doc.edit_count,
        edited_columns: doc.data.some((r) => r.id === rowId)
          ? [...new Set([...doc.edited_columns, "order_cycle"])]
          : doc.edited_columns,
      })),
    );
  };

  // Assign Min N for shown data WHERE min_store === 0 only (with recalc)
  const assignMinBulk = () => {
    const n = parseFloat(assignMinValue);
    if (isNaN(n) || n <= 0) {
      toast({ title: "กรุณาใส่จำนวน Min ที่ถูกต้อง", variant: "destructive" });
      return;
    }
    if (showData.length === 0) {
      toast({ title: "ไม่มีข้อมูลที่แสดง", variant: "destructive" });
      return;
    }
    const zeroMinRows = showData.filter((r) => r.min_store === 0);
    if (zeroMinRows.length === 0) {
      toast({ title: "ไม่มีรายการที่ Min = 0", variant: "destructive" });
      return;
    }
    const affectedIds = new Set(zeroMinRows.map((r) => r.id));
    setShowData((rows) => rows.map((r) => (affectedIds.has(r.id) ? recalcD2SRow({ ...r, min_store: n }) : r)));
    setVendorDocs((prev) =>
      prev.map((doc) => ({
        ...doc,
        data: doc.data.map((r) => (affectedIds.has(r.id) ? recalcD2SRow({ ...r, min_store: n }) : r)),
        edit_count: doc.data.some((r) => affectedIds.has(r.id)) ? doc.edit_count + 1 : doc.edit_count,
        edited_columns: doc.data.some((r) => affectedIds.has(r.id))
          ? [...new Set([...doc.edited_columns, "min_store"])]
          : doc.edited_columns,
      })),
    );
    toast({ title: `Assign Min ${n} สำเร็จ`, description: `${zeroMinRows.length} รายการที่ Min=0 (Recalculated)` });
  };

  // Assign Order Cycle (overwrite for ALL shown rows, then recalc)
  const assignOrderCycleBulk = () => {
    const n = parseFloat(assignOcValue);
    if (isNaN(n) || n < 0) {
      toast({ title: "กรุณาใส่ Order Cycle ที่ถูกต้อง", variant: "destructive" });
      return;
    }
    if (showData.length === 0) {
      toast({ title: "ไม่มีข้อมูลที่แสดง", variant: "destructive" });
      return;
    }
    const affectedIds = new Set(showData.map((r) => r.id));
    setShowData((rows) => rows.map((r) => recalcD2SRow({ ...r, order_cycle: n })));
    setVendorDocs((prev) =>
      prev.map((doc) => ({
        ...doc,
        data: doc.data.map((r) => (affectedIds.has(r.id) ? recalcD2SRow({ ...r, order_cycle: n }) : r)),
        edit_count: doc.data.some((r) => affectedIds.has(r.id)) ? doc.edit_count + 1 : doc.edit_count,
        edited_columns: doc.data.some((r) => affectedIds.has(r.id))
          ? [...new Set([...doc.edited_columns, "order_cycle"])]
          : doc.edited_columns,
      })),
    );
    toast({ title: `Assign Order Cycle = ${n} สำเร็จ`, description: `${showData.length} รายการ (Recalculated)` });
  };

  // Import Excel: match Store Name + SKU → replace SRR Suggest (pcs) + recalc
  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (importFileRef.current) importFileRef.current.value = "";
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json<Record<string, any>>(sheet);
      if (jsonData.length === 0) {
        toast({ title: "ไฟล์ว่าง", variant: "destructive" });
        return;
      }

      // Build lookup: key = "storeName|skuCode" => qty + track skipped rows
      const qtyMap = new Map<string, number>();
      const skipped: SkippedItem[] = [];
      jsonData.forEach((row, idx) => {
        const storeName = String(row["Store Name"] || row["store_name"] || "").trim();
        const sku = String(row["ID (SKU)"] || row["ID"] || row["sku_code"] || row["SKU"] || "").trim();
        const qtyRaw = row["QTy"] ?? row["Qty"] ?? row["qty"] ?? row["QTY"] ?? "";
        const qty = Number(qtyRaw);
        const key = `${storeName}|${sku}`;
        if (!storeName || !sku) {
          skipped.push({
            kind: "other",
            key: `Row ${idx + 2}`,
            reason: !storeName && !sku ? "ไม่มี Store Name และ SKU" : !storeName ? "ไม่มี Store Name" : "ไม่มี SKU",
            detail: `Store=${storeName || "-"}, SKU=${sku || "-"}`,
            original: row,
          });
        } else if (!qty || qty <= 0 || isNaN(qty)) {
          skipped.push({
            kind: "qty",
            key,
            reason: "Qty ว่าง / ไม่ใช่ตัวเลข / ≤ 0",
            detail: `Qty=${qtyRaw}`,
            original: row,
          });
        } else {
          qtyMap.set(key, qty);
        }
      });

      if (qtyMap.size === 0) {
        setShowImportSkipped(skipped);
        toast({
          title: "ไม่พบข้อมูลที่ตรง",
          description: "ต้องมีคอลัมน์ Store Name, ID (SKU), QTy",
          variant: "destructive",
        });
        return;
      }

      // Validate match against current showData (Store|SKU pairs that don't exist in result)
      const showKeys = new Set(showData.map((r) => `${r.store_name}|${r.sku_code}`));
      qtyMap.forEach((q, k) => {
        if (!showKeys.has(k)) {
          const [s, sku] = k.split("|");
          skipped.push({
            kind: "store",
            key: k,
            reason: "ไม่พบ Store + SKU ใน Show",
            detail: `Store=${s}, SKU=${sku}, Qty=${q}`,
          });
        }
      });

      let matchCount = 0;
      const updateRow = (r: D2SRow): D2SRow => {
        const key = `${r.store_name}|${r.sku_code}`;
        const qty = qtyMap.get(key);
        if (qty !== undefined) {
          matchCount++;
          const moq = r.moq || 1;
          const roundedQty = moq > 0 ? Math.ceil(qty / moq) * moq : qty;
          // Set srr_suggest to imported qty, then recalc final order
          const updated = { ...r, srr_suggest: roundedQty };
          const rawFinal = Math.max(roundedQty - r.on_order_store, 0);
          const calcFinalOrderQty = rawFinal === 0 ? 0 : moq > 0 ? Math.ceil(rawFinal / moq) * moq : rawFinal;
          const calcFinalOrderUom = moq > 0 ? calcFinalOrderQty / moq : calcFinalOrderQty;
          const hasUomEdit = r.order_uom_edit !== "" && r.order_uom_edit != null && !isNaN(Number(r.order_uom_edit));
          const uomEditNum = hasUomEdit ? Number(r.order_uom_edit) : 0;
          const finalOrderUom = hasUomEdit ? uomEditNum : calcFinalOrderUom;
          const finalOrderQty = hasUomEdit ? uomEditNum * moq : calcFinalOrderQty;
          const effectiveFinal = finalOrderQty;
          const dohAsis = r.avg_sales_store > 0 ? r.stock_store / r.avg_sales_store : 0;
          const dohTobe =
            r.avg_sales_store > 0
              ? (r.stock_store + r.on_order_store + effectiveFinal - r.avg_sales_store * r.leadtime) / r.avg_sales_store
              : 0;
          return {
            ...updated,
            final_order_qty: Math.round(finalOrderQty * 100) / 100,
            final_order_uom: Math.round(finalOrderUom * 100) / 100,
            final_order_uom_div: moq > 0 ? Math.ceil(finalOrderUom / moq) : 0,
            doh_asis: Math.round(dohAsis * 100) / 100,
            doh_tobe: Math.round(dohTobe * 100) / 100,
          };
        }
        return r;
      };

      setShowData((rows) => rows.map(updateRow));
      setVendorDocs((prev) =>
        prev.map((doc) => ({
          ...doc,
          data: doc.data.map(updateRow),
          edit_count: doc.edit_count + 1,
          edited_columns: [...new Set([...doc.edited_columns, "srr_suggest"])],
        })),
      );
      setShowImportSkipped(skipped);

      toast({
        title: "Import สำเร็จ",
        description: `Match ${matchCount} รายการจาก ${qtyMap.size} แถวในไฟล์${skipped.length ? ` · Skip ${skipped.length}` : ""}`,
      });
    } catch (err: any) {
      toast({ title: "Import Error", description: err.message, variant: "destructive" });
    }
  };

  // Paged
  const filteredShowData = useMemo(() => {
    const base = showOnlyFinalGt0 ? showData.filter((r) => r.final_order_qty > 0) : showData;
    return applyChipFilter(base, tableSearchChips, TABLE_SEARCH_KEYS);
  }, [showData, tableSearchChips, TABLE_SEARCH_KEYS, showOnlyFinalGt0]);
  const pagedData = filteredShowData.slice(page * pageSize, (page + 1) * pageSize);
  const totalPages = Math.ceil(filteredShowData.length / pageSize);

  // Row interactions
  const handleRowClick = (idx: number, id: string, e: { shiftKey: boolean }) => {
    if (e.shiftKey && lastClickedRow !== null) {
      const start = Math.min(lastClickedRow, idx),
        end = Math.max(lastClickedRow, idx);
      setSelectedRows((prev) => {
        const n = new Set(prev);
        for (let i = start; i <= end; i++) if (pagedData[i]) n.add(pagedData[i].id);
        return n;
      });
    } else {
      setSelectedRows((prev) => {
        const n = new Set(prev);
        n.has(id) ? n.delete(id) : n.add(id);
        return n;
      });
    }
    setLastClickedRow(idx);
    setActiveCell({ row: idx, col: activeCell?.col ?? 0 });
  };
  const toggleSelectAll = () => {
    if (selectedRows.size === pagedData.length) setSelectedRows(new Set());
    else setSelectedRows(new Set(pagedData.map((r) => r.id)));
  };

  // Resize
  const onResizeStart = (col: string, e: React.MouseEvent) => {
    e.preventDefault();
    setResizing({ col, startX: e.clientX, startW: columnWidths[col] || getDefaultWidth(col) });
  };
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) =>
      setColumnWidths((prev) => ({
        ...prev,
        [resizing.col]: Math.max(60, resizing.startW + e.clientX - resizing.startX),
      }));
    const onUp = () => setResizing(null);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [resizing]);

  // Export
  const exportTableData = (selectedOnly: boolean) => {
    const rows = selectedOnly ? showData.filter((r) => selectedRows.has(r.id)) : showData;
    if (rows.length === 0) {
      toast({ title: "ไม่มีข้อมูล", variant: "destructive" });
      return;
    }
    const exportRows = rows.map((r) => {
      const mapped: Record<string, any> = {};
      for (const col of displayColumns) mapped[col.label] = r[col.key];
      return mapped;
    });
    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SRR DIRECT ITEM");
    XLSX.writeFile(wb, `SRR_DIRECT_ITEM_export.xlsx`);
    toast({ title: "Export สำเร็จ", description: `${rows.length} แถว` });
  };

  // Save PO (D2S)
  const savePO = () => {
    try {
      const vendors = [...new Set(showData.filter((r) => r.final_order_qty > 0).map((r) => r.vendor_code))].sort();
      if (vendors.length === 0) {
        toast({ title: "ไม่มี Vendor ที่มี Suggest > 0", variant: "destructive" });
        return;
      }
      const now = new Date();
      const ts =
        now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, "0") +
        String(now.getDate()).padStart(2, "0") +
        String(now.getHours()).padStart(2, "0") +
        String(now.getMinutes()).padStart(2, "0") +
        String(now.getSeconds()).padStart(2, "0");
      // No manual picking type selection — auto-map per row from store_name
      const existing = JSON.parse(localStorage.getItem("srr_saved_pos_d2s") || "[]");
      const newPOs: any[] = [];

      const spcManager = "SPC manager01";
      for (const vc of vendors) {
        const vendorRows = showData.filter((r) => r.vendor_code === vc && r.final_order_qty > 0);
        if (vendorRows.length === 0) continue;
        const vName = vendorRows[0].vendor_display;

        // Group by Store Name → po_group (fallback: vendor_code) within Vendor
        const stores = [...new Set(vendorRows.map((r) => r.store_name))].sort();
        for (const storeName of stores) {
          const storeRows = vendorRows.filter((r) => r.store_name === storeName);
          // Sub-group by po_group within (vendor + store)
          const groupMap = new Map<string, D2SRow[]>();
          for (const r of storeRows) {
            const gk = r.po_group && r.po_group.trim() ? r.po_group.trim() : vc;
            if (!groupMap.has(gk)) groupMap.set(gk, []);
            groupMap.get(gk)!.push(r);
          }
          const matchedST = storeTypes.find((st) => st.store_name === storeName);
          const rowPickingId = matchedST ? matchedST.ship_to : "";

          for (const [groupKey, gRows] of groupMap) {
            const sortedRows = gRows.sort((a, b) => String(a.sku_code).localeCompare(String(b.sku_code)));
            const exportRows = sortedRows.map((r, idx) => ({
              partner_id: idx === 0 ? vc : "",
              "Picking Type / Database ID": idx === 0 ? rowPickingId : "",
              "Inter Transfer": idx === 0 ? "true" : "",
              "PO Group": idx === 0 ? groupKey : "",
              "Products to Purchase/barcode": r.main_barcode,
              "Products to Purchase/Product": r.main_barcode,
              "Product name": r.product_name_la,
              "Store Name": r.store_name,
              "Products to Purchase/UoM": r.unit_of_measure || "",
              "Products to Purchase/Exclude In Package": "True",
              "Products to Purchase/Quantity":
                r.order_uom_edit && !isNaN(Number(r.order_uom_edit))
                  ? Number(r.order_uom_edit) * (r.moq || 1)
                  : r.final_order_qty,
              "Products to Purchase/Unit Price": r.po_cost_unit,
              assigned_to: idx === 0 ? spcManager : "",
              description: idx === 0 ? exportDescription : "",
            }));
            newPOs.push({
              id: `po-d2s-${ts}-${vc}-${storeName}-${groupKey}`,
              name: `${ts} - D2S - ${vc} - ${storeName}${groupKey !== vc ? ` (${groupKey})` : ""}`,
              date: now.toISOString(),
              vendor_code: vc,
              vendor_name: vName,
              spc_name: gRows[0].spc_name || "",
              rows: exportRows,
              pickingType,
              description: exportDescription,
            });
          }
        }
      }
      localStorage.setItem("srr_saved_pos_d2s", JSON.stringify([...existing, ...newPOs]));
      setPoRefreshKey((v) => v + 1);
      setSelectedBatchValuesByMode((prev) => ({ ...prev, [activeDateMode]: [now.toISOString()] }));
      toast({ title: "บันทึก PO สำเร็จ", description: `${newPOs.length} เอกสาร (แยกตาม vendor + store + po_group)` });
      setExportOpen(false);
      setExportOpen(false);
    } catch (err: any) {
      toast({ title: "บันทึก PO ไม่สำเร็จ", description: err?.message, variant: "destructive" });
    }
  };

  // Tree helpers (5-level: Date > SPC > Vendor > TypeStore > Store)
  const toggleDate = (dk: string) => {
    setExpandedDates((prev) => {
      const n = new Set(prev);
      n.has(dk) ? n.delete(dk) : n.add(dk);
      return n;
    });
  };
  const toggleSPC = (key: string) => {
    setExpandedSPCs((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  };
  const toggleVendor = (key: string) => {
    setExpandedVendors((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  };
  const toggleTypeStore = (key: string) => {
    setExpandedTypeStores((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  };
  const expandAllTree = () => {
    const allDates = new Set<string>();
    const allSPCs = new Set<string>();
    const allVendors = new Set<string>();
    const allTS = new Set<string>();
    for (const [dk, sm] of docTree) {
      allDates.add(dk);
      for (const [s, vm] of sm) {
        allSPCs.add(`${dk}|${s}`);
        for (const [vc, tsm] of vm) {
          allVendors.add(`${dk}|${s}|${vc}`);
          for (const ts of tsm.keys()) allTS.add(`${dk}|${s}|${vc}|${ts}`);
        }
      }
    }
    setExpandedDates(allDates);
    setExpandedSPCs(allSPCs);
    setExpandedVendors(allVendors);
    setExpandedTypeStores(allTS);
  };
  const collapseAllTree = () => {
    setExpandedSPCs(new Set());
    setExpandedDates(new Set());
    setExpandedVendors(new Set());
    setExpandedTypeStores(new Set());
  };

  // Tab 1 summary: count docs that match the current Tab 1 mode (filter / vendor / import)
  const docsInMode = vendorDocs.filter((d) => (d.source || "filter") === importMode);
  const totalItems = docsInMode.reduce((s, d) => s + d.item_count, 0);
  const totalDocsCount = docsInMode.length;

  const renderTable = (rows: D2SRow[], showEdit: boolean) => {
    if (rows.length === 0) return null;
    return (
      <table className="w-full border-collapse">
        <thead className="sticky top-0 z-10">
          <tr>
            {showEdit && (
              <>
                <th className="data-table-header bg-muted" style={{ width: 36, minWidth: 36 }}>
                  <Checkbox
                    checked={selectedRows.size === pagedData.length && pagedData.length > 0}
                    onCheckedChange={toggleSelectAll}
                    className="mx-auto"
                  />
                </th>
                <th className="data-table-header bg-muted" style={{ width: 44, minWidth: 44 }}>
                  #
                </th>
              </>
            )}
            {!showEdit && (
              <th className="data-table-header bg-muted" style={{ width: 44, minWidth: 44 }}>
                #
              </th>
            )}
            {displayColumns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "data-table-header relative group cursor-pointer select-none whitespace-nowrap",
                  selectedCols.has(col.key) && "bg-emerald-100 dark:bg-emerald-900/40",
                  HIGHLIGHT_D2S.has(col.key) && "bg-blue-50 dark:bg-blue-950/30",
                )}
                style={{ width: columnWidths[col.key] || getDefaultWidth(col.key), minWidth: 60 }}
                onClick={() =>
                  setSelectedCols((prev) => {
                    const n = new Set(prev);
                    n.has(col.key) ? n.delete(col.key) : n.add(col.key);
                    return n;
                  })
                }
              >
                {col.label}
                <div
                  className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-primary/30 group-hover:bg-primary/10"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    onResizeStart(col.key, e);
                  }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const isSelected = selectedRows.has(row.id);
            const isActiveRow = activeCell?.row === idx;
            return (
              <tr
                key={row.id}
                className={cn(
                  "border-b border-border transition-colors",
                  isSelected
                    ? "bg-emerald-50 dark:bg-emerald-950/30"
                    : isActiveRow
                      ? "bg-blue-50/50 dark:bg-blue-950/20"
                      : "hover:bg-muted/50",
                )}
                onClick={(e) => showEdit && handleRowClick(idx, row.id, e)}
              >
                {showEdit && (
                  <>
                    <td
                      className="data-table-cell text-center bg-inherit"
                      style={{ width: 36 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() =>
                          setSelectedRows((prev) => {
                            const n = new Set(prev);
                            n.has(row.id) ? n.delete(row.id) : n.add(row.id);
                            return n;
                          })
                        }
                        className="h-3.5 w-3.5"
                      />
                    </td>
                    <td className="data-table-cell text-muted-foreground text-center bg-inherit" style={{ width: 44 }}>
                      {page * pageSize + idx + 1}
                    </td>
                  </>
                )}
                {!showEdit && (
                  <td className="data-table-cell text-muted-foreground text-center bg-inherit" style={{ width: 44 }}>
                    {idx + 1}
                  </td>
                )}
                {displayColumns.map((col, colIdx) => {
                  const val = row[col.key];
                  const displayVal = formatCellValue(val, col.key);
                  const isTruncate = TRUNCATE_D2S.has(col.key);
                  const isHighlight = HIGHLIGHT_D2S.has(col.key);

                  // Order UOM Edit overrides Final Order Qty → orange highlight
                  const hasUomEditOverride = row.order_uom_edit !== "" && !isNaN(Number(row.order_uom_edit));
                  const isOverriddenFinal = col.key === "final_order_qty" && hasUomEditOverride;
                  // DOH ≥ 30 → light red highlight (D2S)
                  const isDohRed =
                    (col.key === "doh_asis" || col.key === "doh_tobe") &&
                    typeof val === "number" &&
                    (val as number) >= DOH_RED_THRESHOLD_D2S;

                  return (
                    <td
                      key={col.key}
                      data-row={idx}
                      data-col={colIdx}
                      className={cn(
                        "data-table-cell",
                        selectedCols.has(col.key) && "bg-emerald-50/50 dark:bg-emerald-950/20",
                        activeCell?.row === idx && activeCell?.col === colIdx && "ring-2 ring-primary ring-inset",
                        isHighlight &&
                          !isSelected &&
                          !isActiveRow &&
                          !isOverriddenFinal &&
                          !isDohRed &&
                          "bg-blue-50/40 dark:bg-blue-950/20",
                        isOverriddenFinal && "bg-orange-100 dark:bg-orange-950/40",
                        isDohRed && "bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300 font-semibold",
                        col.key === "final_order_qty" &&
                          typeof val === "number" &&
                          (val as number) > 0 &&
                          !isOverriddenFinal
                          ? "font-semibold text-green-600 dark:text-green-400"
                          : "",
                      )}
                      style={{
                        width: columnWidths[col.key] || getDefaultWidth(col.key),
                        maxWidth: isTruncate ? columnWidths[col.key] || 180 : undefined,
                      }}
                      onClick={(e) => {
                        if (showEdit) {
                          e.stopPropagation();
                          setActiveCell({ row: idx, col: colIdx });
                          handleRowClick(idx, row.id, e);
                        }
                      }}
                    >
                      {showEdit && col.key === "avg_sales_store" ? (
                        <div className="flex items-center gap-0.5">
                          <span className="text-xs flex-1">{displayVal}</span>
                          {(val as number) !== 0 ? (
                            <button
                              className="text-[9px] text-destructive hover:underline px-0.5"
                              onClick={(e) => {
                                e.stopPropagation();
                                updateAvgSales(row.id, "0");
                              }}
                              title="Clear"
                            >
                              Clear
                            </button>
                          ) : (
                            <button
                              className="text-[9px] text-primary hover:underline px-0.5"
                              onClick={(e) => {
                                e.stopPropagation();
                                updateAvgSales(row.id, String(row.orig_avg_sales_store));
                              }}
                              title="Restore"
                            >
                              Restore
                            </button>
                          )}
                        </div>
                      ) : showEdit && col.key === "order_uom_edit" ? (
                        <Input
                          className="h-6 text-xs px-1 py-0 border-primary/50 w-full"
                          value={row.order_uom_edit}
                          onChange={(e) => updateOrderUomEdit(row.id, e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="—"
                        />
                      ) : showEdit && col.key === "order_cycle" ? (
                        <div className="flex items-center gap-0.5">
                          <Input
                            className="h-6 text-xs px-1 py-0 border-primary/50 w-16"
                            type="number"
                            value={row.order_cycle || ""}
                            onChange={(e) => updateOrderCycle(row.id, e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            placeholder="—"
                          />
                          {row.order_cycle !== row.orig_order_cycle && (
                            <button
                              className="text-[9px] text-primary hover:underline px-0.5"
                              onClick={(e) => {
                                e.stopPropagation();
                                updateOrderCycle(row.id, String(row.orig_order_cycle));
                              }}
                              title="Restore"
                            >
                              ↩
                            </button>
                          )}
                        </div>
                      ) : col.key === "po_cost_unit" &&
                        Math.abs((row.po_cost_unit || 0) - (row.orig_po_cost_unit || 0)) > 0.001 ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="block">{displayVal}</span>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info
                                className="h-3 w-3 text-amber-600 dark:text-amber-400 cursor-help"
                                onClick={(e) => e.stopPropagation()}
                              />
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              <div className="text-xs space-y-0.5">
                                <div className="font-semibold">PO Cost Override (Import)</div>
                                <div>
                                  Original:{" "}
                                  <span className="font-mono">
                                    {row.orig_po_cost_unit?.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                  </span>
                                </div>
                                <div>
                                  Imported:{" "}
                                  <span className="font-mono text-amber-600 dark:text-amber-400">
                                    {row.po_cost_unit?.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                  </span>
                                </div>
                                <div className="text-muted-foreground">
                                  Δ{" "}
                                  {((row.po_cost_unit || 0) - (row.orig_po_cost_unit || 0)).toLocaleString(undefined, {
                                    maximumFractionDigits: 2,
                                  })}
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </span>
                      ) : isTruncate && displayVal.length > 25 ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="truncate block max-w-full">{displayVal}</span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-sm">
                            <p className="text-xs">{displayVal}</p>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span
                          className={cn(
                            "block",
                            isTruncate && "truncate",
                            col.key === "rank_sales" &&
                              row.rank_is_default &&
                              "text-red-600 dark:text-red-400 font-semibold",
                          )}
                        >
                          {displayVal}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };

  return (
    <div className="flex flex-col h-full animate-fade-in" tabIndex={-1}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
        <div>
          <h1 className="text-lg font-bold text-foreground">SRR DIRECT ITEM</h1>
          <p className="text-xs text-muted-foreground">
            {totalDocsCount > 0
              ? `✅ ${totalDocsCount} Vendor Docs · ${totalItems.toLocaleString()} รายการ`
              : "กด Read & Cal เพื่อเริ่ม"}
            {showData.length > 0 && ` · แสดง ${showData.length.toLocaleString()}`}
            {selectedRows.size > 0 && ` · เลือก ${selectedRows.size}`}
          </p>
        </div>
      </div>

      {loading && calcProgress > 0 && (
        <div className="px-4 py-2 bg-card border-b border-border space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{loadingPhase}</span>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{calcProgress}%</span>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  cancelCalcRef.current = true;
                }}
                className="h-6 text-xs px-2"
              >
                <X className="w-3 h-3 mr-1" /> Cancel
              </Button>
            </div>
          </div>
          <Progress value={calcProgress} className="h-2" />
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="px-4 pt-2 border-b border-border bg-card flex items-center gap-2">
          <TabsList className="h-9">
            <TabsTrigger value="read-cal" className="text-xs gap-1.5">
              <Database className="w-3.5 h-3.5" /> Read & Cal
            </TabsTrigger>
            <TabsTrigger value="show-edit" className="text-xs gap-1.5">
              <Filter className="w-3.5 h-3.5" /> Filter & Show & Edit
            </TabsTrigger>
            <TabsTrigger value="list-po" className="text-xs gap-1.5">
              <FolderOpen className="w-3.5 h-3.5" /> List Import PO
            </TabsTrigger>
            <TabsTrigger value="report" className="text-xs gap-1.5">
              <BarChart3 className="w-3.5 h-3.5" /> Report
            </TabsTrigger>
          </TabsList>
          {/* Right group: เตรียมข้อมูล (only on Read & Cal tab) + Date selector */}
          <div className="ml-auto pr-2 flex items-center gap-2 pb-2">
            {activeTab === "read-cal" && (
              <Button
                variant="outline"
                size="sm"
                onClick={loadFilterOptions}
                disabled={
                  loading ||
                  (importMode === "filter"
                    ? selectedSpcForCal.length === 0
                    : importMode === "vendor"
                      ? importedVendors.length === 0
                      : importedItems.length === 0)
                }
                className="h-7 gap-1 text-xs px-2 border-amber-400 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30"
              >
                <RefreshCw className="w-3 h-3" /> เตรียมข้อมูล{" "}
                {importMode === "import" && importedItems.length > 0
                  ? `(${importedItems.length})`
                  : importMode === "vendor" && importedVendors.length > 0
                    ? `(${importedVendors.length})`
                    : ""}
              </Button>
            )}
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {activeDateMode === "filter"
                ? "Filter Mode"
                : activeDateMode === "vendor"
                  ? "Import Vendor"
                  : "Import Barcode"}
            </span>
            <SnapshotBatchPicker
              batches={activeTab === "list-po" ? listPoBatches : documentBatches}
              multiple
              mode={activeTab === "list-po" ? undefined : activeDateMode}
              values={selectedBatchValuesByMode[activeDateMode]}
              onChangeMulti={(vs) => {
                setSelectedBatchValuesByMode((prev) => ({ ...prev, [activeDateMode]: vs }));
                if (activeTab === "list-po") return;
                if (vs.length === 0) loadHistoricalDate("today", activeDateMode);
                else if (vs.length === 1) loadHistoricalDate(vs[0], activeDateMode);
                else loadHistoricalBatches(vs, activeDateMode);
              }}
              loading={loadingSnapshots}
            />
          </div>
        </div>

        {/* TAB 1: READ & CAL */}
        <TabsContent value="read-cal" className="flex-1 flex flex-col mt-0 min-h-0 data-[state=inactive]:hidden">
          {/* ROW 1: mode + filters + เตรียมข้อมูล */}
          <div className="flex items-center gap-1.5 px-3 py-2 bg-card border-b border-border flex-wrap">
            <SrrImportFilter
              compact
              mode={importMode}
              onModeChange={(m) => {
                setImportMode(m);
                setTab2Mode(m);
                setDataReady(false);
                if (m !== "import") {
                  setImportedItems([]);
                  setImportedSkuSet(new Set());
                  setImportedQtyByKey(new Map());
                  setImportedPoCostBySku(new Map());
                  setImportedStoreBySku(new Map());
                  setImportedSkippedKeys([]);
                }
                if (m !== "vendor") {
                  setImportedVendors([]);
                }
                if (m === "filter") {
                  setVendorFilterCal([]);
                }
                setImportedSkippedItems([]);
                setSelectedDocSpc([]);
                setVendorFilter([]);
                setOrderDayFilter([]);
                setItemTypeFilter([]);
                setStoreFilter([]);
                setTypeStoreFilter([]);
                setBuyingStatusFilter([]);
                setPoGroupFilter([]);
                setShowData([]);
                setTableSearchChips([]);
                setSelectedRows(new Set());
                setActiveCell(null);
                setPage(0);
              }}
              importedItems={importedItems}
              onImportedChange={(items) => {
                setImportedItems(items);
                setDataReady(false);
              }}
              matchedCount={importedSkuSet.size}
              skippedCount={importedSkippedKeys.length}
              disabled={loading}
              enableVendorMode
              importedVendors={importedVendors}
              onImportedVendorsChange={(v) => {
                setImportedVendors(v);
                setDataReady(false);
              }}
              showStoreNameInTemplate
            />
            <div className="h-5 w-px bg-border mx-0.5" />
            <SrrFiltersPopover
              activeCount={
                (importMode === "filter" ? selectedSpcForCal.length : 0) +
                (importMode === "filter" || importMode === "vendor" ? orderDayCal.length + vendorFilterCal.length : 0) +
                itemTypeCal.length +
                typeStoreCal.length +
                storeCal.length +
                buyingStatusCal.length +
                poGroupCal.length
              }
            >
              {importMode === "filter" && (
                <MultiSelect
                  compact
                  label="SPC Name"
                  options={spcOptions}
                  selected={selectedSpcForCal}
                  onChange={(v) => {
                    setSelectedSpcForCal(v);
                    setDataReady(false);
                    setVendorFilterCal([]);
                  }}
                />
              )}
              {(importMode === "filter" || importMode === "vendor") && (
                <MultiSelect
                  compact
                  label="Order Day"
                  options={preOrderDayOptions}
                  selected={orderDayCal}
                  onChange={setOrderDayCal}
                  searchable={false}
                />
              )}
              {(importMode === "filter" || importMode === "vendor") && (
                <MultiSelect
                  compact
                  label="Vendor"
                  options={preVendorOptions}
                  selected={vendorFilterCal}
                  onChange={setVendorFilterCal}
                />
              )}
              <MultiSelect
                compact
                label="Item Type"
                options={preFilterOptions.itemTypes}
                selected={itemTypeCal}
                onChange={setItemTypeCal}
              />
              <MultiSelect
                compact
                label="Type Store"
                options={TYPE_STORE_OPTIONS}
                selected={typeStoreCal}
                onChange={setTypeStoreCal}
                searchable={false}
              />
              <MultiSelect
                compact
                label="Store"
                options={preFilterOptions.stores}
                selected={storeCal}
                onChange={setStoreCal}
              />
              <MultiSelect
                compact
                label="Buying Status"
                options={preFilterOptions.buyingStatuses}
                selected={buyingStatusCal}
                onChange={setBuyingStatusCal}
              />
              <MultiSelect
                compact
                label="PO Group"
                options={preFilterOptions.poGroups}
                selected={poGroupCal}
                onChange={setPoGroupCal}
              />
            </SrrFiltersPopover>

            {!dataReady && !loading && !dataLoadingMsg && (
              <div className="flex items-center gap-1.5 px-2 h-7 rounded-md bg-muted/50 border border-border text-muted-foreground text-xs font-medium">
                <Database className="w-3 h-3" /> เลือก SPC แล้วกดเตรียมข้อมูล
              </div>
            )}
            {!dataReady && !loading && dataLoadingMsg && (
              <div className="flex items-center gap-1.5 px-2 h-7 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs font-medium">
                <Loader2 className="w-3 h-3 animate-spin" /> {dataLoadingMsg}
              </div>
            )}
            {dataReady && !loading && (
              <div className="flex items-center gap-1.5 px-2 h-7 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                <Check className="w-3 h-3" /> พร้อม ({selectedSpcForCal.length} SPC)
              </div>
            )}
            <Button
              onClick={readAndCalc}
              disabled={loading || !dataReady}
              size="sm"
              className="h-7 gap-1 text-xs px-2.5"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              Read & Cal{" "}
              {importMode === "import"
                ? `(${importedSkuSet.size} SKU, ${selectedSpcForCal.length} SPC)`
                : importMode === "vendor"
                  ? `(${importedVendors.length} V, ${selectedSpcForCal.length} SPC)`
                  : `(${selectedSpcForCal.length} SPC${vendorFilterCal.length > 0 ? `, ${vendorFilterCal.length} V` : ""}${typeStoreCal.length > 0 ? `, ${typeStoreCal.length} TS` : ""}${storeCal.length > 0 ? `, ${storeCal.length} St` : ""}${itemTypeCal.length > 0 ? `, ${itemTypeCal.length} IT` : ""})`}
            </Button>
            {importedSkippedItems.length > 0 && (
              <ImportSkipBar
                count={importedSkippedItems.length}
                context={importMode === "vendor" ? "Vendor Import" : "Barcode/SKU Import"}
                items={importedSkippedItems}
                title={importMode === "vendor" ? "srr_direct_vendor" : "srr_direct_sku"}
                onClear={() => setImportedSkippedItems([])}
              />
            )}
            {totalDocsCount > 0 && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="icon" onClick={selectAllDocs} className="h-7 w-7">
                      <CheckSquare className="w-3.5 h-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Select All</TooltipContent>
                </Tooltip>
                {selectedDocIds.size > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="icon" onClick={unselectAllDocs} className="h-7 w-7">
                        <XCircle className="w-3.5 h-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Unselect</TooltipContent>
                  </Tooltip>
                )}
                {selectedDocIds.size > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={deleteSelectedDocs}
                        className="h-7 text-xs gap-1 px-2"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> {selectedDocIds.size}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete Selected ({selectedDocIds.size})</TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="destructive" size="icon" onClick={clearAllDocuments} className="h-7 w-7">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete All</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={expandedSPCs.size > 0 ? collapseAllTree : expandAllTree}
                      className="h-7 w-7"
                    >
                      {expandedSPCs.size > 0 ? (
                        <ChevronUpIcon className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{expandedSPCs.size > 0 ? "Collapse All" : "Expand All"}</TooltipContent>
                </Tooltip>
              </>
            )}
            <div className="ml-auto flex items-center gap-1">
              <Search className="w-3 h-3 text-muted-foreground" />
              <Input
                placeholder="ค้นหา..."
                value={docSearch}
                onChange={(e) => setDocSearch(e.target.value)}
                className="h-7 w-44 text-xs"
              />
              {docSearch && (
                <button onClick={() => setDocSearch("")}>
                  <X className="w-3 h-3 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4">
            {vendorDocs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                <Calculator className="w-12 h-12 mb-3 opacity-30" />
                <p className="text-sm">ยังไม่มีข้อมูลคำนวณ SRR Direct Item</p>
                <p className="text-xs mt-2">เลือก SPC Name → เตรียมข้อมูล → Read & Cal</p>
                <p className="text-xs mt-1">คำนวณแบบ Per-Store (แต่ละสาขา)</p>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    📄 Documents ({totalDocsCount})
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${importMode === "filter" ? "bg-primary/15 text-primary border border-primary/30" : importMode === "vendor" ? "bg-blue-500/15 text-blue-700 dark:text-blue-400 border border-blue-500/30" : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30"}`}
                    >
                      {importMode === "filter"
                        ? "Filter Mode"
                        : importMode === "vendor"
                          ? "Vendor Mode"
                          : "Import Mode"}
                    </span>
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    {docTree.size} batches · รวม {totalItems.toLocaleString()} รายการ
                  </span>
                </div>
                {/* 5-Level Tree: Date > SPC > Vendor > TypeStore > Store */}
                {[...docTree.entries()]
                  .sort((a, b) => b[0].localeCompare(a[0]))
                  .map(([dateKey, spcMap]) => {
                    const isDateExpanded = expandedDates.has(dateKey);
                    const dateAllDocs = [...spcMap.values()].flatMap((vm) =>
                      [...vm.values()].flatMap((tsm) => [...tsm.values()].flat()),
                    );
                    const dateItemCount = dateAllDocs.reduce((s, d) => s + d.item_count, 0);
                    const dateDocIds = dateAllDocs.map((d) => d.id);
                    const dateSelectedCount = dateDocIds.filter((id) => selectedDocIds.has(id)).length;
                    const dateAllSelected = dateSelectedCount === dateDocIds.length && dateDocIds.length > 0;
                    const dateSomeSelected = dateSelectedCount > 0 && !dateAllSelected;
                    return (
                      <div key={dateKey} className="border border-border rounded-lg overflow-hidden mb-1">
                        <div
                          className="flex items-center gap-2 px-3 py-2.5 cursor-pointer bg-muted/60 hover:bg-muted transition-colors"
                          onClick={() => toggleDate(dateKey)}
                        >
                          {isDateExpanded ? (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          )}
                          <FolderOpen className="w-4 h-4 text-primary" />
                          <span className="text-sm font-mono font-semibold text-foreground">
                            📅 {fmtTreeStamp(dateKey, dateAllDocs)}
                          </span>
                          <Button
                            size="sm"
                            variant={dateAllSelected ? "default" : dateSomeSelected ? "secondary" : "outline"}
                            className="h-6 text-[10px] px-2 py-0 ml-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedDocIds((prev) => {
                                const n = new Set(prev);
                                if (dateAllSelected) dateDocIds.forEach((id) => n.delete(id));
                                else dateDocIds.forEach((id) => n.add(id));
                                return n;
                              });
                            }}
                            title={dateAllSelected ? "ยกเลิกเลือกทั้งวัน" : "เลือกทั้งวัน"}
                          >
                            {dateAllSelected ? (
                              <>
                                <XCircle className="w-2.5 h-2.5 mr-0.5" />
                                Unselect
                              </>
                            ) : (
                              <>
                                <CheckSquare className="w-2.5 h-2.5 mr-0.5" />
                                Select
                              </>
                            )}
                            {dateSelectedCount > 0 && ` (${dateSelectedCount}/${dateDocIds.length})`}
                          </Button>
                          <span className="text-xs text-muted-foreground ml-auto">
                            {[...spcMap.keys()].length} SPC · {dateAllDocs.length} docs · {dateItemCount.toLocaleString()} items
                          </span>
                        </div>
                        {isDateExpanded && (
                          <div className="border-t border-border">
                            {[...spcMap.entries()]
                              .sort((a, b) => a[0].localeCompare(b[0]))
                              .map(([spcName, vendorMap]) => {
                                const spcExpandKey = `${dateKey}|${spcName}`;
                                const isSpcExpanded = expandedSPCs.has(spcExpandKey);
                                const spcDocs = [...vendorMap.values()].flatMap((tsm) => [...tsm.values()].flat());
                                const spcItemCount = spcDocs.reduce((s, d) => s + d.item_count, 0);
                                const spcDocIds = spcDocs.map((d) => d.id);
                                const spcSelectedCount = spcDocIds.filter((id) => selectedDocIds.has(id)).length;
                                const spcAllSelected = spcSelectedCount === spcDocIds.length && spcDocIds.length > 0;
                                const spcSomeSelected = spcSelectedCount > 0 && !spcAllSelected;
                                return (
                                  <div key={spcName}>
                                    <div
                                      className="flex items-center gap-2 px-6 py-1.5 bg-muted/30 border-b border-border/50 cursor-pointer hover:bg-muted/50"
                                      onClick={() => toggleSPC(spcExpandKey)}
                                    >
                                      {isSpcExpanded ? (
                                        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                                      ) : (
                                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                                      )}
                                      <span className="text-xs font-medium text-foreground">{spcName}</span>
                                      <Button
                                        size="sm"
                                        variant={
                                          spcAllSelected ? "default" : spcSomeSelected ? "secondary" : "outline"
                                        }
                                        className="h-5 text-[10px] px-1.5 py-0 ml-1"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedDocIds((prev) => {
                                            const n = new Set(prev);
                                            if (spcAllSelected) spcDocIds.forEach((id) => n.delete(id));
                                            else spcDocIds.forEach((id) => n.add(id));
                                            return n;
                                          });
                                        }}
                                        title={spcAllSelected ? "ยกเลิกเลือกทั้ง SPC" : "เลือกทั้ง SPC"}
                                      >
                                        {spcAllSelected ? (
                                          <>
                                            <XCircle className="w-2.5 h-2.5 mr-0.5" />
                                            Unselect
                                          </>
                                        ) : (
                                          <>
                                            <CheckSquare className="w-2.5 h-2.5 mr-0.5" />
                                            Select
                                          </>
                                        )}
                                        {spcSelectedCount > 0 && ` (${spcSelectedCount}/${spcDocIds.length})`}
                                      </Button>
                                      <span className="text-[10px] text-muted-foreground/70 ml-auto">
                                        {[...vendorMap.keys()].length} vendors · {spcDocs.length} stores
                                      </span>
                                    </div>
                                    {isSpcExpanded &&
                                      [...vendorMap.entries()]
                                        .sort((a, b) => a[0].localeCompare(b[0]))
                                        .map(([vc, typeStoreMap]) => {
                                          const vendorExpandKey = `${dateKey}|${spcName}|${vc}`;
                                          const isVendorExpanded = expandedVendors.has(vendorExpandKey);
                                          const vendorAllDocs = [...typeStoreMap.values()].flat();
                                          const vendorDisplay = vendorAllDocs[0]?.vendor_display || vc;
                                          const vendorItemCount = vendorAllDocs.reduce((s, d) => s + d.item_count, 0);
                                          const vendorDocIds = vendorAllDocs.map((d) => d.id);
                                          const vendorSelectedCount = vendorDocIds.filter((id) =>
                                            selectedDocIds.has(id),
                                          ).length;
                                          const vendorAllSelected =
                                            vendorSelectedCount === vendorDocIds.length && vendorDocIds.length > 0;
                                          const vendorSomeSelected = vendorSelectedCount > 0 && !vendorAllSelected;
                                          return (
                                            <div key={vc}>
                                              <div
                                                className="flex items-center gap-2 px-10 py-1.5 bg-muted/20 border-b border-border/30 cursor-pointer hover:bg-muted/40"
                                                onClick={() => toggleVendor(vendorExpandKey)}
                                              >
                                                {isVendorExpanded ? (
                                                  <ChevronDown className="w-3 h-3 text-muted-foreground" />
                                                ) : (
                                                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                                                )}
                                                <span className="text-xs font-medium text-foreground truncate">
                                                  {vendorDisplay}
                                                </span>
                                                <Button
                                                  size="sm"
                                                  variant={
                                                    vendorAllSelected
                                                      ? "default"
                                                      : vendorSomeSelected
                                                        ? "secondary"
                                                        : "outline"
                                                  }
                                                  className="h-5 text-[10px] px-1.5 py-0 ml-1"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    setSelectedDocIds((prev) => {
                                                      const n = new Set(prev);
                                                      if (vendorAllSelected) vendorDocIds.forEach((id) => n.delete(id));
                                                      else vendorDocIds.forEach((id) => n.add(id));
                                                      return n;
                                                    });
                                                  }}
                                                  title={
                                                    vendorAllSelected ? "ยกเลิกเลือกทั้ง Vendor" : "เลือกทั้ง Vendor"
                                                  }
                                                >
                                                  {vendorAllSelected ? (
                                                    <>
                                                      <XCircle className="w-2.5 h-2.5 mr-0.5" />
                                                      Unselect
                                                    </>
                                                  ) : (
                                                    <>
                                                      <CheckSquare className="w-2.5 h-2.5 mr-0.5" />
                                                      Select
                                                    </>
                                                  )}
                                                  {vendorSelectedCount > 0 &&
                                                    ` (${vendorSelectedCount}/${vendorDocIds.length})`}
                                                </Button>
                                                <span className="text-[10px] text-muted-foreground/70 ml-auto">
                                                  {vendorAllDocs.length} stores · {vendorItemCount} items
                                                </span>
                                              </div>
                                              {isVendorExpanded &&
                                                [...typeStoreMap.entries()]
                                                  .sort((a, b) => a[0].localeCompare(b[0]))
                                                  .map(([tsKey, storeDocs]) => {
                                                    const tsExpandKey = `${dateKey}|${spcName}|${vc}|${tsKey}`;
                                                    const isTSExpanded = expandedTypeStores.has(tsExpandKey);
                                                    const tsItemCount = storeDocs.reduce((s, d) => s + d.item_count, 0);
                                                    const tsDocIds = storeDocs.map((d) => d.id);
                                                    const tsSelectedCount = tsDocIds.filter((id) =>
                                                      selectedDocIds.has(id),
                                                    ).length;
                                                    const tsAllSelected =
                                                      tsSelectedCount === tsDocIds.length && tsDocIds.length > 0;
                                                    const tsSomeSelected = tsSelectedCount > 0 && !tsAllSelected;
                                                    return (
                                                      <div key={tsKey}>
                                                        <div
                                                          className="flex items-center gap-2 px-14 py-1 bg-muted/10 border-b border-border/20 cursor-pointer hover:bg-muted/30"
                                                          onClick={() => toggleTypeStore(tsExpandKey)}
                                                        >
                                                          {isTSExpanded ? (
                                                            <ChevronDown className="w-3 h-3 text-muted-foreground" />
                                                          ) : (
                                                            <ChevronRight className="w-3 h-3 text-muted-foreground" />
                                                          )}
                                                          <span className="text-[11px] font-medium text-muted-foreground">
                                                            🏷️ {tsKey}
                                                          </span>
                                                          <Button
                                                            size="sm"
                                                            variant={
                                                              tsAllSelected
                                                                ? "default"
                                                                : tsSomeSelected
                                                                  ? "secondary"
                                                                  : "outline"
                                                            }
                                                            className="h-5 text-[10px] px-1.5 py-0 ml-1"
                                                            onClick={(e) => {
                                                              e.stopPropagation();
                                                              setSelectedDocIds((prev) => {
                                                                const n = new Set(prev);
                                                                if (tsAllSelected) {
                                                                  tsDocIds.forEach((id) => n.delete(id));
                                                                } else {
                                                                  tsDocIds.forEach((id) => n.add(id));
                                                                }
                                                                return n;
                                                              });
                                                            }}
                                                            title={
                                                              tsAllSelected ? "ยกเลิกเลือกทั้งกลุ่ม" : "เลือกทั้งกลุ่ม"
                                                            }
                                                          >
                                                            {tsAllSelected ? (
                                                              <>
                                                                <XCircle className="w-2.5 h-2.5 mr-0.5" />
                                                                Unselect
                                                              </>
                                                            ) : (
                                                              <>
                                                                <CheckSquare className="w-2.5 h-2.5 mr-0.5" />
                                                                Select
                                                              </>
                                                            )}
                                                            {tsSelectedCount > 0 &&
                                                              ` (${tsSelectedCount}/${tsDocIds.length})`}
                                                          </Button>
                                                          <span className="text-[10px] text-muted-foreground/60 ml-auto">
                                                            {storeDocs.length} stores · {tsItemCount} items
                                                          </span>
                                                        </div>
                                                        {isTSExpanded &&
                                                          storeDocs
                                                            .sort((a, b) => a.store_name.localeCompare(b.store_name))
                                                            .map((doc) => (
                                                              <div
                                                                key={doc.id}
                                                                className={cn(
                                                                  "flex items-center gap-3 px-[72px] py-2 border-b border-border/20 cursor-pointer transition-colors",
                                                                  selectedDocIds.has(doc.id)
                                                                    ? "bg-primary/5"
                                                                    : "hover:bg-muted/30",
                                                                )}
                                                                onDoubleClick={() => setPreviewDoc(doc)}
                                                              >
                                                                <Checkbox
                                                                  checked={selectedDocIds.has(doc.id)}
                                                                  onCheckedChange={() => toggleDocSelect(doc.id)}
                                                                  onClick={(e) => e.stopPropagation()}
                                                                  className="h-3.5 w-3.5"
                                                                />
                                                                <FileSpreadsheet className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                                                                <div className="flex-1 min-w-0">
                                                                  <p className="text-xs font-medium truncate">
                                                                    🏪 {doc.store_name}
                                                                  </p>
                                                                  <span className="text-[10px] text-muted-foreground">
                                                                    {doc.item_count} items · {doc.suggest_count} suggest
                                                                    &gt; 0
                                                                  </span>
                                                                </div>
                                                                <Button
                                                                  size="sm"
                                                                  variant="ghost"
                                                                  className="h-6 w-6 p-0 text-destructive"
                                                                  onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    deleteVendorDoc(doc.id);
                                                                  }}
                                                                >
                                                                  <X className="w-3 h-3" />
                                                                </Button>
                                                              </div>
                                                            ))}
                                                      </div>
                                                    );
                                                  })}
                                            </div>
                                          );
                                        })}
                                  </div>
                                );
                              })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                <p className="text-xs text-muted-foreground text-center mt-4">
                  👉 ดับเบิลคลิกที่ Store เพื่อดูข้อมูล · สลับไป Tab "Filter & Show & Edit" เพื่อแก้ไข
                </p>
              </div>
            )}
          </div>
        </TabsContent>

        {/* TAB 2: FILTER & SHOW & EDIT */}
        <TabsContent value="show-edit" className="flex-1 flex flex-col mt-0 min-h-0 data-[state=inactive]:hidden">
          <div className="flex items-center gap-2 px-3 py-2 bg-card border-b border-border flex-wrap">
            {/* Mode toggle (independent from Tab 1) — Filter / Vendor / Barcode */}
            <div className="flex items-center gap-0.5 border border-border rounded-md p-0.5 bg-muted/30">
              <Button
                size="sm"
                variant={tab2Mode === "filter" ? "default" : "ghost"}
                onClick={() => {
                  if (tab2Mode === "filter") return;
                  setTab2Mode("filter");
                  setSelectedDocSpc([]);
                  setOrderDayFilter([]);
                  setVendorFilter([]);
                  setItemTypeFilter([]);
                  setStoreFilter([]);
                  setTypeStoreFilter([]);
                  setBuyingStatusFilter([]);
                  setPoGroupFilter([]);
                  setShowData([]);
                  setTableSearchChips([]);
                  setPage(0);
                }}
                className="h-6 text-[11px] px-2"
              >
                Filter
              </Button>
              <Button
                size="sm"
                variant={tab2Mode === "vendor" ? "default" : "ghost"}
                onClick={() => {
                  if (tab2Mode === "vendor") return;
                  setTab2Mode("vendor");
                  setSelectedDocSpc([]);
                  setOrderDayFilter([]);
                  setVendorFilter([]);
                  setItemTypeFilter([]);
                  setStoreFilter([]);
                  setTypeStoreFilter([]);
                  setBuyingStatusFilter([]);
                  setPoGroupFilter([]);
                  setShowData([]);
                  setTableSearchChips([]);
                  setPage(0);
                }}
                className="h-6 text-[11px] px-2"
              >
                Import Vendor
              </Button>
              <Button
                size="sm"
                variant={tab2Mode === "import" ? "default" : "ghost"}
                onClick={() => {
                  if (tab2Mode === "import") return;
                  setTab2Mode("import");
                  setSelectedDocSpc([]);
                  setOrderDayFilter([]);
                  setVendorFilter([]);
                  setItemTypeFilter([]);
                  setStoreFilter([]);
                  setTypeStoreFilter([]);
                  setBuyingStatusFilter([]);
                  setPoGroupFilter([]);
                  setShowData([]);
                  setTableSearchChips([]);
                  setPage(0);
                }}
                className="h-6 text-[11px] px-2"
              >
                Import Barcode
              </Button>
            </div>
            <span className="text-[10px] text-muted-foreground">{docsForTab2.length} docs</span>
            <MultiSelect
              compact
              label="SPC Name"
              options={availableDocSpcs.length > 0 ? availableDocSpcs : spcOptions}
              selected={selectedDocSpc}
              onChange={setSelectedDocSpc}
            />
            <MultiSelect
              compact
              label="Order Day"
              options={docDerivedOptions.orderDays}
              selected={orderDayFilter}
              onChange={setOrderDayFilter}
              searchable={false}
            />
            <MultiSelect
              compact
              label="Vendor"
              options={vendorOptions}
              selected={vendorFilter}
              onChange={setVendorFilter}
            />
            <MultiSelect
              compact
              label="Item Type"
              options={docDerivedOptions.itemTypes}
              selected={itemTypeFilter}
              onChange={setItemTypeFilter}
              searchable={false}
            />
            <MultiSelect
              compact
              label="Type Store"
              options={docDerivedOptions.typeStores}
              selected={typeStoreFilter}
              onChange={setTypeStoreFilter}
              searchable={false}
            />
            <MultiSelect
              compact
              label="Store"
              options={docDerivedOptions.stores}
              selected={storeFilter}
              onChange={setStoreFilter}
            />
            <MultiSelect
              compact
              label="Buying Status"
              options={docDerivedOptions.buyingStatuses}
              selected={buyingStatusFilter}
              onChange={setBuyingStatusFilter}
              searchable={false}
            />
            <MultiSelect
              compact
              label="PO Group"
              options={docDerivedOptions.poGroups}
              selected={poGroupFilter}
              onChange={setPoGroupFilter}
              searchable={false}
            />
            {(selectedDocSpc.length > 0 ||
              orderDayFilter.length > 0 ||
              vendorFilter.length > 0 ||
              itemTypeFilter.length > 0 ||
              storeFilter.length > 0 ||
              typeStoreFilter.length > 0 ||
              buyingStatusFilter.length > 0 ||
              poGroupFilter.length > 0) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs px-2"
                onClick={() => {
                  setSelectedDocSpc([]);
                  setOrderDayFilter([]);
                  setVendorFilter([]);
                  setItemTypeFilter([]);
                  setStoreFilter([]);
                  setTypeStoreFilter([]);
                  setBuyingStatusFilter([]);
                  setPoGroupFilter([]);
                }}
              >
                <X className="w-3 h-3 mr-1" /> ล้าง
              </Button>
            )}
            <div className="ml-auto flex items-center gap-1.5 flex-wrap">
              <Button
                size="sm"
                onClick={showFilteredData}
                disabled={vendorDocs.length === 0}
                className="text-xs gap-1.5"
              >
                <Eye className="w-3.5 h-3.5" /> Show
              </Button>
              {showData.length > 0 && (
                <>
                  <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-muted/40 border border-border">
                    <span className="text-[10px] text-muted-foreground">Min=</span>
                    <Input
                      value={assignMinValue}
                      onChange={(e) => setAssignMinValue(e.target.value)}
                      className="h-6 w-12 text-xs px-1 py-0"
                      type="number"
                    />
                    <Button size="sm" variant="secondary" onClick={assignMinBulk} className="text-xs h-6 px-2">
                      Assign Min
                    </Button>
                  </div>
                  <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-muted/40 border border-border">
                    <span className="text-[10px] text-muted-foreground">OC=</span>
                    <Input
                      value={assignOcValue}
                      onChange={(e) => setAssignOcValue(e.target.value)}
                      className="h-6 w-14 text-xs px-1 py-0"
                      type="number"
                      placeholder="วัน"
                    />
                    <Button size="sm" variant="secondary" onClick={assignOrderCycleBulk} className="text-xs h-6 px-2">
                      Assign OC
                    </Button>
                  </div>

                  <input
                    type="file"
                    ref={importFileRef}
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={handleImportExcel}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => importFileRef.current?.click()}
                    className="text-xs gap-1.5"
                  >
                    <Upload className="w-3.5 h-3.5" /> Import
                  </Button>
                  {showImportSkipped.length > 0 && (
                    <ImportSkipBar
                      count={showImportSkipped.length}
                      context="Import Show"
                      items={showImportSkipped}
                      title="srr_direct_show_import"
                      onClear={() => setShowImportSkipped([])}
                    />
                  )}

                  <Popover>
                    <PopoverTrigger asChild>
                      <Button size="sm" variant="outline" className="text-xs">
                        <Columns className="w-3.5 h-3.5 mr-1" /> Columns ({displayColumns.length}/{D2S_COLUMNS.length})
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72 max-h-[70vh] overflow-y-auto p-2" align="end">
                      <div className="flex items-center justify-between mb-2 px-1">
                        <span className="text-xs font-semibold">Show/Hide Columns</span>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-[10px] px-2"
                            onClick={() => setVisibleColumns(new Set(ALL_D2S_KEYS))}
                          >
                            All
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-[10px] px-2"
                            onClick={() => setVisibleColumns(new Set())}
                          >
                            None
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-0.5 mb-3">
                        {D2S_COLUMNS.map((col) => (
                          <label
                            key={col.key}
                            className="flex items-center gap-2 px-2 py-1 hover:bg-muted rounded cursor-pointer text-xs"
                          >
                            <Checkbox
                              checked={visibleColumns.has(col.key)}
                              onCheckedChange={() =>
                                setVisibleColumns((prev) => {
                                  const n = new Set(prev);
                                  n.has(col.key) ? n.delete(col.key) : n.add(col.key);
                                  return n;
                                })
                              }
                              className="h-3.5 w-3.5"
                            />
                            {col.label}
                          </label>
                        ))}
                      </div>
                      <div className="border-t pt-2 space-y-2">
                        <span className="text-xs font-semibold px-1">Saved Views</span>
                        {savedViews.map((v) => (
                          <div key={v.name} className="flex items-center gap-1 px-1">
                            <Button size="sm" variant="ghost" className="h-6 text-[10px] flex-1 justify-start" onClick={() => loadView(v)}>
                              <Eye className="w-3 h-3 mr-1" />{v.name}
                            </Button>
                            <button onClick={() => deleteView(v.name)} className="text-destructive hover:text-destructive/80"><X className="w-3 h-3" /></button>
                          </div>
                        ))}
                        <div className="flex items-center gap-1 px-1">
                          <Input
                            placeholder="View name..."
                            value={newViewName}
                            onChange={(e) => setNewViewName(e.target.value)}
                            className="h-6 text-[10px] flex-1"
                            onKeyDown={(e) => e.key === "Enter" && saveCurrentView()}
                          />
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={saveCurrentView} disabled={!newViewName.trim()}>
                            <Save className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" className="text-xs">
                        <Download className="w-3.5 h-3.5 mr-1" /> Export
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onClick={() => exportTableData(false)}>
                        <Download className="w-3.5 h-3.5 mr-2" /> Export ทั้งหมด
                      </DropdownMenuItem>
                      {selectedRows.size > 0 && (
                        <DropdownMenuItem onClick={() => exportTableData(true)}>
                          <CheckSquare className="w-3.5 h-3.5 mr-2" /> Export ที่เลือก ({selectedRows.size})
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Button size="sm" variant="outline" onClick={() => setExportOpen(true)} className="text-xs">
                    <Save className="w-3.5 h-3.5 mr-1" /> Save
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setShowData([]);
                      setSelectedRows(new Set());
                      setActiveCell(null);
                      setPage(0);
                    }}
                    className="text-xs"
                  >
                    <XCircle className="w-3.5 h-3.5 mr-1" /> Clear
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Odoo-style chip search + Final > 0 toggle (Tab 2) */}
          {showData.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/20 border-b border-border">
              <TableChipSearch
                columns={TABLE_SEARCH_COLS}
                chips={tableSearchChips}
                onChipsChange={(chips) => {
                  setTableSearchChips(chips);
                  setPage(0);
                }}
                placeholder="ค้นหาในตาราง"
              />
              <label className="flex items-center gap-1.5 text-xs cursor-pointer ml-2 select-none">
                <Checkbox
                  checked={showOnlyFinalGt0}
                  onCheckedChange={(c) => {
                    setShowOnlyFinalGt0(!!c);
                    setPage(0);
                  }}
                  className="h-3.5 w-3.5"
                />
                <span>Show FinalOrder &gt; 0</span>
              </label>
            </div>
          )}

          <div ref={tableContainerRef} className="flex-1 overflow-auto">
            {showData.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground">
                <Filter className="w-10 h-10 mb-2 opacity-30" />
                {vendorDocs.length === 0 ? (
                  <>
                    <p className="text-sm">กรุณากด "Read & Cal" ใน Tab 1 ก่อน</p>
                    <p className="text-xs mt-1">คำนวณ Per-Store แล้วกลับมากด "Show"</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm">
                      เลือก SPC Name แล้วกด <strong>"Show"</strong>
                    </p>
                    <p className="text-xs mt-1">มี {vendorDocs.length} vendor documents พร้อมใช้งาน</p>
                  </>
                )}
              </div>
            ) : (
              renderTable(pagedData, true)
            )}
          </div>

          {showData.length > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-card">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">แสดง</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-7 text-xs px-2 min-w-[40px]">
                        {pageSize}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {[30, 50, 100, 200].map((size) => (
                        <DropdownMenuItem
                          key={size}
                          onClick={() => {
                            setPageSize(size);
                            setPage(0);
                          }}
                          className={cn("text-xs", pageSize === size && "font-bold")}
                        >
                          {size} แถว
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <span className="text-xs text-muted-foreground">
                    / {filteredShowData.length.toLocaleString()} แถว
                    {tableSearchChips.length > 0 && filteredShowData.length !== showData.length && (
                      <span className="text-muted-foreground/60"> (จาก {showData.length.toLocaleString()})</span>
                    )}
                  </span>
                </div>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage(Math.max(0, page - 1))}
                    disabled={page === 0}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-xs text-muted-foreground px-2">
                    {page + 1} / {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                    disabled={page >= totalPages - 1}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* TAB 3: LIST IMPORT PO */}
        <TabsContent
          value="list-po"
          className="flex-1 flex flex-col mt-0 min-h-0 data-[state=inactive]:hidden overflow-auto"
        >
          <ListImportPO storageKey="srr_saved_pos_d2s" title="List Import PO (D2S)" selectedBatchValues={selectedBatchValuesByMode[activeDateMode]} refreshKey={poRefreshKey} onDataChange={() => setPoRefreshKey((v) => v + 1)} />
        </TabsContent>

        {/* TAB 4: REPORT */}
        <TabsContent value="report" className="flex-1 flex flex-col mt-0 min-h-0 data-[state=inactive]:hidden">
          <SRRReportTab mode="direct" />
        </TabsContent>
      </Tabs>

      {/* Preview */}
      <Dialog open={!!previewDoc} onOpenChange={() => setPreviewDoc(null)}>
        <DialogContent className="max-w-[95vw] max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-base">
              {previewDoc?.spc_name} · {previewDoc?.date_key} · {previewDoc?.vendor_display}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              {previewDoc?.item_count} items · {previewDoc?.suggest_count} suggest &gt; 0
            </p>
          </DialogHeader>
          {previewDoc && <div className="flex-1 overflow-auto">{renderTable(previewDoc.data, false)}</div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewDoc(null)}>
              ปิด
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save PO Dialog */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save PO (Direct to Store)</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Picking Type จะถูก Mapping อัตโนมัติจาก Store Name → Store Type (ship_to)
            </p>
            <div>
              <label className="text-xs font-medium text-foreground mb-1 block">Description</label>
              <Input
                value={exportDescription}
                onChange={(e) => setExportDescription(e.target.value)}
                className="h-8 text-xs"
                placeholder="หมายเหตุ (ถ้ามี)"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {showData.filter((r) => r.final_order_qty > 0).length} รายการที่มี Suggest &gt; 0 จาก{" "}
              {new Set(showData.filter((r) => r.final_order_qty > 0).map((r) => r.vendor_code)).size} Vendor
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportOpen(false)}>
              ยกเลิก
            </Button>
            <Button onClick={savePO}>
              <Save className="w-3.5 h-3.5 mr-1" /> Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportSkipDialog
        open={importSkipDialogOpen}
        onOpenChange={setImportSkipDialogOpen}
        items={importedSkippedItems}
        title={importMode === "vendor" ? "srr_direct_vendor" : "srr_direct_sku"}
        closeLabel="ปิด แล้วไป Read & Cal"
      />
    </div>
  );
}
