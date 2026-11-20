import { Agent } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 預設只聽本機；`startserver.bat lan` 設 CHERUNO_HOST=0.0.0.0，讓同一個區網的平板用 http://<電腦IP>:5173 連。
// 從 iPad 開啟時 app 把本機服務的請求改走下面的轉送（src/remote.ts）。轉送目標可用環境變數改（隔離測試用另一組埠）
const AUDIO = process.env.CHERUNO_AUDIO_TARGET ?? 'http://127.0.0.1:8790';
const LMS = process.env.CHERUNO_LMS_TARGET ?? 'http://127.0.0.1:1234';
// 連線重用，但閒置 2 秒就由這邊先關：uvicorn 閒置 5 秒會關連線，轉送若剛好重用那條就 ECONNRESET → 502；
// 每次開新連線（keepAlive: false）在 Windows 上 uvicorn 收尾時會出錯、偶爾卡住（2026-11-20 兩種都實測過）
const agent = new Agent({ keepAlive: true, timeout: 2000 });

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.CHERUNO_HOST ?? '127.0.0.1',
    port: 5173,
    strictPort: true,
    allowedHosts: ['.ts.net'], // IP 位址本來就允許；另外允許 Tailscale 的 MagicDNS 名稱
    proxy: {
      '/audio': { target: AUDIO, changeOrigin: true, agent, rewrite: (p) => p.replace(/^\/audio/, '') },
      '/lms': { target: LMS, changeOrigin: true, agent, rewrite: (p) => p.replace(/^\/lms/, '') },
    },
  },
});
