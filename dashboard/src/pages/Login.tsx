import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, Typography, Spin, Result, Alert, Form, Input, Button } from 'antd';
import { CommentOutlined, SendOutlined } from '@ant-design/icons';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';

const { Title, Paragraph, Text } = Typography;

const BRAND_PRIMARY = '#0d9488';
const BRAND_BG = '#031a18';

export default function Login() {
  const [params] = useSearchParams();
  const { login, token } = useAuth();
  const nav = useNavigate();
  const [status, setStatus] = useState<'idle' | 'exchanging' | 'sending' | 'sent' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');

  // Redirect if already logged in
  useEffect(() => {
    if (token) nav('/agents', { replace: true });
  }, [token, nav]);

  // Exchange magic token from URL
  useEffect(() => {
    const magicToken = params.get('token');
    if (!magicToken) return;

    setStatus('exchanging');
    api.exchangeMagicToken(magicToken)
      .then(({ token: sessionToken }) => {
        login(sessionToken);
        setStatus('success');
        setTimeout(() => nav('/agents', { replace: true }), 1200);
      })
      .catch((e: Error) => {
        setError(e.message);
        setStatus('error');
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleRequestLink({ email }: { email: string }) {
    setStatus('sending');
    setError('');
    try {
      await api.requestMagicLink(email.trim().toLowerCase());
      setStatus('sent');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }

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
        {/* Logo */}
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

        {/* Exchanging magic token */}
        {(status === 'exchanging') && (
          <div style={{ textAlign: 'center' }}>
            <Spin size="large" />
            <Paragraph type="secondary" style={{ marginTop: 16 }}>Autenticando…</Paragraph>
          </div>
        )}

        {/* Login success */}
        {status === 'success' && (
          <Result status="success" title="Acesso autorizado!" subTitle="Redirecionando para o dashboard…" />
        )}

        {/* Link sent */}
        {status === 'sent' && (
          <Result
            status="success"
            title="Link enviado!"
            subTitle="Verifique seu email e clique no link para acessar o painel. O link expira em 7 dias."
          />
        )}

        {/* Error state */}
        {status === 'error' && (
          <>
            <Alert
              type="error"
              message="Erro"
              description={error || 'Tente novamente ou entre em contato com o suporte.'}
              showIcon
              style={{ marginBottom: 20 }}
            />
            <Button block onClick={() => setStatus('idle')}>Tentar novamente</Button>
          </>
        )}

        {/* Email form (idle or sending) */}
        {(status === 'idle' || status === 'sending') && (
          <>
            <Paragraph type="secondary" style={{ marginBottom: 20, textAlign: 'center' }}>
              Digite seu email para receber o link de acesso.
            </Paragraph>
            <Form layout="vertical" onFinish={handleRequestLink}>
              <Form.Item
                name="email"
                rules={[
                  { required: true, message: 'Informe seu email' },
                  { type: 'email', message: 'Email inválido' },
                ]}
              >
                <Input
                  size="large"
                  placeholder="seu@email.com"
                  type="email"
                  autoComplete="email"
                  autoFocus
                />
              </Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                block
                size="large"
                icon={<SendOutlined />}
                loading={status === 'sending'}
                style={{ background: BRAND_PRIMARY, borderColor: BRAND_PRIMARY }}
              >
                Enviar link de acesso
              </Button>
            </Form>
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 20, textAlign: 'center', marginBottom: 0 }}>
              Apenas assinantes do plano Vendly têm acesso.{' '}
              <a href={`mailto:suporte@vendly.chat`} style={{ color: BRAND_PRIMARY }}>suporte@vendly.chat</a>
            </Paragraph>
          </>
        )}
      </Card>
    </div>
  );
}
