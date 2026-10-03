/** Nhóm tool của Pi, dùng chung cho chính sách, luật permission và Jev. */
export const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const WRITE_TOOLS = new Set(["edit", "write"]);
/** Tool chạy lệnh shell: bash, bg_run (chạy nền) và powershell (Windows, không qua bộ phân tích kiểu sh). */
export const SHELL_TOOLS = new Set(["bash", "bg_run", "powershell"]);
