# Hướng dẫn chạy dự án trên Windows

Hướng dẫn này dùng PowerShell trong VS Code. Mỗi terminal bên dưới đều bắt đầu ở thư mục gốc của dự án; thay đường dẫn trong ví dụ nếu bạn đặt dự án ở nơi khác. Không cần chạy lại các lệnh cài đặt mỗi lần mở dự án.

## Chuẩn bị lần đầu

- Cài Node.js 24 trở lên, Corepack và Docker Desktop. Mở Docker Desktop và đợi Docker khởi động xong.
- Trong PowerShell, mở thư mục dự án và cài dependency:

  ```powershell
  cd D:\2.Study\SE373.AI\do-an\SE373-Analytics-Agent
  corepack pnpm install --frozen-lockfile
  ```

- Tạo `.env` từ `.env.example` **chỉ khi chưa có `.env`**:

  ```powershell
  if (-not (Test-Path .env)) { Copy-Item .env.example .env }
  ```

  Không ghi đè `.env` sẵn có, chia sẻ key hoặc commit file này.
- Mở `.env` và kiểm tra các URL `OWNER_DATABASE_URL`, `AGENT_RO_DATABASE_URL`, `INDEXER_DATABASE_URL`, `HARNESS_STATE_DATABASE_URL`. Các giá trị mẫu khớp cấu hình Docker mặc định dành riêng cho máy local. Không sử dụng mật khẩu mẫu trong môi trường triển khai.
- Bỏ dấu `#` và đặt các token riêng, khác nhau cho `MCP_TOKEN_SALES_SOUTH`, `MCP_TOKEN_MARKETING`, `MCP_TOKEN_HR` và `MCP_TOKEN_ADMIN`. Chạy lệnh sau bốn lần, sao chép mỗi kết quả vào một biến trong `.env` và không chia sẻ các giá trị đó:

  ```powershell
  node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
  ```

- Nếu dùng 9Router làm nhà cung cấp model, chạy 9Router riêng và cấu hình các biến `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_API_KEY`, `AGENT_MODEL_ID` phù hợp. Ví dụ base URL cục bộ thường là `http://127.0.0.1:20128/v1`; hãy dùng địa chỉ thực tế do 9Router của bạn cung cấp. Model cần hỗ trợ định dạng JSON mà ứng dụng yêu cầu. Khi không đặt `AGENT_MODEL_API_KEY`, tracer dùng model giả định sẵn để thử nghiệm, không gọi AI thật.

## Các bước khởi động

### 1. Database

Mở Docker Desktop, sau đó chạy trong một terminal:

```powershell
cd D:\2.Study\SE373.AI\do-an\SE373-Analytics-Agent
corepack pnpm db:up
docker compose -f docker/docker-compose.yml ps
```

Kiểm tra dịch vụ `db` có trạng thái `healthy`. Lệnh `db:up` giữ lại dữ liệu đã lưu. Đừng chạy `corepack pnpm db:reset` nếu không muốn xóa volume database.

Chỉ với database mới, trống và cần dữ liệu mẫu, chạy lệnh sau từ thư mục gốc (cần Internet; có thể mất vài phút):

```powershell
node --env-file=.env --import tsx packages/data/src/load.ts
node --env-file=.env --import tsx packages/data/src/verify.ts
```

Không cần nạp lại mỗi lần chạy. Với database đang có dữ liệu, không tự ý nạp lại hoặc reset; tham khảo [README chính](../README.md) trước khi thay đổi dữ liệu.

### 2. Build

Trong terminal ở thư mục gốc:

```powershell
corepack pnpm build
```

Chạy khi thiết lập lần đầu và sau khi thay đổi code backend hoặc các package dùng chung. Nếu API/MCP đang chạy khi build, khởi động lại tiến trình liên quan để nạp code mới.

### 3. MCP server

Mở một terminal PowerShell mới và giữ terminal đó mở:

```powershell
cd D:\2.Study\SE373.AI\do-an\SE373-Analytics-Agent
node --env-file=.env --import tsx packages/mcp-server/src/server.ts
```

### 4. Backend API

Mở một terminal PowerShell mới và giữ terminal đó mở:

```powershell
cd D:\2.Study\SE373.AI\do-an\SE373-Analytics-Agent
node --env-file=.env --import tsx apps/api/src/index.ts
```

### 5. Frontend

Mở một terminal PowerShell mới và giữ terminal đó mở:

```powershell
cd D:\2.Study\SE373.AI\do-an\SE373-Analytics-Agent
corepack pnpm --filter @shared/web dev
```

Mở địa chỉ Vite in ra, thường là <http://127.0.0.1:5173>. Nếu dùng 9Router, dịch vụ này cũng phải đang chạy trong lúc gửi câu hỏi.

## Kiểm tra và xử lý lỗi

- API: mở <http://127.0.0.1:3001/healthz>; MCP: mở <http://127.0.0.1:8081/healthz>. Nếu bạn đổi cổng trong `.env`, dùng cổng đã cấu hình. Hai trang này trả HTTP 200 chỉ cho biết dịch vụ tương ứng có phản hồi, **không** đảm bảo model hoặc mọi phụ thuộc đã hoạt động.
- `Connection error.` sau khi gửi câu hỏi có thể do API không kết nối được nhà cung cấp model. Nếu cấu hình dùng 9Router cục bộ, kiểm tra 9Router đang chạy, base URL và cổng có đúng, rồi thử lại. Cũng xem thông báo trong terminal API; không chia sẻ key hoặc token.
- Lỗi quota/rate limit nghĩa là nhà cung cấp model đang giới hạn lượt gọi hoặc hết hạn mức; kiểm tra dashboard của nhà cung cấp hoặc chọn model còn hạn mức.
- Lỗi model không trả JSON đúng định dạng có thể do model/provider không tuân theo structured output; kiểm tra khả năng hỗ trợ của model và cấu hình provider. API hiện dùng luồng tracer demo, không phải toàn bộ luồng phân tích UC-01.
- Nếu gặp lỗi cổng đang được sử dụng, kiểm tra terminal cũ trước khi khởi động thêm một bản. Chỉ nhấn `Ctrl+C` trong terminal của tiến trình muốn dừng; không đóng các terminal còn cần dùng. Docker container vẫn chạy nền sau khi đóng terminal khởi động nó.
