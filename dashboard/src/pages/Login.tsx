import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, Typography, Spin, Result, Alert, Form, Input, Button } from 'antd';
import { CommentOutlined } from '@ant-design/icons';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';

const { Title, Text } = Typography;

const BRAND_PRIMARY = '#0d9488';
const BRAND_BG = '#031a18';

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
          style={{ background: BRAND_PRIMARY, borderColor: BRAND_PRIMARY }}
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
      background: `linear-gradient(135deg, ${BRAND_BG} 0%, #051e1c 100%)`,
    }}>
      <Card
        style={{ width: 420, borderRadius: 16, border: 'none', boxShadow: '0 8px 40px #00000040' }}
        styles={{ body: { padding: 48 } }}
      >
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 16, background: BRAND_PRIMARY,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <CommentOutlined style={{ fontSize: 34, color: '#fff' }} />
          </div>
          <Title level={2} style={{ margin: 0, fontWeight: 800, color: '#111' }}>vendly</Title>
          <Text type="secondary" style={{ fontSize: 14 }}>Plataforma de agentes WhatsApp</Text>
        </div>
        {children}
      </Card>
    </div>
  );
}
