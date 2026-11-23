import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** UC-05 HITL RCA plan review & UC-07 costly query approval queue page. */
export function ApprovalsPage() {
  return (
    <div className="content space-y-6">
      <div className="heading">
        <div>
          <div className="eyebrow accent">UC-05 · UC-07 · HUMAN-IN-THE-LOOP</div>
          <h1>Phê duyệt truy vấn &amp; Kế hoạch</h1>
          <p>Hàng đợi duyệt kế hoạch phân tích nguyên nhân (RCA) và truy vấn chi phí cao.</p>
        </div>
        <ShieldCheck className="heading-icon size-8" aria-hidden="true" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Hàng đợi phê duyệt</CardTitle>
          <CardDescription>
            Khi LangGraph tạm dừng tại <code>interrupt()</code> cho UC-05 hoặc UC-07, yêu cầu cần duyệt sẽ hiển thị tại đây.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Chưa có yêu cầu nào đang chờ phê duyệt.</p>
        </CardContent>
      </Card>
    </div>
  );
}
