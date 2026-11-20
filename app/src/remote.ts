// 從別台裝置連進來（iPad 經區網 http://<電腦IP>:5173，使用者 2026-11-20）：設定裡的服務位址都是這台電腦的 127.0.0.1／localhost，
// 在 iPad 上那是 iPad 自己。所以從遠端開啟時，送往這台電腦本機服務的請求改走同一個網址底下的轉送路徑
// （vite.config.ts 的 server.proxy：/audio → 音訊服務 :8790、/lms → LM Studio :1234）。存檔、設定、語音庫都在電腦的存檔區，兩邊讀寫同一份。
// 在電腦上開（網址是 localhost／127.0.0.1）什麼都不改。
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
export const ROUTES: Record<string, string> = { '8790': '/audio', '1234': '/lms' };

export const isRemote = () => !LOOPBACK.test(location.hostname);

/** 指向這台電腦本機服務的網址 → 同一個網址底下的轉送路徑；其他網址（雲端 API）原樣 */
export function viaOrigin(url: string): string {
  if (!isRemote() || !/^https?:\/\//i.test(url)) return url;
  const u = new URL(url);
  const prefix = LOOPBACK.test(u.hostname) ? ROUTES[u.port] : undefined;
  return prefix ? `${location.origin}${prefix}${u.pathname}${u.search}` : url;
}

/** 啟動時裝一次：所有 fetch 都經過這裡改寫（音訊服務、存檔區、LM Studio、Claude 轉接都是 fetch） */
export function installRemoteFetch() {
  if (!isRemote()) return;
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') return orig(viaOrigin(input), init);
    if (input instanceof URL) return orig(viaOrigin(input.href), init);
    const to = viaOrigin(input.url);
    return orig(to === input.url ? input : new Request(to, input), init);
  };
}
