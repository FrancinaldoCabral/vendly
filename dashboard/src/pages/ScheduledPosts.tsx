import { useState } from 'react';
import {
  Typography, Button, Card, Badge, Space, Modal, Form, Input, Select,
  Checkbox, Popconfirm, Tag, message, Steps, Collapse, Divider, Alert,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, CalendarOutlined, PauseCircleOutlined,
  PlayCircleOutlined, EditOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { ScheduledPost, PipelineStep, PostTarget } from '../lib/types';
import dayjs from 'dayjs';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const STEP_TYPES = [
  { value: 'search', label: 'Pesquisa na web' },
  { value: 'image_gen', label: 'Geração de imagem' },
  { value: 'fetch_url', label: 'Buscar URL' },
  { value: 'compose', label: 'Compor com IA' },
];

function formatSchedule(s: ScheduledPost['schedule']) {
  const dayStr = s.days.map(d => DAYS[d]).join(', ');
  return `${dayStr} às ${s.time}`;
}

// ── Pipeline step editor ────────────────────────────────────────────────────

function PipelineEditor({ steps, onChange }: { steps: PipelineStep[]; onChange: (s: PipelineStep[]) => void }) {
  const add = () => onChange([...steps, { type: 'compose', config: {} }]);
  const remove = (i: number) => onChange(steps.filter((_, idx) => idx !== i));
  const setType = (i: number, type: PipelineStep['type']) =>
    onChange(steps.map((s, idx) => idx === i ? { ...s, type } : s));
  const setConfig = (i: number, key: string, value: string) =>
    onChange(steps.map((s, idx) => idx === i ? { ...s, config: { ...s.config, [key]: value } } : s));

  return (
    <div>
      {steps.map((step, i) => (
        <Card key={i} size="small" style={{ marginBottom: 8 }}
          title={<Space><Text strong>Passo {i + 1}</Text><Select size="small" value={step.type} onChange={t => setType(i, t)} options={STEP_TYPES} style={{ width: 180 }} /></Space>}
          extra={<Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(i)} />}
        >
          {step.type === 'search' && (
            <Form.Item label="Pesquisa" style={{ margin: 0 }}>
              <Input value={String(step.config.query ?? '')} onChange={e => setConfig(i, 'query', e.target.value)} placeholder="Ex: notícias de tecnologia {topic}" />
            </Form.Item>
          )}
          {step.type === 'image_gen' && (
            <Form.Item label="Prompt da imagem" style={{ margin: 0 }}>
              <Input value={String(step.config.prompt ?? '')} onChange={e => setConfig(i, 'prompt', e.target.value)} placeholder="Use {searchResult} para incluir resultado anterior" />
            </Form.Item>
          )}
          {step.type === 'fetch_url' && (
            <Form.Item label="URL" style={{ margin: 0 }}>
              <Input value={String(step.config.url ?? '')} onChange={e => setConfig(i, 'url', e.target.value)} placeholder="https://api.exemplo.com/dados" />
            </Form.Item>
          )}
          {step.type === 'compose' && (
            <>
              <Form.Item label="Instruções do sistema" style={{ marginBottom: 8 }}>
                <Input value={String(step.config.systemPrompt ?? '')} onChange={e => setConfig(i, 'systemPrompt', e.target.value)} placeholder="Você é um criador de conteúdo para WhatsApp…" />
              </Form.Item>
              <Form.Item label="Template do prompt" style={{ margin: 0 }}>
                <TextArea rows={3} value={String(step.config.prompt ?? '')} onChange={e => setConfig(i, 'prompt', e.target.value)} placeholder="Crie uma postagem sobre {searchResult}. Seja criativo e use emojis." />
              </Form.Item>
            </>
          )}
        </Card>
      ))}
      <Button type="dashed" icon={<PlusOutlined />} onClick={add} block>Adicionar passo</Button>
    </div>
  );
}

// ── Target editor ───────────────────────────────────────────────────────────

function TargetEditor({ targets, onChange }: { targets: PostTarget[]; onChange: (t: PostTarget[]) => void }) {
  const add = () => onChange([...targets, { type: 'contact', jid: '' }]);
  const remove = (i: number) => onChange(targets.filter((_, idx) => idx !== i));
  const set = (i: number, field: keyof PostTarget, value: string) =>
    onChange(targets.map((t, idx) => idx === i ? { ...t, [field]: value } : t));

  return (
    <div>
      {targets.map((t, i) => (
        <Space key={i} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
          <Select
            value={t.type}
            onChange={v => set(i, 'type', v)}
            style={{ width: 110 }}
            options={[
              { value: 'contact', label: 'Contato' },
              { value: 'group', label: 'Grupo' },
              { value: 'status', label: 'Status' },
            ]}
          />
          {t.type !== 'status' && (
            <Input
              value={t.jid}
              onChange={e => set(i, 'jid', e.target.value)}
              placeholder={t.type === 'group' ? '5511GRUPO@g.us' : '5511999887766@s.whatsapp.net'}
              style={{ width: 280 }}
            />
          )}
          <Button icon={<DeleteOutlined />} size="small" danger onClick={() => remove(i)} />
        </Space>
      ))}
      <Button type="dashed" icon={<PlusOutlined />} onClick={add}>Adicionar destino</Button>
    </div>
  );
}

// ── Post Form Modal ─────────────────────────────────────────────────────────

function PostModal({ post, agentId, open, onClose }: { post: ScheduledPost | null; agentId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [pipeline, setPipeline] = useState<PipelineStep[]>([]);
  const [targets, setTargets] = useState<PostTarget[]>([]);
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const isEdit = !!post;

  const resetForm = () => {
    if (post) {
      form.setFieldsValue({ time: post.schedule.time, timezone: post.schedule.timezone ?? 'America/Sao_Paulo' });
      setSelectedDays(post.schedule.days);
      setPipeline(post.pipeline);
      setTargets(post.targets);
    } else {
      form.resetFields();
      form.setFieldsValue({ time: '09:00', timezone: 'America/Sao_Paulo' });
      setSelectedDays([1, 2, 3, 4, 5]);
      setPipeline([{ type: 'compose', config: { systemPrompt: 'Você é um criador de conteúdo para WhatsApp.', prompt: 'Crie uma mensagem para o dia {topic}.' } }]);
      setTargets([]);
    }
  };

  const create = useMutation({
    mutationFn: (vals: Record<string, unknown>) => api.createScheduledPost({
      agentId,
      schedule: { days: selectedDays, time: vals.time as string, timezone: vals.timezone as string },
      pipeline,
      targets,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduled_posts'] }); message.success('Postagem agendada!'); onClose(); },
    onError: (e: Error) => message.error(e.message),
  });

  const update = useMutation({
    mutationFn: (vals: Record<string, unknown>) => api.updateScheduledPost(post!._id, {
      schedule: { days: selectedDays, time: vals.time as string, timezone: vals.timezone as string },
      pipeline,
      targets,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduled_posts'] }); message.success('Postagem atualizada!'); onClose(); },
    onError: (e: Error) => message.error(e.message),
  });

  const submit = () => {
    if (targets.length === 0) { message.warning('Adicione pelo menos um destino.'); return; }
    form.validateFields().then(vals => { isEdit ? update.mutate(vals as Record<string, unknown>) : create.mutate(vals as Record<string, unknown>); });
  };

  return (
    <Modal
      title={isEdit ? 'Editar postagem' : 'Nova postagem agendada'}
      open={open}
      onCancel={onClose}
      onOk={submit}
      afterOpenChange={open => { if (open) resetForm(); }}
      confirmLoading={create.isPending || update.isPending}
      okText={isEdit ? 'Salvar' : 'Criar'}
      width={680}
      destroyOnClose
    >
      <Steps size="small" style={{ marginBottom: 24 }} items={[
        { title: 'Agenda' },
        { title: 'Pipeline' },
        { title: 'Destinos' },
      ]} />

      <Form form={form} layout="vertical">
        <Divider orientation="left">1. Agenda</Divider>
        <Form.Item label="Dias da semana">
          <Checkbox.Group
            value={selectedDays}
            onChange={vals => setSelectedDays(vals as number[])}
            options={DAYS.map((d, i) => ({ label: d, value: i }))}
          />
        </Form.Item>
        <Space>
          <Form.Item name="time" label="Horário (HH:MM)" rules={[{ required: true, pattern: /^\d{2}:\d{2}$/, message: 'Ex: 09:00' }]}>
            <Input placeholder="09:00" style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="timezone" label="Fuso horário">
            <Select style={{ width: 220 }} options={[
              { value: 'America/Sao_Paulo', label: 'Brasil (BRT)' },
              { value: 'America/Manaus', label: 'Manaus (AMT)' },
              { value: 'America/Fortaleza', label: 'Fortaleza (BRT)' },
              { value: 'America/Belem', label: 'Belém (BRT)' },
              { value: 'UTC', label: 'UTC' },
            ]} />
          </Form.Item>
        </Space>

        <Divider orientation="left">2. Pipeline de conteúdo</Divider>
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          Os passos são executados em sequência. Use {'{'+'variável'+'}'} para referenciar resultados anteriores (ex: {'{'+'searchResult'+'}'}, {'{'+'imageUrl'+'}'}).
        </Paragraph>
        <PipelineEditor steps={pipeline} onChange={setPipeline} />

        <Divider orientation="left">3. Destinos</Divider>
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          Defina para quem a postagem será enviada. Use o JID do WhatsApp (ex: 5511999@s.whatsapp.net).
        </Paragraph>
        <TargetEditor targets={targets} onChange={setTargets} />
      </Form>
    </Modal>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function ScheduledPosts() {
  const qc = useQueryClient();
  const [agentFilter, setAgentFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editPost, setEditPost] = useState<ScheduledPost | null>(null);

  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: api.getAgents });
  const { data: posts = [], isLoading } = useQuery({
    queryKey: ['scheduled_posts', agentFilter],
    queryFn: () => api.getScheduledPosts(agentFilter || undefined),
  });

  const toggle = useMutation({
    mutationFn: (id: string) => api.toggleScheduledPost(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduled_posts'] }); },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteScheduledPost(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduled_posts'] }); message.success('Postagem removida.'); },
    onError: (e: Error) => message.error(e.message),
  });

  const openCreate = () => { setEditPost(null); setModalOpen(true); };
  const openEdit = (p: ScheduledPost) => { setEditPost(p); setModalOpen(true); };

  const agentName = (id: string) => agents.find(a => a._id === id)?.name ?? id;
  const currentAgentId = agentFilter || (agents[0]?._id ?? '');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}><CalendarOutlined /> Postagens agendadas</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={agents.length === 0}>
          Nova postagem
        </Button>
      </div>

      <Space style={{ marginBottom: 16 }}>
        <Select
          placeholder="Filtrar por agente"
          value={agentFilter || undefined}
          onChange={v => setAgentFilter(v ?? '')}
          allowClear
          style={{ width: 220 }}
          options={agents.map(a => ({ value: a._id, label: a.name }))}
        />
      </Space>

      {agents.length === 0 && (
        <Alert type="info" showIcon message="Crie um agente primeiro para agendar postagens." />
      )}

      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {!isLoading && posts.length === 0 && agents.length > 0 && (
          <Card>
            <div style={{ textAlign: 'center', padding: 32 }}>
              <CalendarOutlined style={{ fontSize: 40, color: '#d9d9d9', marginBottom: 12 }} />
              <Title level={5} type="secondary">Nenhuma postagem agendada</Title>
              <Paragraph type="secondary">Crie postagens recorrentes com pipelines de conteúdo automático.</Paragraph>
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Criar postagem</Button>
            </div>
          </Card>
        )}

        {posts.map(p => (
          <Card key={p._id} styles={{ body: { padding: '14px 20px' } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge status={p.status === 'active' ? 'success' : 'default'} text={<Text strong>{formatSchedule(p.schedule)}</Text>} />
                  <Tag color="blue">{agentName(p.agentId)}</Tag>
                  <Tag>{p.targets.length} destino{p.targets.length !== 1 ? 's' : ''}</Tag>
                </div>
                <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {p.pipeline.map((step, i) => (
                    <Tag key={i} style={{ fontSize: 11 }}>{STEP_TYPES.find(s => s.value === step.type)?.label ?? step.type}</Tag>
                  ))}
                </div>
                {p.lastRun && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    Última execução: {dayjs(p.lastRun).format('DD/MM/YY HH:mm')}
                  </Text>
                )}
              </div>
              <Space wrap>
                <Button
                  icon={p.status === 'active' ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                  onClick={() => toggle.mutate(p._id)}
                  loading={toggle.isPending}
                >
                  {p.status === 'active' ? 'Pausar' : 'Retomar'}
                </Button>
                <Button icon={<EditOutlined />} onClick={() => openEdit(p)}>Editar</Button>
                <Popconfirm title="Remover postagem?" onConfirm={() => remove.mutate(p._id)} okText="Remover" okButtonProps={{ danger: true }}>
                  <Button danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            </div>
          </Card>
        ))}
      </Space>

      <PostModal
        open={modalOpen}
        post={editPost}
        agentId={editPost?.agentId ?? currentAgentId}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}
