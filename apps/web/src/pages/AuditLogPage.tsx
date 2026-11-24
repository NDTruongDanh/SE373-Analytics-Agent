import { ScrollText } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** UC-09 MCP audit log viewer page. */
export function AuditLogPage() {
  return (
    <div className="content space-y-6">
      <div className="heading">
        <div>
          <div className="eyebrow accent">UC-09 · AUDIT LOG</div>
          <h1>Nhật ký kiểm toán</h1>
          <p>Theo dõi lịch sử gọi công cụ MCP, kiểm soát phạm vi dữ liệu và ẩn danh PII.</p>
        </div>
        <ScrollText className="heading-icon size-8" aria-hidden="true" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Nhật ký thực thi MCP (Redacted Audit Trail)</CardTitle>
          <CardDescription>
            Mọi truy vấn qua gateway được ghi nhận có kiểm soát vào <code>logs/mcp_audit.jsonl</code> theo chuẩn{" "}
            <code>TraceEvent</code> từ <code>@shared/contracts</code>, không lưu giá trị PII thô.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Kết nối nguồn dữ liệu kiểm toán từ máy chủ MCP để tra cứu chi tiết các lượt truy cập theo vai trò.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
