import React, { useState } from 'react';
import { Layout as AntLayout, Menu, Button, Typography, Avatar, Dropdown } from 'antd';
import {
  RobotOutlined, BookOutlined, CalendarOutlined, MessageOutlined,
  SettingOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, UserOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

const { Header, Sider, Content } = AntLayout;
const { Text } = Typography;

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
        style={{ background: '#001529' }}
      >
        <div style={{
          color: '#fff',
          padding: collapsed ? '16px 8px' : '16px 20px',
          fontSize: collapsed ? 14 : 17,
          fontWeight: 700,
          borderBottom: '1px solid #ffffff20',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}>
          {collapsed ? 'S' : 'Stack MCP'}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[loc.pathname]}
          items={menuItems}
          onClick={({ key }) => nav(key)}
        />
      </Sider>

      <AntLayout>
        <Header style={{
          padding: '0 16px 0 24px',
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <Avatar size="small" icon={<UserOutlined />} />
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
