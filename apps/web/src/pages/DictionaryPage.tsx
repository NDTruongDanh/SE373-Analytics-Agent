import { BookOpen } from "lucide-react";
import { DictionaryAdmin } from "@/components/DictionaryAdmin";

export interface DictionaryPageProps {
  persona: string;
}

/** UC-02 Data Dictionary & Semantic Layer Admin page. */
export function DictionaryPage({ persona }: DictionaryPageProps) {
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

      <DictionaryAdmin persona={persona} />
    </div>
  );
}
