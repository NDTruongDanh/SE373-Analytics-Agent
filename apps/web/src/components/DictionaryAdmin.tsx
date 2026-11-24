import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DbToolErrorSchema,
  SemanticCatalogResponseSchema,
  SemanticReindexResultSchema,
  type SemanticCatalogItem,
  type SemanticCatalogResponse,
  type SemanticDocType,
  type SemanticReindexResult,
  type SemanticSensitivity,
} from "@shared/contracts";
import {
  AlertTriangle,
  CalendarRange,
  Clock,
  Database,
  GitMerge,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface DictionaryAdminProps {
  persona: string;
}

type DocTypeFilter = "all" | SemanticDocType;

const DOC_TYPE_TABS: { value: DocTypeFilter; label: string }[] = [
  { value: "all", label: "Tất cả" },
  { value: "metric", label: "Chỉ số" },
  { value: "table", label: "Bảng" },
  { value: "column", label: "Cột" },
  { value: "join_rule", label: "Quy tắc nối" },
  { value: "example", label: "Ví dụ SQL" },
  { value: "event", label: "Sự kiện" },
];

const DOC_TYPE_LABELS: Record<SemanticDocType, string> = {
  metric: "Chỉ số",
  table: "Bảng",
  column: "Cột",
  join_rule: "Quy tắc nối",
  example: "Ví dụ SQL",
  event: "Sự kiện",
};

const SENSITIVITY_META: Record<
  SemanticSensitivity,
  { label: string; variant: "success" | "warning" | "destructive" }
> = {
  public: { label: "Công khai", variant: "success" },
  internal: { label: "Nội bộ", variant: "warning" },
  restricted_pii: { label: "Restricted PII", variant: "destructive" },
};

async function fetchSemanticCatalog(): Promise<SemanticCatalogResponse> {
  const response = await fetch("/api/semantic/catalog");
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let parsedError: ReturnType<typeof DbToolErrorSchema.safeParse> | undefined;
    try {
      parsedError = DbToolErrorSchema.safeParse(JSON.parse(text));
    } catch {
      parsedError = undefined;
    }
    if (parsedError?.success) {
      throw new Error(parsedError.data.message);
    }
    throw new Error(text || `Không thể tải từ điển dữ liệu (HTTP ${response.status}).`);
  }
  return SemanticCatalogResponseSchema.parse(await response.json());
}

async function triggerReindex(persona: string): Promise<SemanticReindexResult> {
  const response = await fetch("/api/semantic/reindex", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ persona }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let parsedError: ReturnType<typeof DbToolErrorSchema.safeParse> | undefined;
    try {
      parsedError = DbToolErrorSchema.safeParse(JSON.parse(text));
    } catch {
      parsedError = undefined;
    }
    if (
      response.status === 403 ||
      (parsedError?.success && parsedError.data.code === "SCOPE_DENIED")
    ) {
      throw new Error(
        "Không đủ quyền (SCOPE_DENIED): Chỉ vai trò Quản trị dữ liệu (data_admin) mới có thể đồng bộ kho tri thức.",
      );
    }
    if (parsedError?.success) {
      throw new Error(parsedError.data.message);
    }
    throw new Error(text || `Không thể cập nhật chỉ mục (HTTP ${response.status}).`);
  }
  return SemanticReindexResultSchema.parse(await response.json());
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "Chưa ghi nhận";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("vi-VN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function matchesSearch(item: SemanticCatalogItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const fields: string[] = [
    item.chunkId,
    item.docType,
    item.table ?? "",
    ...item.tables,
    item.metricName ?? "",
    ...item.aliases,
    item.summary,
    item.formula ?? "",
    item.sqlTemplate ?? "",
    item.column ?? "",
    item.question ?? "",
    ...item.caveats,
  ];
  return fields.some((field) => field.toLowerCase().includes(normalized));
}

function itemHeading(item: SemanticCatalogItem): string {
  return item.metricName ?? item.column ?? item.table ?? item.chunkId;
}

function CatalogEntryCard({ item }: { item: SemanticCatalogItem }) {
  const sensitivity = SENSITIVITY_META[item.sensitivity];
  const heading = itemHeading(item);

  return (
    <Card data-testid={`catalog-item-${item.chunkId}`}>
      <CardHeader className="gap-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{heading}</CardTitle>
              <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">
                {item.chunkId}
              </code>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3.5" aria-hidden="true" />
              <span>Cập nhật: {formatTimestamp(item.updatedAt)}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{DOC_TYPE_LABELS[item.docType]}</Badge>
            <Badge variant={sensitivity.variant}>
              {item.sensitivity === "restricted_pii" && (
                <ShieldAlert className="size-3" aria-hidden="true" />
              )}
              {sensitivity.label}
            </Badge>
            {item.additive !== undefined && (
              <Badge variant={item.additive ? "secondary" : "outline"}>
                {item.additive ? "Additive" : "Non-additive"}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 text-sm">
        <p className="leading-relaxed text-foreground">{item.summary}</p>

        {item.question && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <span className="font-semibold text-foreground">Câu hỏi mẫu: </span>
            <span className="text-muted-foreground">{item.question}</span>
          </div>
        )}

        {item.formula && (
          <div className="rounded-md border border-[#cfe3d0] bg-[#f2f8f3] px-3 py-2 text-xs">
            <span className="font-semibold text-[#1f4035]">Công thức: </span>
            <code className="font-mono text-[#18382f]">{item.formula}</code>
          </div>
        )}

        {item.sqlTemplate && (
          <div className="space-y-1">
            <div className="text-xs font-semibold text-muted-foreground">SQL tham chiếu</div>
            <pre className="overflow-x-auto rounded-md border bg-muted/50 p-2.5 text-xs font-mono text-foreground">
              <code>{item.sqlTemplate}</code>
            </pre>
          </div>
        )}

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          {item.tables.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Database className="size-3.5" aria-hidden="true" />
              <span className="font-semibold text-foreground">Bảng:</span>
              {item.tables.map((tableName) => (
                <code
                  key={tableName}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground"
                >
                  {tableName}
                </code>
              ))}
            </div>
          )}

          {item.primaryKey && (
            <div>
              <span className="font-semibold text-foreground">Khóa chính:</span>{" "}
              <code className="font-mono">{item.primaryKey}</code>
            </div>
          )}

          {item.grain && (
            <div>
              <span className="font-semibold text-foreground">Grain:</span> {item.grain}
            </div>
          )}

          {item.rowCountScale && (
            <div>
              <span className="font-semibold text-foreground">Quy mô:</span> {item.rowCountScale}
            </div>
          )}

          {item.dataType && (
            <div>
              <span className="font-semibold text-foreground">Kiểu dữ liệu:</span>{" "}
              <code className="font-mono">{item.dataType}</code>
            </div>
          )}
        </div>

        {item.enumValues && item.enumValues.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold text-foreground">Giá trị hợp lệ:</span>
            {item.enumValues.map((val) => (
              <Badge key={val} variant="outline" className="font-mono text-[11px]">
                {val}
              </Badge>
            ))}
          </div>
        )}

        {item.citedMetrics && item.citedMetrics.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <GitMerge className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="font-semibold text-foreground">Chỉ số liên quan:</span>
            {item.citedMetrics.map((metric) => (
              <Badge key={metric} variant="secondary" className="font-mono text-[11px]">
                {metric}
              </Badge>
            ))}
          </div>
        )}

        {(item.startDate || item.endDate || item.affectedRegions?.length || item.affectedChannels?.length) && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {(item.startDate || item.endDate) && (
              <span className="inline-flex items-center gap-1.5">
                <CalendarRange className="size-3.5" aria-hidden="true" />
                <span>
                  {item.startDate ?? "?"} → {item.endDate ?? "?"}
                </span>
              </span>
            )}
            {item.affectedRegions && item.affectedRegions.length > 0 && (
              <span>
                <strong className="text-foreground">Khu vực:</strong>{" "}
                {item.affectedRegions.join(", ")}
              </span>
            )}
            {item.affectedChannels && item.affectedChannels.length > 0 && (
              <span>
                <strong className="text-foreground">Kênh:</strong>{" "}
                {item.affectedChannels.join(", ")}
              </span>
            )}
          </div>
        )}

        {item.aliases.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold text-foreground">Từ đồng nghĩa:</span>
            {item.aliases.map((alias) => (
              <Badge key={alias} variant="outline" className="font-normal">
                {alias}
              </Badge>
            ))}
          </div>
        )}

        {item.caveats.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
            <div className="mb-1 flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="size-3.5" aria-hidden="true" />
              <span>Lưu ý phân tích</span>
            </div>
            <ul className="list-disc space-y-0.5 pl-4">
              {item.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** UC-02 Data Dictionary & Semantic Layer Admin view. */
export function DictionaryAdmin({ persona }: DictionaryAdminProps) {
  const queryClient = useQueryClient();
  const [activeDocType, setActiveDocType] = useState<DocTypeFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const catalogQuery = useQuery({
    queryKey: ["semantic-catalog"],
    queryFn: fetchSemanticCatalog,
  });

  const reindex = useMutation({
    mutationFn: () => triggerReindex(persona),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["semantic-catalog"] });
    },
  });

  const isAdmin = persona === "data_admin";

  const filteredItems = useMemo(() => {
    const items = catalogQuery.data?.items ?? [];
    return items.filter((item) => {
      if (activeDocType !== "all" && item.docType !== activeDocType) {
        return false;
      }
      return matchesSearch(item, searchQuery);
    });
  }, [catalogQuery.data?.items, activeDocType, searchQuery]);

  const countsByDocType = catalogQuery.data?.countsByDocType;
  const totalChunks = catalogQuery.data?.totalChunks ?? 0;

  function tabCount(value: DocTypeFilter): number | undefined {
    if (!catalogQuery.data) return undefined;
    if (value === "all") return catalogQuery.data.totalChunks;
    return catalogQuery.data.countsByDocType[value];
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
          <div>
            <CardTitle>Đồng bộ kho tri thức (Semantic Re-index)</CardTitle>
            <CardDescription>
              Chỉ vai trò Quản trị dữ liệu (<code>data_admin</code>) mới có quyền gọi{" "}
              <code>POST /api/semantic/reindex</code> để cập nhật vector/SHA-256 gia tăng.
            </CardDescription>
          </div>
          <Button
            type="button"
            disabled={!isAdmin || reindex.isPending}
            onClick={() => reindex.mutate()}
          >
            <RefreshCw className={reindex.isPending ? "animate-spin" : undefined} aria-hidden="true" />
            {reindex.isPending ? "Đang đồng bộ…" : "Re-index Changed Chunks"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {!isAdmin && (
            <p className="text-xs text-muted-foreground">
              Hãy chuyển vai trò ở góc trên bên phải sang <strong>Quản trị dữ liệu</strong> để kích hoạt đồng bộ.
            </p>
          )}
          {reindex.isError && (
            <div className="error" role="alert">
              {reindex.error instanceof Error ? reindex.error.message : "Lỗi đồng bộ chỉ mục."}
            </div>
          )}
          {reindex.isSuccess && (
            <div className="flex flex-wrap gap-2" data-testid="reindex-result-badges">
              <Badge variant="success">Added: {reindex.data.added}</Badge>
              <Badge variant="secondary">Updated: {reindex.data.updated}</Badge>
              <Badge variant="outline">Skipped: {reindex.data.skipped}</Badge>
              <Badge variant="warning">Deleted: {reindex.data.deleted}</Badge>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-2 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Tổng quan Semantic Layer</CardTitle>
              <CardDescription>
                Duyệt định nghĩa bảng, cột, chỉ số, quy tắc nối, ví dụ SQL và sự kiện nghiệp vụ.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" data-testid="catalog-total-chunks">
                Tổng chunks: {catalogQuery.data ? totalChunks : "…"}
              </Badge>
              <span data-testid="catalog-last-updated">
                Cập nhật gần nhất:{" "}
                <strong>{formatTimestamp(catalogQuery.data?.lastUpdatedAt ?? null)}</strong>
              </span>
            </div>
          </div>

          {countsByDocType && (
            <div className="flex flex-wrap gap-2 pt-1" data-testid="catalog-doc-type-summary">
              {DOC_TYPE_TABS.filter((tab) => tab.value !== "all").map((tab) => (
                <Badge key={tab.value} variant="secondary">
                  {tab.label}: {countsByDocType[tab.value as SemanticDocType]}
                </Badge>
              ))}
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Tìm chỉ số, bảng, cột, alias, quy tắc nối..."
                aria-label="Tìm kiếm từ điển dữ liệu"
                className="pl-9"
              />
            </div>
          </div>

          <Tabs
            value={activeDocType}
            onValueChange={(value) => setActiveDocType(value as DocTypeFilter)}
          >
            <TabsList className="h-auto flex-wrap justify-start">
              {DOC_TYPE_TABS.map((tab) => {
                const count = tabCount(tab.value);
                return (
                  <TabsTrigger key={tab.value} value={tab.value}>
                    {tab.label}
                    {count !== undefined ? ` (${count})` : ""}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>

          {catalogQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Đang tải từ điển dữ liệu…</p>
          )}

          {catalogQuery.isError && (
            <div className="space-y-2" role="alert">
              <div className="error">
                {catalogQuery.error instanceof Error
                  ? catalogQuery.error.message
                  : "Không thể tải danh mục semantic."}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => void catalogQuery.refetch()}>
                Thử lại
              </Button>
            </div>
          )}

          {!catalogQuery.isLoading && !catalogQuery.isError && filteredItems.length === 0 && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Không tìm thấy mục nào phù hợp với bộ lọc hiện tại.
            </p>
          )}

          {!catalogQuery.isLoading && !catalogQuery.isError && filteredItems.length > 0 && (
            <div className="space-y-4">
              {filteredItems.map((item) => (
                <CatalogEntryCard key={item.chunkId} item={item} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
