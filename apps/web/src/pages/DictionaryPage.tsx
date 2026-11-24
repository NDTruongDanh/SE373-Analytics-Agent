import { useMutation } from "@tanstack/react-query";
import { BookOpen, RefreshCw } from "lucide-react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const ReindexResultSchema = z.object({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
});

type ReindexResult = z.infer<typeof ReindexResultSchema>;

export interface DictionaryPageProps {
  persona: string;
}

async function triggerReindex(persona: string): Promise<ReindexResult> {
  const response = await fetch("/api/semantic/reindex", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ persona }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Không thể cập nhật chỉ mục (HTTP ${response.status}).`);
  }
  return ReindexResultSchema.parse(await response.json());
}

export function DictionaryPage({ persona }: DictionaryPageProps) {
  const reindex = useMutation({
    mutationFn: () => triggerReindex(persona),
  });

  const isAdmin = persona === "data_admin";

  return (
    <div className="content space-y-6">
      <div className="heading">
        <div>
          <div className="eyebrow accent">UC-02 · SEMANTIC LAYER</div>
          <h1>Từ điển dữ liệu &amp; Chỉ số</h1>
          <p>Quản lý định nghĩa chỉ số, quy tắc nối bảng và đồng bộ kho tri thức.</p>
        </div>
        <BookOpen className="heading-icon size-8" aria-hidden="true" />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Đồng bộ kho tri thức (Semantic Re-index)</CardTitle>
            <CardDescription>
              Chỉ vai trò Quản trị dữ liệu (<code>data_admin</code>) mới có quyền gọi{" "}
              <code>POST /api/semantic/reindex</code>.
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
            <div className="flex flex-wrap gap-2">
              <Badge variant="success">Added: {reindex.data.added}</Badge>
              <Badge variant="secondary">Updated: {reindex.data.updated}</Badge>
              <Badge variant="outline">Skipped: {reindex.data.skipped}</Badge>
              <Badge variant="warning">Deleted: {reindex.data.deleted}</Badge>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
