import React, { useState } from 'react';
import { Layout as AntLayout, Menu, Button, Typography, Avatar, Dropdown, Alert, message, Space } from 'antd';
import {
  BookOutlined, CalendarOutlined,
  SettingOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  UserOutlined, CommentOutlined, WhatsAppOutlined, InboxOutlined, IdcardOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { brand, gradientText } from '../lib/theme';

const { Header, Sider, Content } = AntLayout;
const { Text } = Typography;

const BRAND_BG = brand.bgDark;

export default function Layout({ children }: { children: React.ReactNode }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.getMe });
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: api.getConnections });
  const { data: health } = useQuery({ queryKey: ['provisioning-health'], queryFn: api.getProvisioningHealth, refetchInterval: 60_000 });

  // Gate: until the negócio has at least one WhatsApp connected, the rest is locked.
  const configured = connections.length > 0;

  const menuItems = [
    { key: '/connections', icon: <WhatsAppOutlined />, label: 'WhatsApp e agentes' },
    { key: '/knowledge', icon: <BookOutlined />, label: 'Conhecimento', disabled: !configured },
    { key: '/scheduled-posts', icon: <CalendarOutlined />, label: 'Postagens agendadas', disabled: !configured },
    { key: '/settings', icon: <SettingOutlined />, label: 'Configurações' },
  ];

  const openCrm = async () => {
    try {
      const { url } = await api.getCrmLink();
      window.open(url, '_blank', 'noopener');
    } catch {
      message.error('Não foi possível abrir a Central de Conversas agora. Tente novamente.');
    }
  };

  const copyAccountId = async () => {
    if (!me?._id) return;
    try { await navigator.clipboard.writeText(me._id); message.success('ID da conta copiado!'); }
    catch { message.info(me._id); }
  };

  const userMenu = {
    items: [
      {
        key: 'accountId',
        icon: <IdcardOutlined />,
        label: <span style={{ fontSize: 12 }}>ID da conta: <Text copyable={false} style={{ fontFamily: 'monospace', fontSize: 12 }}>{me?._id ?? '—'}</Text></span>,
        onClick: copyAccountId,
      },
      { type: 'divider' as const },
      {
        key: 'logout',
        icon: <LogoutOutlined />,
        label: 'Sair',
        danger: true,
        onClick: () => { logout(); nav('/login'); },
      },
    ],
  };

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        trigger={null}
        width={220}
        style={{ background: BRAND_BG }}
      >
        {/* Logo */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: collapsed ? 0 : 10,
          justifyContent: collapsed ? 'center' : 'flex-start',
          padding: collapsed ? '18px 0' : '14px 20px',
          borderBottom: '1px solid #ffffff15',
          overflow: 'hidden',
          cursor: 'pointer',
        }} onClick={() => nav('/')}>
          <div style={{
            width: 32, height: 32, borderRadius: 9, background: brand.gradient,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <CommentOutlined style={{ fontSize: 18, color: '#fff' }} />
          </div>
          {!collapsed && (
            <span style={{ ...gradientText, fontFamily: brand.fontHeading, fontSize: 20, fontWeight: 800, letterSpacing: 0.3, lineHeight: 1 }}>
              vendly
            </span>
          )}
        </div>

        <Menu
          mode="inline"
          selectedKeys={[loc.pathname]}
          items={menuItems}
          onClick={({ key }) => nav(key)}
          style={{ background: BRAND_BG, borderRight: 0 }}
          theme="dark"
        />
      </Sider>

      <AntLayout>
        <Header style={{
          padding: '0 20px 0 20px',
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          boxShadow: '0 1px 4px #0001',
        }}>
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
          />
          <Space>
          <Button icon={<InboxOutlined />} onClick={openCrm}>Central de Conversas</Button>
          <Dropdown menu={userMenu} placement="bottomRight">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '4px 8px', borderRadius: 8, transition: 'background 0.2s' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f5')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <Avatar size={28} style={{ background: brand.gradient }} icon={<UserOutlined />} />
              <Text style={{ fontSize: 13 }}>{me?.email ?? '…'}</Text>
            </div>
          </Dropdown>
          </Space>
        </Header>

        <Content style={{ margin: 24, background: '#f5f5f5', borderRadius: 8, padding: 24, minHeight: 360 }}>
          {health && !health.healthy && loc.pathname !== '/settings' && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="Há itens de configuração pendentes"
              description="Alguns provisionamentos não foram concluídos. Vá em Configurações e clique em Resolver para corrigir automaticamente."
              action={<Button type="primary" size="small" onClick={() => nav('/settings')}>Resolver</Button>}
            />
          )}
          {!configured && loc.pathname !== '/connections' && loc.pathname !== '/settings' && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="Configure seu negócio para começar"
              description="Conecte um WhatsApp para liberar os agentes, o conhecimento e as conversas."
              action={<Button type="primary" size="small" onClick={() => nav('/connections')}>Conectar WhatsApp</Button>}
            />
          )}
          {children}
        </Content>
      </AntLayout>
    </AntLayout>
  );
}
