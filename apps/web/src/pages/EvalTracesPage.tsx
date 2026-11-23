import { Activity } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";

/** Observability traces & benchmark evaluation summary page. */
export function EvalTracesPage() {
  return (
    <div className="content space-y-6">
      <div className="heading">
        <div>
          <div className="eyebrow accent">OBSERVABILITY · EVALS</div>
          <h1>Trace &amp; Đánh giá</h1>
          <p>Theo dõi Execution Accuracy (EX), độ trễ, token và dấu vết thực thi đã che PII.</p>
        </div>
        <Activity className="heading-icon size-8" aria-hidden="true" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Nhật ký chạy &amp; Chỉ số đánh giá</CardTitle>
          <CardDescription>
            Dữ liệu được chuẩn hóa theo <code>TraceEvent</code> và <code>BenchmarkRow</code> từ{" "}
            <code>@shared/contracts</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Kết nối API danh sách trace hoặc tải tệp kết quả eval để hiển thị bảng so sánh chi tiết.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
