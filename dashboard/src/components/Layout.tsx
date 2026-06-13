import React, { useState } from 'react';
import { Layout as AntLayout, Menu, Button, Typography, Avatar, Dropdown } from 'antd';
import {
  RobotOutlined, BookOutlined, CalendarOutlined, MessageOutlined,
  SettingOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  UserOutlined, WhatsAppOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

const { Header, Sider, Content } = AntLayout;
const { Text } = Typography;

// Vendly brand green (dark sidebar variant)
const BRAND_BG = '#0a1f0a';
const BRAND_GREEN = '#25d366';

const menuItems = [
  { key: '/agents', icon: <RobotOutlined />, label: 'Agentes' },
  { key: '/knowledge', icon: <BookOutlined />, label: 'Base de conhecimento' },
  { key: '/scheduled-posts', icon: <CalendarOutlined />, label: 'Postagens agendadas' },
  { key: '/conversations', icon: <MessageOutlined />, label: 'Conversas' },
  { key: '/settings', icon: <SettingOutlined />, label: 'Configurações' },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.getMe });

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
          <WhatsAppOutlined style={{ fontSize: 22, color: BRAND_GREEN, flexShrink: 0 }} />
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
          <Dropdown menu={userMenu} placement="bottomRight">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '4px 8px', borderRadius: 8, transition: 'background 0.2s' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f5')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <Avatar size={28} style={{ background: BRAND_GREEN }} icon={<UserOutlined />} />
              <Text style={{ fontSize: 13 }}>{me?.email ?? '…'}</Text>
            </div>
          </Dropdown>
        </Header>

        <Content style={{ margin: 24, background: '#f5f5f5', borderRadius: 8, padding: 24, minHeight: 360 }}>
          {children}
        </Content>
      </AntLayout>
    </AntLayout>
  );
}
