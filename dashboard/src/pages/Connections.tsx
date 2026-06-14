import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Typography, Button, Card, Badge, Space, Modal, Form, Input, Popconfirm,
  message, Result, Spin, Alert,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, QrcodeOutlined, ReloadOutlined, WhatsAppOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Connection } from '../lib/types';

const { Title, Paragraph, Text } = Typography;

function statusBadge(status: Connection['status']) {
  if (status === 'active') return { color: 'success' as const, label: 'Conectado' };
  if (status === 'pending_qr') return { color: 'warning' as const, label: 'Aguardando conexão' };
  return { color: 'default' as const, label: 'Pausado' };
}

// QR modal driven by the connection endpoints
function QrModal({ connectionId, name, open, onClose }: { connectionId: string; name: string; open: boolean; onClose: () => void }) {
  const [qrBase64, setQrBase64] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState('');
  const [connected, setConnected] = useState(false);
  const statusRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qc = useQueryClient();

  const fetchQr = useCallback(async () => {
    setQrLoading(true); setQrError('');
    try {
      const d = await api.getConnectionQr(connectionId);
      if (d.base64) setQrBase64(d.base64);
      else setQrError('QR ainda não disponível — aguarde ou clique em Atualizar.');
    } catch (e) {
      setQrError((e as Error).message || 'Erro ao buscar o QR.');
    }
    setQrLoading(false);
  }, [connectionId]);

  useEffect(() => {
    if (!open) {
      if (statusRef.current) clearInterval(statusRef.current);
      if (refreshRef.current) clearInterval(refreshRef.current);
      return;
    }
    setConnected(false); setQrBase64(null); setQrError('');
    fetchQr();
    statusRef.current = setInterval(async () => {
      try {
        const d = await api.getConnectionStatus(connectionId);
        if (d.connected || d.connectionStatus === 'active') {
          setConnected(true);
          if (statusRef.current) clearInterval(statusRef.current);
          if (refreshRef.current) clearInterval(refreshRef.current);
          qc.invalidateQueries({ queryKey: ['connections'] });
        }
      } catch { /* ignore */ }
    }, 3000);
    refreshRef.current = setInterval(fetchQr, 10_000);
    return () => {
      if (statusRef.current) clearInterval(statusRef.current);
      if (refreshRef.current) clearInterval(refreshRef.current);
    };
  }, [open, connectionId, fetchQr, qc]);

  return (
    <Modal
      title={`Conectar WhatsApp — ${name}`}
      open={open}
      onCancel={onClose}
      footer={connected ? null : [
        <Button key="refresh" loading={qrLoading} icon={<ReloadOutlined />} onClick={fetchQr}>Atualizar</Button>,
        <Button key="close" onClick={onClose}>Fechar</Button>,
      ]}
      width={420}
    >
      {connected ? (
        <Result status="success" title="WhatsApp conectado!" subTitle="Agora crie agentes que atendem por este número." />
      ) : (
        <div style={{ textAlign: 'center', padding: '8px 0' }}>
          <div style={{ width: 280, height: 280, margin: '0 auto 16px', background: '#f9f9f9', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #f0f0f0' }}>
            {qrLoading ? <Spin size="large" /> : qrBase64 ? (
              <img src={qrBase64} alt="QR Code" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 10 }} />
            ) : <Text type="secondary" style={{ fontSize: 13 }}>Aguardando QR…</Text>}
          </div>
          {qrError && <Alert type="warning" message={qrError} showIcon style={{ marginBottom: 12, textAlign: 'left' }} />}
          <Paragraph type="secondary" style={{ fontSize: 13 }}>
            No celular: <Text strong>WhatsApp → Aparelhos conectados → Conectar um aparelho</Text> e aponte para o QR.
          </Paragraph>
        </div>
      )}
    </Modal>
  );
}

export default function Connections() {
  const { data: connections = [], isLoading } = useQuery({ queryKey: ['connections'], queryFn: api.getConnections, refetchInterval: 15_000 });
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();
  const [qrConn, setQrConn] = useState<Connection | null>(null);

  const create = useMutation({
    mutationFn: (name: string) => api.createConnection(name),
    onSuccess: ({ connection }) => {
      qc.invalidateQueries({ queryKey: ['connections'] });
      setCreateOpen(false);
      message.success('WhatsApp criado! Escaneie o QR para conectar.');
      setQrConn(connection);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); qc.invalidateQueries({ queryKey: ['agents'] }); message.success('WhatsApp removido.'); },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Title level={3} style={{ margin: 0 }}><WhatsAppOutlined /> WhatsApp</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setCreateOpen(true); }}>
          Conectar um WhatsApp
        </Button>
      </div>
      <Paragraph type="secondary" style={{ marginBottom: 20 }}>
        Cada WhatsApp conectado pode ser atendido por um ou vários agentes — por exemplo, um agente
        para o grupo do restaurante e outro para o grupo dos entregadores, no mesmo número.
      </Paragraph>

      {connections.length === 0 && !isLoading && (
        <Card>
          <div style={{ textAlign: 'center', padding: 40 }}>
            <WhatsAppOutlined style={{ fontSize: 48, color: '#d9d9d9', marginBottom: 16 }} />
            <Title level={4} type="secondary">Nenhum WhatsApp conectado</Title>
            <Paragraph type="secondary">Conecte seu primeiro número para começar a atender.</Paragraph>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setCreateOpen(true); }}>Conectar um WhatsApp</Button>
          </div>
        </Card>
      )}

      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        {connections.map(conn => {
          const sb = statusBadge(conn.status);
          return (
            <Card key={conn._id} styles={{ body: { padding: '16px 24px' } }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <Text strong style={{ fontSize: 16 }}>{conn.name}</Text>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                    <Badge status={sb.color} text={sb.label} />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {conn.agentCount ?? 0} agente{(conn.agentCount ?? 0) === 1 ? '' : 's'}
                    </Text>
                  </div>
                </div>
                <Space wrap>
                  <Button type={conn.status === 'pending_qr' ? 'primary' : 'default'} icon={<QrcodeOutlined />} onClick={() => setQrConn(conn)}>
                    {conn.status === 'pending_qr' ? 'Conectar WhatsApp' : 'Reconectar / QR'}
                  </Button>
                  <Popconfirm
                    title={`Remover "${conn.name}"?`}
                    description="Isso desconecta o número e remove os agentes ligados a ele."
                    onConfirm={() => del.mutate(conn._id)}
                    okText="Remover" okButtonProps={{ danger: true }}
                  >
                    <Button danger icon={<DeleteOutlined />}>Remover</Button>
                  </Popconfirm>
                </Space>
              </div>
            </Card>
          );
        })}
      </Space>

      <Modal
        title="Conectar um novo WhatsApp"
        open={createOpen}
        onOk={() => form.validateFields().then(v => create.mutate(v.name))}
        confirmLoading={create.isPending}
        onCancel={() => setCreateOpen(false)}
        okText="Criar e gerar QR"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="Como você quer chamar este número?" rules={[{ required: true, message: 'Dê um nome' }]}
            extra="Só para você se organizar. Ex.: 'Atendimento', 'Delivery', 'Loja Centro'.">
            <Input placeholder="Atendimento" />
          </Form.Item>
        </Form>
      </Modal>

      {qrConn && (
        <QrModal connectionId={qrConn._id} name={qrConn.name} open={!!qrConn} onClose={() => setQrConn(null)} />
      )}
    </div>
  );
}
