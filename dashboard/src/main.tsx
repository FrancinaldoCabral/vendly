import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import App from './App';
import { brand } from './lib/theme';

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ConfigProvider
        theme={{
          token: {
            colorPrimary: brand.primary,
            colorLink: brand.blue,
            colorLinkHover: brand.blueLight,
            fontFamily: brand.fontBody,
            borderRadius: 10,
          },
          components: {
            // Sidebar escura no estilo Redatudo
            Menu: {
              darkItemBg: brand.bgDark,
              darkSubMenuItemBg: brand.bgDark,
              darkItemSelectedBg: brand.primary,
              darkItemHoverBg: 'rgba(167,139,250,0.15)',
              darkItemColor: '#D1D5DB',
              darkItemSelectedColor: '#FFFFFF',
            },
            Layout: {
              siderBg: brand.bgDark,
              triggerBg: brand.bgDark,
            },
          },
        }}
      >
        <App />
      </ConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
