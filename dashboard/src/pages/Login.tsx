import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, Typography, Spin, Result, Alert } from 'antd';
import { CommentOutlined } from '@ant-design/icons';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';

const { Title, Paragraph, Text } = Typography;

const BRAND_PRIMARY = '#0d9488';
const BRAND_BG = '#031a18';

export default function Login() {
  const [params] = useSearchParams();
  const { login, token } = useAuth();
  const nav = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error' | 'waiting'>('waiting');
  const [error, setError] = useState('');

  useEffect(() => {
    if (token) { nav('/agents', { replace: true }); return; }
    const magicToken = params.get('token');
    if (!magicToken) { setStatus('waiting'); return; }

    setStatus('loading');
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

        {status === 'loading' && (
          <div style={{ textAlign: 'center' }}>
            <Spin size="large" />
            <Paragraph type="secondary" style={{ marginTop: 16 }}>Autenticando…</Paragraph>
          </div>
        )}

        {status === 'success' && (
          <Result status="success" title="Acesso autorizado!" subTitle="Redirecionando para o dashboard…" />
        )}

        {status === 'error' && (
          <Alert
            type="error"
            message="Link inválido ou expirado"
            description={error || 'Solicite um novo link de acesso ao suporte.'}
            showIcon
          />
        )}

        {status === 'waiting' && (
          <div style={{ textAlign: 'center' }}>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Clique no link enviado para o seu email para acessar o dashboard.
            </Paragraph>
            <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 16 }}>
              Não recebeu? Entre em contato com{' '}
              <Text style={{ color: BRAND_PRIMARY }}>suporte@vendly.chat</Text>
            </Paragraph>
          </div>
        )}
      </Card>
    </div>
  );
}
