import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Typography, Button, Card, Badge, Space, Modal, Form, Input, Switch, Select,
  Collapse, Popconfirm, Tag, message, Result, Spin, AutoComplete, Alert,
  Tabs, Divider,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, QrcodeOutlined, ReloadOutlined,
  RobotOutlined, ApiOutlined, SaveOutlined, TeamOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Agent, CustomApi } from '../lib/types';

const { Title, Paragraph, Text } = Typography;
const { TextArea } = Input;

const POPULAR_MODELS = [
  { value: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (rápido e barato)' },
  { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (equilibrado)' },
  { value: 'openai/gpt-4.1-mini', label: 'GPT 4.1 mini' },
  { value: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

const BUILTIN_TOOLS = [
  { value: 'evolution', label: 'Evolution API (WhatsApp)' },
  { value: 'chatwoot', label: 'Chatwoot (gestão de conversas)' },
  { value: 'mongo', label: 'MongoDB (dados de clientes)' },
  { value: 'qdrant', label: 'Qdrant (busca semântica)' },
  { value: 'n8n', label: 'N8N (automações externas)' },
  { value: 'system', label: 'System (limpeza de sessões)' },
];

function statusBadge(status: Agent['status']) {
  if (status === 'active') return { color: 'success' as const, label: 'Ativo' };
  if (status === 'pending_qr') return { color: 'warning' as const, label: 'Aguardando QR' };
  if (status === 'paused') return { color: 'default' as const, label: 'Pausado' };
  return { color: 'error' as const, label: 'Erro' };
}

// ── QR Code Modal ────────────────────────────────────────────────────────────

function QrModal({ agentId, agentName, open, onClose }: { agentId: string; agentName: string; open: boolean; onClose: () => void }) {
  const [qrBase64, setQrBase64] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState('');
  const [connected, setConnected] = useState(false);
  const statusRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qc = useQueryClient();

  const fetchQr = useCallback(async () => {
    setQrLoading(true);
    setQrError('');
    try {
      const d = await api.getAgentQr(agentId);
      if (d.base64) {
        setQrBase64(d.base64);
      } else {
        setQrError('QR não disponível ainda — aguarde ou clique em Atualizar.');
      }
    } catch (e) {
      setQrError((e as Error).message || 'Erro ao buscar QR code.');
    }
    setQrLoading(false);
  }, [agentId]);

  useEffect(() => {
    if (!open) {
      if (statusRef.current) clearInterval(statusRef.current);
      if (refreshRef.current) clearInterval(refreshRef.current);
      return;
    }
    setConnected(false);
    setQrBase64(null);
    setQrError('');
    fetchQr();

    // Poll connection state every 3s — check both Evolution state and MongoDB status (updated by webhook)
    statusRef.current = setInterval(async () => {
      try {
        const d = await api.getAgentStatus(agentId);
        if (d.connected || d.agentStatus === 'active') {
          setConnected(true);
          if (statusRef.current) clearInterval(statusRef.current);
          if (refreshRef.current) clearInterval(refreshRef.current);
          qc.invalidateQueries({ queryKey: ['agents'] });
        }
      } catch { /* ignore */ }
    }, 3000);

    // Refresh QR every 10s (QR codes expire after ~20–30s)
    refreshRef.current = setInterval(fetchQr, 10_000);

    return () => {
      if (statusRef.current) clearInterval(statusRef.current);
      if (refreshRef.current) clearInterval(refreshRef.current);
    };
  }, [open, agentId, fetchQr, qc]);

  return (
    <Modal
      title={`Conectar WhatsApp — ${agentName}`}
      open={open}
      onCancel={onClose}
      footer={connected ? null : [
        <Button key="refresh" loading={qrLoading} icon={<ReloadOutlined />} onClick={fetchQr}>Atualizar QR</Button>,
        <Button key="close" onClick={onClose}>Fechar</Button>,
      ]}
      width={420}
    >
      {connected ? (
        <Result status="success" title="WhatsApp conectado!" />
      ) : (
        <div style={{ textAlign: 'center', padding: '8px 0' }}>
          <div style={{ width: 280, height: 280, margin: '0 auto 16px', background: '#f9f9f9', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #f0f0f0' }}>
            {qrLoading ? <Spin size="large" /> : qrBase64 ? (
              <img src={qrBase64} alt="QR Code" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 10 }} />
            ) : (
              <div style={{ padding: 16 }}>
                <Text type="secondary" style={{ fontSize: 13 }}>Aguardando QR code…</Text>
              </div>
            )}
          </div>
          {qrError && (
            <Alert type="warning" message={qrError} showIcon style={{ marginBottom: 12, textAlign: 'left' }} />
          )}
          <Paragraph type="secondary" style={{ fontSize: 13 }}>
            No celular: <Text strong>WhatsApp → Dispositivos conectados → Conectar dispositivo</Text>
          </Paragraph>
        </div>
      )}
    </Modal>
  );
}

// ── Custom API Editor ────────────────────────────────────────────────────────

function CustomApiEditor({ apis, onChange }: { apis: CustomApi[]; onChange: (apis: CustomApi[]) => void }) {
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [form] = Form.useForm();

  const openNew = () => { form.resetFields(); form.setFieldsValue({ method: 'GET', headers: [], schema: '{}' }); setEditIdx(-1); };
  const openEdit = (i: number) => {
    const a = apis[i];
    form.setFieldsValue({ ...a, headers: a.headers ?? [], schema: JSON.stringify(a.schema, null, 2) });
    setEditIdx(i);
  };
  const remove = (i: number) => onChange(apis.filter((_, idx) => idx !== i));
  const save = () => {
    form.validateFields().then(vals => {
      let schema: Record<string, unknown> = {};
      try { schema = JSON.parse(String(vals.schema ?? '{}')); } catch { /* ignore */ }
      const api_: CustomApi = { ...vals, schema, headers: vals.headers ?? [] };
      if (editIdx === -1) onChange([...apis, api_]);
      else onChange(apis.map((a, i) => i === editIdx ? api_ : a));
      setEditIdx(null);
    });
  };

  return (
    <div>
      {apis.map((a, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
          <Tag color="blue">{a.method}</Tag>
          <Text strong style={{ fontSize: 13 }}>{a.name}</Text>
          <Text type="secondary" style={{ fontSize: 12, flex: 1 }}>{a.description}</Text>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(i)} />
          <Popconfirm title="Remover?" onConfirm={() => remove(i)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      ))}
      <Button type="dashed" icon={<PlusOutlined />} onClick={openNew} style={{ marginTop: 8 }}>
        Adicionar API
      </Button>

      <Modal
        title={editIdx === -1 ? 'Nova API' : 'Editar API'}
        open={editIdx !== null}
        onOk={save}
        onCancel={() => setEditIdx(null)}
        width={560}
        okText="Salvar"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="Nome da ferramenta (snake_case)" rules={[{ required: true }]}>
            <Input placeholder="buscar_produto" />
          </Form.Item>
          <Form.Item name="description" label="Descrição (para o LLM)" rules={[{ required: true }]}>
            <Input placeholder="Busca produto pelo nome no catálogo" />
          </Form.Item>
          <Form.Item name="url" label="URL" rules={[{ required: true }]}>
            <Input placeholder="https://api.meusite.com/produtos/{nome}" />
          </Form.Item>
          <Form.Item name="method" label="Método HTTP">
            <Select options={['GET', 'POST', 'PUT', 'DELETE'].map(m => ({ value: m, label: m }))} />
          </Form.Item>
          <Form.Item name="schema" label="Parâmetros (JSON Schema)">
            <TextArea rows={4} style={{ fontFamily: 'monospace', fontSize: 12 }} placeholder='{"type":"object","properties":{"nome":{"type":"string"}},"required":["nome"]}' />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ── Agent Form Modal ─────────────────────────────────────────────────────────

function AgentModal({ agent, open, onClose }: {
  agent: Agent | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [customApis, setCustomApis] = useState<CustomApi[]>([]);
  const isEdit = !!agent;

  useEffect(() => {
    if (!open) return;
    if (agent) {
      // Populate from cached list data immediately, then fetch full agent for systemPrompt
      form.setFieldsValue({
        name: agent.name,
        assistantName: agent.assistantName,
        tools: agent.tools,
        model: agent.model ?? 'google/gemini-2.5-flash-lite',
        temperature: agent.temperature ?? 0.7,
        maxIter: agent.maxIter ?? 8,
        respondToMentions: agent.groupConfig?.respondToMentions ?? true,
        respondToReplies: agent.groupConfig?.respondToReplies ?? true,
        respondToAll: agent.groupConfig?.respondToAll ?? false,
      });
      setCustomApis(agent.customApis ?? []);
      // Fetch full agent to load systemPrompt (excluded from list endpoint)
      api.getAgent(agent._id).then(full => {
        form.setFieldsValue({ systemPrompt: full.systemPrompt });
        setCustomApis(full.customApis ?? []);
      }).catch(() => { /* silently ignore — user can re-enter if fetch fails */ });
    } else {
      form.resetFields();
      form.setFieldsValue({ model: 'google/gemini-2.5-flash-lite', temperature: 0.7, maxIter: 8, tools: ['evolution', 'chatwoot'], respondToMentions: true, respondToReplies: true, respondToAll: false });
      setCustomApis([]);
    }
  }, [open, agent, form]);

  const create = useMutation({
    mutationFn: (vals: Record<string, unknown>) => api.createAgent(buildPayload(vals)),
    onSuccess: ({ agent: created }) => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      message.success(`Agente "${created.name}" criado! Conecte o WhatsApp.`);
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const update = useMutation({
    mutationFn: (vals: Record<string, unknown>) => api.updateAgent(agent!._id, buildPayload(vals)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents'] }); message.success('Agente atualizado!'); onClose(); },
    onError: (e: Error) => message.error(e.message),
  });

  function buildPayload(vals: Record<string, unknown>) {
    return {
      name: vals.name as string,
      assistantName: vals.assistantName as string,
      systemPrompt: vals.systemPrompt as string,
      tools: vals.tools as string[],
      customApis,
      model: vals.model as string,
      temperature: Number(vals.temperature),
      maxIter: Number(vals.maxIter),
      groupConfig: {
        respondToMentions: vals.respondToMentions as boolean,
        respondToReplies: vals.respondToReplies as boolean,
        respondToAll: vals.respondToAll as boolean,
      },
    };
  }

  const submit = () => {
    form.validateFields().then(vals => {
      if (isEdit) update.mutate(vals as Record<string, unknown>);
      else create.mutate(vals as Record<string, unknown>);
    });
  };

  const loading = create.isPending || update.isPending;

  return (
    <Modal
      title={isEdit ? `Editar agente — ${agent.name}` : 'Novo agente'}
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={loading}
      okText={isEdit ? 'Salvar' : 'Criar agente'}
      width={660}
      destroyOnClose
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Tabs defaultActiveKey="basic" items={[
          {
            key: 'basic',
            label: <span><RobotOutlined /> Identidade</span>,
            children: (
              <>
                <Form.Item name="name" label="Nome interno do agente" rules={[{ required: true }]}>
                  <Input placeholder="Agente Vendas" />
                </Form.Item>
                <Form.Item name="assistantName" label="Nome apresentado ao cliente">
                  <Input placeholder="Sofia" />
                </Form.Item>
                <Form.Item name="systemPrompt" label="Instruções (System Prompt)">
                  <TextArea rows={8} placeholder="Você é Sofia, assistente virtual da empresa…" style={{ fontFamily: 'monospace', fontSize: 13 }} />
                </Form.Item>
              </>
            ),
          },
          {
            key: 'tools',
            label: <span><ApiOutlined /> Ferramentas</span>,
            children: (
              <>
                <Form.Item name="tools" label="Ferramentas built-in habilitadas">
                  <Select mode="multiple" options={BUILTIN_TOOLS} placeholder="Selecione as ferramentas" />
                </Form.Item>
                <Divider orientation="left">APIs customizadas</Divider>
                <CustomApiEditor apis={customApis} onChange={setCustomApis} />
              </>
            ),
          },
          {
            key: 'groups',
            label: <span><TeamOutlined /> Grupos</span>,
            children: (
              <>
                <Alert type="info" showIcon message="Em grupos, o agente só responde se os critérios abaixo forem atendidos." style={{ marginBottom: 16 }} />
                <Form.Item name="respondToMentions" label="Responder quando mencionado (@agente)" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Form.Item name="respondToReplies" label="Responder quando respondem a uma mensagem do agente" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Form.Item name="respondToAll" label="Responder a todas as mensagens do grupo (ignora filtros acima)" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </>
            ),
          },
          {
            key: 'advanced',
            label: <span><SaveOutlined /> Avançado</span>,
            children: (
              <>
                <Form.Item name="model" label="Modelo de IA">
                  <AutoComplete
                    options={POPULAR_MODELS}
                    filterOption={(input, option) => (option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
                    placeholder="google/gemini-2.5-flash-lite"
                  />
                </Form.Item>
                <Form.Item name="temperature" label="Temperature (0.0 – 1.0)">
                  <Input type="number" min={0} max={1} step={0.1} />
                </Form.Item>
                <Form.Item name="maxIter" label="Máximo de iterações (tool calls)">
                  <Input type="number" min={1} max={20} />
                </Form.Item>
              </>
            ),
          },
        ]} />
      </Form>
    </Modal>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function Agents() {
  const { data: agents = [], isLoading } = useQuery({ queryKey: ['agents'], queryFn: api.getAgents, refetchInterval: 15_000 });
  const qc = useQueryClient();

  const [modalOpen, setModalOpen] = useState(false);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [qrAgent, setQrAgent] = useState<Agent | null>(null);

  const deleteAgent = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents'] }); message.success('Agente removido.'); },
    onError: (e: Error) => message.error(e.message),
  });

  const openCreate = () => { setEditAgent(null); setModalOpen(true); };
  const openEdit = (a: Agent) => { setEditAgent(a); setModalOpen(true); };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0 }}><RobotOutlined /> Agentes</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Novo agente</Button>
      </div>

      {agents.length === 0 && !isLoading && (
        <Card>
          <div style={{ textAlign: 'center', padding: 40 }}>
            <RobotOutlined style={{ fontSize: 48, color: '#d9d9d9', marginBottom: 16 }} />
            <Title level={4} type="secondary">Nenhum agente criado</Title>
            <Paragraph type="secondary">Crie seu primeiro agente para começar a receber mensagens no WhatsApp.</Paragraph>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Criar agente</Button>
          </div>
        </Card>
      )}

      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        {agents.map(agent => {
          const sb = statusBadge(agent.status);
          return (
            <Card
              key={agent._id}
              styles={{ body: { padding: '16px 24px' } }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Text strong style={{ fontSize: 16 }}>{agent.name}</Text>
                    {agent.assistantName && <Text type="secondary" style={{ fontSize: 13 }}>({agent.assistantName})</Text>}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                    <Badge status={sb.color} text={sb.label} />
                    {agent.evolutionInstance && (
                      <Text type="secondary" code style={{ fontSize: 11 }}>{agent.evolutionInstance}</Text>
                    )}
                    {agent.model && <Tag style={{ fontSize: 11 }}>{agent.model}</Tag>}
                  </div>
                </div>
                <Space wrap>
                  {agent.status === 'pending_qr' && (
                    <Button type="primary" icon={<QrcodeOutlined />} onClick={() => setQrAgent(agent)}>
                      Conectar WhatsApp
                    </Button>
                  )}
                  {agent.status === 'active' && (
                    <Button icon={<QrcodeOutlined />} onClick={() => setQrAgent(agent)}>
                      QR Code
                    </Button>
                  )}
                  <Button icon={<EditOutlined />} onClick={() => openEdit(agent)}>Editar</Button>
                  <Popconfirm
                    title={`Remover agente "${agent.name}"?`}
                    description="Isso desconecta o WhatsApp, remove o inbox do Chatwoot e apaga a base de conhecimento."
                    onConfirm={() => deleteAgent.mutate(agent._id)}
                    okText="Remover"
                    okButtonProps={{ danger: true }}
                  >
                    <Button danger icon={<DeleteOutlined />}>Remover</Button>
                  </Popconfirm>
                </Space>
              </div>

              {agent.systemPrompt && (
                <Collapse ghost style={{ marginTop: 8 }} items={[{
                  key: 'prompt',
                  label: <Text type="secondary" style={{ fontSize: 12 }}>Ver system prompt</Text>,
                  children: <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', margin: 0, color: '#555' }}>{agent.systemPrompt}</pre>,
                }]} />
              )}
            </Card>
          );
        })}
      </Space>

      <AgentModal open={modalOpen} agent={editAgent} onClose={() => setModalOpen(false)} />
      {qrAgent && (
        <QrModal
          agentId={qrAgent._id}
          agentName={qrAgent.name}
          open={!!qrAgent}
          onClose={() => setQrAgent(null)}
        />
      )}
    </div>
  );
}
