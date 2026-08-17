import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    // ⚠ 用 threads 而不是默认的 forks：对拍当时是单文件 42586 个用例，worker 要为每个用例
    // 向主进程发一次 onTaskUpdate。forks 走进程间 IPC，CI 上会超时——表现是
    // `[vitest-worker]: Timeout calling "onTaskUpdate"`，而**全部用例其实都通过了**
    // （第一次失败的日志里明写着 `Tests 42874 passed` + `Errors 1 error`）。
    // threads 走 MessageChannel，同一进程内传递，量级完全不同。
    // ⚠ 走了三轮弯路才定位：dot reporter 的进度点会把报错冲掉，于是每次都误判成内存问题
    // （先后怀疑过 reporter、V8 堆上限、worker 并发峰值，三次都不对）。
    // ⚠ 第四十八批把对拍拆成了 16 个文件（`test/helpers/trace-slices.ts`），单文件最多
    // 3975 个用例——`threads` 从此不再是承重墙，但**别换回 forks**：换回去只是把同一颗雷
    // 的引信调长，而 threads 这边还白拿了「16 片共享一个进程」的内存与墙钟收益。
    pool: "threads",
    // ⚠ 与 CI runner 的 4 vCPU 对齐，让本地量到的峰值 RSS 与 CI 可比。
    // 实测（拆成 16 片之后，`/usr/bin/time -l` 全量）：4 worker 峰值 1.82GB / 13.8s，
    // 1 worker 0.81GB / 36.3s。拆之前这个旋钮**毫无作用**（2.70GB vs 2.73GB），
    // 因为那时全部语料在同一个文件里，并发与否都得有一个 isolate 扛下 2.1GB 堆。
    maxWorkers: 4,
  },
});
