import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    // ⚠ 用 threads 而不是默认的 forks：对拍单文件 42586 个用例，worker 要为每个用例
    // 向主进程发一次 onTaskUpdate。forks 走进程间 IPC，CI 上会超时——表现是
    // `[vitest-worker]: Timeout calling "onTaskUpdate"`，而**全部用例其实都通过了**
    // （第一次失败的日志里明写着 `Tests 42874 passed` + `Errors 1 error`）。
    // threads 走 MessageChannel，同一进程内传递，量级完全不同。
    // ⚠ 走了三轮弯路才定位：dot reporter 的进度点会把报错冲掉，于是每次都误判成内存问题
    // （先后怀疑过 reporter、V8 堆上限、worker 并发峰值，三次都不对）。
    pool: "threads",
    maxWorkers: 4,
  },
});
