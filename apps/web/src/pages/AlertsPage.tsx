import { BellRing } from "lucide-react";
import { AlertsView } from "@/components/AlertsView";

/** UC-10 anomaly detection & scheduled alerts workspace page. */
export function AlertsPage() {
  return (
    <div className="content space-y-6">
      <div className="heading">
        <div>
          <div className="eyebrow accent">UC-10 · PROACTIVE MONITORING</div>
          <h1>Cảnh báo bất thường</h1>
          <p>Theo dõi biến động chỉ số và kích hoạt quét thủ công theo ngày.</p>
        </div>
        <BellRing className="heading-icon size-8" aria-hidden="true" />
      </div>
      <AlertsView />
    </div>
  );
}
