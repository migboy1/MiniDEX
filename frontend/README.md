# DApp 前端起始框架

使用 React、TypeScript 和 Vite，保留基础示例页面，供后续实现 DApp 功能。

## 安装与运行

建议使用 Node.js 24。使用 nvm 时，在 `frontend/` 目录执行：

```bash
nvm install
nvm use
```

也可以自行安装满足 `package.json` 中 `engines` 要求的 Node.js 版本。

首次安装依赖并启动：

```bash
npm ci
npm start
```

访问终端显示的地址（默认 [http://localhost:3000](http://localhost:3000)，端口占用时自动选择其他端口），修改 `src/App.tsx` 即可开始开发。`npm run dev` 与 `npm start` 等效。

## 检查与构建

```bash
npm run typecheck
npm test
npm run build
```

`npm test` 使用 Vitest 执行一次测试；`npm run test:watch` 持续监听修改。测试配置在 `vite.config.ts`，测试示例在 `src/App.test.tsx`。

生产文件输出到 `build/`。执行 `npm run preview`，在 [http://localhost:4173](http://localhost:4173) 本地预览生产构建。

HTML 入口位于 `frontend/index.html`；图片、图标等静态资源放在 `public/`，代码和样式放在 `src/`。
