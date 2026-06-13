import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, Typography, Spin, Result, Alert } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';

const { Title, Paragraph } = Typography;

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
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f2f5' }}>
      <Card style={{ width: 400, textAlign: 'center', borderRadius: 16 }} styles={{ body: { padding: 40 } }}>
        <RobotOutlined style={{ fontSize: 48, color: '#1677ff', marginBottom: 16 }} />
        <Title level={3} style={{ marginTop: 0 }}>Stack MCP</Title>

        {status === 'loading' && (
          <>
            <Spin size="large" />
            <Paragraph type="secondary" style={{ marginTop: 16 }}>Autenticando…</Paragraph>
          </>
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
          <Paragraph type="secondary">
            Para acessar o dashboard, clique no link enviado para o seu email.
            <br /><br />
            Se você não recebeu o email, entre em contato com o suporte.
          </Paragraph>
        )}
      </Card>
    </div>
  );
}
