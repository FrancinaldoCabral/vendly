import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, Typography, Spin, Result, Alert, Form, Input, Button } from 'antd';
import { CommentOutlined } from '@ant-design/icons';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { brand, gradientText } from '../lib/theme';

const { Title, Text } = Typography;

const BRAND_PRIMARY = brand.primary;

export default function Login() {
  const [params] = useSearchParams();
  const { login, token } = useAuth();
  const nav = useNavigate();
  const [exchanging, setExchanging] = useState(false);
  const [exchangeError, setExchangeError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState('');

  // Redirect if already authenticated
  useEffect(() => {
    if (token) nav('/agents', { replace: true });
  }, [token, nav]);

  // Exchange magic-link token from URL (backward compat)
  useEffect(() => {
    const magicToken = params.get('token');
    if (!magicToken) return;
    setExchanging(true);
    api.exchangeMagicToken(magicToken)
      .then(({ token: t }) => { login(t); nav('/agents', { replace: true }); })
      .catch((e: Error) => { setExchangeError(e.message); setExchanging(false); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleLogin({ email, password }: { email: string; password: string }) {
    setSubmitting(true);
    setLoginError('');
    try {
      const { token: t } = await api.login(email.trim(), password);
      login(t);
      nav('/agents', { replace: true });
    } catch (e) {
      setLoginError((e as Error).message);
      setSubmitting(false);
    }
  }

  // Exchanging magic token state
  if (exchanging) {
    return (
      <LoginShell>
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <Spin size="large" />
          <Text type="secondary" style={{ display: 'block', marginTop: 16 }}>Autenticando…</Text>
        </div>
      </LoginShell>
    );
  }

  if (exchangeError) {
    return (
      <LoginShell>
        <Alert type="error" message="Link inválido ou expirado" description={exchangeError} showIcon />
      </LoginShell>
    );
  }

  return (
    <LoginShell>
      {loginError && (
        <Alert
          type="error"
          message={loginError}
          showIcon
          closable
          onClose={() => setLoginError('')}
          style={{ marginBottom: 20 }}
        />
      )}
      <Form layout="vertical" onFinish={handleLogin} requiredMark={false}>
        <Form.Item
          name="email"
          label="Email"
          rules={[{ required: true, message: 'Informe seu email' }, { type: 'email', message: 'Email inválido' }]}
        >
          <Input size="large" placeholder="seu@email.com" type="email" autoComplete="email" autoFocus />
        </Form.Item>
        <Form.Item
          name="password"
          label="Senha"
          rules={[{ required: true, message: 'Informe sua senha' }]}
          style={{ marginBottom: 24 }}
        >
          <Input.Password size="large" placeholder="••••••••" autoComplete="current-password" />
        </Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          block
          size="large"
          loading={submitting}
          style={{ background: brand.gradient, borderColor: 'transparent', fontWeight: 700 }}
        >
          Entrar
        </Button>
      </Form>
      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 20, textAlign: 'center' }}>
        Use o email e senha da sua conta em{' '}
        <a href="https://redatudo.online" target="_blank" rel="noreferrer" style={{ color: BRAND_PRIMARY }}>
          redatudo.online
        </a>
      </Text>
    </LoginShell>
  );
}

function LoginShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: `radial-gradient(circle at 50% 0%, rgba(124,58,237,0.18) 0%, transparent 55%), ${brand.bgDark}`,
      fontFamily: brand.fontBody,
    }}>
      <Card
        style={{ width: 420, borderRadius: 20, border: `1px solid ${brand.border}`, boxShadow: '0 20px 60px #00000060' }}
        styles={{ body: { padding: 48 } }}
      >
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 18, background: brand.gradient,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px', boxShadow: '0 12px 28px rgba(124,58,237,0.4)',
          }}>
            <CommentOutlined style={{ fontSize: 34, color: '#fff' }} />
          </div>
          <Title level={2} style={{ ...gradientText, margin: 0, fontWeight: 800, fontFamily: brand.fontHeading }}>vendly</Title>
          <Text type="secondary" style={{ fontSize: 14 }}>Plataforma de agentes WhatsApp</Text>
        </div>
        {children}
      </Card>
    </div>
  );
}
