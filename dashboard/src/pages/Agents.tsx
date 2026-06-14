import { useEffect, useMemo, useState } from 'react';
import {
  Typography, Button, Card, Badge, Space, Modal, Form, Input, Switch, Select,
  Popconfirm, Tag, message, Result, Divider, Tabs, Alert, Checkbox, Empty,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, RobotOutlined, ApiOutlined,
  TeamOutlined, FilterOutlined, ToolOutlined, WhatsAppOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { Agent, CustomApi, ContactFilter, CatalogTool } from '../lib/types';

const { Title, Paragraph, Text } = Typography;
const { TextArea } = Input;

function statusBadge(status: Agent['status']) {
  if (status === 'active') return { color: 'success' as const, label: 'Ativo' };
  if (status === 'pending_qr') return { color: 'warning' as const, label: 'Aguardando WhatsApp' };
  if (status === 'paused') return { color: 'default' as const, label: 'Pausado' };
  return { color: 'error' as const, label: 'Erro' };
}

// ── Integrations (custom APIs) editor ────────────────────────────────────────

const KIND_OPTS = [
  { value: 'responding', label: 'Responde — o agente espera o resultado e usa na resposta' },
  { value: 'void', label: 'Ação — o agente executa e só confirma para o cliente' },
  { value: 'async', label: 'Assíncrona — demora; o agente avisa "estou verificando" e responde quando chegar' },
];

function CustomApiEditor({ apis, onChange }: { apis: CustomApi[]; onChange: (apis: CustomApi[]) => void }) {
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [form] = Form.useForm();

  const openNew = () => { form.resetFields(); form.setFieldsValue({ method: 'GET', kind: 'responding', schema: '{}' }); setEditIdx(-1); };
  const openEdit = (i: number) => {
    const a = apis[i];
    form.setFieldsValue({ ...a, kind: a.kind ?? 'responding', schema: JSON.stringify(a.schema ?? {}, null, 2) });
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

  const kind = Form.useWatch('kind', form);

  return (
    <div>
      <Paragraph type="secondary" style={{ fontSize: 13 }}>
        Conecte o agente a sistemas externos (seu sistema de pedidos, estoque, entregas…). Você descreve o que a
        ferramenta faz e o agente decide quando usar.
      </Paragraph>
      {apis.map((a, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
          <Tag color={a.kind === 'async' ? 'purple' : a.kind === 'void' ? 'orange' : 'blue'}>
            {a.kind === 'async' ? 'Assíncrona' : a.kind === 'void' ? 'Ação' : 'Responde'}
          </Tag>
          <Text strong style={{ fontSize: 13 }}>{a.name}</Text>
          <Text type="secondary" style={{ fontSize: 12, flex: 1 }}>{a.description}</Text>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(i)} />
          <Popconfirm title="Remover?" onConfirm={() => remove(i)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      ))}
      <Button type="dashed" icon={<PlusOutlined />} onClick={openNew} style={{ marginTop: 8 }}>
        Adicionar ferramenta
      </Button>

      <Modal
        title={editIdx === -1 ? 'Nova ferramenta' : 'Editar ferramenta'}
        open={editIdx !== null}
        onOk={save}
        onCancel={() => setEditIdx(null)}
        width={560}
        okText="Salvar"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="Nome curto (sem espaços)" rules={[{ required: true }]}
            extra="Use esse nome no prompt do agente para orientá-lo. Ex.: consultar_pedido">
            <Input placeholder="consultar_pedido" />
          </Form.Item>
          <Form.Item name="description" label="O que essa ferramenta faz" rules={[{ required: true }]}>
            <Input placeholder="Consulta o status de um pedido pelo número" />
          </Form.Item>
          <Form.Item name="kind" label="Como ela se comporta">
            <Select options={KIND_OPTS} />
          </Form.Item>
          {kind === 'async' && (
            <Form.Item name="waitingMessage" label="O que o agente está verificando (texto curto)"
              extra='Usado na mensagem "estou verificando ___…".'>
              <Input placeholder="o status do seu pedido" />
            </Form.Item>
          )}
          <Form.Item name="url" label="Endereço (URL)" rules={[{ required: true }]}
            extra="Pode usar {parametro} para inserir valores. Ex.: https://meusistema.com/pedidos/{numero}">
            <Input placeholder="https://meusistema.com/pedidos/{numero}" />
          </Form.Item>
          <Form.Item name="method" label="Tipo de chamada">
            <Select options={['GET', 'POST', 'PUT', 'DELETE'].map(m => ({ value: m, label: m }))} />
          </Form.Item>
          <Form.Item name="schema" label="Parâmetros (avançado, JSON Schema)"
            extra="Deixe {} se a ferramenta não precisa de parâmetros.">
            <TextArea rows={3} style={{ fontFamily: 'monospace', fontSize: 12 }} placeholder='{"type":"object","properties":{"numero":{"type":"string"}},"required":["numero"]}' />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ── Built-in tool catalog (friendly toggles) ─────────────────────────────────

function ToolCatalog({ value, onChange, catalog }: { value: string[]; onChange: (v: string[]) => void; catalog: CatalogTool[] }) {
  const byCategory = useMemo(() => {
    const m = new Map<string, CatalogTool[]>();
    for (const t of catalog) { if (!m.has(t.category)) m.set(t.category, []); m.get(t.category)!.push(t); }
    return Array.from(m.entries());
  }, [catalog]);

  const toggle = (id: string, on: boolean) => {
    onChange(on ? Array.from(new Set([...value, id])) : value.filter(v => v !== id));
  };

  return (
    <div>
      <Paragraph type="secondary" style={{ fontSize: 13 }}>
        Ações que o agente pode realizar durante a conversa. Ative só o que fizer sentido para o seu negócio.
      </Paragraph>
      {byCategory.map(([cat, tools]) => (
        <div key={cat} style={{ marginBottom: 14 }}>
          <Text strong style={{ fontSize: 13 }}>{cat}</Text>
          <div style={{ marginTop: 6 }}>
            {tools.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0' }}>
                <Checkbox checked={value.includes(t.id)} onChange={e => toggle(t.id, e.target.checked)} />
                <div>
                  <Text style={{ fontSize: 13 }}>{t.label}</Text>
                  <div><Text type="secondary" style={{ fontSize: 12 }}>{t.description}</Text></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Prompt mask: highlight which configured tools are referenced in the prompt ─

function PromptToolMask({ prompt, toolNames }: { prompt: string; toolNames: string[] }) {
  const referenced = toolNames.filter(n => n && prompt.toLowerCase().includes(n.toLowerCase()));
  if (toolNames.length === 0) return null;
  return (
    <Alert
      type={referenced.length ? 'success' : 'info'}
      showIcon
      style={{ marginTop: 8 }}
      message={referenced.length
        ? <span>Ferramentas citadas no texto: {referenced.map(n => <Tag key={n} color="green">{n}</Tag>)}</span>
        : 'Dica: cite o nome das ferramentas no texto para orientar o agente a usá-las.'}
    />
  );
}

// ── Agent Form Modal ─────────────────────────────────────────────────────────

const EMPTY_FILTER: ContactFilter = { mode: 'blacklist', contacts: [], groups: [] };

function AgentModal({ agent, open, onClose, catalog, connectionId }: {
  agent: Agent | null;
  open: boolean;
  onClose: () => void;
  catalog: CatalogTool[];
  connectionId?: string;
}) {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [customApis, setCustomApis] = useState<CustomApi[]>([]);
  const [builtinTools, setBuiltinTools] = useState<string[]>([]);
  const [filter, setFilter] = useState<ContactFilter>(EMPTY_FILTER);
  const [prompt, setPrompt] = useState('');
  const isEdit = !!agent;

  useEffect(() => {
    if (!open) return;
    if (agent) {
      form.setFieldsValue({
        name: agent.name,
        assistantName: agent.assistantName,
        respondToMentions: agent.groupConfig?.respondToMentions ?? true,
        respondToReplies: agent.groupConfig?.respondToReplies ?? true,
        respondToAll: agent.groupConfig?.respondToAll ?? false,
      });
      setBuiltinTools(agent.builtinTools ?? []);
      setFilter(agent.contactFilter ?? EMPTY_FILTER);
      api.getAgent(agent._id).then(full => {
        form.setFieldsValue({ systemPrompt: full.systemPrompt });
        setPrompt(full.systemPrompt ?? '');
        setCustomApis(full.customApis ?? []);
        setBuiltinTools(full.builtinTools ?? []);
        setFilter(full.contactFilter ?? EMPTY_FILTER);
      }).catch(() => { /* ignore */ });
    } else {
      form.resetFields();
      form.setFieldsValue({ respondToMentions: true, respondToReplies: true, respondToAll: false });
      setCustomApis([]); setBuiltinTools([]); setFilter(EMPTY_FILTER); setPrompt('');
    }
  }, [open, agent, form]);

  function buildPayload(vals: Record<string, unknown>) {
    return {
      name: vals.name as string,
      assistantName: vals.assistantName as string,
      systemPrompt: vals.systemPrompt as string,
      tools: ['evolution', 'chatwoot'], // base capabilities, hidden from the client
      builtinTools,
      customApis,
      contactFilter: filter,
      connectionId,
      groupConfig: {
        respondToMentions: vals.respondToMentions as boolean,
        respondToReplies: vals.respondToReplies as boolean,
        respondToAll: vals.respondToAll as boolean,
      },
    };
  }

  const create = useMutation({
    mutationFn: (vals: Record<string, unknown>) => api.createAgent(buildPayload(vals)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents'] }); message.success('Agente criado!'); onClose(); },
    onError: (e: Error) => message.error(e.message),
  });
  const update = useMutation({
    mutationFn: (vals: Record<string, unknown>) => api.updateAgent(agent!._id, buildPayload(vals)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents'] }); message.success('Agente atualizado!'); onClose(); },
    onError: (e: Error) => message.error(e.message),
  });

  const submit = () => form.validateFields().then(vals => {
    if (isEdit) update.mutate(vals as Record<string, unknown>);
    else create.mutate(vals as Record<string, unknown>);
  });

  const toolNames = [
    ...customApis.map(a => a.name),
    ...catalog.filter(c => builtinTools.includes(c.id)).map(c => c.label),
  ];

  return (
    <Modal
      title={isEdit ? `Editar agente — ${agent.name}` : 'Novo agente'}
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={create.isPending || update.isPending}
      okText={isEdit ? 'Salvar' : 'Criar agente'}
      width={680}
      destroyOnClose
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Tabs defaultActiveKey="basic" items={[
          {
            key: 'basic',
            label: <span><RobotOutlined /> Identidade</span>,
            children: (
              <>
                <Form.Item name="name" label="Nome do agente (para você)" rules={[{ required: true }]}>
                  <Input placeholder="Atendimento Vendas" />
                </Form.Item>
                <Form.Item name="assistantName" label="Como o agente se apresenta ao cliente">
                  <Input placeholder="Sofia" />
                </Form.Item>
                <Form.Item name="systemPrompt" label="Instruções do agente" rules={[{ required: true }]}
                  extra="Descreva a personalidade, o que ele deve fazer e quando usar cada ferramenta.">
                  <TextArea rows={8} placeholder="Você é a Sofia, atendente da empresa…" onChange={e => setPrompt(e.target.value)} />
                </Form.Item>
                <PromptToolMask prompt={prompt} toolNames={toolNames} />
              </>
            ),
          },
          {
            key: 'tools',
            label: <span><ToolOutlined /> Ações</span>,
            children: <ToolCatalog value={builtinTools} onChange={setBuiltinTools} catalog={catalog} />,
          },
          {
            key: 'integrations',
            label: <span><ApiOutlined /> Integrações</span>,
            children: <CustomApiEditor apis={customApis} onChange={setCustomApis} />,
          },
          {
            key: 'filter',
            label: <span><FilterOutlined /> Quem ele atende</span>,
            children: (
              <>
                <Paragraph type="secondary" style={{ fontSize: 13 }}>
                  Por padrão o agente responde a todos. Use a lista para restringir — ótimo quando vários agentes
                  dividem o mesmo WhatsApp (ex.: um só para o grupo dos entregadores).
                </Paragraph>
                <Form.Item label="Modo">
                  <Select
                    value={filter.mode}
                    onChange={mode => setFilter({ ...filter, mode })}
                    options={[
                      { value: 'blacklist', label: 'Responder a todos, EXCETO os bloqueados' },
                      { value: 'whitelist', label: 'Responder SOMENTE aos permitidos' },
                    ]}
                  />
                </Form.Item>
                <Form.Item label={filter.mode === 'whitelist' ? 'Números permitidos' : 'Números bloqueados'}
                  extra="Digite o número com DDI/DDD (ex.: 5511999998888) e tecle Enter.">
                  <Select mode="tags" value={filter.contacts} onChange={contacts => setFilter({ ...filter, contacts })}
                    placeholder="5511999998888" tokenSeparators={[',', ' ']} open={false} />
                </Form.Item>
                <Form.Item label={filter.mode === 'whitelist' ? 'Grupos permitidos' : 'Grupos bloqueados'}
                  extra="Cole o ID do grupo (termina com @g.us) e tecle Enter.">
                  <Select mode="tags" value={filter.groups} onChange={groups => setFilter({ ...filter, groups })}
                    placeholder="1203...@g.us" tokenSeparators={[',', ' ']} open={false} />
                </Form.Item>
              </>
            ),
          },
          {
            key: 'groups',
            label: <span><TeamOutlined /> Grupos</span>,
            children: (
              <>
                <Alert type="info" showIcon message="Em grupos, o agente só responde se os critérios abaixo forem atendidos." style={{ marginBottom: 16 }} />
                <Form.Item name="respondToMentions" label="Responder quando mencionado (@)" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Form.Item name="respondToReplies" label="Responder quando respondem a uma mensagem dele" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Form.Item name="respondToAll" label="Responder a todas as mensagens do grupo" valuePropName="checked">
                  <Switch />
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
  const nav = useNavigate();
  const { data: agents = [], isLoading } = useQuery({ queryKey: ['agents'], queryFn: api.getAgents, refetchInterval: 15_000 });
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: api.getConnections });
  const { data: catalog = [] } = useQuery({ queryKey: ['tool-catalog'], queryFn: api.getToolCatalog });
  const qc = useQueryClient();

  const [modalOpen, setModalOpen] = useState(false);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [chosenConnection, setChosenConnection] = useState<string | undefined>(undefined);

  const deleteAgent = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents'] }); qc.invalidateQueries({ queryKey: ['connections'] }); message.success('Agente removido.'); },
    onError: (e: Error) => message.error(e.message),
  });

  const connName = (id?: string) => connections.find(c => c._id === id)?.name ?? '—';

  const startCreate = () => {
    if (connections.length === 0) { message.info('Conecte um WhatsApp primeiro.'); nav('/connections'); return; }
    if (connections.length === 1) { setChosenConnection(connections[0]._id); setEditAgent(null); setModalOpen(true); }
    else { setChosenConnection(undefined); setPickOpen(true); }
  };
  const openEdit = (a: Agent) => { setChosenConnection(a.connectionId); setEditAgent(a); setModalOpen(true); };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0 }}><RobotOutlined /> Agentes</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={startCreate}>Novo agente</Button>
      </div>

      {agents.length === 0 && !isLoading && (
        <Card>
          <Empty description="Nenhum agente ainda">
            <Button type="primary" icon={<PlusOutlined />} onClick={startCreate}>Criar agente</Button>
          </Empty>
        </Card>
      )}

      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        {agents.map(agent => {
          const sb = statusBadge(agent.status);
          return (
            <Card key={agent._id} styles={{ body: { padding: '16px 24px' } }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Text strong style={{ fontSize: 16 }}>{agent.name}</Text>
                    {agent.assistantName && <Text type="secondary" style={{ fontSize: 13 }}>({agent.assistantName})</Text>}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    <Badge status={sb.color} text={sb.label} />
                    <Tag icon={<WhatsAppOutlined />} color="green" style={{ fontSize: 11 }}>{connName(agent.connectionId)}</Tag>
                    {agent.contactFilter?.mode === 'whitelist' && <Tag color="blue" style={{ fontSize: 11 }}>Atende lista específica</Tag>}
                  </div>
                </div>
                <Space wrap>
                  <Button icon={<EditOutlined />} onClick={() => openEdit(agent)}>Editar</Button>
                  <Popconfirm
                    title={`Remover agente "${agent.name}"?`}
                    description="Remove o agente e sua base de conhecimento. O WhatsApp continua, se outros agentes usarem."
                    onConfirm={() => deleteAgent.mutate(agent._id)}
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

      <AgentModal open={modalOpen} agent={editAgent} connectionId={chosenConnection} catalog={catalog} onClose={() => setModalOpen(false)} />

      {/* Pick a WhatsApp when more than one exists */}
      <Modal
        title="Em qual WhatsApp este agente vai atender?"
        open={pickOpen}
        onCancel={() => setPickOpen(false)}
        okText="Continuar"
        okButtonProps={{ disabled: !chosenConnection }}
        onOk={() => { setPickOpen(false); setEditAgent(null); setModalOpen(true); }}
      >
        <Select
          style={{ width: '100%', marginTop: 8 }}
          placeholder="Escolha o WhatsApp"
          value={chosenConnection}
          onChange={setChosenConnection}
          options={connections.map(c => ({ value: c._id, label: c.name }))}
        />
        <Divider />
        <Text type="secondary" style={{ fontSize: 12 }}>
          Vários agentes podem dividir o mesmo WhatsApp — use "Quem ele atende" para separar (ex.: um por grupo).
        </Text>
      </Modal>
    </div>
  );
}
