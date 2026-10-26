# Hướng dẫn cho nhóm — bàn giao harness (SE373 Analytics Agent)

Tài liệu này dành cho các thành viên nhận UC. Đọc hết một lần (khoảng 15 phút)
trước khi viết code. Phần kỹ thuật chi tiết nằm ở `docs/architecture.md` (tiếng Anh).

> Cập nhật: 25/10/2026 · Người viết: HungPham-VNU (UC-09)

---

## 1. Hiện trạng dự án

Nhóm đang làm milestone **v1.0 — Shared Agent Harness**: phần "khung" mà mọi UC
cắm vào (repo, contracts dùng chung, CSDL chỉ-đọc, cổng MCP `db-tools`, khung
agent LangGraph, trace/eval). Logic riêng của từng UC **không** nằm trong
milestone này — mỗi người tự làm trên khung có sẵn.

| Phase | Nội dung | Trạng thái |
|---|---|---|
| 1 | Monorepo + contracts dùng chung (`@se373/contracts`), CI, cấm import DB | ✅ Xong (PR #10) |
| 2 | Postgres 16 + pgvector, 3 role, nạp dữ liệu Olist Việt hoá, kịch bản cài sẵn | ⏳ Chưa làm — **cần người nhận** |
| 3 | SQL guard (`@se373/sql-guard`) + executor chỉ-đọc + seam `AccessPolicy` | ✅ Xong (nhánh `feat/phase-3-sql-guard`) |
| 4 | MCP server `db-tools`: 5 tool, xác thực token + scope, audit log | ⏳ Chờ Phase 2 (UC-09) |
| 5 | Khung agent LangGraph.js: state, checkpointer, MCP client, chỗ cắm UC | ⏳ Chờ Phase 4 |
| 6 | Trace JSONL che PII, chấm EX, `pnpm eval`, bộ case tấn công, mẫu skill | ⏳ Làm được ngay |
| 7 | Nối end-to-end, khung web/api, tài liệu, OpenWiki | ⏳ Cuối cùng |

**Nhánh và PR:**
- PR **#10** (`feat/agent-harness-architecture` → `main`): kế hoạch + Phase 1. Cần 1 người review rồi merge.
- Nhánh `feat/phase-3-sql-guard`: Phase 3, xếp chồng lên PR #10 — mở PR sau khi #10 được merge.
- Sau khi cả hai vào `main`, mọi người **tạo nhánh mới từ `main`**.

---

## 2. Đọc gì, theo thứ tự nào

| # | File | Đọc để biết |
|---|---|---|
| 1 | `docs/prd.md` §1.5, §2, §4 | Luật bắt buộc của đề tài (vi phạm = 0 điểm UC), yêu cầu CSDL, harness chung |
| 2 | `docs/UC-plan/UCxx.md` của bạn | Kế hoạch UC của chính bạn |
| 3 | `docs/architecture.md` | Kiến trúc: các tầng, ai được import ai, contracts, **§8 — code UC của bạn đặt ở đâu** |
| 4 | `packages/contracts/src/*.ts` + `docs/mcp_interface.md` | Hình dạng dữ liệu chung: 5 tool, 11 mã lỗi, `SQLAnswer`, trace event |
| 5 | `packages/contracts/README.md` | Luật sửa contracts (chỉ được thêm) |
| 6 | `.planning/ROADMAP.md` + `.planning/REQUIREMENTS.md` | Phase nào làm gì, tiêu chí "xong" |
| 7 | (tuỳ chọn) `.planning/research/ARCHITECTURE.md`, `PITFALLS.md` | Lý do thiết kế, các bẫy thường gặp |

---

## 3. Cài đặt môi trường

Yêu cầu: **Node ≥ 24**, **pnpm 11.25.0**, **Docker** (cho Phase 2 trở đi).

```sh
# Node 24 (qua nvm)
nvm install 24 && nvm use 24

# pnpm đúng phiên bản (repo đã ghim trong package.json)
corepack enable
corepack prepare pnpm@11.25.0 --activate

# Cài và kiểm tra
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test
```

- Tất cả phải **xanh**. Hiện có 1 file test bị **skip** (`db.live.test.ts`) — đúng
  thiết kế: nó chỉ chạy khi có `DATABASE_URL` (sau Phase 2).
- Docker trên Linux: sau khi `sudo usermod -aG docker $USER` phải **đăng xuất/đăng
  nhập lại**, nếu không sẽ báo `permission denied` (tạm thời dùng `sg docker -c "docker …"`).
- `.env`: copy từ `.env.example`, **không bao giờ commit `.env`**.

Lệnh hay dùng:

| Lệnh | Việc |
|---|---|
| `pnpm --filter @se373/<pkg> test` | Test một package (`contracts`, `sql-guard`, `mcp-server`, `access-policy`, `agent`, `api`, `web`) |
| `pnpm docs:interface` | Sinh lại `docs/mcp_interface.md` từ contracts (không sửa tay file này) |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Kiểm tra toàn repo (CI chạy đúng 3 lệnh này + quét secret) |

---

## 4. Quy trình làm việc

1. **Mỗi việc một nhánh** từ `main`: `feat/uc01-...`, `feat/phase-2-db`, …
   Không push thẳng lên `main` (đã khoá).
2. **Commit nhỏ, rõ ràng**: `feat(uc01): ...`, `test(uc02): ...`, `docs: ...`.
3. **Mở PR vào `main`**. CI phải xanh 4 job: `typecheck`, `lint`, `test`, `secrets`.
   Cần **1 code-owner duyệt**.
4. **CODEOWNERS**: trong PR đầu tiên, sửa `.github/CODEOWNERS` — thay dòng
   `# TODO(UC-xx owner)` bằng GitHub handle của bạn cho thư mục bạn phụ trách.
5. **Sửa contracts** (`packages/contracts`): chỉ **thêm** (field optional mới,
   schema mới) → 1 người duyệt. **Xoá / đổi tên / siết kiểu / đổi enum hoặc mã lỗi**
   là thay đổi phá vỡ → tăng `CONTRACTS_VERSION` + **tất cả** chủ UC bị ảnh hưởng
   phải đồng ý. Tên field dùng camelCase.

---

## 5. Luật bắt buộc (vi phạm = UC bị 0 điểm)

- **Agent chỉ được đọc DB qua MCP `db-tools`.** Không import `pg`, `pg-cursor` hay
  `@se373/mcp-server` từ `packages/agent` hoặc `apps/*` — ESLint sẽ chặn, CI fail.
- **Chặn ở tầng code, không chỉ ở prompt**: role `agent_ro` chỉ có quyền `SELECT`;
  mọi SQL đi qua `sqlGuard` trên server.
- **Không dùng dữ liệu thật**: tên, SĐT, email, địa chỉ, lương đều sinh bằng Faker (vi).
- **Không dùng sản phẩm text-to-SQL/BI có sẵn** (Vanna hosted, Copilot, Genie, …).
- **Gold SQL, kết quả chuẩn, `data/seeded_scenarios.md` phải giấu khỏi agent** —
  không đưa vào prompt, few-shot hay semantic layer.
- **Không commit secret** (`.env`, API key) — CI có gitleaks.
- Ngôn ngữ: **TypeScript** (UC-05 cần chuyển kế hoạch từ Python/Pydantic sang TS/zod).

---

## 6. Cách code

### 6.1. Dùng contracts

```ts
import {
  RunQueryInputSchema, type RunQueryOutput,
  SQLAnswerSchema, type SQLAnswer,
  dbToolError, type DbToolError,
  TraceEventSchema,
} from "@se373/contracts";

const answer: SQLAnswer = SQLAnswerSchema.parse(raw); // luôn parse output của LLM
```

Lỗi luôn là một trong 11 mã: `UNAUTHORIZED`, `SCOPE_DENIED`, `INVALID_PARAMS`,
`INVALID_SQL`, `FORBIDDEN_STATEMENT`, `FORBIDDEN_FUNCTION`, `UNKNOWN_TABLE`,
`SENSITIVE_COLUMN_DENIED`, `TIMEOUT`, `RATE_LIMITED`, `INTERNAL_ERROR`
(kèm cờ `retryable`). Kết quả bị cắt **không phải lỗi** — là `truncated: true`.

### 6.2. Kiểm tra SQL trước khi gửi (UC-01, UC-05, UC-10)

`@se373/sql-guard` là package thuần (không có driver DB) — agent được import để
tự kiểm tra trước; server vẫn kiểm tra lại độc lập.

```ts
import { warmupSqlGuard, sqlGuard } from "@se373/sql-guard";
import type { SchemaCatalog } from "@se373/contracts";

await warmupSqlGuard();                       // gọi 1 lần lúc khởi động
const result = await sqlGuard(sql, catalog);  // catalog: { tables: { orders: ["id", ...] } }
if (!result.ok) {
  // result.error: DbToolError — ví dụ FORBIDDEN_STATEMENT, UNKNOWN_TABLE
}
```

Guard chặn: nhiều câu lệnh, mọi DDL/DML (kể cả DML trong CTE), `SELECT INTO`,
`FOR UPDATE`, hàm nguy hiểm (`pg_sleep`, `pg_read_file`, `dblink`, `lo_*`, …),
schema hệ thống, bảng/cột không có trong catalog. Có 82 test mẫu trong
`packages/sql-guard/test/guard.test.ts` — xem để biết hành vi.

### 6.3. Code của bạn đặt ở đâu

| UC | Thư mục | Việc chính |
|---|---|---|
| UC-01 text-to-SQL | `packages/agent/src/subgraphs/uc01*`, `skills/text-to-sql/`, `evals/uc01/` | sinh SQL → kiểm tra → chạy → tự sửa (≤ 3 lần); bộ ≥ 30 câu hỏi chuẩn |
| UC-02 semantic layer | `semantic/*.yaml`, `packages/agent/src/semantic/*`, `evals/uc02/` | kho tri thức, indexer, retriever hybrid, kiểm tra citation |
| UC-05 tìm nguyên nhân | `packages/agent/src/subgraphs/uc05*`, `skills/root-cause-analysis/`, `evals/uc05/` | lập kế hoạch → `interrupt` cho người dùng sửa → phân nhánh → quy đóng góp |
| UC-09 db-tools | `packages/mcp-server`, `packages/access-policy`, `policies/` | 5 tool, scope, che cột, audit (HungPham-VNU) |
| UC-10 cảnh báo | graph riêng trong `packages/agent`, `skills/anomaly-alert/`, `evals/uc10/` | đăng ký chỉ số, phát hiện bất thường (code), drill-down, gửi cảnh báo chống trùng |

**Nguyên tắc mở rộng:**
- Chỉ thêm **file của mình**; không sửa node của UC khác. Chỉ chạm vào graph gốc
  để **đăng ký** node/subgraph của bạn.
- Cần truy cập DB kiểu mới → thêm **tool MCP** trong `packages/mcp-server`
  (kèm contract + scope + eval), **không** gọi DB thẳng từ agent.
- Luật quyền mới (UC-08) → viết một `AccessPolicy` mới trong `packages/access-policy`.
- Mỗi UC cần: **≥ 5 eval case** trong `evals/<uc>/`, một `skills/<tên>/SKILL.md`
  (đủ mục PRD §4.2, không chứa script chạy được hay mật khẩu), và trace event đúng
  `TraceEventSchema`.

### 6.4. Test

- Dùng **vitest**, file `test/*.test.ts` trong package của bạn.
- Test không được cần API key (dùng model giả) và không được cần DB, trừ file
  `*.live.test.ts` có `describe.skipIf(!process.env.DATABASE_URL)`.

---

## 7. Việc cần làm ngay — ai làm gì

### 7.1. Việc chung của harness (cần người nhận)

| Việc | Ai | Ghi chú |
|---|---|---|
| **Review + merge PR #10** | 1 code-owner (NDTruongDanh / HungPham-VNU) | Mở khoá cho mọi người |
| **Phase 2 — CSDL + dữ liệu** | **Cần người nhận** (gợi ý: UC-09 làm schema + role; UC-05, UC-10 tự viết dữ liệu cài sẵn của mình) | Docker Compose, 3 role, `pnpm data:load` (Olist → Việt hoá, Faker vi, `order_items` ≥ 1 triệu dòng), ≥ 3 kịch bản biến động (UC-05), ≥ 5 điểm bất thường (UC-10), ≥ 3 dòng chứa chuỗi injection, giấy phép CC BY-NC-SA 4.0 trong README |
| **Phase 6 — trace + eval** | Cần người nhận (gợi ý: UC-01 hoặc UC-02) | Không phụ thuộc DB, làm được ngay |
| Phase 4 — MCP server | HungPham-VNU (UC-09) | Sau Phase 2 |
| Phase 5 — khung agent | Cần người nhận (gợi ý: UC-01) | Sau Phase 4 |

### 7.2. Mỗi UC chuẩn bị song song (không cần chờ harness)

- **UC-01:** soạn bộ **≥ 30 câu hỏi chuẩn** (≥ 10 dễ, ≥ 12 trung bình, ≥ 8 khó,
  ≥ 5 phụ thuộc định nghĩa chỉ số, ≥ 3 không trả lời được) theo `BenchmarkRowSchema`;
  viết `skills/text-to-sql/SKILL.md`.
- **UC-02:** soạn `semantic/*.yaml` — mô tả bảng/cột, **≥ 10 chỉ số** (doanh thu
  thuần, khách hàng hoạt động, AOV, …), luật join, ví dụ few-shot (**khác hoàn
  toàn** bộ câu hỏi chuẩn của UC-01), nhật ký sự kiện.
- **UC-05:** chuyển kế hoạch sang TypeScript/zod; thống nhất 3 kịch bản biến động
  với người làm Phase 2.
- **UC-10:** thống nhất 5 điểm bất thường với người làm Phase 2; viết
  `config/subscriptions.yaml` + `skills/anomaly-alert/SKILL.md`.
- **Tất cả:** liệt kê ≥ 5 eval case cho UC của mình; điền handle vào CODEOWNERS.

---

## 8. (Tuỳ chọn) Dùng GSD để lập kế hoạch và thực thi

Repo dùng **GSD** (`@opengsd/gsd-core`) để quản lý phase. Toàn bộ kế hoạch nằm
trong `.planning/` (đã commit).

```sh
npx @opengsd/gsd-core@latest --claude --global   # hoặc --opencode
```

Rồi trong Claude Code / OpenCode: `/gsd-progress` (xem đang ở đâu),
`/gsd-plan-phase <N>` (lập kế hoạch), `/gsd-execute-phase <N>` (thực thi).
Báo trước trong nhóm phase nào bạn nhận để tránh hai người cùng làm.
Không dùng GSD cũng được — chỉ cần làm đúng `ROADMAP.md` và các mục §4–§6.

---

## 9. Các quyết định nhóm còn mở

1. **Thiếu mảng K7** — bộ UC hiện tại (01, 02, 05, 09, 10) không có K7 → bị trừ
   0,5 điểm. Cần một người nhận **UC-06 (Reviewer agent)** hoặc **UC-03 (biểu đồ +
   insight)**.
2. **UC-05** còn viết theo Python/Pydantic → chuyển sang TypeScript/zod.
3. **Phiên bản Node:** repo bắt buộc Node ≥ 24; tài liệu UC-09/UC-10 còn ghi Node 22 → thống nhất dùng 24.
4. **Người nhận Phase 2 và Phase 6** (xem §7.1).

---

## 10. Hỏi ai

- Kiến trúc, contracts, SQL guard, MCP, CSDL: **HungPham-VNU** (UC-09).
- Review/merge `main`: code-owner trong `.github/CODEOWNERS`.
- Chi tiết kỹ thuật: `docs/architecture.md`; lịch và tiêu chí: `.planning/ROADMAP.md`.
