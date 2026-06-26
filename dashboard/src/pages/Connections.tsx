import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Typography, Button, Card, Badge, Space, Modal, Form, Input, Popconfirm,
  message, Result, Spin, Alert, Tag, Empty, Divider,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, QrcodeOutlined, ReloadOutlined, WhatsAppOutlined,
  RobotOutlined, EditOutlined, PauseCircleOutlined, PlayCircleOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Connection, Agent } from '../lib/types';
import AgentModal from '../components/AgentModal';

const { Title, Paragraph, Text } = Typography;

function connBadge(status: Connection['status']) {
  if (status === 'active') return { color: 'success' as const, label: 'Conectado' };
  if (status === 'pending_qr') return { color: 'warning' as const, label: 'Aguardando conexão' };
  return { color: 'default' as const, label: 'Pausado' };
}
function agentBadge(status: Agent['status']) {
  if (status === 'active') return { color: 'success' as const, label: 'Ativo' };
  if (status === 'pending_qr') return { color: 'warning' as const, label: 'Aguardando WhatsApp' };
  if (status === 'paused') return { color: 'default' as const, label: 'Pausado' };
  return { color: 'error' as const, label: 'Erro' };
}

// ── QR modal (per connection) ────────────────────────────────────────────────
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
    } catch (e) { setQrError((e as Error).message || 'Erro ao buscar o QR.'); }
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
        <Result status="success" title="WhatsApp conectado!" subTitle="Agora adicione um agente a este número." />
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
  const qc = useQueryClient();
  const { data: connections = [], isLoading } = useQuery({ queryKey: ['connections'], queryFn: api.getConnections, refetchInterval: 15_000 });
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: api.getAgents, refetchInterval: 15_000 });
  const { data: catalog = [] } = useQuery({ queryKey: ['tool-catalog'], queryFn: api.getToolCatalog });

  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();
  const [qrConn, setQrConn] = useState<Connection | null>(null);

  // Agent modal state
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [agentConn, setAgentConn] = useState<Connection | null>(null);

  const agentsByConn = useMemo(() => {
    const m = new Map<string, Agent[]>();
    for (const a of agents) {
      const k = a.connectionId ?? '__none__';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(a);
    }
    return m;
  }, [agents]);

  const createConn = useMutation({
    mutationFn: (name: string) => api.createConnection(name),
    onSuccess: ({ connection }) => {
      qc.invalidateQueries({ queryKey: ['connections'] });
      setCreateOpen(false);
      message.success('WhatsApp criado! Escaneie o QR para conectar.');
      setQrConn(connection);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const delConn = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connections'] }); qc.invalidateQueries({ queryKey: ['agents'] }); message.success('WhatsApp removido.'); },
    onError: (e: Error) => message.error(e.message),
  });

  const delAgent = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents'] }); qc.invalidateQueries({ queryKey: ['connections'] }); message.success('Agente removido.'); },
    onError: (e: Error) => message.error(e.message),
  });

  const toggleAgent = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'paused' }) => api.updateAgent(id, { status }),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ['agents'] }); message.success(v.status === 'paused' ? 'Agente pausado — parou de responder.' : 'Agente reativado.'); },
    onError: (e: Error) => message.error(e.message),
  });

  const openAddAgent = (conn: Connection) => { setEditAgent(null); setAgentConn(conn); setAgentModalOpen(true); };
  const openEditAgent = (conn: Connection, a: Agent) => { setEditAgent(a); setAgentConn(conn); setAgentModalOpen(true); };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <Title level={3} style={{ margin: 0 }}><WhatsAppOutlined /> Meus WhatsApps</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setCreateOpen(true); }}>
          Conectar um WhatsApp
        </Button>
      </div>
      <Paragraph type="secondary" style={{ marginBottom: 20 }}>
        Conecte quantos números quiser. Dentro de cada número você cria os agentes que vão atender por ele —
        pode ser <b>um número com um agente</b>, <b>vários números com agentes diferentes</b>, ou
        <b> um número com vários agentes</b> (ex.: um para o grupo do restaurante e outro para o dos entregadores).
      </Paragraph>

      {connections.length === 0 && !isLoading && (
        <Card>
          <Empty
            image={<WhatsAppOutlined style={{ fontSize: 48, color: '#d9d9d9' }} />}
            description={<span>Nenhum WhatsApp conectado.<br />Conecte seu primeiro número para começar.</span>}
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setCreateOpen(true); }}>Conectar um WhatsApp</Button>
          </Empty>
        </Card>
      )}

      <Space direction="vertical" style={{ width: '100%' }} size={20}>
        {connections.map(conn => {
          const sb = connBadge(conn.status);
          const list = agentsByConn.get(conn._id) ?? [];
          const isConnected = conn.status === 'active';
          return (
            <Card key={conn._id} styles={{ body: { padding: 0 } }}>
              {/* WhatsApp header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '16px 20px', borderBottom: '1px solid #f0f0f0', background: '#fafafa', borderRadius: '8px 8px 0 0' }}>
                <WhatsAppOutlined style={{ fontSize: 22, color: '#25D366' }} />
                <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                  <Text strong style={{ fontSize: 16 }}>{conn.name}</Text>
                  <div style={{ marginTop: 2 }}><Badge status={sb.color} text={sb.label} /></div>
                </div>
                <Space wrap size={8} style={{ marginLeft: 'auto' }}>
                  <Button type={conn.status === 'pending_qr' ? 'primary' : 'default'} icon={<QrcodeOutlined />} onClick={() => setQrConn(conn)}>
                    {conn.status === 'pending_qr' ? 'Conectar' : 'Reconectar / QR'}
                  </Button>
                  <Popconfirm
                    title={`Remover "${conn.name}"?`}
                    description="Desconecta o número e remove os agentes dele."
                    onConfirm={() => delConn.mutate(conn._id)}
                    okText="Remover" okButtonProps={{ danger: true }}
                  >
                    <Button danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              </div>

              {/* Agents inside this WhatsApp */}
              <div style={{ padding: '12px 20px 16px' }}>
                {!isConnected && (
                  <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                    message="Conecte este WhatsApp (botão Conectar) para os agentes começarem a atender." />
                )}
                {list.length === 0 ? (
                  <div style={{ padding: '8px 0' }}>
                    <Text type="secondary" style={{ fontSize: 13 }}>Nenhum agente neste número ainda.</Text>
                  </div>
                ) : (
                  list.map(a => {
                    const ab = agentBadge(a.status);
                    return (
                      <div key={a._id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5', flexWrap: 'wrap' }}>
                        <RobotOutlined style={{ fontSize: 18, color: '#7C3AED', flexShrink: 0 }} />
                        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                          <Text strong>{a.name}</Text>
                          <div style={{ marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <Badge status={ab.color} text={ab.label} />
                            {(a.respondToDirect ?? true) && <Tag color="green" style={{ fontSize: 11 }}>Privado</Tag>}
                            {(a.respondToGroups ?? false) && <Tag color="purple" style={{ fontSize: 11 }}>Grupos</Tag>}
                            {a.contactFilter?.mode === 'whitelist'
                              ? <Tag color="blue" style={{ fontSize: 11 }}>Atende lista específica</Tag>
                              : (a.contactFilter?.contacts?.length || a.contactFilter?.groups?.length)
                                ? <Tag style={{ fontSize: 11 }}>Com bloqueios</Tag>
                                : <Tag style={{ fontSize: 11 }}>Atende todos</Tag>}
                          </div>
                        </div>
                        <Space wrap size={8} style={{ marginLeft: 'auto' }}>
                          {a.status === 'paused' ? (
                            <Button size="small" type="primary" ghost icon={<PlayCircleOutlined />} loading={toggleAgent.isPending}
                              onClick={() => toggleAgent.mutate({ id: a._id, status: 'active' })}>Retomar</Button>
                          ) : (
                            <Button size="small" icon={<PauseCircleOutlined />} loading={toggleAgent.isPending}
                              disabled={a.status === 'pending_qr'}
                              onClick={() => toggleAgent.mutate({ id: a._id, status: 'paused' })}>Pausar</Button>
                          )}
                          <Button size="small" icon={<EditOutlined />} onClick={() => openEditAgent(conn, a)}>Editar</Button>
                          <Popconfirm title={`Remover agente "${a.name}"?`} description="Remove o agente e sua base de conhecimento. O WhatsApp continua conectado." onConfirm={() => delAgent.mutate(a._id)} okText="Remover" okButtonProps={{ danger: true }}>
                            <Button size="small" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        </Space>
                      </div>
                    );
                  })
                )}
                <Button type="dashed" icon={<PlusOutlined />} onClick={() => openAddAgent(conn)} style={{ marginTop: 12 }}>
                  Adicionar agente a este WhatsApp
                </Button>
              </div>
            </Card>
          );
        })}
      </Space>

      {/* Create connection */}
      <Modal
        title="Conectar um novo WhatsApp"
        open={createOpen}
        onOk={() => form.validateFields().then(v => createConn.mutate(v.name))}
        confirmLoading={createConn.isPending}
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

      <AgentModal
        open={agentModalOpen}
        agent={editAgent}
        connectionId={agentConn?._id}
        connectionName={agentConn?.name}
        catalog={catalog}
        onClose={() => setAgentModalOpen(false)}
      />
      <Divider style={{ opacity: 0 }} />
    </div>
  );
}
