import React, { useState } from 'react';
import { Layout as AntLayout, Menu, Button, Typography, Avatar, Dropdown, Alert, message, Space } from 'antd';
import {
  RobotOutlined, BookOutlined, CalendarOutlined, MessageOutlined,
  SettingOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  UserOutlined, CommentOutlined, WhatsAppOutlined, InboxOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

const { Header, Sider, Content } = AntLayout;
const { Text } = Typography;

const BRAND_BG = '#031a18';
const BRAND_PRIMARY = '#0d9488';

export default function Layout({ children }: { children: React.ReactNode }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.getMe });
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: api.getConnections });

  // Gate: until the negócio has at least one WhatsApp connected, the rest is locked.
  const configured = connections.length > 0;

  const menuItems = [
    { key: '/connections', icon: <WhatsAppOutlined />, label: 'WhatsApp' },
    { key: '/agents', icon: <RobotOutlined />, label: 'Agentes', disabled: !configured },
    { key: '/knowledge', icon: <BookOutlined />, label: 'Conhecimento', disabled: !configured },
    { key: '/scheduled-posts', icon: <CalendarOutlined />, label: 'Postagens agendadas', disabled: !configured },
    { key: '/conversations', icon: <MessageOutlined />, label: 'Conversas', disabled: !configured },
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

  const userMenu = {
    items: [
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
          <CommentOutlined style={{ fontSize: 22, color: BRAND_PRIMARY, flexShrink: 0 }} />
          {!collapsed && (
            <span style={{ color: '#fff', fontSize: 18, fontWeight: 800, letterSpacing: 0.5, lineHeight: 1 }}>
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
              <Avatar size={28} style={{ background: BRAND_PRIMARY }} icon={<UserOutlined />} />
              <Text style={{ fontSize: 13 }}>{me?.email ?? '…'}</Text>
            </div>
          </Dropdown>
          </Space>
        </Header>

        <Content style={{ margin: 24, background: '#f5f5f5', borderRadius: 8, padding: 24, minHeight: 360 }}>
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
