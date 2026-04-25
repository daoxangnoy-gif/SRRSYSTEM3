import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useDataTable, SheetInfo, FilterOperator, SearchFilter, OPERATOR_LABELS } from "@/hooks/useDataTable";
import { TableName, AllTableName, DATA_TABLES, COLUMN_LABELS, KEY_COLUMNS, getColumnLabel } from "@/lib/tableConfig";
import {
  parsePoCostFile, resolvePoCostImport, applyPoCostImport,
  downloadSkipList, downloadPoCostTemplate, loadVendorDisplayMap,
  splitExistingMissing, resolvedToSkipRows,
  type PoCostSkipRow, type PoCostResolved,
} from "@/lib/poCostImport";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Upload, Download, RefreshCw, Trash2, ChevronLeft, ChevronRight,
  Loader2, Package, Pencil, Check, X, FileSpreadsheet, XCircle, BarChart3,
  Search, Filter, ChevronDown, Columns, CheckSquare, Square, AlertTriangle,
  Save, Eye,
} from "lucide-react";

interface DataControlPageProps {
  activeTable: AllTableName;
}

const ALL_OPERATORS: FilterOperator[] = ["contains", "=", "!=", "starts_with", "ends_with", "is_set", "is_not_set"];

export default function DataControlPage({ activeTable }: DataControlPageProps) {
  const isPlaceholder = activeTable === "range_store";
  const safeTable = isPlaceholder ? "data_master" : activeTable as TableName;

  const {
    data, totalCount, loading, importProgress, page, setPage, pageSize, columns,
    searchColumns, setSearchColumns, searchValue, setSearchValue,
    filters, addFilter, removeFilter, updateFilter, clearFilters,
    fetchData, getSheets, importData, exportData, exportTemplate, clearUI, deleteAll,
    editingRow, editedData, startEditing, cancelEditing, saveEditing, updateEditedField,
    pasteToRows, groupByColumn,
  } = useDataTable(safeTable);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [importMode, setImportMode] = useState<"insert" | "update">("insert");
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [selectedCols, setSelectedCols] = useState<Set<string>>(new Set());
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [resizing, setResizing] = useState<{ col: string; startX: number; startW: number } | null>(null);

  // Column visibility
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set(columns));

  // Saved column views per-table (localStorage)
  const VIEWS_KEY = `datactl_column_views_${activeTable}`;
  const [savedViews, setSavedViews] = useState<{ name: string; columns: string[] }[]>([]);
  const [newViewName, setNewViewName] = useState("");
  useEffect(() => {
    try { setSavedViews(JSON.parse(localStorage.getItem(VIEWS_KEY) || "[]")); } catch { setSavedViews([]); }
  }, [VIEWS_KEY]);
  const persistViews = (views: { name: string; columns: string[] }[]) => {
    setSavedViews(views);
    try { localStorage.setItem(VIEWS_KEY, JSON.stringify(views)); } catch {}
  };

  // Active cell for keyboard navigation
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  const [lastClickedRow, setLastClickedRow] = useState<number | null>(null);

  // Search dropdown
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [showFilterDialog, setShowFilterDialog] = useState(false);
  const [filterCol, setFilterCol] = useState("");
  const [filterOp, setFilterOp] = useState<FilterOperator>("contains");
  const [filterValue, setFilterValue] = useState("");

  // Sheet selector
  const [sheetDialogOpen, setSheetDialogOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  const [selectedSheet, setSelectedSheet] = useState(0);

  // Group by dialog
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupCol, setGroupCol] = useState("");
  const [valueCol, setValueCol] = useState("");
  const [aggType, setAggType] = useState<"count" | "sum" | "avg" | "distinct_count">("count");
  const [groupResult, setGroupResult] = useState<any[] | null>(null);
  const [pivotSearch, setPivotSearch] = useState("");
  const [pivotVisibleCols, setPivotVisibleCols] = useState<Set<string>>(new Set(["count", "sum", "avg"]));

  // PO Cost custom import state
  const { toast } = useToast();
  const [poCostImportLoading, setPoCostImportLoading] = useState(false);
  const [poCostImportProgress, setPoCostImportProgress] = useState<{ current: number; total: number; phase: string } | null>(null);
  const [poCostSkipped, setPoCostSkipped] = useState<PoCostSkipRow[]>([]);
  const [showPoCostSkipDialog, setShowPoCostSkipDialog] = useState(false);
  const [poCostImportSummary, setPoCostImportSummary] = useState<{ inserted: number; updated: number } | null>(null);
  const [vendorDisplayMap, setVendorDisplayMap] = useState<Map<string, string>>(new Map());
  // Update-mode missing-rows prompt
  const [missingPrompt, setMissingPrompt] = useState<{
    existing: PoCostResolved[];
    missing: PoCostResolved[];
  } | null>(null);

  const tableConfig = DATA_TABLES.find(t => t.name === activeTable)!;
  const keyColumns = KEY_COLUMNS[safeTable] || columns.slice(0, 5);

  // Compute displayed columns based on visibility
  const displayColumns = columns.filter(c => visibleColumns.has(c));

  // Edit filter state
  const [editingFilterIdx, setEditingFilterIdx] = useState<number | null>(null);

  // Reset visible columns when table changes
  useEffect(() => {
    setVisibleColumns(new Set(columns));
  }, [activeTable, columns.join(",")]);

  useEffect(() => {
    if (!isPlaceholder) fetchData();
    setSelectedRows(new Set());
    setSelectedCols(new Set());
    setActiveCell(null);
    setLastClickedRow(null);
  }, [activeTable, page]);

  // Load Vendor display map (Currency - Code - Name) for po_cost rows
  useEffect(() => {
    if (activeTable !== "po_cost" || data.length === 0) return;
    const codes = data.map((r: any) => String(r.vendor || "")).filter(Boolean);
    if (codes.length === 0) return;
    loadVendorDisplayMap(codes).then(setVendorDisplayMap).catch(() => {});
  }, [activeTable, data]);

  // Search: when clicking a column suggestion, open filter dialog with that column
  const addSearchFilter = (col: string) => {
    setFilterCol(col);
    setFilterOp("contains");
    setFilterValue(searchValue.trim());
    setShowFilterDialog(true);
    setShowSearchDropdown(false);
  };

  // Confirm advanced filter (add or update)
  const confirmFilter = () => {
    if (!filterCol) return;
    const newFilter: SearchFilter = {
      column: filterCol,
      operator: filterOp,
      value: ["is_set", "is_not_set"].includes(filterOp) ? "" : filterValue.trim(),
    };
    if (editingFilterIdx !== null) {
      updateFilter(editingFilterIdx, newFilter);
      setEditingFilterIdx(null);
    } else {
      if (["is_set", "is_not_set"].includes(filterOp) || filterValue.trim()) {
        addFilter(newFilter);
      }
    }
    setShowFilterDialog(false);
    setFilterCol("");
    setFilterValue("");
  };

  // Open filter dialog to edit an existing chip
  const editFilter = (idx: number) => {
    const f = filters[idx];
    setFilterCol(f.column);
    setFilterOp(f.operator);
    setFilterValue(f.value);
    setEditingFilterIdx(idx);
    setShowFilterDialog(true);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (searchValue.trim()) {
        const col = keyColumns[0] || columns[0];
        setFilterCol(col);
        setFilterOp("contains");
        setFilterValue(searchValue.trim());
        setShowFilterDialog(true);
        setShowSearchDropdown(false);
      } else {
        setPage(0);
        fetchData();
      }
    } else if (e.key === "Escape") {
      setShowSearchDropdown(false);
    }
  };

  // Auto-search when filters change
  useEffect(() => {
    if (!isPlaceholder) { setPage(0); fetchData(); }
  }, [filters]);

  // PO Cost custom import (replaces default import for po_cost table)
  const handlePoCostImport = async (file: File, mode: "insert" | "update") => {
    setPoCostImportLoading(true);
    setPoCostImportProgress({ current: 0, total: 0, phase: "กำลังอ่านไฟล์..." });
    try {
      const rows = await parsePoCostFile(file);
      if (rows.length === 0) {
        toast({ title: "ไฟล์ว่างเปล่า", variant: "destructive" });
        return;
      }
      const { toUpsert, skipped } = await resolvePoCostImport(rows, (cur, total, phase) => {
        setPoCostImportProgress({ current: cur, total, phase });
      });

      // In Update mode: detect rows that don't exist (item_id+vendor not in DB) and prompt user
      if (mode === "update" && toUpsert.length > 0) {
        setPoCostImportProgress({ current: 0, total: toUpsert.length, phase: "ตรวจสอบข้อมูลเดิม..." });
        const { existing, missing } = await splitExistingMissing(toUpsert);
        if (missing.length > 0) {
          // Stash for prompt; keep skipped (validation skips) for later merge
          setPoCostSkipped(skipped);
          setMissingPrompt({ existing, missing });
          return;
        }
      }

      await runApplyAndFinish(toUpsert, mode, skipped);
    } catch (err: any) {
      toast({ title: "Import ผิดพลาด", description: err.message, variant: "destructive" });
    } finally {
      setPoCostImportLoading(false);
      setPoCostImportProgress(null);
    }
  };

  // Apply upsert + show summary/skip dialog
  const runApplyAndFinish = async (
    toUpsert: PoCostResolved[],
    mode: "insert" | "update",
    skipped: PoCostSkipRow[],
  ) => {
    let summary = { inserted: 0, updated: 0 };
    if (toUpsert.length > 0) {
      summary = await applyPoCostImport(toUpsert, mode, (cur, total, phase) => {
        setPoCostImportProgress({ current: cur, total, phase });
      });
    }

    setPoCostImportSummary(summary);
    setPoCostSkipped(skipped);

    if (skipped.length > 0) {
      setShowPoCostSkipDialog(true);
    }

    toast({
      title: mode === "update" ? "อัปเดตสำเร็จ" : "นำเข้าสำเร็จ",
      description: `Insert: ${summary.inserted} · Update: ${summary.updated}${skipped.length > 0 ? ` · ข้าม: ${skipped.length}` : ""}`,
    });

    await fetchData();
  };

  // User chose: Insert missing rows (existing → update, missing → insert)
  const confirmMissingInsert = async () => {
    if (!missingPrompt) return;
    setPoCostImportLoading(true);
    try {
      const all = [...missingPrompt.existing, ...missingPrompt.missing];
      // upsert with onConflict will update existing and insert missing
      await runApplyAndFinish(all, "update", poCostSkipped);
    } catch (err: any) {
      toast({ title: "Import ผิดพลาด", description: err.message, variant: "destructive" });
    } finally {
      setMissingPrompt(null);
      setPoCostImportLoading(false);
      setPoCostImportProgress(null);
    }
  };

  // User chose: Skip missing rows (only update existing, missing → skip list)
  const confirmMissingSkip = async () => {
    if (!missingPrompt) return;
    setPoCostImportLoading(true);
    try {
      const skipFromMissing = resolvedToSkipRows(
        missingPrompt.missing,
        "ไม่พบ SKU+Vendor ในข้อมูลเดิม (Update mode)",
      );
      const mergedSkip = [...poCostSkipped, ...skipFromMissing];
      await runApplyAndFinish(missingPrompt.existing, "update", mergedSkip);
    } catch (err: any) {
      toast({ title: "Import ผิดพลาด", description: err.message, variant: "destructive" });
    } finally {
      setMissingPrompt(null);
      setPoCostImportLoading(false);
      setPoCostImportProgress(null);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    // Custom flow for po_cost
    if (activeTable === "po_cost") {
      await handlePoCostImport(file, importMode);
      return;
    }

    try {
      const sheetList = await getSheets(file);
      if (sheetList.length > 1) {
        setPendingFile(file);
        setSheets(sheetList);
        setSelectedSheet(0);
        setSheetDialogOpen(true);
      } else {
        importData(file, importMode, 0);
      }
    } catch {
      importData(file, importMode, 0);
    }
  };

  const confirmSheetImport = () => {
    if (pendingFile) importData(pendingFile, importMode, selectedSheet);
    setSheetDialogOpen(false);
    setPendingFile(null);
  };

  const toggleColHighlight = (col: string) => {
    setSelectedCols(prev => {
      const next = new Set(prev);
      next.has(col) ? next.delete(col) : next.add(col);
      return next;
    });
  };

  // Row selection with Shift support
  const handleRowClick = (idx: number, id: string, e: React.MouseEvent) => {
    if (e.shiftKey && lastClickedRow !== null) {
      const start = Math.min(lastClickedRow, idx);
      const end = Math.max(lastClickedRow, idx);
      setSelectedRows(prev => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          if (data[i]) next.add(data[i].id);
        }
        return next;
      });
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedRows(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    } else {
      setSelectedRows(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }
    setLastClickedRow(idx);
    setActiveCell({ row: idx, col: activeCell?.col ?? 0 });
  };

  const toggleSelectAll = () => {
    if (selectedRows.size === data.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(data.map(r => r.id)));
    }
  };

  // Paste from clipboard
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    if (selectedRows.size === 0) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const selectedIds = Array.from(selectedRows);
    await pasteToRows(selectedIds, text);
  }, [selectedRows, pasteToRows]);

  useEffect(() => {
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handlePaste]);

  // Scroll active cell into view
  const scrollActiveCellIntoView = useCallback((row: number, col: number) => {
    if (!tableContainerRef.current) return;
    const container = tableContainerRef.current;
    // Find the target cell
    const rowEls = container.querySelectorAll("tbody tr");
    const targetRow = rowEls[row] as HTMLElement;
    if (!targetRow) return;
    const cells = targetRow.querySelectorAll("td");
    const targetCell = cells[col + 3] as HTMLElement; // +3 for checkbox, #, edit columns
    if (!targetCell) return;

    // Scroll horizontally
    const cellLeft = targetCell.offsetLeft;
    const cellRight = cellLeft + targetCell.offsetWidth;
    const containerLeft = container.scrollLeft;
    const containerRight = containerLeft + container.clientWidth;
    if (cellRight > containerRight) {
      container.scrollLeft = cellRight - container.clientWidth + 20;
    } else if (cellLeft < containerLeft) {
      container.scrollLeft = cellLeft - 20;
    }

    // Scroll vertically
    const rowTop = targetRow.offsetTop;
    const rowBottom = rowTop + targetRow.offsetHeight;
    const headerHeight = 36; // sticky header
    const visibleTop = container.scrollTop + headerHeight;
    const visibleBottom = container.scrollTop + container.clientHeight;
    if (rowBottom > visibleBottom) {
      container.scrollTop = rowBottom - container.clientHeight + 10;
    } else if (rowTop < visibleTop) {
      container.scrollTop = rowTop - headerHeight - 10;
    }
  }, []);

  // Keyboard navigation (Ctrl+Arrow, Enter, Tab, Escape)
  const handleTableKeyDown = useCallback((e: KeyboardEvent) => {
    if (!activeCell || data.length === 0) return;
    // Don't intercept when typing in inputs
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    const { row, col } = activeCell;

    if (e.ctrlKey || e.metaKey) {
      let newRow = row, newCol = col;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          newRow = data.length - 1;
          break;
        case "ArrowUp":
          e.preventDefault();
          newRow = 0;
          break;
        case "ArrowRight":
          e.preventDefault();
          newCol = displayColumns.length - 1;
          break;
        case "ArrowLeft":
          e.preventDefault();
          newCol = 0;
          break;
        case "a":
          e.preventDefault();
          setSelectedRows(new Set(data.map(r => r.id)));
          return;
        default:
          return;
      }
      setActiveCell({ row: newRow, col: newCol });
      requestAnimationFrame(() => scrollActiveCellIntoView(newRow, newCol));
      return;
    }

    let newRow = row, newCol = col;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (row < data.length - 1) {
          newRow = row + 1;
          if (e.shiftKey && data[newRow]) {
            setSelectedRows(prev => new Set([...prev, data[newRow].id]));
          }
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (row > 0) {
          newRow = row - 1;
          if (e.shiftKey && data[newRow]) {
            setSelectedRows(prev => new Set([...prev, data[newRow].id]));
          }
        }
        break;
      case "ArrowRight":
        e.preventDefault();
        if (col < displayColumns.length - 1) newCol = col + 1;
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (col > 0) newCol = col - 1;
        break;
      case "Tab":
        e.preventDefault();
        if (e.shiftKey) {
          if (col > 0) newCol = col - 1;
          else if (row > 0) { newRow = row - 1; newCol = displayColumns.length - 1; }
        } else {
          if (col < displayColumns.length - 1) newCol = col + 1;
          else if (row < data.length - 1) { newRow = row + 1; newCol = 0; }
        }
        break;
      case "Escape":
        setActiveCell(null);
        setSelectedRows(new Set());
        return;
      case " ":
        e.preventDefault();
        if (data[row]) {
          setSelectedRows(prev => {
            const next = new Set(prev);
            const id = data[row].id;
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
          });
        }
        return;
      default:
        return;
    }
    if (newRow !== row || newCol !== col) {
      setActiveCell({ row: newRow, col: newCol });
      requestAnimationFrame(() => scrollActiveCellIntoView(newRow, newCol));
    }
  }, [activeCell, data, displayColumns, scrollActiveCellIntoView]);

  useEffect(() => {
    document.addEventListener("keydown", handleTableKeyDown);
    return () => document.removeEventListener("keydown", handleTableKeyDown);
  }, [handleTableKeyDown]);

  // Column resize
  const onResizeStart = (col: string, e: React.MouseEvent) => {
    e.preventDefault();
    setResizing({ col, startX: e.clientX, startW: columnWidths[col] || 120 });
  };

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const diff = e.clientX - resizing.startX;
      setColumnWidths(prev => ({ ...prev, [resizing.col]: Math.max(60, resizing.startW + diff) }));
    };
    const onUp = () => setResizing(null);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [resizing]);

  const handleGroupBy = async () => {
    if (!groupCol) return;
    const result = await groupByColumn(groupCol, valueCol || columns[0], aggType === "distinct_count" ? "count" : aggType);
    setGroupResult(result);
  };

  const deleteSelected = async () => {
    if (selectedRows.size === 0) return;
    try {
      const ids = Array.from(selectedRows);
      const { error } = await (await import("@/integrations/supabase/client")).supabase
        .from(safeTable).delete().in("id", ids);
      if (error) throw error;
      setSelectedRows(new Set());
      fetchData();
    } catch (err: any) {
      console.error(err);
    }
  };

  // Column visibility helpers
  const toggleColumnVisible = (col: string) => {
    setVisibleColumns(prev => {
      const next = new Set(prev);
      next.has(col) ? next.delete(col) : next.add(col);
      return next;
    });
  };
  const selectAllColumns = () => setVisibleColumns(new Set(columns));
  const clearAllColumns = () => setVisibleColumns(new Set());

  const saveCurrentView = () => {
    const name = newViewName.trim();
    if (!name) return;
    const next = [...savedViews.filter(v => v.name !== name), { name, columns: Array.from(visibleColumns) }];
    persistViews(next);
    setNewViewName("");
    toast({ title: "บันทึก View สำเร็จ", description: name });
  };
  const loadView = (view: { name: string; columns: string[] }) => {
    // Only load columns that still exist in current table
    const valid = view.columns.filter(c => columns.includes(c));
    setVisibleColumns(new Set(valid));
    toast({ title: `โหลด View: ${view.name}` });
  };
  const deleteView = (name: string) => {
    persistViews(savedViews.filter(v => v.name !== name));
  };

  const totalPages = Math.ceil(totalCount / pageSize);

  if (isPlaceholder) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Package className="w-16 h-16 mb-4 opacity-30" />
        <h2 className="text-lg font-semibold text-foreground">{tableConfig?.label || activeTable}</h2>
        <p className="text-sm mt-2">รอการออกแบบเพิ่มเติม</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full animate-fade-in" tabIndex={-1}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
        <div>
          <h1 className="text-lg font-bold text-foreground">{tableConfig.label}</h1>
          <p className="text-xs text-muted-foreground">
            {tableConfig.labelTh} · {totalCount.toLocaleString()} แถว
            {selectedRows.size > 0 && ` · เลือก ${selectedRows.size} รายการ`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleImport} className="hidden" />
          {activeTable === "po_cost" && (
            <Button size="sm" variant="outline" className="text-xs" onClick={downloadPoCostTemplate}>
              <FileSpreadsheet className="w-3.5 h-3.5 mr-1" /> Template
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="text-xs" disabled={!!importProgress || poCostImportLoading}>
                {(importProgress || poCostImportProgress) ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <Upload className="w-3.5 h-3.5 mr-1" />
                )}
                {(() => {
                  const p = poCostImportProgress || importProgress;
                  if (!p) return "Import";
                  return `${p.phase}${p.total ? ` · ${p.current.toLocaleString()}/${p.total.toLocaleString()} (${Math.floor((p.current / Math.max(p.total, 1)) * 100)}%)` : ""}`;
                })()}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => { setImportMode("insert"); fileInputRef.current?.click(); }}>
                <Upload className="w-3.5 h-3.5 mr-2" /> Insert (เพิ่มข้อมูลใหม่)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setImportMode("update"); fileInputRef.current?.click(); }}>
                <RefreshCw className="w-3.5 h-3.5 mr-2" /> Update (อัปเดตข้อมูล)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Column Visibility */}
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="text-xs">
                <Columns className="w-3.5 h-3.5 mr-1" /> Columns ({displayColumns.length}/{columns.length})
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 max-h-[70vh] overflow-y-auto p-2" align="end">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-xs font-semibold">Show/Hide Columns</span>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={selectAllColumns}>All</Button>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={clearAllColumns}>None</Button>
                </div>
              </div>
              <div className="space-y-0.5 mb-3">
                {columns.map(col => (
                  <label key={col} className="flex items-center gap-2 px-2 py-1 hover:bg-muted rounded cursor-pointer text-xs">
                    <Checkbox
                      checked={visibleColumns.has(col)}
                      onCheckedChange={() => toggleColumnVisible(col)}
                      className="h-3.5 w-3.5"
                    />
                    {getColumnLabel(col, activeTable)}
                  </label>
                ))}
              </div>
              <div className="border-t pt-2 space-y-2">
                <span className="text-xs font-semibold px-1">Saved Views</span>
                {savedViews.map(v => (
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
                    onChange={e => setNewViewName(e.target.value)}
                    className="h-6 text-[10px] flex-1"
                    onKeyDown={e => e.key === "Enter" && saveCurrentView()}
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
              <DropdownMenuItem onClick={() => exportData()}>
                <Download className="w-3.5 h-3.5 mr-2" /> Export ทั้งหมด
              </DropdownMenuItem>
              {selectedRows.size > 0 && (
                <DropdownMenuItem onClick={() => exportData(Array.from(selectedRows))}>
                  <CheckSquare className="w-3.5 h-3.5 mr-2" /> Export ที่เลือก ({selectedRows.size})
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={exportTemplate}>
                <FileSpreadsheet className="w-3.5 h-3.5 mr-2" /> Export Template
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="outline" onClick={() => { setGroupCol(""); setValueCol(""); setAggType("count"); setGroupResult(null); setGroupDialogOpen(true); }} className="text-xs">
            <BarChart3 className="w-3.5 h-3.5 mr-1" /> Pivot
          </Button>
          <Button size="sm" variant="outline" onClick={fetchData} className="text-xs">
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Read
          </Button>
          <Button size="sm" variant="outline" onClick={clearUI} className="text-xs">
            <XCircle className="w-3.5 h-3.5 mr-1" /> Clear
          </Button>
          {selectedRows.size > 0 && (
            <Button size="sm" variant="destructive" onClick={deleteSelected} className="text-xs">
              <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete Selected ({selectedRows.size})
            </Button>
          )}
          <Button size="sm" variant="destructive" onClick={deleteAll} className="text-xs">
            <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete All
          </Button>
        </div>
      </div>

      {/* Odoo-style Search Bar */}
      <div className="flex items-center gap-2 px-6 py-2.5 bg-card border-b border-border flex-wrap">
        <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        {/* Active filter chips */}
        {filters.map((f, i) => (
          <Badge key={i} variant="secondary" className="text-xs gap-1 pl-2 pr-1 py-0.5 cursor-pointer hover:bg-secondary/80" onClick={() => editFilter(i)}>
            <span className="font-medium">{getColumnLabel(f.column, activeTable)}</span>
            <span className="text-muted-foreground">{OPERATOR_LABELS[f.operator]}</span>
            {f.value && <span className="font-semibold">{f.value}</span>}
            <Pencil className="w-2.5 h-2.5 text-muted-foreground ml-0.5" />
            <button onClick={(e) => { e.stopPropagation(); removeFilter(i); }} className="ml-0.5 hover:bg-destructive/20 rounded p-0.5">
              <X className="w-3 h-3" />
            </button>
          </Badge>
        ))}
        {/* Search input with dropdown */}
        <div className="relative flex-1 min-w-[200px]">
          <Input
            ref={searchInputRef}
            className="h-8 text-xs border-0 shadow-none focus-visible:ring-0 bg-transparent"
            placeholder="พิมพ์เพื่อค้นหา..."
            value={searchValue}
            onChange={e => { setSearchValue(e.target.value); setShowSearchDropdown(true); }}
            onFocus={() => setShowSearchDropdown(true)}
            onKeyDown={handleSearchKeyDown}
          />
          {/* Dropdown suggestions */}
          {showSearchDropdown && searchValue.trim() && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-popover border border-border rounded-md shadow-lg w-80 max-h-80 overflow-y-auto">
              {keyColumns.map(col => (
                <button
                  key={col}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-primary/10 text-left transition-colors"
                  onClick={() => addSearchFilter(col)}
                >
                  <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  <span>Search <span className="font-semibold text-primary">{getColumnLabel(col, activeTable)}</span> for: <span className="font-mono text-xs">{searchValue}</span></span>
                </button>
              ))}
              <div className="border-t border-border" />
              {columns.filter(c => !keyColumns.includes(c)).slice(0, 10).map(col => (
                <button
                  key={col}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted text-left transition-colors"
                  onClick={() => addSearchFilter(col)}
                >
                  <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                  <span>Search <span className="font-medium">{getColumnLabel(col, activeTable)}</span> for: <span className="font-mono text-xs">{searchValue}</span></span>
                </button>
              ))}
            </div>
          )}
        </div>
        {filters.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => { clearFilters(); fetchData(); }} className="text-xs h-7">
            <X className="w-3 h-3 mr-1" /> Clear All
          </Button>
        )}
      </div>

      {/* Table */}
      <div
        ref={tableContainerRef}
        className="flex-1 overflow-auto"
        onClick={() => showSearchDropdown && setShowSearchDropdown(false)}
      >
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
            <span className="ml-2 text-sm text-muted-foreground">กำลังโหลด...</span>
          </div>
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <Package className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">ยังไม่มีข้อมูล</p>
            <p className="text-xs mt-1">กด Import เพื่อนำเข้าข้อมูลจากไฟล์ Excel</p>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="data-table-header bg-muted" style={{ width: 40, minWidth: 40 }}>
                  <Checkbox checked={selectedRows.size === data.length && data.length > 0} onCheckedChange={toggleSelectAll} className="mx-auto" />
                </th>
                <th className="data-table-header bg-muted" style={{ width: 48, minWidth: 48 }}>#</th>
                <th className="data-table-header bg-muted" style={{ width: 56, minWidth: 56 }}>Edit</th>
                {displayColumns.map((col, colIdx) => (
                  <th
                    key={col}
                    className={cn(
                      "data-table-header relative group cursor-pointer select-none",
                      selectedCols.has(col) && "bg-emerald-100 dark:bg-emerald-900/40"
                    )}
                    style={{ width: columnWidths[col] || 120, minWidth: 60 }}
                    onClick={() => toggleColHighlight(col)}
                  >
                    {getColumnLabel(col, activeTable)}
                    <div
                      className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-primary/30 group-hover:bg-primary/10"
                      onMouseDown={e => { e.stopPropagation(); onResizeStart(col, e); }}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, idx) => {
                const isSelected = selectedRows.has(row.id);
                const isActiveRow = activeCell?.row === idx;
                return (
                  <tr
                    key={row.id || idx}
                    className={cn(
                      "border-b border-border transition-colors",
                      isSelected
                        ? "bg-emerald-50 dark:bg-emerald-950/30 hover:bg-emerald-100 dark:hover:bg-emerald-950/50"
                        : isActiveRow
                          ? "bg-blue-50/50 dark:bg-blue-950/20"
                          : "hover:bg-muted/50"
                    )}
                    onClick={(e) => handleRowClick(idx, row.id, e)}
                  >
                    <td className="data-table-cell text-center bg-inherit" style={{ width: 40, minWidth: 40 }} onClick={e => e.stopPropagation()}>
                      <Checkbox checked={isSelected} onCheckedChange={() => handleRowClick(idx, row.id, { shiftKey: false, ctrlKey: false, metaKey: false } as any)} />
                    </td>
                    <td className="data-table-cell text-muted-foreground text-center bg-inherit" style={{ width: 48, minWidth: 48 }}>{page * pageSize + idx + 1}</td>
                    <td className="data-table-cell text-center bg-inherit" style={{ width: 56, minWidth: 56 }} onClick={e => e.stopPropagation()}>
                      {editingRow === row.id ? (
                        <div className="flex gap-1 justify-center">
                          <button onClick={saveEditing} className="text-green-600 hover:text-green-800"><Check className="w-3.5 h-3.5" /></button>
                          <button onClick={cancelEditing} className="text-red-500 hover:text-red-700"><X className="w-3.5 h-3.5" /></button>
                        </div>
                      ) : (
                        <button onClick={() => startEditing(row.id)} className="text-muted-foreground hover:text-primary"><Pencil className="w-3.5 h-3.5" /></button>
                      )}
                    </td>
                    {displayColumns.map((col, colIdx) => {
                      const isCellActive = activeCell?.row === idx && activeCell?.col === colIdx;
                      let displayValue = String(row[col] ?? "");
                      if (activeTable === "po_cost" && col === "vendor" && row[col]) {
                        displayValue = vendorDisplayMap.get(String(row[col])) || String(row[col]);
                      }
                      return (
                        <td
                          key={col}
                          className={cn(
                            "data-table-cell",
                            selectedCols.has(col) && "bg-emerald-50/50 dark:bg-emerald-950/20",
                            isCellActive && "ring-2 ring-primary ring-inset"
                          )}
                          style={{ width: columnWidths[col] || 120, maxWidth: columnWidths[col] || 250 }}
                          title={displayValue}
                          onClick={(e) => { e.stopPropagation(); setActiveCell({ row: idx, col: colIdx }); handleRowClick(idx, row.id, e); }}
                        >
                          {editingRow === row.id ? (
                            <Input className="h-6 text-xs px-1 py-0 border-primary/50" value={editedData[col] ?? ""} onChange={e => updateEditedField(col, e.target.value)} />
                          ) : (
                            <span className="truncate block">{displayValue}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-2.5 border-t border-border bg-card">
        <div className="flex items-center gap-4">
          <span className="text-xs text-muted-foreground">
            {totalPages > 0 ? `หน้า ${page + 1} / ${totalPages}` : ""} ({totalCount.toLocaleString()} แถว)
          </span>
          <span className="text-[10px] text-muted-foreground/60 hidden md:inline">
            Shift+Click: เลือกช่วง · Ctrl+A: เลือกทั้งหมด · Arrow: เลื่อน · Ctrl+Arrow: ข้ามไปสุด · Space: เลือก/ยกเลิก
          </span>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="h-7 w-7 p-0">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} className="h-7 w-7 p-0">
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Custom Filter Dialog */}
      <Dialog open={showFilterDialog} onOpenChange={(open) => { setShowFilterDialog(open); if (!open) setEditingFilterIdx(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingFilterIdx !== null ? "Edit Condition" : "Modify Condition"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Column</label>
              <select className="w-full border rounded px-2 py-1.5 text-sm bg-background" value={filterCol} onChange={e => setFilterCol(e.target.value)}>
                <option value="">เลือกคอลัมน์...</option>
                {columns.map(c => <option key={c} value={c}>{getColumnLabel(c, activeTable)}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block">Condition</label>
              <div className="flex flex-wrap gap-1.5">
                {ALL_OPERATORS.map(op => (
                  <Button
                    key={op}
                    size="sm"
                    variant={filterOp === op ? "default" : "outline"}
                    className="text-xs h-7 px-3"
                    onClick={() => setFilterOp(op)}
                  >
                    {OPERATOR_LABELS[op]}
                  </Button>
                ))}
              </div>
            </div>
            {!["is_set", "is_not_set"].includes(filterOp) && (
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Value</label>
                <Input value={filterValue} onChange={e => setFilterValue(e.target.value)} placeholder="ค่าที่ต้องการ..." onKeyDown={e => e.key === "Enter" && confirmFilter()} autoFocus />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFilterDialog(false)}>Discard</Button>
            <Button onClick={confirmFilter} disabled={!filterCol}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sheet Selector Dialog */}
      <Dialog open={sheetDialogOpen} onOpenChange={setSheetDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>เลือก Sheet ที่ต้องการ Import</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-4">
            {sheets.map(s => (
              <label key={s.index} className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer border transition-colors",
                selectedSheet === s.index ? "border-primary bg-primary/5" : "border-border hover:bg-muted"
              )}>
                <input type="radio" checked={selectedSheet === s.index} onChange={() => setSelectedSheet(s.index)} className="accent-primary" />
                <span className="text-sm font-medium">{s.name}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSheetDialogOpen(false)}>ยกเลิก</Button>
            <Button onClick={confirmSheetImport}>Import Sheet นี้</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pivot Dialog */}
      <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Pivot Table</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-3 py-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">📊 Row (Group By)</label>
              <select className="w-full border rounded px-2 py-1.5 text-sm bg-background" value={groupCol} onChange={e => setGroupCol(e.target.value)}>
                <option value="">เลือกคอลัมน์...</option>
                {displayColumns.map(c => <option key={c} value={c}>{getColumnLabel(c, activeTable)}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">📈 Value</label>
              <select className="w-full border rounded px-2 py-1.5 text-sm bg-background" value={valueCol} onChange={e => setValueCol(e.target.value)}>
                <option value="">เลือกคอลัมน์...</option>
                {displayColumns.map(c => <option key={c} value={c}>{getColumnLabel(c, activeTable)}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">🔢 Aggregation</label>
              <select className="w-full border rounded px-2 py-1.5 text-sm bg-background" value={aggType} onChange={e => setAggType(e.target.value as any)}>
                <option value="count">Count</option>
                <option value="sum">Sum</option>
                <option value="avg">Average</option>
                <option value="distinct_count">Distinct Count</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" onClick={handleGroupBy} disabled={!groupCol}>สร้าง Pivot</Button>
            <Button size="sm" variant="outline" onClick={() => setGroupResult(null)}>Clear</Button>
            {groupResult && groupResult.length > 0 && (
              <>
                <div className="border-l border-border h-6 mx-1" />
                <Button size="sm" variant="outline" className="text-xs" onClick={() => {
                  const exportRows = (pivotSearch
                    ? groupResult.filter(r => String(r[groupCol] ?? "").toLowerCase().includes(pivotSearch.toLowerCase()))
                    : groupResult
                  ).map(r => {
                    const row: Record<string, any> = { [getColumnLabel(groupCol, activeTable)]: r[groupCol] };
                    if (aggType === "count" || aggType === "distinct_count") row["Count"] = r.count;
                    if (aggType === "sum") row["Sum"] = r.sum;
                    if (aggType === "avg") row["Average"] = r.avg;
                    return row;
                  });
                  import("xlsx").then(XLSX => {
                    const ws = XLSX.utils.json_to_sheet(exportRows);
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, "Pivot");
                    XLSX.writeFile(wb, `${safeTable}_pivot.xlsx`);
                  });
                }}>
                  <Download className="w-3.5 h-3.5 mr-1" /> Export Pivot
                </Button>
                <div className="flex-1 min-w-[150px]">
                  <Input
                    className="h-7 text-xs"
                    placeholder="ค้นหาใน Pivot..."
                    value={pivotSearch}
                    onChange={e => setPivotSearch(e.target.value)}
                  />
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="outline" className="text-xs">
                      <Columns className="w-3.5 h-3.5 mr-1" /> Columns
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-48 p-2" align="end">
                    <div className="space-y-1">
                      {["count", "sum", "avg"].map(col => (
                        <label key={col} className="flex items-center gap-2 px-2 py-1 hover:bg-muted rounded cursor-pointer text-xs">
                          <Checkbox
                            checked={pivotVisibleCols.has(col)}
                            onCheckedChange={() => setPivotVisibleCols(prev => {
                              const next = new Set(prev);
                              next.has(col) ? next.delete(col) : next.add(col);
                              return next;
                            })}
                            className="h-3.5 w-3.5"
                          />
                          {col === "count" ? "Count" : col === "sum" ? "Sum" : "Average"}
                        </label>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              </>
            )}
          </div>
          {groupResult && (() => {
            const filtered = pivotSearch
              ? groupResult.filter(r => String(r[groupCol] ?? "").toLowerCase().includes(pivotSearch.toLowerCase()))
              : groupResult;
            return (
              <>
                <p className="text-xs text-muted-foreground mt-2">{filtered.length.toLocaleString()} กลุ่ม</p>
                <div className="border rounded overflow-auto max-h-96 mt-1">
                  <table className="w-full text-xs border-collapse">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="text-left px-3 py-2 border-b font-semibold">{getColumnLabel(groupCol, activeTable)}</th>
                        {pivotVisibleCols.has("count") && <th className="text-right px-3 py-2 border-b font-semibold">Count</th>}
                        {pivotVisibleCols.has("sum") && <th className="text-right px-3 py-2 border-b font-semibold">Sum</th>}
                        {pivotVisibleCols.has("avg") && <th className="text-right px-3 py-2 border-b font-semibold">Average</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, 500).map((r, i) => (
                        <tr key={i} className="border-b hover:bg-muted/50">
                          <td className="px-3 py-1.5">{r[groupCol]}</td>
                          {pivotVisibleCols.has("count") && <td className="px-3 py-1.5 text-right">{r.count.toLocaleString()}</td>}
                          {pivotVisibleCols.has("sum") && <td className="px-3 py-1.5 text-right">{r.sum.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>}
                          {pivotVisibleCols.has("avg") && <td className="px-3 py-1.5 text-right">{r.avg.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filtered.length > 500 && <p className="text-xs text-muted-foreground p-2">แสดง 500 จาก {filtered.length} กลุ่ม</p>}
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* PO Cost Skip List Dialog */}
      <Dialog open={showPoCostSkipDialog} onOpenChange={setShowPoCostSkipDialog}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              Skip List ({poCostSkipped.length} รายการที่ข้าม)
            </DialogTitle>
            <DialogDescription>
              {poCostImportSummary && (
                <span>นำเข้าสำเร็จ: Insert {poCostImportSummary.inserted} · Update {poCostImportSummary.updated} · ข้าม {poCostSkipped.length}</span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto border rounded">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="text-left px-2 py-1.5 border-b">ID/SKU/Barcode</th>
                  <th className="text-left px-2 py-1.5 border-b">Product Name</th>
                  <th className="text-right px-2 py-1.5 border-b">Po Cost</th>
                  <th className="text-right px-2 py-1.5 border-b">Moq</th>
                  <th className="text-left px-2 py-1.5 border-b">Vendor</th>
                  <th className="text-left px-2 py-1.5 border-b">Reason</th>
                  <th className="text-right px-2 py-1.5 border-b">Suggest Unit</th>
                </tr>
              </thead>
              <tbody>
                {poCostSkipped.slice(0, 500).map((s, i) => (
                  <tr key={i} className="border-b hover:bg-muted/30">
                    <td className="px-2 py-1 font-mono">{s.key}</td>
                    <td className="px-2 py-1">{s.productName}</td>
                    <td className="px-2 py-1 text-right">{s.poCost ?? "-"}</td>
                    <td className="px-2 py-1 text-right">{s.moq ?? "-"}</td>
                    <td className="px-2 py-1">{s.vendor}</td>
                    <td className="px-2 py-1 text-amber-700 dark:text-amber-400">{s.reason}</td>
                    <td className="px-2 py-1 text-right font-semibold">{s.suggestUnit ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {poCostSkipped.length > 500 && (
              <p className="text-xs text-muted-foreground p-2">แสดง 500 จาก {poCostSkipped.length} (กด Download เพื่อดูทั้งหมด)</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPoCostSkipDialog(false)}>ปิด</Button>
            <Button onClick={() => downloadSkipList(poCostSkipped)}>
              <Download className="w-3.5 h-3.5 mr-1" /> Download Skip List
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PO Cost: Update mode — missing rows confirmation */}
      <Dialog open={!!missingPrompt} onOpenChange={(o) => !o && setMissingPrompt(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              พบข้อมูลใหม่ที่ไม่มีอยู่เดิม
            </DialogTitle>
            <DialogDescription>
              {missingPrompt && (
                <span>
                  จะอัปเดต {missingPrompt.existing.length} รายการที่มีอยู่เดิม ·
                  พบ <strong className="text-amber-600">{missingPrompt.missing.length}</strong> รายการใหม่ที่ไม่มี SKU+Vendor ในระบบ
                  <br />
                  ต้องการ <strong>Insert</strong> รายการใหม่เหล่านี้ หรือ <strong>Skip</strong> (ใส่ลง Skip List ให้ Download)?
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto border rounded">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="text-left px-2 py-1.5 border-b">ID (SKUCode)</th>
                  <th className="text-left px-2 py-1.5 border-b">Vendor</th>
                  <th className="text-left px-2 py-1.5 border-b">Product Name</th>
                  <th className="text-right px-2 py-1.5 border-b">MOQ</th>
                  <th className="text-right px-2 py-1.5 border-b">PO Cost</th>
                </tr>
              </thead>
              <tbody>
                {missingPrompt?.missing.slice(0, 500).map((r, i) => (
                  <tr key={i} className="border-b hover:bg-muted/30">
                    <td className="px-2 py-1 font-mono">{r.item_id}</td>
                    <td className="px-2 py-1">{r.vendor}</td>
                    <td className="px-2 py-1">{r.product_name}</td>
                    <td className="px-2 py-1 text-right">{r.moq}</td>
                    <td className="px-2 py-1 text-right">{r.po_cost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(missingPrompt?.missing.length ?? 0) > 500 && (
              <p className="text-xs text-muted-foreground p-2">แสดง 500 จาก {missingPrompt!.missing.length}</p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setMissingPrompt(null)}>ยกเลิก</Button>
            <Button variant="secondary" onClick={confirmMissingSkip}>
              Skip + ใส่ Skip List
            </Button>
            <Button onClick={confirmMissingInsert}>
              Insert รายการใหม่
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
