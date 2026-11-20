import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Root.tsx';
import { installRemoteFetch } from './remote.ts';
import './styles.css';

installRemoteFetch(); // iPad 經 Tailscale 連進來時，本機服務的請求改走同網址的轉送

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
