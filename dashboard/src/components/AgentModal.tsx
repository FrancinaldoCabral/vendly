import { useEffect, useState } from 'react';
import {
  Modal, Form, Input, Switch, Select, Popconfirm, Tag, message, Alert, Tabs, Typography, Button,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, RobotOutlined, ApiOutlined,
  TeamOutlined, FilterOutlined, ThunderboltOutlined, WhatsAppOutlined,
} from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Agent, CustomApi, ContactFilter, CatalogTool } from '../lib/types';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

const EMPTY_FILTER: ContactFilter = { mode: 'blacklist', contacts: [], groups: [] };

// ── Integrations (custom APIs) editor ────────────────────────────────────────

const KIND_OPTS = [
  { value: 'responding', label: 'Responde — o agente espera o resultado e usa na resposta' },
  { value: 'void', label: 'Ação — o agente executa e só confirma para o cliente' },
  { value: 'async', label: 'Demorada — o agente avisa "estou verificando" e responde quando o resultado chega' },
];

function CustomApiEditor({ apis, onChange }: { apis: CustomApi[]; onChange: (apis: CustomApi[]) => void }) {
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [form] = Form.useForm();

  const openNew = () => { form.resetFields(); form.setFieldsValue({ method: 'GET', kind: 'responding', schema: '{}', headers: [] }); setEditIdx(-1); };
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
        Conecte o agente aos <b>seus</b> sistemas (pedidos, estoque, entregas…). É opcional e técnico —
        se você não tem um sistema para conectar, pode deixar em branco.
      </Paragraph>
      {apis.map((a, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
          <Tag color={a.kind === 'async' ? 'purple' : a.kind === 'void' ? 'orange' : 'blue'}>
            {a.kind === 'async' ? 'Demorada' : a.kind === 'void' ? 'Ação' : 'Responde'}
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
        Conectar um sistema
      </Button>

      <Modal
        title={editIdx === -1 ? 'Conectar um sistema' : 'Editar integração'}
        open={editIdx !== null}
        onOk={save}
        onCancel={() => setEditIdx(null)}
        width={560}
        okText="Salvar"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="Nome curto (sem espaços)" rules={[{ required: true }]}
            extra="Use esse nome nas instruções do agente. Ex.: consultar_pedido">
            <Input placeholder="consultar_pedido" />
          </Form.Item>
          <Form.Item name="description" label="O que essa integração faz" rules={[{ required: true }]}>
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
            extra="Use {parametro} para inserir valores. Ex.: https://meusistema.com/pedidos/{numero}">
            <Input placeholder="https://meusistema.com/pedidos/{numero}" />
          </Form.Item>
          <Form.Item name="method" label="Tipo de chamada">
            <Select options={['GET', 'POST', 'PUT', 'DELETE'].map(m => ({ value: m, label: m }))} />
          </Form.Item>

          <Form.List name="headers">
            {(fields, { add, remove }) => (
              <Form.Item label="Cabeçalhos / autenticação (headers)"
                extra="Necessário para APIs com chave. Ex.: Authorization = Bearer sk-... | x-api-key = sk-ant-... | anthropic-version = 2023-06-01 | content-type = application/json">
                {fields.map(({ key, name, ...rest }) => (
                  <div key={key} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <Form.Item {...rest} name={[name, 'key']} noStyle rules={[{ required: true, message: 'nome' }]}>
                      <Input placeholder="Authorization" style={{ flex: 1 }} />
                    </Form.Item>
                    <Form.Item {...rest} name={[name, 'value']} noStyle rules={[{ required: true, message: 'valor' }]}>
                      <Input placeholder="Bearer sk-..." style={{ flex: 2 }} />
                    </Form.Item>
                    <Button danger type="text" icon={<DeleteOutlined />} onClick={() => remove(name)} />
                  </div>
                ))}
                <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ key: '', value: '' })} block>
                  Adicionar cabeçalho
                </Button>
              </Form.Item>
            )}
          </Form.List>

          <Form.Item name="schema" label="Parâmetros que o agente preenche (avançado, JSON Schema)"
            extra="O que o agente envia no corpo/URL da requisição. Deixe {} se não precisa de parâmetros.">
            <TextArea rows={3} style={{ fontFamily: 'monospace', fontSize: 12 }} placeholder='{"type":"object","properties":{"numero":{"type":"string"}},"required":["numero"]}' />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ── Built-in actions (friendly switches with examples) ───────────────────────

function ActionsCatalog({ value, onChange, catalog }: { value: string[]; onChange: (v: string[]) => void; catalog: CatalogTool[] }) {
  const toggle = (id: string, on: boolean) =>
    onChange(on ? Array.from(new Set([...value, id])) : value.filter(v => v !== id));

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="O que o agente pode fazer sozinho"
        description="Ligue as ações que você autoriza. O agente decide a hora certa de usar cada uma, sozinho, conforme a conversa e as instruções que você escreveu. Tudo desligado = ele só conversa por texto."
      />
      {catalog.length === 0 && <Text type="secondary">Carregando ações…</Text>}
      {catalog.map(t => {
        const on = value.includes(t.id);
        return (
          <div key={t.id} style={{
            display: 'flex', gap: 12, alignItems: 'flex-start',
            padding: '12px 14px', marginBottom: 8,
            border: `1px solid ${on ? '#0d9488' : '#f0f0f0'}`,
            background: on ? '#f0fdfa' : '#fff',
            borderRadius: 8,
          }}>
            <Switch checked={on} onChange={c => toggle(t.id, c)} style={{ marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <Text strong style={{ fontSize: 14 }}>{t.label}</Text>
              <div><Text type="secondary" style={{ fontSize: 13 }}>{t.description}</Text></div>
              <div style={{ marginTop: 4 }}>
                <Text style={{ fontSize: 12, color: '#0d9488' }}>💡 {t.example}</Text>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Prompt mask: highlight which configured tools are referenced in the prompt ─

function PromptToolMask({ prompt, toolNames }: { prompt: string; toolNames: string[] }) {
  if (toolNames.length === 0) return null;
  const referenced = toolNames.filter(n => n && prompt.toLowerCase().includes(n.toLowerCase()));
  return (
    <Alert
      type={referenced.length ? 'success' : 'warning'}
      showIcon
      style={{ marginTop: 8 }}
      message={referenced.length
        ? <span>Citadas nas instruções: {referenced.map(n => <Tag key={n} color="green">{n}</Tag>)}</span>
        : 'Dica: mencione as ações/integrações nas instruções (ex.: "se pedirem o endereço, envie a localização") para o agente saber quando usá-las.'}
    />
  );
}

// ── Agent Modal ──────────────────────────────────────────────────────────────

export default function AgentModal({ agent, open, onClose, catalog, connectionId, connectionName }: {
  agent: Agent | null;
  open: boolean;
  onClose: () => void;
  catalog: CatalogTool[];
  connectionId?: string;
  connectionName?: string;
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
      message.success('Agente criado!');
      onClose();
    },
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
      {connectionName && (
        <Alert
          type="success" showIcon icon={<WhatsAppOutlined />}
          style={{ marginBottom: 12 }}
          message={<span>Este agente vai atender no WhatsApp <b>{connectionName}</b></span>}
        />
      )}
      <Form form={form} layout="vertical">
        <Tabs defaultActiveKey="basic" items={[
          {
            key: 'basic',
            label: <span><RobotOutlined /> Identidade</span>,
            children: (
              <>
                <Form.Item name="name" label="Nome do agente (só para você organizar)" rules={[{ required: true }]}>
                  <Input placeholder="Atendimento Vendas" />
                </Form.Item>
                <Form.Item name="assistantName" label="Como o agente se apresenta ao cliente">
                  <Input placeholder="Sofia" />
                </Form.Item>
                <Form.Item name="systemPrompt" label="Instruções do agente" rules={[{ required: true }]}
                  extra="Descreva a personalidade, o que ele deve fazer e quando usar cada ação.">
                  <TextArea rows={8} placeholder="Você é a Sofia, atendente da empresa. Seja simpática e objetiva. Se o cliente pedir o endereço, envie a localização…" onChange={e => setPrompt(e.target.value)} />
                </Form.Item>
                <PromptToolMask prompt={prompt} toolNames={toolNames} />
              </>
            ),
          },
          {
            key: 'actions',
            label: <span><ThunderboltOutlined /> Ações</span>,
            children: <ActionsCatalog value={builtinTools} onChange={setBuiltinTools} catalog={catalog} />,
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
                  Por padrão o agente responde a todos neste WhatsApp. Restrinja apenas se você tiver
                  <b> mais de um agente no mesmo número</b> (ex.: um só para o grupo dos entregadores).
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
                <Alert type="info" showIcon message="Em grupos, o agente só responde se uma destas condições for atendida." style={{ marginBottom: 16 }} />
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
